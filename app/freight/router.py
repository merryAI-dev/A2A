"""해상 운임 HTTP 표면 — /v1/freight/ocean.

인증은 SaaS 공통(current_user). 바깥 유료 호출이 없어 비용 캡을 걸지 않는다(접점 찾기와 같은 결정).
화면과 에이전트 도구가 같은 경로를 쓴다.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..saas.auth import SaasUser, current_user
from . import rates

router = APIRouter(prefix="/v1/freight", tags=["freight"])


class OceanIn(BaseModel):
    origin: str = Field(min_length=1, max_length=80)
    destination: str = Field(min_length=1, max_length=80)
    container: str = Field(default="40", max_length=20)
    cargo: str = Field(default="", max_length=120)      # 기록·주의 문구용 — 값 계산엔 쓰지 않는다


@router.post("/ocean")
def ocean(body: OceanIn, user: SaasUser = Depends(current_user)):
    return rates.estimate(body.origin, body.destination, body.container, body.cargo)
