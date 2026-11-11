"""이 컴퓨터의 상태 조회 — osquery를 자식 프로세스로 불러 허용된 테이블만 읽는다.

osquery(Apache-2.0)는 운영체제 상태를 SQL 테이블로 보여 준다. 에이전트가 SQL을 쓰므로
통제를 겹으로 둔다:
  1) 허용 테이블(TABLES) — osquery 자체에 `--enable_tables`로 강제한다. 목록 밖 테이블은
     osquery가 "no such table"로 거절한다(`curl`·`file`처럼 밖으로 나가거나 임의 파일을 읽는
     테이블이 기본으로 켜져 있어서다).
  2) SELECT 한 문장만 — osquery는 메모리 DB에 CREATE/INSERT를 허용하므로 여기서 거른다.
  3) 행 수·칸 길이·시간 상한.
허용 테이블의 원본은 이 파일의 TABLES 하나다(도구 설명도 여기서 받아 간다).

설치된 앱 목록은 osquery의 `apps` 테이블이 실측 60초를 넘겨(2026-11-11, macOS 26.4) 쓰지
않고 Info.plist를 직접 읽는다(find_apps).
"""
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from ..errors import EngineError

# 허용 테이블 — 일반 사용자 권한으로 읽히고, 파일 내용·방문 기록·자격증명을 담지 않는 것만.
# 권한이 없으면 오류 없이 빈 결과를 내는 테이블(startup_items·file·shell_history 등)은 넣지 않는다:
# "없다"와 "못 읽었다"를 가를 수 없어서다.
TABLES: dict[str, str] = {
    "os_version": "운영체제 이름·버전·빌드",
    "system_info": "기기 모델·CPU·메모리·호스트 이름",
    "uptime": "켜진 뒤 지난 시간",
    "processes": "지금 도는 프로세스(name, pid, path, resident_size 바이트, start_time)",
    "listening_ports": "열려 있는 포트(pid, port, address) — processes와 pid로 잇는다",
    "interface_addresses": "네트워크 인터페이스 주소",
    "battery": "배터리 잔량·상태(맥)",
    "chrome_extensions": "크롬 계열 브라우저에 깔린 확장(browser_type, name, version, permissions, profile)",
    "disk_encryption": "디스크 암호화 여부(encrypted=1이면 암호화)",
    "alf": "맥 방화벽(global_state 0=꺼짐, 1=켜짐, 2=필수 서비스만)",
    "sip_config": "맥 시스템 무결성 보호(config_flag='sip'의 enabled)",
    "gatekeeper": "맥 게이트키퍼(assessments_enabled)",
}

MAX_SQL = 2000
MAX_ROWS = 200
MAX_CELL = 500
TIMEOUT_S = 5.0

_SELECT = re.compile(r"^\s*select\b", re.IGNORECASE)


def binary() -> str | None:
    """osquery 실행 파일 — A2A_OSQUERY_PATH > data/osquery/(scripts/fetch_osquery.sh가 받는 곳) > PATH."""
    env = os.environ.get("A2A_OSQUERY_PATH")
    if env:
        return env if os.access(env, os.X_OK) else None
    local = Path(__file__).resolve().parent.parent.parent / "data" / "osquery" / "osquery.app" / "Contents" / "MacOS" / "osqueryd"
    if os.access(local, os.X_OK):
        return str(local)
    return shutil.which("osqueryi")


def check_sql(sql: str) -> str:
    """SELECT 한 문장인지 본다. 통과하면 다듬은 문장을 돌려준다."""
    s = (sql or "").strip().rstrip(";").strip()
    if not s:
        raise EngineError(400, "device_query_rejected", "빈 질의입니다")
    if len(s) > MAX_SQL:
        raise EngineError(400, "device_query_rejected", f"질의가 너무 깁니다(최대 {MAX_SQL}자)")
    if not _SELECT.match(s):
        raise EngineError(400, "device_query_rejected", "SELECT 문만 실행합니다")
    # 문자열 안의 ;까지 막는다 — 여러 문장을 가려내는 가장 단순하고 빠져나갈 틈이 없는 기준
    if ";" in s:
        raise EngineError(400, "device_query_rejected", "한 번에 한 문장만 실행합니다(; 는 쓸 수 없습니다)")
    return s


