"""해상 운임(app/freight/rates.py) — 오프라인 결정적 시험.

KOBC 시계열 표(2026-11-11 실측한 모양)를 가짜 응답으로 주입한다. 원칙은 접점 찾기와 같다:
출처·기준일 없는 숫자, 지어낸 숫자가 결과에 섞이면 그게 곧 실패다.
"""
from datetime import date

import httpx
import pytest
from fastapi.testclient import TestClient

from app.errors import EngineError
from app.freight import rates

HEAD = """<table class="TbCommon"><caption>표</caption><thead><tr>
<th rowspan="2" scope="col">Date</th><th rowspan="2">KCCI</th>
<th colspan="4" class="col">Mainlane</th><th colspan="6" class="col">Non-Mainlane</th><th colspan="3" class="col">Intra Asia</th></tr>
<tr><th scope="col">KUWI</th><th scope="col">KUEI</th><th scope="col">KNEI</th><th scope="col">KMDI</th>
<th scope="col">KMEI</th><th scope="col">KAUI</th><th scope="col">KLEI</th><th scope="col">KLWI</th>
<th scope="col">KSAI</th><th scope="col">KWAI</th><th scope="col">KCI</th><th scope="col">KJI</th><th scope="col">KSEI</th></tr></thead><tbody>"""
ROWS = [
    ("2026-11-09", "4,668 8,267 11,542 3,537 4,177 8,930 4,853 5,314 6,073 5,061 4,993 52 216 1,688"),
    ("2026-11-02", "4,667 8,247 11,568 3,513 3,981 9,024 4,854 5,881 6,003 4,685 4,752 52 228 1,678"),
    ("2026-10-26", "4,666 8,267 11,572 3,508 3,945 8,887 4,916 6,062 5,979 4,500 4,720 52 229 1,684"),
]


def page(rows=ROWS, head=HEAD):
    body = "".join(f"<tr><td> {d} </td>" + "".join(f"<td> {v} </td>" for v in vals.split()) + "</tr>" for d, vals in rows)
    return f"<html><body>{head}{body}</tbody></table></body></html>"


def client(html=None, status=200, seen=None):
    def handle(req):
        if seen is not None:
            seen.append((req.method, str(req.url), req.content.decode()))
        return httpx.Response(status, text=page() if html is None else html)
    return httpx.Client(transport=httpx.MockTransport(handle))


TODAY = date(2026, 11, 11)


def test_korea_to_italy_is_mediterranean_lane_with_source_and_date():
    seen = []
    out = rates.estimate("한국", "이탈리아", "40", "가구", client=client(seen=seen), today=TODAY)
    assert out["status"] == "ok" and out["kind"] == "index" and out["unit"] == "USD/FEU"
    (lane,) = out["lanes"]
    assert lane["code"] == "KMDI" and lane["usd_per_feu"] == 4177 and lane["as_of"] == "2026-11-09"
    assert lane["previous"] == {"usd_per_feu": 3981, "as_of": "2026-11-02"}
    assert lane["change"] == {"abs": 196, "pct": 4.92}
    assert lane["range"]["low"] == 3945 and lane["range"]["high"] == 4177 and lane["range"]["weeks"] == 3
    assert [p["date"] for p in lane["history"]] == ["2026-10-26", "2026-11-02", "2026-11-09"]
    assert out["source"]["publisher"] == "한국해양진흥공사" and out["source"]["url"].startswith("https://kobc.or.kr/")
    assert out["source"]["fetched_at"] and out["not_included"]
    # 한 번만, 날짜 범위를 실어 보낸다
    assert len(seen) == 1 and seen[0][0] == "POST" and "eDay=2026-11-11" in seen[0][2] and "sDay=2026-08-12" in seen[0][2]


def test_port_code_and_names_resolve():
    assert rates.place("ITGOA") == {"input": "ITGOA", "country": "IT", "port": "ITGOA"}
    assert rates.place(" Genoa ")["port"] == "ITGOA" and rates.place("it")["country"] == "IT"
    assert rates.place("어딘가") is None and rates.place("") is None


