"""해상 컨테이너 운임 — 공개 지수에서 직접 읽는다(구독·키 없음, 2026-11-11).

출처는 하나다: 한국해양진흥공사(KOBC)의 KCCI(부산 출발 컨테이너 운임지수). 매주 월요일
공표, 구간(항로)별 값의 단위는 USD/FEU(40피트 한 대), 종합지수(KCCI)만 pt다. 공공데이터포털이
"이용허락범위 제한 없음"으로 올려 둔 자료이고 robots.txt도 막지 않는다. 조사한 다른 곳
(SURFF·Drewry·Freightos·선사 API)은 약관이 재사용을 막거나 계정이 필요해 붙이지 않았다.

지키는 것(접점 찾기와 같은 원칙):
  - 숫자마다 출처·기준일을 붙인다. 가져온 시각도 남긴다.
  - 이것은 지수(여러 선사 시세의 구간 평균)다. 견적이 아니다 — kind="index"로만 내보내고
    견적처럼 보이게 가공하지 않는다(부대비용·내륙 운송·통관을 더해 '총액'을 지어내지 않는다).
  - 모르면 모른다고 한다: 부산 출발이 아니면, 구간을 못 정하면, 20피트·냉동·LCL이면
    그 값은 이 출처에 없다고 돌려준다. 40피트 값을 반으로 나누는 식의 추정은 하지 않는다.

구간 대응표(나라 → KCCI 항로)는 우리가 만들었다. KOBC가 항로별 항구 목록을 표로 주지 않아
나라 단위로만 맞추고, 한 나라가 두 항로에 걸치면(미국 동·서안 등) 후보를 모두 돌려준다.

바깥 요청은 netguard(SSRF 가드) 클라이언트로 나간다. 시험은 client를 주입한다.
"""
import re
import threading
import time
from datetime import date, datetime, timedelta, timezone

import httpx

from ..errors import EngineError
from ..ingest import netguard

PAGE = "https://kobc.or.kr/ebz/shippinginfo/timeseries/gridList.do?mId=0304000000"
SOURCE = {
    "name": "KCCI (KOBC Container Composite Index)",
    "publisher": "한국해양진흥공사",
    "url": PAGE,
    "license": "공공데이터포털 '이용허락범위 제한 없음' (data.go.kr/data/15131881)",
    "cadence": "매주 월요일 공표",
}
UNIT = "USD/FEU"
WEEKS = 13                      # 범위·추이를 보여 줄 기본 기간
MAX_WEEKS = 156                 # KCCI는 2022-11부터 — 3년이면 거의 전부
TIMEOUT = 15.0
CACHE_TTL = 30 * 60             # 주 1회 바뀌는 표 — 같은 표를 계속 치지 않는다
STALE_DAYS = 14