def query(sql: str, *, _run=subprocess.run) -> dict:
    """허용 테이블에 SELECT 한 문장을 실행한다. 행은 MAX_ROWS, 칸은 MAX_CELL에서 자른다."""
    s = check_sql(sql)
    exe = binary()
    if not exe:
        raise EngineError(503, "device_unavailable",
                          "이 컴퓨터에 osquery가 없습니다 — scripts/fetch_osquery.sh로 받거나 A2A_OSQUERY_PATH를 지정하세요")
    argv = [exe, "-S", "--json", "--disable_events", "--disable_extensions",
            "--enable_tables=" + ",".join(TABLES), s]
    t0 = time.monotonic()
    try:
        # 빈 임시 폴더에서 돌린다 — 상대 경로로 무엇을 읽거나 남기지 않게
        with tempfile.TemporaryDirectory(prefix="a2a-osq-") as cwd:
            p = _run(argv, capture_output=True, text=True, timeout=TIMEOUT_S, cwd=cwd,
                     stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise EngineError(504, "device_query_timeout", f"{TIMEOUT_S:.0f}초 안에 끝나지 않았습니다") from None
    except OSError as e:
        raise EngineError(503, "device_unavailable", f"osquery를 실행하지 못했습니다: {e}") from None
    ms = int((time.monotonic() - t0) * 1000)
    if p.returncode != 0:
        err = (p.stderr or "").strip().splitlines()
        msg = err[-1] if err else f"종료 코드 {p.returncode}"
        if "no such table" in msg:
            msg += f" — 읽을 수 있는 테이블: {', '.join(TABLES)}"
        raise EngineError(400, "device_query_failed", msg[:400])
    try:
        rows = json.loads(p.stdout or "[]")
    except json.JSONDecodeError:
        raise EngineError(502, "device_query_failed", "osquery 응답을 읽지 못했습니다") from None
    total = len(rows)
    rows = [{k: (v if len(str(v)) <= MAX_CELL else str(v)[:MAX_CELL] + "…") for k, v in r.items()}
            for r in rows[:MAX_ROWS]]
    return {"sql": s, "rows": rows, "row_count": total, "truncated": total > MAX_ROWS,
            "elapsed_ms": ms, "source": "osquery"}


# ── 설치된 앱 ──────────────────────────────────────────────────────
def _app_dirs() -> list[Path]:
    return [Path("/Applications"), Path("/Applications/Utilities"), Path("/System/Applications"),
            Path("/System/Applications/Utilities"), Path.home() / "Applications"]


def find_apps(name: str = "", *, _dirs=None) -> dict:
    """앱 폴더의 .app 묶음을 읽어 이름·버전을 돌려준다(맥 전용). name을 주면 이름·번들 ID에 그 글자가 든 것만."""
    if _dirs is None and sys.platform != "darwin":
        raise EngineError(501, "device_unsupported", "설치된 앱 조회는 지금 맥에서만 됩니다")
    needle = (name or "").strip().casefold()
    dirs = _dirs if _dirs is not None else _app_dirs()
    apps, unreadable = [], []
    for d in dirs:
        try:
            bundles = sorted(x for x in d.iterdir() if x.suffix == ".app")
        except OSError:
            if d.exists():
                unreadable.append(str(d))
            continue
        for b in bundles:
            info = {}
            try:
                with open(b / "Contents" / "Info.plist", "rb") as f:
                    info = plistlib.load(f)
            except (OSError, plistlib.InvalidFileException, ValueError):
                pass                      # 이름은 폴더에서 알 수 있다 — 버전만 비운다
            row = {"name": b.stem,
                   "version": str(info.get("CFBundleShortVersionString") or info.get("CFBundleVersion") or ""),
                   "bundle_id": str(info.get("CFBundleIdentifier") or ""),
                   "path": str(b)}
            if needle and needle not in row["name"].casefold() and needle not in row["bundle_id"].casefold():
                continue
            apps.append(row)
    return {"name": name or "", "apps": apps[:MAX_ROWS], "row_count": len(apps),
            "truncated": len(apps) > MAX_ROWS,
            "searched": [str(d) for d in dirs], "unreadable": unreadable, "source": "Info.plist"}
