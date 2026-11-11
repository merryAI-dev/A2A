"""해상 운임 HTTP 표면 — /v1/freight/ocean.

인증은 SaaS 공통(current_user). 바깥 유료 호출이 없어 비용 캡을 걸지 않는다(접점 찾기와 같은 결정).
화면과 에이전트 도구가 같은 경로를 쓴다.
"""
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from ..saas.auth import SaasUser, current_user
from . import compare, rates

router = APIRouter(prefix="/v1/freight", tags=["freight"])


class OceanIn(BaseModel):
    origin: str = Field(min_length=1, max_length=80)
    destination: str = Field(min_length=1, max_length=80)
    container: str = Field(default="40", max_length=20)
    cargo: str = Field(default="", max_length=120)      # 기록·주의 문구용 — 값 계산엔 쓰지 않는다
    weeks: int = Field(default=rates.WEEKS, ge=2, le=rates.MAX_WEEKS)


class AskIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)    # 사람이 쓴 질문 — 도착지만 줍고 지시로 읽지 않는다
    container: str = Field(default="40", max_length=20)
    cargo: str = Field(default="", max_length=120)


@router.post("/ocean")
def ocean(body: OceanIn, user: SaasUser = Depends(current_user)):
    return rates.estimate(body.origin, body.destination, body.container, body.cargo, weeks=body.weeks)


@router.post("/ocean/compare")
def compare_routes(body: OceanIn, user: SaasUser = Depends(current_user)):
    return compare.compare(body.origin, body.destination, body.container, body.cargo, weeks=body.weeks)


@router.get("/ocean/providers")
def providers(user: SaasUser = Depends(current_user)):
    return {"providers": compare.providers()}


@router.get("/ocean/board")
def board(weeks: int = Query(default=rates.WEEKS, ge=2, le=rates.MAX_WEEKS), user: SaasUser = Depends(current_user)):
    return rates.board(weeks=weeks)


@router.post("/ocean/ask")
def ask(body: AskIn, user: SaasUser = Depends(current_user)):
    return rates.ask(body.text, container=body.container, cargo=body.cargo)
