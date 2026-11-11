"""기기 상태 조회(app/device/) — 오프라인 결정적 시험.

통제가 겹마다 지켜지는지 본다: SELECT 한 문장만, 허용 테이블만(osquery에 넘기는 인자),
행·칸 상한, 같은 컴퓨터에서 온 요청만. osquery가 실제로 있으면(scripts/fetch_osquery.sh)
허용 밖 테이블이 진짜로 거절되는지도 확인한다 — 없으면 그 시험만 건너뛴다.
"""
import json
import plistlib
import subprocess
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.device import osq
from app.device import router as device_router
from app.errors import EngineError

H = {"X-Dev-User": "boram"}


@pytest.mark.parametrize("sql", [
    "", "   ", "drop table processes", "pragma table_info(processes)",
    "create table x(a); insert into x values(1); select * from x",
    "select 1; select 2", "select ';' from os_version",
    "attach database '/tmp/z.db' as z", "select " + "1," * 1200 + "1",
])
def test_check_sql_rejects(sql):
    with pytest.raises(EngineError) as e:
        osq.check_sql(sql)
    assert e.value.code == "device_query_rejected"


def test_check_sql_accepts_one_select():
    assert osq.check_sql("  SELECT name FROM processes limit 3 ; ") == "SELECT name FROM processes limit 3"


def _fake(stdout="[]", rc=0, stderr=""):
    calls = []

    def run(argv, **kw):
        calls.append((argv, kw))
        return SimpleNamespace(returncode=rc, stdout=stdout, stderr=stderr)
    return run, calls


def test_query_passes_allowlist_and_caps(monkeypatch):
    monkeypatch.setenv("A2A_OSQUERY_PATH", "/bin/sh")          # 있는 실행 파일이면 된다 — 실제로 부르지 않는다
    rows = [{"name": f"p{i}", "cmdline": "x" * 2000} for i in range(osq.MAX_ROWS + 50)]
    run, calls = _fake(json.dumps(rows))
    out = osq.query("select name, cmdline from processes", _run=run)
    argv, kw = calls[0]
    assert "--enable_tables=" + ",".join(osq.TABLES) in argv
    assert "--disable_extensions" in argv and "-S" in argv
    assert argv[-1] == "select name, cmdline from processes"
    assert kw["timeout"] == osq.TIMEOUT_S
    assert out["row_count"] == osq.MAX_ROWS + 50 and out["truncated"] and len(out["rows"]) == osq.MAX_ROWS
    assert len(out["rows"][0]["cmdline"]) == osq.MAX_CELL + 1


def test_dangerous_tables_are_not_allowed():
    # 밖으로 나가거나(curl) 임의 파일·기록을 읽는 테이블은 허용 목록에 없어야 한다
    assert not {"curl", "file", "hash", "shell_history", "apps", "yara", "carves", "keychain_items"} & set(osq.TABLES)


def test_query_errors(monkeypatch):
    monkeypatch.setenv("A2A_OSQUERY_PATH", "/bin/sh")
    run, _ = _fake(rc=1, stderr="Error: no such table: curl")
    with pytest.raises(EngineError) as e:
        osq.query("select * from curl", _run=run)
    assert e.value.code == "device_query_failed" and "os_version" in e.value.message

    def slow(argv, **kw):
        raise subprocess.TimeoutExpired(argv, kw["timeout"])
    with pytest.raises(EngineError) as e:
        osq.query("select 1", _run=slow)
    assert e.value.http_status == 504

    monkeypatch.setenv("A2A_OSQUERY_PATH", "/nonexistent/osqueryd")
    with pytest.raises(EngineError) as e:
        osq.query("select 1")
    assert e.value.code == "device_unavailable"


