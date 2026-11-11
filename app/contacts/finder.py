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

공식 채널(2026-11-10 추가, Sherlock 방식의 축소판 — 사이트 표는 직접 만들었다): 회사 계정만 다룬다.
개인 아이디 추적은 하지 않는다. 길은 둘이고 역시 섞지 않는다:
  linked    = 회사 홈페이지가 직접 링크한 계정(출처 = 그 페이지).
  same_name = 도메인 이름·링크된 계정 이름과 같은 계정이 그 사이트에 있음(상태 코드로 확인).
              계정 페이지에 회사 도메인이 적혀 있으면 mentions_domain(그 대목이 출처). 아니면
              이름만 같은 것이라 이 회사 것이라는 보장이 없다 — 화면도 그렇게 말한다. 없는 계정에 404를 주는
              사이트만 찔러 본다(실측 2026-11-10). 인스타그램·페이스북·링크드인은 없는 계정에도
              200을 줘서 찔러 보지 않는다.

바깥 요청은 전부 netguard(SSRF 가드) 클라이언트로 나간다. 시험은 client를 주입한다.
"""
import os
import re
import secrets
import smtplib
import socket
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup

from ..errors import EngineError
from ..ingest import netguard

MAX_PAGES = 12
DEADLINE = float(os.environ.get("CONTACTS_DEADLINE", "45"))      # 요청 하나가 쓰는 전체 시간 상한(초)
MAX_BYTES = 2 * 1024 * 1024
TIMEOUT = float(os.environ.get("CONTACTS_FETCH_TIMEOUT", "10"))

EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
# 난독화 표기 — "name [at] corp [dot] com" 류. 과하게 풀지 않는다(두 가지 흔한 모양만).
OBFUSCATED = re.compile(
    r"([A-Za-z0-9._%+\-]+)\s*[\[(（{]\s*(?:at|골뱅이)\s*[\])）}]\s*([A-Za-z0-9.\-]+)"
    r"\s*(?:[\[(（{]\s*(?:dot|닷)\s*[\])）}]\s*([A-Za-z]{2,}))?", re.I)
# 링크 우선순위 — 연락처가 있을 법한 순서. 0점 링크는 따라가지 않는다.
_HINTS = [(3, re.compile(r"contact|inquiry|enquir|partner|문의|연락|상담|제휴|협력|오시는", re.I)),
          (2, re.compile(r"about|company|team|people|member|consult|회사|소개|구성원|조직|컨설팅", re.I)),
          (1, re.compile(r"press|news|media|recruit|career|service|support|business|"
                         r"보도|뉴스|채용|서비스|사업|고객센터", re.I))]
SKIP_FILE = re.compile(r"\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|css|js|ico|xml)(\?|$)", re.I)
# 자바스크립트로 그리는 사이트는 <a>가 없다 — 페이지 데이터(JSON) 속 내부 경로에서 줍는다(실측: anthropic.com)
EMBEDDED_PATH = re.compile(r"""[\"'](/[A-Za-z0-9_\-/]{2,80})\\?[\"']""")
# 링크를 하나도 못 줍는 사이트용 — 없으면 조용히 넘어간다(실패로 세지 않는다)
GUESS_PATHS = ["/contact", "/contact-us", "/about", "/company", "/team", "/partners", "/inquiry"]
GENERIC_LOCAL = re.compile(r"^(info|contact|hello|sales|support|admin|office|master|webmaster|"
                           r"help|cs|pr|hr|biz|business|partner|marketing|service|mail|post)[0-9]*$", re.I)
# 긁어도 의미 없는 주소 — 예시·플랫폼 잡음
NOISE_DOMAIN = re.compile(r"(example\.(com|org|net)|sentry|wixpress|googlemail|@[0-9.]+$|"
                          r"@(your)?domain\.|@email\.com$|@test\.|@company\.com$)", re.I)
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


# 국가 도메인의 2단계 공개 접미사(co.kr·or.jp·com.vn …) — 여기를 놓치면 등록 도메인이 'co.kr'로 잘린다
_SECOND_LEVEL = {"co", "or", "ne", "re", "go", "ac", "pe", "ed", "com", "org", "net", "edu", "gov"}


def _root_domain(host: str) -> str:
    bits = host.lower().removeprefix("www.").split(":")[0].split(".")
    if len(bits) >= 3 and len(bits[-1]) == 2 and bits[-2] in _SECOND_LEVEL:
        return ".".join(bits[-3:])
    return ".".join(bits[-2:]) if len(bits) >= 2 else host.lower()