def test_columns_follow_the_header_not_position():
    # KOBC가 열 순서를 바꿔도 머리글을 따라간다 — 자리로 읽으면 다른 항로 값을 지중해라고 말하게 된다
    head = HEAD.replace('<th scope="col">KNEI</th><th scope="col">KMDI</th>', '<th scope="col">KMDI</th><th scope="col">KNEI</th>')
    out = rates.estimate("KR", "IT", client=client(page(head=head)), today=TODAY)
    assert out["lanes"][0]["usd_per_feu"] == 3537


def test_two_coast_country_returns_candidates_and_port_narrows():
    out = rates.estimate("부산", "미국", client=client(), today=TODAY)
    assert out["status"] == "ambiguous" and [l["code"] for l in out["lanes"]] == ["KUWI", "KUEI"]
    one = rates.estimate("부산", "USLAX", client=client(), today=TODAY)
    assert one["status"] == "ok" and one["lanes"][0]["code"] == "KUWI" and one["lanes"][0]["usd_per_feu"] == 8267


def test_unknowns_are_said_not_guessed():
    calls = []
    c = client(seen=calls)
    not_korea = rates.estimate("상하이", "IT", client=c, today=TODAY)
    assert not_korea["status"] == "unknown" and not_korea["lanes"] == [] and "부산 출발" in not_korea["reason"]
    nowhere = rates.estimate("KR", "어딘가", client=c, today=TODAY)
    assert nowhere["status"] == "unknown" and nowhere["lanes"] == []
    unmapped = rates.estimate("KR", "MN", client=c, today=TODAY)
    assert unmapped["status"] == "unknown" and unmapped["lanes"] == [] and unmapped["available_lanes"]
    assert calls == []          # 답할 수 없는 물음에 바깥 요청을 쓰지 않는다


def test_other_container_or_cargo_is_flagged_never_scaled():
    out = rates.estimate("KR", "IT", "20", "냉동 식품", client=client(), today=TODAY)
    assert out["lanes"][0]["usd_per_feu"] == 4177            # 반으로 나누지 않는다
    assert out["container"] == {"requested": "20", "priced": "40ft dry (FEU)"}
    assert any("절반이 아닙니다" in n for n in out["notes"]) and any("냉동" in n for n in out["notes"])
    assert rates.estimate("KR", "IT", "40", "가구", client=client(), today=TODAY)["notes"] == []


def test_old_publication_is_marked_stale():
    out = rates.estimate("KR", "IT", client=client(), today=date(2026, 12, 20))
    assert out["lanes"][0]["stale"] is True and any("오래됐습니다" in n for n in out["notes"])


def test_source_failures_are_errors_not_empty_answers():
    with pytest.raises(EngineError) as e:
        rates.estimate("KR", "IT", client=client("<html>점검 중</html>"), today=TODAY)
    assert e.value.code == "source_changed"
    with pytest.raises(EngineError) as e:
        rates.estimate("KR", "IT", client=client(status=503), today=TODAY)
    assert e.value.code == "source_unreachable"
    with pytest.raises(EngineError):
        rates.estimate("", "IT", client=client(), today=TODAY)


def test_http_surface(monkeypatch, tmp_path):
    import app.config as config_mod
    monkeypatch.setattr(config_mod, "_load_dotenv", lambda: None)
    monkeypatch.setenv("SAAS_AUTH", "dev")
    monkeypatch.setenv("SAAS_DB_PATH", str(tmp_path / "saas.db"))
    monkeypatch.setenv("SAAS_ALLOWED_USERS", "boram")
    from app.main import app
    monkeypatch.setattr(rates, "fetch_table", lambda c=None, today=None: {**rates.parse_timeseries(page()), "fetched_at": "2026-11-11T00:00:00+00:00"})
    r = TestClient(app).post("/v1/freight/ocean", json={"origin": "한국", "destination": "이탈리아"}, headers={"X-Dev-User": "boram"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "ok" and d["lanes"][0]["code"] == "KMDI" and d["lanes"][0]["usd_per_feu"] == 4177
