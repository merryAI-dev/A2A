"""접점 발굴(app/contacts/finder.py) — 오프라인 결정적 시험.

가짜 회사 사이트를 로컬 HTTP로 띄우고 평문 클라이언트를 주입한다(netguard는 루프백을
막는 게 정상이라, 실 서비스 경로가 아닌 주입 경로로 시험한다). MX·SMTP는 스텁.
BENCH_CONTACTS의 원칙대로: 출처 없는 접점이 결과에 섞이면 그게 곧 실패다.
"""
import http.server
import threading

import httpx
import pytest

from app.contacts import finder

SITE = {
    "/": """<html><body>
      <a href="/contact">문의하기</a> <a href="/about">회사소개</a>
      <a href="/blog">블로그</a> <a href="https://other.example.net/x">밖</a>
      <footer>대표문의 info@acme-robots.kr</footer></body></html>""",
    "/contact": """<html><body>
      영업: jane.doe@acme-robots.kr (제휴·구매)
      채용 문의는 recruit@acme-robots.kr
      그림 속 주소 logo@2x.png
      대행사: agency@mail-vendor.co.kr</body></html>""",
    "/sitemap.xml": "<urlset><url><loc>__BASE__/people/partnership</loc></url></urlset>",
    "/people/partnership": "<html>제휴 담당 partner.kim@acme-robots.kr</html>",
    "/robots.txt": "User-agent: *\nDisallow: /contact-us\n",
    "/contact-us": "<html>금지 구역 secret@acme-robots.kr</html>",
    "/about": """<html><body>
      홍보 담당 김민준 — minjun [at] acme-robots [dot] kr
      예시 주소 user@example.com 는 안내용입니다</body></html>""",
}


@pytest.fixture(scope="module")
def site():
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = SITE.get(self.path.split("?")[0])
            if body:
                body = body.replace("__BASE__", f"http://127.0.0.1:{self.server.server_port}")
            self.send_response(200 if body else 404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write((body or "없음").encode())

        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


@pytest.fixture()
def no_dns(monkeypatch):
    monkeypatch.setattr(finder, "_mx_hosts", lambda d: ["mx1." + d])


def _addrs(out):
    return {e["address"]: e for e in out["emails"]}


def test_collects_emails_with_sources(site, no_dns):
    out = finder.discover(site, client=httpx.Client(), assume_root="acme-robots.kr")
    e = _addrs(out)
    assert "jane.doe@acme-robots.kr" in e and "info@acme-robots.kr" in e
    for x in e.values():
        if x["method"] == "found":
            assert x["sources"] and x["sources"][0]["url"].startswith(site)
            assert x["address"].split("@")[0][:4] in x["sources"][0]["quote"].lower()


def test_obfuscated_and_noise(site, no_dns):
    e = _addrs(finder.discover(site, client=httpx.Client(), assume_root="acme-robots.kr"))
    assert "minjun@acme-robots.kr" in e            # [at]/[dot] 복원
    assert "user@example.com" not in e             # 예시 도메인 제외
    assert all(not a.endswith(".png") for a in e)  # 이미지 파일명 오탐 제외


def test_generic_flag_and_ordering(site, no_dns):
    out = finder.discover(site, client=httpx.Client(), assume_root="acme-robots.kr")
    e = _addrs(out)
    assert e["info@acme-robots.kr"]["generic"] is True
    assert e["jane.doe@acme-robots.kr"]["generic"] is False
    assert e["agency@mail-vendor.co.kr"]["same_domain"] is False
    # 같은 도메인 개인 주소가 목록 앞, 밖 도메인이 뒤
    order = [x["address"] for x in out["emails"]]
    assert order.index("jane.doe@acme-robots.kr") < order.index("info@acme-robots.kr") \
        < order.index("agency@mail-vendor.co.kr")


def test_pattern_inference_and_person_candidates(site, no_dns):
    out = finder.discover(site, person={"first": "Hana", "last": "Park"}, client=httpx.Client(), assume_root="acme-robots.kr")
    assert {"pattern": "{first}.{last}", "seen": 2} in out["patterns"]
    cands = [e for e in out["emails"] if e["method"] == "pattern"]
    assert cands and cands[0]["address"] == "hana.park@acme-robots.kr"
    assert all(not c["sources"] for c in cands)     # 추측에 출처를 달지 않는다


def test_verify_statuses(monkeypatch):
    monkeypatch.setattr(finder, "_mx_hosts", lambda d: {"has.kr": ["mx.has.kr"], "none.kr": [],
                                                        "dark.kr": None}[d])
    cache = {}
    assert finder.verify("a@has.kr", mx_cache=cache, smtp_check=False)["status"] == "mx_ok"
    assert finder.verify("a@none.kr", mx_cache=cache, smtp_check=False)["status"] == "no_mx"
    assert finder.verify("a@dark.kr", mx_cache=cache, smtp_check=False)["status"] == "unknown"


def test_smtp_catch_all_detection(monkeypatch):
    monkeypatch.setattr(finder, "_mx_hosts", lambda d: ["mx." + d])
    monkeypatch.setattr(finder, "_smtp_probe", lambda mx, addr, helo: True)   # 아무 주소나 수락
    out = finder.verify("x@ca.kr", mx_cache={}, smtp_check=True)
    assert out["status"] == "smtp_catch_all"
    # 캐치올이 아니면 개별 판정이 산다
    monkeypatch.setattr(finder, "_smtp_probe",
                        lambda mx, addr, helo: not addr.startswith("zz-") and addr == "ok@real.kr")
    cache = {}
    assert finder.verify("ok@real.kr", mx_cache=cache, smtp_check=True)["status"] == "smtp_ok"
    assert finder.verify("no@real.kr", mx_cache=cache, smtp_check=True)["status"] == "smtp_rejected"


def test_bad_domain_rejected():
    with pytest.raises(Exception) as e:
        finder.discover("한글만")
    assert getattr(e.value, "code", "") == "invalid_input"


def test_root_domain_keeps_public_suffix():
    assert finder._root_domain("www.mysc.co.kr") == "mysc.co.kr"
    assert finder._root_domain("corp.example.com.vn") == "example.com.vn"
    assert finder._root_domain("www.anthropic.com") == "anthropic.com"


def test_links_follow_www_and_apex_of_same_company():
    html = '<a href="https://www.corp.co.kr/contact">문의</a><a href="https://other.co.kr/contact">문의</a>'
    assert finder._links(html, "https://corp.co.kr") == ["https://www.corp.co.kr/contact"]


def test_sitemap_page_found_and_robots_respected(site, no_dns):
    out = finder.discover(site, client=httpx.Client(), assume_root="acme-robots.kr")
    e = _addrs(out)
    assert "partner.kim@acme-robots.kr" in e       # 메뉴에 없고 sitemap에만 있는 페이지
    assert "secret@acme-robots.kr" not in e and out["skipped_robots"] >= 1


def test_guessed_404s_are_not_errors(site, no_dns):
    out = finder.discover(site, client=httpx.Client(), assume_root="acme-robots.kr")
    assert out["errors"] == []                     # /team 같은 찍어 본 경로의 404는 실패가 아니다


def test_paths_embedded_in_page_data():
    html = 'x={"link":"/company/contact-sales","other":"/assets/app"}'
    assert finder._links(html, "https://www.corp.com") == ["https://www.corp.com/company/contact-sales"]


def test_placeholder_addresses_dropped():
    out = finder._emails_in("문의 user@domain.com 또는 you@yourdomain.co.kr, 실제 real@corp.kr", "u")
    assert [e["address"] for e in out] == ["real@corp.kr"]