# 항로 — 코드와 영문 이름은 KOBC 표 그대로, 한글 이름은 우리가 붙였다
LANES = {
    "KUWI": ("USWC", "북미 서안"), "KUEI": ("USEC", "북미 동안"),
    "KNEI": ("Europe", "북유럽"), "KMDI": ("Mediterranean", "지중해"),
    "KMEI": ("Middle East", "중동"), "KAUI": ("Australia", "호주"),
    "KLEI": ("Latin America East Coast", "중남미 동안"), "KLWI": ("Latin America West Coast", "중남미 서안"),
    "KSAI": ("South Africa", "남아프리카"), "KWAI": ("West Africa", "서아프리카"),
    "KCI": ("China", "중국"), "KJI": ("Japan", "일본"), "KSEI": ("South East Asia", "동남아"),
}
# 나라(ISO 3166-1 alpha-2) → 항로 후보. 둘 이상이면 항구로 좁혀야 한다.
COUNTRY_LANES = {
    "US": ["KUWI", "KUEI"], "CA": ["KUWI", "KUEI"],
    "DE": ["KNEI"], "NL": ["KNEI"], "BE": ["KNEI"], "GB": ["KNEI"], "PL": ["KNEI"], "DK": ["KNEI"],
    "SE": ["KNEI"], "NO": ["KNEI"], "FI": ["KNEI"], "IE": ["KNEI"], "PT": ["KNEI"],
    "FR": ["KNEI", "KMDI"], "ES": ["KMDI", "KNEI"],
    "IT": ["KMDI"], "GR": ["KMDI"], "TR": ["KMDI"], "HR": ["KMDI"], "SI": ["KMDI"], "MT": ["KMDI"],
    "CY": ["KMDI"], "IL": ["KMDI"], "LB": ["KMDI"], "TN": ["KMDI"], "DZ": ["KMDI"],
    "EG": ["KMDI", "KMEI"], "MA": ["KMDI", "KWAI"],
    "AE": ["KMEI"], "SA": ["KMEI"], "QA": ["KMEI"], "KW": ["KMEI"], "OM": ["KMEI"], "BH": ["KMEI"],
    "IQ": ["KMEI"], "JO": ["KMEI"],
    "AU": ["KAUI"],
    "BR": ["KLEI"], "AR": ["KLEI"], "UY": ["KLEI"],
    "CL": ["KLWI"], "PE": ["KLWI"], "EC": ["KLWI"], "MX": ["KLWI", "KLEI"], "CO": ["KLWI", "KLEI"],
    "ZA": ["KSAI"],
    "NG": ["KWAI"], "GH": ["KWAI"], "CI": ["KWAI"], "SN": ["KWAI"], "TG": ["KWAI"],
    "CN": ["KCI"], "JP": ["KJI"],
    "VN": ["KSEI"], "TH": ["KSEI"], "SG": ["KSEI"], "MY": ["KSEI"], "ID": ["KSEI"], "PH": ["KSEI"],
}
# 항구(UN/LOCODE) → 항로. 나라만으로 갈리는 곳을 좁힌다.
PORT_LANE = {
    "USLAX": "KUWI", "USLGB": "KUWI", "USOAK": "KUWI", "USSEA": "KUWI", "USTIW": "KUWI", "CAVAN": "KUWI",
    "USNYC": "KUEI", "USSAV": "KUEI", "USCHS": "KUEI", "USORF": "KUEI", "USHOU": "KUEI", "USMIA": "KUEI",
    "USBAL": "KUEI", "CAHAL": "KUEI", "CAMTR": "KUEI",
    "FRLEH": "KNEI", "FRFOS": "KMDI", "FRMRS": "KMDI", "ESBCN": "KMDI", "ESVLC": "KMDI", "ESALG": "KMDI",
    "ESBIO": "KNEI", "EGALY": "KMDI", "EGPSD": "KMDI", "MXZLO": "KLWI", "MXLZC": "KLWI", "MXVER": "KLEI",
    "MXATM": "KLEI", "COBUN": "KLWI", "COCTG": "KLEI",
}
# 이름 → 나라 코드 또는 항구 코드. 에이전트는 코드를 주는 게 원칙이고, 사람이 화면에 쓰는 흔한 이름만 받는다.
NAMES = {
    "한국": "KR", "대한민국": "KR", "korea": "KR", "southkorea": "KR", "부산": "KRPUS", "busan": "KRPUS",
    "pusan": "KRPUS", "인천": "KRINC", "incheon": "KRINC", "광양": "KRKAN", "gwangyang": "KRKAN",
    "이탈리아": "IT", "이태리": "IT", "italy": "IT", "제노바": "ITGOA", "genoa": "ITGOA", "genova": "ITGOA",
    "라스페치아": "ITSPE", "laspezia": "ITSPE", "나폴리": "ITNAP", "naples": "ITNAP",
    "스페인": "ES", "spain": "ES", "바르셀로나": "ESBCN", "barcelona": "ESBCN", "발렌시아": "ESVLC", "valencia": "ESVLC",
    "그리스": "GR", "greece": "GR", "튀르키예": "TR", "터키": "TR", "turkey": "TR", "turkiye": "TR",
    "프랑스": "FR", "france": "FR", "르아브르": "FRLEH", "lehavre": "FRLEH", "마르세유": "FRMRS", "marseille": "FRMRS",
    "독일": "DE", "germany": "DE", "함부르크": "DEHAM", "hamburg": "DEHAM",
    "네덜란드": "NL", "netherlands": "NL", "로테르담": "NLRTM", "rotterdam": "NLRTM",
    "벨기에": "BE", "belgium": "BE", "앤트워프": "BEANR", "antwerp": "BEANR",
    "영국": "GB", "uk": "GB", "unitedkingdom": "GB", "폴란드": "PL", "poland": "PL",
    "미국": "US", "usa": "US", "unitedstates": "US", "로스앤젤레스": "USLAX", "la": "USLAX", "losangeles": "USLAX",
    "롱비치": "USLGB", "longbeach": "USLGB", "뉴욕": "USNYC", "newyork": "USNYC", "서배너": "USSAV", "savannah": "USSAV",
    "캐나다": "CA", "canada": "CA", "밴쿠버": "CAVAN", "vancouver": "CAVAN",
    "아랍에미리트": "AE", "uae": "AE", "두바이": "AEJEA", "dubai": "AEJEA", "사우디": "SA", "사우디아라비아": "SA", "saudiarabia": "SA",
    "호주": "AU", "australia": "AU", "시드니": "AUSYD", "sydney": "AUSYD",
    "브라질": "BR", "brazil": "BR", "아르헨티나": "AR", "argentina": "AR", "칠레": "CL", "chile": "CL",
    "페루": "PE", "peru": "PE", "멕시코": "MX", "mexico": "MX",
    "남아공": "ZA", "남아프리카공화국": "ZA", "southafrica": "ZA", "나이지리아": "NG", "nigeria": "NG", "가나": "GH", "ghana": "GH",
    "중국": "CN", "china": "CN", "상하이": "CNSHA", "shanghai": "CNSHA", "일본": "JP", "japan": "JP",
    "베트남": "VN", "vietnam": "VN", "태국": "TH", "thailand": "TH", "싱가포르": "SG", "singapore": "SG",
    "말레이시아": "MY", "malaysia": "MY", "인도네시아": "ID", "indonesia": "ID", "필리핀": "PH", "philippines": "PH",
    "이집트": "EG", "egypt": "EG", "이스라엘": "IL", "israel": "IL", "모로코": "MA", "morocco": "MA",
}
NOT_INCLUDED = ["터미널 조작료(THC)·서류비 등 출발지·도착지 부대비용", "내륙 운송", "통관·관세", "적하보험"]

