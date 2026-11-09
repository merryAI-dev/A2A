"""법인 메일 발굴·검증 — 구독(Hunter류) 없이 공개 페이지에서 직접 (2026-11-09 사용자 결정).

방법은 셋이고, 전부 출처가 남는다:
  1) 수집: 회사 자기 도메인의 공개 페이지(홈 + 문의/회사소개류 링크 몇 장)에서 메일 주소를
     긁는다. 주소마다 (페이지 URL, 주변 인용)을 붙인다 — BENCH_CONTACTS의 원칙: 출처 없는
     접점은 접점이 아니라 환각이다.
  2) 패턴: 수집된 개인형 주소의 모양({f}{last}@, {first}.{last}@ …)을 세고, 사람 이름이
     주어지면 관측된 패턴 순서로 후보를 만든다. 후보는 언제나 method="pattern"으로 표시 —
     수집된 사실과 추측을 섞지 않는다.
  3) 검증: MX 조회(dnspython). CONTACTS_SMTP_CHECK=1일 때만 SMTP RCPT 확인을 더한다
     (주거망은 25번이 막혀 있는 일이 많고, 캐치올 도메인은 전부 받으므로 무작위 주소로
     캐치올을 먼저 가려낸다). 확인 못 하면 못 했다고 말한다(unknown) — 조용한 단정 없음.

바깥 요청은 전부 netguard(SSRF 가드) 클라이언트로 나간다. 시험은 client를 주입한다.
"""
import os
import re
import secrets
import smtplib
import socket
from collections import Counter
from urllib.parse import urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup

from ..errors import EngineError
from ..ingest import netguard

MAX_PAGES = 6
MAX_BYTES = 2 * 1024 * 1024
TIMEOUT = float(os.environ.get("CONTACTS_FETCH_TIMEOUT", "10"))

EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
# 난독화 표기 — "name [at] corp [dot] com" 류. 과하게 풀지 않는다(두 가지 흔한 모양만).
OBFUSCATED = re.compile(
    r"([A-Za-z0-9._%+\-]+)\s*[\[(（{]\s*(?:at|골뱅이)\s*[\])）}]\s*([A-Za-z0-9.\-]+)"
    r"\s*(?:[\[(（{]\s*(?:dot|닷)\s*[\])）}]\s*([A-Za-z]{2,}))?", re.I)
CONTACT_HINT = re.compile(r"contact|about|company|support|recruit|press|inquiry|"
                          r"문의|연락|상담|회사소개|회사 소개|소개|오시는|고객센터|제휴", re.I)
GENERIC_LOCAL = re.compile(r"^(info|contact|hello|sales|support|admin|office|master|webmaster|"
                           r"help|cs|pr|hr|biz|business|partner|marketing|service|mail|post)[0-9]*$", re.I)
# 긁어도 의미 없는 주소 — 예시·플랫폼 잡음
NOISE_DOMAIN = re.compile(r"(example\.(com|org|net)|sentry|wixpress|googlemail|@[0-9.]+$)", re.I)
IMAGEY = re.compile(r"\.(png|jpe?g|gif|svg|webp)$", re.I)


def _norm_base(domain: str) -> str:
    d = domain.strip().lower()
    if not d:
        raise EngineError(400, "invalid_input", "domain이 비었습니다")
    if not d.startswith(("http://", "https://")):
        d = f"https://{d}"
    parts = urlsplit(d)
    if not parts.hostname or "." not in parts.hostname:
        raise EngineError(400, "invalid_input", f"도메인 모양이 아닙니다: {domain}")
    return f"{parts.scheme}://{parts.netloc}"


def _root_domain(host: str) -> str:
    bits = host.lower().removeprefix("www.").split(":")[0].split(".")
    return ".".join(bits[-2:]) if len(bits) >= 2 else host.lower()


def _quote(text: str, pos: int, needle: str, width: int = 60) -> str:
    s = max(0, pos - width)
    return " ".join(text[s:pos + len(needle) + width].split())


def _emails_in(html: str, page_url: str) -> list[dict]:
    out = []
    for m in EMAIL.finditer(html):
        addr = m.group(0).strip(".")
        if NOISE_DOMAIN.search(addr) or IMAGEY.search(addr):
            continue
        out.append({"address": addr.lower(), "url": page_url, "quote": _quote(html, m.start(), addr)})
    for m in OBFUSCATED.finditer(html):
        local, dom, tld = m.group(1), m.group(2), m.group(3)
        addr = f"{local}@{dom}" + (f".{tld}" if tld and not dom.endswith(f".{tld}") else "")
        if "." not in addr.split("@")[1]:
            continue
        out.append({"address": addr.lower(), "url": page_url,
                    "quote": _quote(html, m.start(), m.group(0)), "obfuscated": True})
    return out


