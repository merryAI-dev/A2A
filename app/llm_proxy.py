"""개발용 모델 프록시 — 브라우저 패널이 엔진 .env의 키로 Claude를 부른다.

키는 브라우저로 내려가지 않는다. A2A_DEV_LLM_PROXY=1일 때만 열리고(기본은 404), 우리
내장 확장의 Origin만 받는다. 사용자 인증·비용 캡이 없으니 배포 환경에서 켜면 안 된다.
"""
import os

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

UPSTREAM = "https://api.anthropic.com/v1/messages"
EXTENSION_ID = os.environ.get("A2A_EXTENSION_ID", "pjfhlidneddkhdaafcleleomokgdlnan")
FORWARD_REQUEST = ("anthropic-version", "anthropic-beta", "content-type", "accept")
FORWARD_RESPONSE = ("content-type", "request-id", "retry-after")
TIMEOUT = httpx.Timeout(600.0, connect=10.0)

router = APIRouter(prefix="/llm", tags=["llm-proxy"])
transport: httpx.AsyncBaseTransport | None = None   # 시험에서 바꿔 끼운다


def _gate(request: Request) -> str:
    if os.environ.get("A2A_DEV_LLM_PROXY") != "1":
        raise HTTPException(status_code=404, detail="not found")
    if request.headers.get("origin") != f"chrome-extension://{EXTENSION_ID}":
        raise HTTPException(status_code=403, detail="origin not allowed")
    return os.environ.get("ANTHROPIC_API_KEY", "")


@router.post("/status")   # GET에는 확장의 Origin이 실리지 않는다
def status(request: Request):
    return {"available": bool(_gate(request))}


@router.post("/v1/messages")
async def messages(request: Request):
    key = _gate(request)
    if not key:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not set")
    headers = {h: request.headers[h] for h in FORWARD_REQUEST if h in request.headers}
    headers["x-api-key"] = key
    headers["accept-encoding"] = "identity"   # 압축된 응답을 그대로 흘리면 SDK가 SSE를 못 읽는다
    client = httpx.AsyncClient(timeout=TIMEOUT, transport=transport)
    upstream = await client.send(
        client.build_request("POST", UPSTREAM, params=request.query_params,
                             content=await request.body(), headers=headers),
        stream=True,
    )
    async def close():
        await upstream.aclose()
        await client.aclose()
    return StreamingResponse(
        upstream.aiter_raw(), status_code=upstream.status_code,
        headers={h: upstream.headers[h] for h in FORWARD_RESPONSE if h in upstream.headers},
        background=BackgroundTask(close),
    )