_cache: dict = {}
_lock = threading.Lock()


def place(text: str) -> "dict | None":
    """사람이 쓴 곳 이름을 {country, port}로. 모르면 None — 지어내지 않는다."""
    raw = str(text or "").strip()
    key = re.sub(r"[\s\-_.,·]", "", raw).lower()
    code = NAMES.get(key)
    if code is None:
        up = raw.upper().replace(" ", "")
        if re.fullmatch(r"[A-Z]{2}", up) or re.fullmatch(r"[A-Z]{2}[A-Z0-9]{3}", up):
            code = up
    if code is None:
        return None
    return {"input": raw, "country": code[:2], "port": code if len(code) == 5 else None}


def _num(cell: str) -> "float | None":
    s = re.sub(r"[,\s]", "", cell)
    return float(s) if re.fullmatch(r"-?\d+(\.\d+)?", s) else None


def parse_timeseries(html: str) -> dict:
    """KOBC 시계열 표 → {codes, rows:[{date, values:{code: 값}}]} (최신이 앞).

    열 순서는 표 머리글에서 읽는다 — 자리를 외워 두면 KOBC가 열을 바꿀 때 조용히 다른 항로 값을 내게 된다.
    """
    m = re.search(r"<table[^>]*>(.*?)</table>", html, re.S)
    if not m:
        raise EngineError(502, "source_changed", "KOBC 운임지수 표를 찾지 못했습니다 — 페이지 모양이 바뀐 것 같습니다")
    table = m.group(1)
    head = re.search(r"<thead[^>]*>(.*?)</thead>", table, re.S)
    cells = lambda s, tag: [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", c)).strip()
                            for c in re.findall(rf"<{tag}[^>]*>(.*?)</{tag}>", s, re.S)]
    codes = [h for h in cells(head.group(1) if head else "", "th") if h == "KCCI" or h in LANES]
    if "KCCI" not in codes or len(codes) < 2:
        raise EngineError(502, "source_changed", "KOBC 운임지수 표의 머리글을 읽지 못했습니다")
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", table.split("</thead>")[-1], re.S):
        td = cells(tr, "td")
        if len(td) != len(codes) + 1 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", td[0]):
            continue
        rows.append({"date": td[0], "values": {c: _num(v) for c, v in zip(codes, td[1:])}})
    if not rows:
        raise EngineError(502, "source_changed", "KOBC 운임지수 표에 읽을 행이 없습니다")
    rows.sort(key=lambda r: r["date"], reverse=True)
    return {"codes": codes, "rows": rows}