def _links(html: str, base: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    seen, out = set(), []
    host = urlsplit(base).hostname
    for a in soup.find_all("a", href=True):
        label = f"{a.get_text(' ', strip=True)} {a['href']}"
        if not CONTACT_HINT.search(label):
            continue
        u = urljoin(base + "/", a["href"].split("#")[0])
        if urlsplit(u).hostname != host or u in seen or u.rstrip("/") == base:
            continue
        seen.add(u)
        out.append(u)
    return out


# ── 패턴 추론 ─────────────────────────────────────────────────────────
def _shape(local: str, first: str = "", last: str = "") -> "str | None":
    """관측된 개인형 주소의 모양 분류. first/last가 없으면 구분자 기반 추정만."""
    if first and last:
        f, l = first.lower(), last.lower()
        table = {f"{f}.{l}": "{first}.{last}", f"{f}{l}": "{first}{last}",
                 f"{f}_{l}": "{first}_{last}", f"{f[:1]}{l}": "{f}{last}",
                 f"{l}{f[:1]}": "{last}{f}", f"{f}": "{first}", f"{l}.{f}": "{last}.{first}",
                 f"{l}{f}": "{last}{first}"}
        return table.get(local.lower())
    if "." in local:
        return "{first}.{last}"
    if "_" in local:
        return "{first}_{last}"
    return None


def render_pattern(pattern: str, first: str, last: str) -> str:
    f, l = first.lower(), last.lower()
    return (pattern.replace("{first}", f).replace("{last}", l)
            .replace("{f}", f[:1]).replace("{l}", l[:1]))


# ── 검증 ─────────────────────────────────────────────────────────────
def _mx_hosts(domain: str) -> "list[str] | None":
    """MX 레코드 — dnspython이 없거나 조회가 막히면 None(모름)."""
    try:
        import dns.resolver
    except ImportError:
        return None
    try:
        answers = dns.resolver.resolve(domain, "MX", lifetime=5)
        return [str(r.exchange).rstrip(".") for r in
                sorted(answers, key=lambda r: r.preference)] or None
    except dns.resolver.NXDOMAIN:
        return []
    except Exception:  # noqa: BLE001 — 타임아웃·서버 불능은 '모름'
        return None


def _smtp_probe(mx: str, address: str, helo_domain: str) -> "bool | None":
    """RCPT TO 한 번 — 받는지(True)/거절(False)/연결 불가(None). 메일은 보내지 않는다."""
    try:
        with smtplib.SMTP(mx, 25, timeout=8, local_hostname=helo_domain) as s:
            s.mail("probe@" + helo_domain)
            code, _ = s.rcpt(address)
            return 200 <= code < 300
    except (OSError, smtplib.SMTPException, socket.timeout):
        return None


def verify(address: str, *, mx_cache: dict, smtp_check: bool, helo_domain: str = "a2a.local") -> dict:
    domain = address.split("@", 1)[1]
    if domain not in mx_cache:
        mx_cache[domain] = {"mx": _mx_hosts(domain), "catch_all": None}
    mx = mx_cache[domain]["mx"]
    if mx is None:
        return {"status": "unknown", "detail": "MX 조회 불가"}
    if not mx:
        return {"status": "no_mx", "detail": "메일 서버 없음"}
    if not smtp_check:
        return {"status": "mx_ok", "detail": f"MX {mx[0]}"}
    if mx_cache[domain]["catch_all"] is None:
        probe = _smtp_probe(mx[0], f"zz-{secrets.token_hex(6)}@{domain}", helo_domain)
        mx_cache[domain]["catch_all"] = probe            # True=캐치올, None=연결 불가
    ca = mx_cache[domain]["catch_all"]
    if ca is None:
        return {"status": "mx_ok", "detail": "SMTP 연결 불가(25번 차단?) — MX까지만"}
    if ca:
        return {"status": "smtp_catch_all", "detail": "도메인이 전부 수신 — 개별 확인 불가"}
    ok = _smtp_probe(mx[0], address, helo_domain)
    if ok is None:
        return {"status": "mx_ok", "detail": "SMTP 연결 불안정 — MX까지만"}
    return {"status": "smtp_ok" if ok else "smtp_rejected",
            "detail": "RCPT 수락" if ok else "RCPT 거절"}


# ── 본체 ─────────────────────────────────────────────────────────────
def discover(domain: str, person: "dict | None" = None, *,
             client: "httpx.Client | None" = None,
             smtp_check: "bool | None" = None,
             mx_lookup: bool = True,
             assume_root: "str | None" = None) -> dict:
    """assume_root: 시험용 — 가짜 서버(127.0.0.1)로 긁되 회사 도메인 판정은 이 값으로."""
    base = _norm_base(domain)
    root = assume_root or _root_domain(urlsplit(base).hostname)
    own = client is None
    client = client or netguard.make_client(
        TIMEOUT, headers={"User-Agent": "Mozilla/5.0 (Macintosh) A2A-Engine/0.1"})
    if smtp_check is None:
        smtp_check = os.environ.get("CONTACTS_SMTP_CHECK") == "1"

    pages, found, errors = [], [], []
    retried_www = False
    try:
        def crawl(start):
            queue, visited = [start], set()
            while queue and len(visited) < MAX_PAGES:
                url = queue.pop(0)
                if url in visited:
                    continue
                visited.add(url)
                try:
                    r = netguard.get(client, url, total_timeout=TIMEOUT * 2, max_bytes=MAX_BYTES)
                    r.raise_for_status()
                except httpx.HTTPError as e:
                    errors.append({"url": url, "error": str(e)[:160]})
                    continue
                html = r.text
                pages.append({"url": url, "bytes": len(html)})
                found.extend(_emails_in(html, url))
                if url == start:
                    queue += _links(html, start)[: MAX_PAGES - 1]

        crawl(base)
        # 흔한 실패: 인증서가 www에만 걸려 apex가 죽는 사이트(실측: mysc.co.kr) — www로 한 번 더
        host = urlsplit(base).hostname
        if not pages and not host.startswith("www."):
            retried_www = True
            base = f"{urlsplit(base).scheme}://www.{urlsplit(base).netloc}"
            crawl(base)
    finally:
        if own:
            client.close()

    # 주소별로 출처를 모은다 — 같은 도메인 주소를 앞세우고, 밖의 주소(그룹웨어·대행사)는 뒤로
    by_addr: dict[str, dict] = {}
    for f in found:
        e = by_addr.setdefault(f["address"], {
            "address": f["address"], "method": "found",
            "same_domain": _root_domain(f["address"].split("@", 1)[1]) == root,
            "generic": bool(GENERIC_LOCAL.match(f["address"].split("@", 1)[0])),
            "sources": []})
        if len(e["sources"]) < 3:
            e["sources"].append({"url": f["url"], "quote": f["quote"][:200]})

    # 관측된 개인형 주소의 모양 통계 (같은 도메인·비일반 주소만)
    shapes = Counter()
    for e in by_addr.values():
        if e["same_domain"] and not e["generic"]:
            s = _shape(e["address"].split("@", 1)[0])
            if s:
                shapes[s] += 1
    patterns = [{"pattern": p, "seen": n} for p, n in shapes.most_common()]

    results = sorted(by_addr.values(),
                     key=lambda e: (not e["same_domain"], e["generic"], e["address"]))

    # 사람 이름이 있으면: 관측된 패턴(없으면 흔한 순서)으로 후보 생성 — 추측임을 표시
    if person and person.get("first") and person.get("last"):
        order = [p["pattern"] for p in patterns] or \
            ["{first}.{last}", "{f}{last}", "{first}", "{first}{last}", "{first}_{last}"]
        known = set(by_addr)
        for p in order[:5]:
            addr = f"{render_pattern(p, person['first'], person['last'])}@{root}"
            if addr not in known:
                results.append({"address": addr, "method": "pattern", "pattern": p,
                                "same_domain": True, "generic": False, "sources": []})
                known.add(addr)

    mx_cache: dict = {}
    for e in results:
        e["verify"] = (verify(e["address"], mx_cache=mx_cache, smtp_check=smtp_check)
                       if mx_lookup else {"status": "unchecked", "detail": "조회 생략"})

    return {"domain": root, "base": base, "pages": pages, "errors": errors,
            "retried_www": retried_www,
            "emails": results, "patterns": patterns,
            "smtp_check": smtp_check,
            "note": "found=페이지에서 실제로 본 주소(출처 포함) · pattern=이름+패턴 추측 — 섞지 말 것"}