def _quote(text: str, pos: int, needle: str, width: int = 60) -> str:
    s = max(0, pos - width)
    return " ".join(text[s:pos + len(needle) + width].split())


_TAGS = re.compile(r"<[^>]*>|^[^<>]*>|<[^<>]*$")


def _emails_in(html: str, page_url: str) -> list[dict]:
    # 인용은 사람이 페이지에서 보는 글로 — 원문 HTML을 그대로 자르면 태그·스타일 조각이 출처로 나온다
    text = BeautifulSoup(html, "html.parser").get_text(" ", strip=True)
    low = text.lower()

    def quote(pos: int, needle: str) -> str:
        at = low.find(needle.lower())
        if at >= 0:
            return _quote(text, at, needle)
        # 글에는 없고 속성(mailto 등)에만 있는 주소 — 주변 원문에서 태그를 걷어 낸다
        near = " ".join(_TAGS.sub(" ", _quote(html, pos, needle)).split())
        return near if needle.lower() in near.lower() else f"{needle} (링크 주소) {near}".strip()

    out = []
    for m in EMAIL.finditer(html):
        addr = m.group(0).strip(".")
        if NOISE_DOMAIN.search(addr) or IMAGEY.search(addr):
            continue
        out.append({"address": addr.lower(), "url": page_url, "quote": quote(m.start(), addr)})
    for m in OBFUSCATED.finditer(html):
        local, dom, tld = m.group(1), m.group(2), m.group(3)
        addr = f"{local}@{dom}" + (f".{tld}" if tld and not dom.endswith(f".{tld}") else "")
        if "." not in addr.split("@")[1]:
            continue
        out.append({"address": addr.lower(), "url": page_url,
                    "quote": quote(m.start(), m.group(0)), "obfuscated": True})
    return out


# ── 공식 채널 ─────────────────────────────────────────────────────────
# (키, 이름, 호스트, 계정 경로, 같은 이름 확인용 주소 또는 None)
CHANNELS = [
    ("linkedin", "링크드인", r"(^|\.)linkedin\.com$", r"^/((?:company|school|showcase)/[^/?#]+)", None),
    ("instagram", "인스타그램", r"(^|\.)instagram\.com$", r"^/([A-Za-z0-9_.]+)/?$", None),
    ("facebook", "페이스북", r"(^|\.)(facebook|fb)\.com$", r"^/([A-Za-z0-9.\-]+)/?$", None),
    ("youtube", "유튜브", r"(^|\.)youtube\.com$", r"^/(@[^/?#]+|(?:channel|c|user)/[^/?#]+)", "https://www.youtube.com/@{}"),
    ("x", "X", r"(^|\.)(x|twitter)\.com$", r"^/([A-Za-z0-9_]{1,15})/?$", "https://x.com/{}"),
    ("naverblog", "네이버 블로그", r"^(m\.)?blog\.naver\.com$", r"^/([A-Za-z0-9_\-]+)/?$", "https://blog.naver.com/{}"),
    ("tistory", "티스토리", r"^([a-z0-9\-]+)\.tistory\.com$", None, "https://{}.tistory.com/"),
    ("brunch", "브런치", r"^brunch\.co\.kr$", r"^/(@[^/?#]+)", "https://brunch.co.kr/@{}"),
    ("github", "깃허브", r"^github\.com$", r"^/([A-Za-z0-9\-]+)/?$", "https://github.com/{}"),
    ("huggingface", "허깅페이스", r"^huggingface\.co$", r"^/([A-Za-z0-9\-_.]+)/?$", "https://huggingface.co/{}"),
    ("kakao", "카카오톡 채널", r"^pf\.kakao\.com$", r"^/(_[A-Za-z0-9]+)", None),
    ("threads", "스레드", r"(^|\.)threads\.(net|com)$", r"^/(@[^/?#]+)", None),
    ("tiktok", "틱톡", r"(^|\.)tiktok\.com$", r"^/(@[^/?#]+)", None),
    ("medium", "미디엄", r"^medium\.com$", r"^/(@[^/?#]+)", None),
    ("telegram", "텔레그램", r"^t\.me$", r"^/([A-Za-z0-9_]{4,})/?$", None),
]
CHANNELS = [(k, n, re.compile(h, re.I), re.compile(p) if p else None, t) for k, n, h, p, t in CHANNELS]
# 계정이 아니라 사이트 기능인 경로 — 공유 버튼·로그인 따위
NOT_A_HANDLE = {"share", "sharer", "sharer.php", "intent", "home", "login", "signup", "explore", "search",
                "hashtag", "p", "reel", "watch", "about", "features", "pricing", "policies", "privacy",
                "terms", "help", "i", "tr", "dialog", "plugins", "docs", "join", "models", "datasets",
                "spaces", "blog", "www", "notice", "profile.php", "tos", "legal", "settings", "topics"}
