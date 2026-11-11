"""기기 상태 조회 HTTP 표면 — /v1/device/*.

엔진이 도는 컴퓨터의 상태를 읽는다. 그래서 같은 컴퓨터에서 온 요청만 받는다(local_only):
클라우드에 배포된 엔진에서는 서버 정보를 내주지 않도록 통째로 닫힌다(enabled).
누가 무엇을 물었는지는 감사 기록(app/audit.py)에 남긴다 — 결과 내용은 남기지 않는다.
"""
import ipaddress
import os

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import audit
from ..saas.auth import SaasUser, current_user
from . import osq


def enabled() -> bool:
    """A2A_DEVICE=1/0으로 정한다. 안 정했으면 로컬 실행(SAAS_AUTH=dev)일 때만 켠다.

    Rust 게이트웨이(8423)를 거쳐 온 요청은 엔진에게 늘 루프백으로 보인다 — 게이트웨이를 밖에 여는
    배포(로그인 인증을 쓴다)에서는 주소 검사만으로 못 막으므로 여기서 통째로 끈다."""
    v = os.environ.get("A2A_DEVICE", "").strip()
    return v == "1" if v else os.environ.get("SAAS_AUTH", "dev").lower() == "dev"


def local_only(request: Request) -> None:
    """보낸 쪽도 루프백, 부른 이름(Host)도 루프백일 때만 — 다른 기기와 DNS 리바인딩을 함께 막는다."""
    if not enabled():
        raise HTTPException(403, "이 엔진에서는 기기 조회가 꺼져 있습니다")
    host = request.client.host if request.client else ""
    try:
        peer_ok = ipaddress.ip_address(host).is_loopback
    except ValueError:
        peer_ok = False
    name = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]")
    if not peer_ok or name not in ("127.0.0.1", "localhost", "::1"):
        raise HTTPException(403, "기기 조회는 이 컴퓨터 안에서만 쓸 수 있습니다")


router = APIRouter(prefix="/v1/device", tags=["device"], dependencies=[Depends(local_only)])


class QueryIn(BaseModel):
    sql: str = Field(min_length=1, max_length=osq.MAX_SQL)


class AppsIn(BaseModel):
    name: str = Field(default="", max_length=100)


@router.get("/tables")
def tables(user: SaasUser = Depends(current_user)):
    """읽을 수 있는 테이블과 설명 — 도구 설명의 원본(app/device/osq.py TABLES)."""
    return {"available": osq.binary() is not None, "tables": osq.TABLES}


@router.post("/query")
def query(body: QueryIn, user: SaasUser = Depends(current_user)):
    try:
        out = osq.query(body.sql)
    except Exception as e:
        audit.record("device_query", {"user": user.uid, "sql": body.sql[:osq.MAX_SQL],
                                      "error": getattr(e, "code", type(e).__name__)})
        raise
    audit.record("device_query", {"user": user.uid, "sql": out["sql"],
                                  "rows": out["row_count"], "ms": out["elapsed_ms"]})
    return out


@router.post("/apps")
def apps(body: AppsIn, user: SaasUser = Depends(current_user)):
    out = osq.find_apps(body.name)
    audit.record("device_apps", {"user": user.uid, "name": body.name, "rows": out["row_count"]})
    return out