def test_find_apps_reads_bundles(tmp_path):
    a = tmp_path / "Zoom.app" / "Contents"
    a.mkdir(parents=True)
    (a / "Info.plist").write_bytes(plistlib.dumps(
        {"CFBundleShortVersionString": "6.2.1", "CFBundleIdentifier": "us.zoom.xos"}))
    (tmp_path / "Broken.app").mkdir()                       # Info.plist 없는 묶음 — 이름만
    (tmp_path / "notes.txt").write_text("x")
    out = osq.find_apps("", _dirs=[tmp_path, tmp_path / "missing"])
    assert [x["name"] for x in out["apps"]] == ["Broken", "Zoom"] and out["unreadable"] == []
    hit = osq.find_apps("ZOOM", _dirs=[tmp_path])["apps"]
    assert hit == [{"name": "Zoom", "version": "6.2.1", "bundle_id": "us.zoom.xos",
                    "path": str(tmp_path / "Zoom.app")}]
    assert osq.find_apps("xos", _dirs=[tmp_path])["row_count"] == 1      # 번들 ID로도
    assert osq.find_apps("slack", _dirs=[tmp_path])["apps"] == []


# ── HTTP 표면 ──
@pytest.fixture
def app_mod(tmp_path, monkeypatch):
    import app.config as config_mod
    monkeypatch.setattr(config_mod, "_load_dotenv", lambda: None)
    monkeypatch.setenv("SAAS_AUTH", "dev")
    monkeypatch.setenv("SAAS_STORE", "local")
    monkeypatch.setenv("SAAS_DB_PATH", str(tmp_path / "s.db"))
    monkeypatch.setenv("SAAS_ALLOWED_USERS", "boram")
    import app.saas.store as store_mod
    store_mod._store = None
    monkeypatch.delenv("A2A_DEVICE", raising=False)
    from app import main as main_mod
    return main_mod


def test_remote_caller_is_refused(app_mod):
    c = TestClient(app_mod.app)                              # 보낸 쪽이 루프백이 아니다("testclient")
    assert c.get("/v1/device/tables", headers=H).status_code == 403
    assert c.post("/v1/device/query", headers=H, json={"sql": "select 1"}).status_code == 403


def test_rebinding_host_is_refused(app_mod):
    c = TestClient(app_mod.app, client=("127.0.0.1", 50000), base_url="http://evil.example.com")
    assert c.get("/v1/device/tables", headers=H).status_code == 403


def test_disabled_outside_local_mode(app_mod, monkeypatch):
    c = TestClient(app_mod.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:8423")
    monkeypatch.setenv("A2A_DEVICE", "0")
    assert c.get("/v1/device/tables", headers=H).status_code == 403
    monkeypatch.delenv("A2A_DEVICE")
    monkeypatch.setenv("SAAS_AUTH", "supabase")              # 로그인 인증을 쓰는 배포 — 기본으로 꺼진다
    assert not device_router.enabled()


def test_local_caller_flow(app_mod, monkeypatch):
    c = TestClient(app_mod.app, client=("127.0.0.1", 50000), base_url="http://127.0.0.1:8423")
    assert c.get("/v1/device/tables").status_code == 401     # 로컬이어도 사용자 헤더는 필요
    r = c.get("/v1/device/tables", headers=H)
    assert r.status_code == 200 and "processes" in r.json()["tables"]
    r = c.post("/v1/device/query", headers=H, json={"sql": "delete from processes"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "device_query_rejected"
    seen = []
    monkeypatch.setattr(device_router.audit, "record", lambda kind, payload: seen.append((kind, payload)))
    monkeypatch.setattr(osq, "query", lambda sql: {"sql": sql, "rows": [{"secret": "값"}], "row_count": 1,
                                                    "truncated": False, "elapsed_ms": 3, "source": "osquery"})
    assert c.post("/v1/device/query", headers=H, json={"sql": "select 1"}).status_code == 200
    kind, payload = seen[-1]
    assert kind == "device_query" and payload["sql"] == "select 1" and payload["rows"] == 1
    assert "값" not in json.dumps(payload, ensure_ascii=False)   # 감사 기록에 결과 내용은 남기지 않는다


@pytest.mark.skipif(osq.binary() is None, reason="osquery 없음 — scripts/fetch_osquery.sh")
def test_real_osquery_enforces_allowlist():
    out = osq.query("select name, version from os_version")
    assert out["row_count"] == 1 and out["rows"][0]["name"]
    for sql in ("select * from curl where url='http://127.0.0.1:1/'",
                "select * from file where path='/etc/hosts'"):
        with pytest.raises(EngineError) as e:
            osq.query(sql)
        assert "no such table" in e.value.message