HANDLE_OK = re.compile(r"^[a-z0-9][a-z0-9_\-]{2,29}$")
PROBE_BUDGET = 4.0          # 같은 이름 확인 전체에 쓰는 시간 상한(초)


def _channels_in(html: str, page_url: str) -> list[dict]:
    """페이지가 링크한 회사 계정들 — 출처는 그 페이지와 링크 글자."""
    out = []
    for a in BeautifulSoup(html, "html.parser").find_all("a", href=True):
        parts = urlsplit(a["href"].strip())
        host = (parts.hostname or "").lower().removeprefix("www.")
        if parts.scheme not in ("http", "https") or not host:
            continue
        for key, name, host_rx, path_rx, _ in CHANNELS:
            hm = host_rx.search(host)
            if not hm:
                continue
            m = path_rx.search(parts.path) if path_rx else hm
            handle = m.group(1) if m else ""
            if handle and handle.lower() not in NOT_A_HANDLE:
                label = a.get_text(" ", strip=True) or a.get("aria-label") or a.get("title") or ""
                path = m.group(0).rstrip("/") if path_rx else ""
                out.append({"key": key, "site": name, "handle": handle, "method": "linked",
                            "url": f"https://{parts.hostname}{path}",
                            "sources": [{"url": page_url, "quote": label[:200]}]})
            break
    return out


def _account_page(client: httpx.Client, url: str, root: str, name: str = "") -> "dict | None":
    """그 주소에 계정이 있으면 {url, quote} — quote는 계정 페이지가 회사 도메인을 적은 대목(없으면 "").

    없거나(404) 모르면(차단·시간 초과) None. 모르는 것을 있다고 하지 않는다.
    """
    try:
        r = netguard.get(client, url, total_timeout=PROBE_BUDGET, max_bytes=MAX_BYTES)
    except httpx.HTTPError:
        return None
    # 없는 계정을 로그인·첫 화면으로 돌려보내는 사이트가 있다 — 끝난 주소에 그 이름이 남아 있어야 계정이다
    if r.status_code != 200 or name.lower() not in str(r.url).lower():
        return None
    at = r.text.lower().find(root)
    # 계정 페이지 원문은 스크립트·속성투성이라 인용하지 않는다 — 무엇을 확인했는지만 적는다
    quote = f"계정 페이지에 {root} 주소가 적혀 있음" if at >= 0 else ""
    return {"url": str(r.url), "quote": quote[:200]}


def _same_name_channels(client, names: "list[str]", have: "set[str]", root: str, budget: float) -> list[dict]:
    """홈페이지가 링크하지 않은 사이트에서 같은 이름의 계정을 찾는다 — 사이트마다 앞선 이름이 먼저.

    계정 페이지에 회사 도메인이 적혀 있으면 mentions_domain=True(그 대목이 출처) — 이름만 같은 것과 구분한다.
    """
    jobs = [(key, site, n, tmpl.format(n)) for key, site, _, _, tmpl in CHANNELS
            if tmpl and key not in have for n in names]
    if not jobs or budget <= 0:
        return []
    pool = ThreadPoolExecutor(max_workers=8)
    futures = [pool.submit(_account_page, client, url, root, name) for _, _, name, url in jobs]
    t_end = time.monotonic() + budget
    out, seen = [], set()
    for (key, site, name, url), fut in zip(jobs, futures):
        try:
            page = fut.result(timeout=max(0.0, t_end - time.monotonic()))
        except Exception:  # noqa: BLE001 — 시간 안에 못 본 것은 '모름' — 결과에 올리지 않는다
            page = None
        if page and key not in seen:
            seen.add(key)
            out.append({"key": key, "site": site, "handle": name, "method": "same_name",
                        "url": page["url"].rstrip("/"), "mentions_domain": bool(page["quote"]),
                        "sources": [{"url": page["url"], "quote": page["quote"]}] if page["quote"] else []})
    pool.shutdown(wait=False, cancel_futures=True)
    return sorted(out, key=lambda c: not c["mentions_domain"])


def _score(label: str) -> int:
    return next((n for n, rx in _HINTS if rx.search(label)), 0)


