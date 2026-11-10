"""개발용 모델 프록시(app/llm_proxy.py) — 꺼져 있으면 없는 경로이고, 우리 확장만 통과한다."""
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import llm_proxy

GOOD = {"origin": f"chrome-extension://{llm_proxy.EXTENSION_ID}"}
app = FastAPI()
app.include_router(llm_proxy.router)
client = TestClient(app)


class _Body(httpx.AsyncByteStream):
    async def __aiter__(self):
        yield b'{"type":"error"}'


def _on(monkeypatch):
    monkeypatch.setenv("A2A_DEV_LLM_PROXY", "1")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "server-side-key")


def test_off_by_default(monkeypatch):
    monkeypatch.delenv("A2A_DEV_LLM_PROXY", raising=False)
    assert client.post("/llm/status", headers=GOOD).status_code == 404
    assert client.post("/llm/v1/messages", headers=GOOD, json={}).status_code == 404


def test_rejects_web_pages_and_missing_origin(monkeypatch):
    _on(monkeypatch)
    assert client.post("/llm/v1/messages", headers={"origin": "https://evil.example"}, json={}).status_code == 403
    assert client.post("/llm/v1/messages", json={}).status_code == 403
    assert client.post("/llm/status", headers={"origin": "chrome-extension://other"}).status_code == 403


def test_status_never_returns_the_key(monkeypatch):
    _on(monkeypatch)
    r = client.post("/llm/status", headers=GOOD)
    assert r.json() == {"available": True} and "server-side-key" not in r.text


def test_replaces_placeholder_with_server_key_and_passes_error_status(monkeypatch):
    _on(monkeypatch)
    seen = {}

    def upstream(req: httpx.Request) -> httpx.Response:
        seen.update(key=req.headers["x-api-key"], url=str(req.url), beta=req.headers.get("anthropic-beta"),
                    encoding=req.headers.get("accept-encoding"))
        return httpx.Response(429, stream=_Body(), headers={"retry-after": "7"})

    monkeypatch.setattr(llm_proxy, "transport", httpx.MockTransport(upstream))
    r = client.post("/llm/v1/messages?beta=true", json={"model": "m"},
                    headers={**GOOD, "x-api-key": "a2a-engine-proxy", "anthropic-beta": "b1"})
    assert r.status_code == 429 and r.headers["retry-after"] == "7"
    assert seen == {"key": "server-side-key", "url": f"{llm_proxy.UPSTREAM}?beta=true", "beta": "b1",
                    "encoding": "identity"}