def _weeks(weeks) -> int:
    try:
        return max(2, min(MAX_WEEKS, int(weeks)))
    except (TypeError, ValueError):
        return WEEKS


def fetch_table(client: "httpx.Client | None" = None, today: "date | None" = None, weeks: int = WEEKS) -> dict:
    """최근 weeks주 표. 실제 경로는 기간별 30분 캐시(주 1회 바뀌는 자료), 주입된 client는 캐시를 쓰지 않는다."""
    weeks = _weeks(weeks)
    if client is None:
        with _lock:
            hit = _cache.get(("table", weeks))
            if hit and time.monotonic() - hit[0] < CACHE_TTL:
                return hit[1]
    today = today or date.today()
    form = {"sDay": (today - timedelta(weeks=weeks)).isoformat(), "eDay": today.isoformat(),
            "siteCode": "shippinginfo", "mId": "0304000000"}
    c = client or netguard.make_client(TIMEOUT, headers={"User-Agent": "Mozilla/5.0 (Macintosh) A2A-Engine/0.1"})
    try:
        r = c.post(PAGE, data=form)
        r.raise_for_status()
        html = r.text
    except httpx.HTTPError as e:
        raise EngineError(502, "source_unreachable", f"KOBC 운임지수 페이지를 읽지 못했습니다: {str(e)[:120]}")
    finally:
        if client is None:
            c.close()
    out = parse_timeseries(html)
    out["fetched_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if client is None:
        with _lock:
            _cache[("table", weeks)] = (time.monotonic(), out)
    return out


def _lane(code: str, table: dict, today: date) -> dict:
    series = [{"date": r["date"], "value": r["values"].get(code)} for r in table["rows"]
              if r["values"].get(code) is not None]
    out = {"code": code, "name": LANES[code][0], "name_ko": LANES[code][1], "unit": UNIT}
    if not series:
        return {**out, "usd_per_feu": None, "note": "이 항로 값이 표에 없습니다"}
    cur, prev = series[0], (series[1] if len(series) > 1 else None)
    vals = [p["value"] for p in series]
    out.update({
        "usd_per_feu": cur["value"], "as_of": cur["date"],
        "previous": prev and {"usd_per_feu": prev["value"], "as_of": prev["date"]},
        "change": prev and {"abs": cur["value"] - prev["value"],
                            "pct": round((cur["value"] - prev["value"]) / prev["value"] * 100, 2) if prev["value"] else None},
        "range": {"low": min(vals), "high": max(vals), "weeks": len(vals), "from": series[-1]["date"], "to": cur["date"]},
        "history": list(reversed(series)),
        "stale": (today - date.fromisoformat(cur["date"])).days > STALE_DAYS,
    })
    return out


def estimate(origin: str, destination: str, container: str = "40", cargo: str = "", *,
             client: "httpx.Client | None" = None, today: "date | None" = None, weeks: int = WEEKS) -> dict:
    """출발지·도착지 → 지금의 구간 운임 지수(USD/FEU)와 최근 weeks주(기본 13주) 범위·추이. 모르는 건 status로 말한다.

    status: ok(항로 하나로 정해짐) · ambiguous(후보 여럿 — 항구를 알려 주면 좁혀짐) · unknown(이 출처로는 답할 수 없음)
    """
    today = today or date.today()
    base = {"kind": "index", "unit": UNIT, "source": dict(SOURCE), "not_included": NOT_INCLUDED,
            "cargo": str(cargo or "")[:120], "lanes": []}
    o, d = place(origin), place(destination)
    base["origin"], base["destination"] = o or {"input": str(origin or "")}, d or {"input": str(destination or "")}
    if not str(origin or "").strip() or not str(destination or "").strip():
        raise EngineError(400, "invalid_input", "출발지와 도착지를 모두 주세요")
    if o is None or d is None:
        which = "출발지" if o is None else "도착지"
        return {**base, "status": "unknown",
                "reason": f"{which}를 알아보지 못했습니다 — 나라 코드(IT)나 항구 코드(ITGOA)로 주세요"}
    if o["country"] != "KR":
        return {**base, "status": "unknown",
                "reason": "이 출처(KCCI)는 부산 출발 운임만 다룹니다 — 한국 밖에서 떠나는 구간의 공개 운임은 아직 붙이지 않았습니다"}
    if d["country"] == "KR":
        return {**base, "status": "unknown", "reason": "출발지와 도착지가 모두 한국입니다 — 연안 운송은 이 지수에 없습니다"}
    codes = [PORT_LANE[d["port"]]] if d["port"] in PORT_LANE else COUNTRY_LANES.get(d["country"])
    if not codes:
        return {**base, "status": "unknown",
                "reason": f"{d['input']}({d['country']})에 맞는 KCCI 항로를 정하지 못했습니다",
                "available_lanes": [{"code": c, "name": n, "name_ko": k} for c, (n, k) in LANES.items()]}
    table = fetch_table(client, today, weeks)
    base["source"]["fetched_at"] = table["fetched_at"]
    base["lanes"] = [_lane(c, table, today) for c in codes]
    size = re.sub(r"[^0-9A-Za-z]", "", str(container or "40")).upper()
    kind = re.sub(r"\s", "", str(cargo or "")).lower()
    notes = []
    if size not in ("40", "40FT", "40DRY", "40DR", "FEU", "40DC", "40GP"):
        notes.append(f"요청한 규격({container})의 값은 이 출처에 없습니다 — 아래는 40피트 일반 컨테이너(FEU) 기준입니다"
                     + (" (20피트 운임은 그 절반이 아닙니다)" if size.startswith("20") or size == "TEU" else ""))
    if re.search(r"냉동|냉장|reefer|위험물|dangerous|hazard|lcl|소량|벌크|bulk", kind):
        notes.append("냉동·위험물·소량(LCL)·벌크 화물의 운임은 이 지수에 없습니다 — 일반 컨테이너(dry) 시세만 참고하세요")
    if any(l.get("stale") for l in base["lanes"]):
        notes.append(f"최근 공표가 {STALE_DAYS}일보다 오래됐습니다 — 기준일을 꼭 확인하세요")
    base["container"] = {"requested": str(container or "40"), "priced": "40ft dry (FEU)"}
    base["notes"] = notes
    if len(codes) > 1:
        return {**base, "status": "ambiguous",
                "reason": f"{d['input']}은(는) 항로가 갈립니다({', '.join(LANES[c][1] for c in codes)}) — 도착 항구를 알려 주면 하나로 좁힙니다"}
    return {**base, "status": "ok"}


def board(*, client: "httpx.Client | None" = None, today: "date | None" = None, weeks: int = WEEKS) -> dict:
    """부산발 전체 항로 한눈에 — 종합지수(pt)와 13개 항로(USD/FEU)의 지금 값·전주 대비·기간 추이."""
    today = today or date.today()
    table = fetch_table(client, today, weeks)
    comp = [{"date": r["date"], "value": r["values"].get("KCCI")} for r in table["rows"] if r["values"].get("KCCI") is not None]
    composite = None
    if comp:
        cur, prev = comp[0], (comp[1] if len(comp) > 1 else None)
        composite = {"code": "KCCI", "name": "Comprehensive Index", "name_ko": "종합지수", "unit": "pt",
                     "value": cur["value"], "as_of": cur["date"],
                     "change": prev and {"abs": cur["value"] - prev["value"],
                                         "pct": round((cur["value"] - prev["value"]) / prev["value"] * 100, 2) if prev["value"] else None},
                     "history": list(reversed(comp))}
    return {"kind": "index", "unit": UNIT, "weeks": _weeks(weeks), "source": {**SOURCE, "fetched_at": table["fetched_at"]},
            "not_included": NOT_INCLUDED, "composite": composite,
            "lanes": [_lane(c, table, today) for c in LANES if c in table["codes"]]}


# ── 연간 물량 프로젝션 ──────────────────────────────────────────────────
# 미래 운임은 아무도 모른다. 그래서 "얼마가 들까"를 숫자 하나로 말하지 않고, 지난 52주 지수에서 뽑은
# 네 가지 경우(지금 시세 유지·52주 평균·52주 최저·52주 최고)에 연간 물량을 곱해 범위로 보여 준다.
# 지수가 40피트 일반 컨테이너(FEU) 값이라 40피트만 계산한다 — 20피트를 반으로 나누는 추정은 하지 않는다.
PROJECTION_WEEKS = 52
PER_YEAR = {"year": 1, "half": 2, "quarter": 4, "month": 12, "week": 52}
PER_KO = {"year": "1년", "half": "반년", "quarter": "분기", "month": "한 달", "week": "한 주"}
_PERIOD = [("half", r"반기|반년|6\s*개월"), ("quarter", r"분기|3\s*개월|quarter"),
           ("month", r"매\s*달|매\s*월|한\s*달|월\s*(?:간|에|당|마다)?|monthly|per\s*month|a\s*month|/\s*월|/\s*mo"),
           ("week", r"매\s*주|주\s*(?:당|마다|에)|weekly|per\s*week|a\s*week|/\s*주"),
           ("year", r"연\s*(?:간|에|당|마다)?|1\s*년|일\s*년|한\s*해|매\s*년|년\s*(?:간|에|당|마다)|yearly|annual(?:ly)?|per\s*year|a\s*year|/\s*년|/\s*yr")]
_COUNT = re.compile(r"(\d+(?:\.\d+)?)\s*(?:(20|40)\s*(?:피트|ft|')\s*)?(?:HC|하이큐브)?\s*"
                    r"(대|개|컨테이너|박스|FEU|TEU|box(?:es)?|containers?)", re.I)


def volume_in(text: str) -> "dict | None":
    """문장 속 물량 — "월 2대", "1년에 40피트 24개", "연간 30 FEU". 기간이 없으면 per=None(계산하지 않고 묻는다)."""
    t = str(text or "")
    m = _COUNT.search(t)
    if not m:
        return None
    count = float(m.group(1))
    if count <= 0 or count > 100_000:
        return None
    unit = m.group(3).upper()
    near = t[max(0, m.start() - 14):m.start()] + " " + t[m.end():m.end() + 10]
    size = "20" if (m.group(2) == "20" or unit == "TEU" or re.search(r"20\s*(피트|ft|')", near, re.I)) else "40"
    if size == "40" and re.search(r"HC|하이큐브|high\s*cube", t[max(0, m.start() - 14):m.end() + 10], re.I):
        size = "40HC"
    per = next((k for k, rx in _PERIOD if re.search(rx, near, re.I)), None)
    return {"count": int(count) if count.is_integer() else count, "per": per, "size": size, "text": m.group(0).strip()}


def projection(lane: dict, count: float, per: str, size: str = "40") -> dict:
    """항로 하나(52주 history 포함)에 연간 물량을 곱한 네 가지 경우. 계산을 그대로 보여 준다(값마다 식)."""
    if per not in PER_YEAR:
        return {"status": "need_period", "reason": "기간(월·연 등)이 없어 1년 물량을 정할 수 없습니다 — 예: 월 2대, 1년에 24대"}
    if str(size).upper() in ("20", "20FT", "TEU"):
        return {"status": "unknown", "reason": "20피트 운임은 이 지수에 없습니다 — 40피트 값을 나눠 추정하지 않습니다. 40피트 대수로 알려 주시면 계산합니다"}
    if lane.get("usd_per_feu") is None:
        return {"status": "unknown", "reason": lane.get("note") or "이 항로 값이 없습니다"}
    per_year = round(count * PER_YEAR[per], 2)
    vals = [p["value"] for p in lane.get("history") or []] or [lane["usd_per_feu"]]
    rate = {"now": lane["usd_per_feu"], "avg": round(sum(vals) / len(vals)), "low": min(vals), "high": max(vals)}
    label = {"now": f"지금 시세 유지({lane['as_of']})", "avg": f"지난 {len(vals)}주 평균",
             "low": f"지난 {len(vals)}주 최저", "high": f"지난 {len(vals)}주 최고"}
    cases = [{"key": k, "label": label[k], "usd_per_feu": rate[k], "annual_usd": round(rate[k] * per_year),
              "formula": f"{rate[k]:,.0f} × {per_year:g}대"} for k in ("now", "avg", "low", "high")]
    notes = ["지수(항로 평균 시세)로 계산한 범위이며 견적이 아닙니다 — 부대비용·내륙 운송·통관·보험은 빠져 있습니다"]
    if str(size).upper() != "40":
        notes.append(f"요청 규격 {size}의 값은 이 지수에 없어 40피트 일반 컨테이너 시세로 계산했습니다")
    return {"status": "ok", "count": count, "per": per, "per_ko": PER_KO[per], "per_year": per_year, "size": "40",
            "weeks": len(vals), "from": lane["range"]["from"], "to": lane["range"]["to"], "cases": cases,
            "monthly_now_usd": round(rate["now"] * per_year / 12), "notes": notes}


def project(origin: str, destination: str, count: float, per: str, container: str = "40", cargo: str = "", *,
            client: "httpx.Client | None" = None, today: "date | None" = None) -> dict:
    """estimate(52주) + 항로마다 연간 물량 프로젝션. 화면·메리·에이전트가 같은 계산을 쓴다."""
    out = estimate(origin, destination, container, cargo, client=client, today=today, weeks=PROJECTION_WEEKS)
    out["volume"] = {"count": count, "per": per, "size": str(container or "40")}
    for lane in out.get("lanes") or []:
        lane["projection"] = projection(lane, count, per, str(container or "40"))
    return out


# 문장 속 도착지 — 메리 대화처럼 사람이 쓴 말("이탈리아나 스페인에 팔려면")에서 이름표에 있는 곳만 줍는다.
# 이름표에 없는 곳은 줍지 않는다(지어내지 않는다). 한국 이름은 출발지로 보고 빼며, 같은 나라는 한 번만.
def places_in(text: str) -> list[dict]:
    t = str(text or "")
    low = re.sub(r"[\s\-_.,·]", "", t).lower()
    hits = []
    for name, code in sorted(NAMES.items(), key=lambda kv: -len(kv[0])):
        if len(name) < 2 or (name.isascii() and len(name) < 4):
            continue                     # "la"·"uk"·"uae" 같은 짧은 영문은 낱말 경계로만
        i = low.find(name)
        if i >= 0 and not any(i < e and i + len(name) > b for b, e, _ in hits):
            hits.append((i, i + len(name), code))
    for m in re.finditer(r"\b(UK|UAE|USA|LA|[A-Z]{2}[A-Z0-9]{3})\b", t):
        code = NAMES.get(m.group(1).lower()) or (m.group(1) if len(m.group(1)) == 5 else None)
        if code:
            hits.append((10_000 + m.start(), 10_000 + m.end(), code))
    out, seen = [], set()
    for _, _, code in sorted(hits):
        country = code[:2]
        if country == "KR" or code in seen:
            continue
        if len(code) == 2 and any(c[:2] == country for c in seen):
            continue
        seen.add(code)
        out.append(code)
    # 같은 나라의 나라 코드와 항구 코드가 함께 잡히면 항구만 남긴다(더 구체적)
    ports = {c[:2] for c in out if len(c) == 5}
    return [c for c in out if len(c) == 5 or c not in ports][:5]


def ask(text: str, *, origin: str = "KR", container: str = "40", cargo: str = "",
        client: "httpx.Client | None" = None, today: "date | None" = None, weeks: int = WEEKS) -> dict:
    """사람의 질문 한 문장 → 문장 속 도착지마다 estimate. 출발지는 문장에 없으면 한국(부산)으로 보고 그렇다고 밝힌다."""
    # 답에는 사람이 쓰는 이름으로(IT → 이탈리아). 이름표의 첫 한국어 이름, 없으면 코드 그대로
    label = {}
    for k, v in NAMES.items():
        if not k.isascii():
            label.setdefault(v, k)
    dests = [label.get(c, c) for c in places_in(text)]
    named_origin = bool(re.search(r"(부산|인천|광양|busan|pusan)\S{0,3}(에서|발|from)", str(text), re.I))
    vol = volume_in(text)
    if vol and vol["per"]:
        results = [project(origin, d, vol["count"], vol["per"], vol["size"], cargo, client=client, today=today) for d in dests]
    else:
        results = [estimate(origin, d, container, cargo, client=client, today=today, weeks=weeks) for d in dests]
    return {"kind": "index", "unit": UNIT, "question": str(text or "")[:400], "destinations": dests,
            "origin": origin, "origin_assumed": not named_origin, "volume": vol, "results": results}
