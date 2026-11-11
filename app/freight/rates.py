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
WEEKS = 13                      # 범위·추이를 보여 줄 기간
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


def fetch_table(client: "httpx.Client | None" = None, today: "date | None" = None) -> dict:
    """최근 WEEKS주 표. 실제 경로는 30분 캐시(주 1회 바뀌는 자료), 주입된 client는 캐시를 쓰지 않는다."""
    if client is None:
        with _lock:
            hit = _cache.get("table")
            if hit and time.monotonic() - hit[0] < CACHE_TTL:
                return hit[1]
    today = today or date.today()
    form = {"sDay": (today - timedelta(weeks=WEEKS)).isoformat(), "eDay": today.isoformat(),
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
            _cache["table"] = (time.monotonic(), out)
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
             client: "httpx.Client | None" = None, today: "date | None" = None) -> dict:
    """출발지·도착지 → 지금의 구간 운임 지수(USD/FEU)와 최근 13주 범위. 모르는 건 status로 말한다.

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
    table = fetch_table(client, today)
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