def _links(html: str, base: str) -> list[str]:
    """같은 회사(등록 도메인)의 연락처 후보 링크를 우선순위 순으로."""
    soup = BeautifulSoup(html, "html.parser")
    root = _root_domain(urlsplit(base).hostname)
    scored: dict[str, int] = {}

    def offer(u: str, label: str):
        u = u.split("#")[0]
        h = urlsplit(u).hostname
        if not h or _root_domain(h) != root or SKIP_FILE.search(u) or u.rstrip("/") == base.rstrip("/"):
            return
        n = _score(label)
        if n:
            scored[u] = max(n, scored.get(u, 0))

    for a in soup.find_all("a", href=True):
        offer(urljoin(base + "/", a["href"]), f"{a.get_text(' ', strip=True)} {a['href']}")
    for m in EMBEDDED_PATH.finditer(html):
        offer(urljoin(base + "/", m.group(1)), m.group(1))
    return sorted(scored, key=lambda u: (-scored[u], len(u)))


LOC = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.I)


def _sitemap_urls(fetch, base: str, extra: "list[str]") -> list[str]:
    """sitemap.xml(+색인의 하위 몇 개)에서 연락처 후보 — 메뉴에 없는 페이지를 찾는 길."""
    root = _root_domain(urlsplit(base).hostname)
    todo, out = [*extra, f"{base}/sitemap.xml"], []
    for _ in range(4):
        if not todo:
            break
        r = fetch(todo.pop(0))
        if r is None:
            continue
        for loc in LOC.findall(r.text):
            if loc.lower().split("?")[0].endswith(".xml"):
                todo.append(loc)
            elif urlsplit(loc).hostname and _root_domain(urlsplit(loc).hostname) == root and _score(loc):
                out.append(loc)
    return sorted(set(out), key=lambda u: (-_score(u), len(u)))


def _robots(fetch, base: str) -> "tuple[RobotFileParser | None, list[str]]":
    r = fetch(f"{base}/robots.txt")
    if r is None:
        return None, []
    rp = RobotFileParser()
    lines = r.text.splitlines()
    rp.parse(lines)
    return rp, [ln.split(":", 1)[1].strip() for ln in lines if ln.lower().startswith("sitemap:")]


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


def _entry(hit: dict, root: str, sources: bool = True) -> dict:
    """페이지에서 본 주소 하나의 결과 모양 — 진행 알림과 최종 결과가 같은 모양을 쓴다."""
    local, dom = hit["address"].split("@", 1)
    return {"address": hit["address"], "method": "found",
            "same_domain": _root_domain(dom) == root,
            "generic": bool(GENERIC_LOCAL.match(local)),
            "sources": [{"url": hit["url"], "quote": hit["quote"][:200]}] if sources else []}


