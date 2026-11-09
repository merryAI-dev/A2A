"""접점 발굴 HTTP 표면 — /v1/contacts/discover.

인증은 SaaS 공통(current_user·허용 목록). MVP는 외부 유료 호출이 없어 비용 캡을 걸지
않는다(2026-11-09 사용자 결정 — LLM 비용만 reserve_cost 대상). 요청당 페이지 수·크기
상한은 finder가 쥔다.
"""
from fastapi import APIRouter, Depends
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
