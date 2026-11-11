"""접점 발굴 HTTP 표면 — /v1/contacts/discover.

인증은 SaaS 공통(current_user·허용 목록). MVP는 외부 유료 호출이 없어 비용 캡을 걸지
않는다(2026-11-09 사용자 결정 — LLM 비용만 reserve_cost 대상). 요청당 페이지 수·크기
상한은 finder가 쥔다.
"""
import json
import queue
import threading

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..saas.auth import SaasUser, current_user
from . import finder

router = APIRouter(prefix="/v1/contacts", tags=["contacts"])


class Person(BaseModel):
    first: str = Field(default="", max_length=40)
    last: str = Field(default="", max_length=40)


class DiscoverIn(BaseModel):
    domain: str = Field(min_length=3, max_length=200)
    person: "Person | None" = None
    company: str = Field(default="", max_length=200)   # 기록용 — 검색엔 안 쓴다


@router.post("/discover")
def discover(body: DiscoverIn, user: SaasUser = Depends(current_user)):
    person = body.person.model_dump() if body.person else None
    out = finder.discover(body.domain, person)
    if body.company:
        out["company"] = body.company
    return out


@router.post("/discover/stream")
def discover_stream(body: DiscoverIn, user: SaasUser = Depends(current_user)):
    """같은 발굴을 한 줄에 사건 하나(NDJSON)로 흘린다 — page·email·step, 마지막에 done(전체 결과) 또는 error.

    발굴은 최대 45초쯤 걸린다. 끝까지 기다리게 하지 않고 찾는 대로 화면에 올리려는 것.
    """
    person = body.person.model_dump() if body.person else None
    events: "queue.Queue[dict | None]" = queue.Queue()

    def work():
        try:
            out = finder.discover(body.domain, person, on_event=events.put)
            if body.company:
                out["company"] = body.company
            events.put({"type": "done", "result": out})
        except Exception as e:  # noqa: BLE001 — 스트림은 이미 200으로 열렸다. 실패도 사건으로 알린다
            events.put({"type": "error", "message": getattr(e, "message", None) or str(e)[:300]})
        finally:
            events.put(None)

    threading.Thread(target=work, daemon=True).start()

    def lines():
        while (ev := events.get()) is not None:
            yield json.dumps(ev, ensure_ascii=False) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