# ── 본체 ─────────────────────────────────────────────────────────────
def discover(domain: str, person: "dict | None" = None, *,
             client: "httpx.Client | None" = None,
             smtp_check: "bool | None" = None,
             mx_lookup: bool = True,
             assume_root: "str | None" = None,
             probe_channels: "bool | None" = None,
             on_event=None) -> dict:
    """assume_root: 시험용 — 가짜 서버(127.0.0.1)로 긁되 회사 도메인 판정은 이 값으로.

    probe_channels: 같은 이름 계정 확인(바깥 사이트 요청). 기본은 실제 경로(자기 클라이언트)에서만.

    on_event(dict): 진행을 한 걸음씩 알린다 — 읽은 페이지(page), 새로 본 주소(email),
    링크된 계정(channel), 단계(step). 화면이 끝까지 기다리지 않고 찾는 대로 보여 주게 하려는 것. 결과는 그대로 반환한다.
    """
    emit = on_event or (lambda ev: None)
    base = _norm_base(domain)
    root = assume_root or _root_domain(urlsplit(base).hostname)
    own = client is None
    client = client or netguard.make_client(
        TIMEOUT, headers={"User-Agent": "Mozilla/5.0 (Macintosh) A2A-Engine/0.1"})
    if smtp_check is None:
        smtp_check = os.environ.get("CONTACTS_SMTP_CHECK") == "1"
    if probe_channels is None:
        probe_channels = own

    pages, found, errors = [], [], []
    announced: set[str] = set()
    channels: dict[tuple, dict] = {}

    def took(url, html):
        """페이지 하나를 읽었다 — 기록하고, 처음 보는 주소는 바로 알린다."""
        pages.append({"url": url, "bytes": len(html)})
        hits = _emails_in(html, url)
        found.extend(hits)
        emit({"type": "page", "url": url, "pages": len(pages)})
        for h in hits:
            if h["address"] not in announced:
                announced.add(h["address"])
                emit({"type": "email", "email": _entry(h, root)})
        for ch in _channels_in(html, url):
            k = (ch["key"], ch["handle"].lower())
            if k not in channels:
                channels[k] = ch
                emit({"type": "channel", "channel": ch})
    retried_www = False
    skipped_robots = 0
    t_end = time.monotonic() + DEADLINE

    def fetch(url, record=False):
        """응답 또는 None. record=True인 것(실제 링크)만 실패로 센다 — 찍어 본 경로의 404는 실패가 아니다."""
        if time.monotonic() > t_end:
            return None
        try:
            r = netguard.get(client, url, total_timeout=TIMEOUT * 2, max_bytes=MAX_BYTES)
            r.raise_for_status()
            return r
        except httpx.HTTPError as e:
            if record:
                errors.append({"url": url, "error": str(e)[:160]})
            return None

    def crawl(start):
        nonlocal skipped_robots
        home = fetch(start, record=True)
        if home is None:
            return
        rp, maps = _robots(fetch, start)
        visited = {start, str(home.url).rstrip("/")}
        took(start, home.text)
        queue = _links(home.text, str(home.url).rstrip("/"))
        queue += [u for u in _sitemap_urls(fetch, start, maps) if u not in queue]
        guesses = [f"{start}{p}" for p in GUESS_PATHS]
        while (queue or guesses) and len(pages) < MAX_PAGES and time.monotonic() < t_end:
            guess = not queue
            url = guesses.pop(0) if guess else queue.pop(0)
            if url.rstrip("/") in visited:
                continue
            visited.add(url.rstrip("/"))
            if rp is not None and not rp.can_fetch("A2A-Engine", url):
                skipped_robots += 1
                continue
            r = fetch(url, record=not guess)
            if r is None:
                continue
            final = str(r.url).rstrip("/")
            if final in visited and final != url.rstrip("/"):      # 홈으로 되돌아온 리다이렉트
                continue
            visited.add(final)
            took(url, r.text)
            queue += [u for u in _links(r.text, final) if u not in queue and u.rstrip("/") not in visited]

    try:
        crawl(base)
        # 흔한 실패: 인증서가 www에만 걸려 apex가 죽는 사이트(실측: mysc.co.kr) — www로 한 번 더
        host = urlsplit(base).hostname
        if not pages and not host.startswith("www."):
            retried_www = True
            base = f"{urlsplit(base).scheme}://www.{urlsplit(base).netloc}"
            crawl(base)
        if probe_channels and pages:
            # 찔러 볼 이름: 도메인 이름 먼저, 그다음 홈페이지가 링크한 계정 이름(둘까지)
            names = [root.split(".")[0]] + [c["handle"].lstrip("@").lower() for c in channels.values()]
            names = list(dict.fromkeys(n for n in names if HANDLE_OK.match(n)))[:2]
            if names:
                emit({"type": "step", "text": "같은 이름의 계정이 있는지 확인하는 중…"})
            for ch in _same_name_channels(client, names, {k for k, _ in channels}, root,
                                          min(PROBE_BUDGET, t_end - time.monotonic())):
                channels[(ch["key"], ch["handle"])] = ch
                emit({"type": "channel", "channel": ch})
    finally:
        if own:
            client.close()

    # 주소별로 출처를 모은다 — 같은 도메인 주소를 앞세우고, 밖의 주소(그룹웨어·대행사)는 뒤로
    by_addr: dict[str, dict] = {}
    for f in found:
        e = by_addr.setdefault(f["address"], _entry(f, root, sources=False))
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

    if results:
        emit({"type": "step", "text": f"주소 {len(results)}개의 메일 서버를 확인하는 중…"})
    mx_cache: dict = {}
    for e in results:
        e["verify"] = (verify(e["address"], mx_cache=mx_cache, smtp_check=smtp_check)
                       if mx_lookup else {"status": "unchecked", "detail": "조회 생략"})

    return {"domain": root, "base": base, "pages": pages, "errors": errors,
            "retried_www": retried_www, "skipped_robots": skipped_robots,
            "emails": results, "patterns": patterns, "channels": list(channels.values()),
            "smtp_check": smtp_check,
            "note": "found=페이지에서 실제로 본 주소(출처 포함) · pattern=이름+패턴 추측 — 섞지 말 것 · "
                    "채널: linked=홈페이지가 링크한 계정 · same_name=이름만 같은 계정(이 회사 것인지 미확인)"}
