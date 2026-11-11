"""해상 경로 비교 — 스카이스캐너처럼 도착 후보(항구)마다 카드 하나. 지금은 틀이다(2026-11-11 사용자 결정: "우선은 틀만").

카드 한 장 = 부산 → 도착 항구 하나:
  price    — 그 항구가 속한 KCCI 항로의 지수(USD/FEU). 연결돼 있다. 같은 항로의 항구들은 같은 값이다
             (항로 평균이라 항구별 값이 아님) — 카드에 그렇게 적는다.
  transit  — 운항 일수. 출처가 아직 연결되지 않았다 → days=None, status="not_connected".
  sailings — 출발일·선사·환적. 선사 스케줄 출처가 아직 연결되지 않았다 → [].

출처 자리(PROVIDERS)는 키·법무 검토가 끝나면 채운다. 조사 결과(2026-11-11):
  - 머스크 Point-to-Point Schedules: 무료지만 사용자 본인 키, 결과 공유·캐시 금지 → 본인 화면에만.
  - 다른 선사(HMM·MSC·Hapag-Lloyd·ZIM 등): 승인·계약 필요, 또는 상업적 이용 금지.
  - 거리 기반 추정(searoute): 코드는 Apache-2.0이나 항로망 데이터 라이선스 미확인 → 보류.
연결되지 않은 출처는 숫자를 내지 않는다. "빠른 순" 정렬은 운항 일수가 하나라도 있을 때만 켜진다.
"""
import os
from datetime import date

from . import rates

# 나라별 주요 도착 항구 — (UN/LOCODE, 한글 이름, 영문 이름). 항로는 rates.PORT_LANE, 없으면 나라의 첫 항로.
PORTS = {
    "IT": [("ITGOA", "제노바", "Genoa"), ("ITSPE", "라스페치아", "La Spezia"), ("ITNAP", "나폴리", "Naples"),
           ("ITTRS", "트리에스테", "Trieste"), ("ITGIT", "조이아타우로", "Gioia Tauro")],
    "ES": [("ESBCN", "바르셀로나", "Barcelona"), ("ESVLC", "발렌시아", "Valencia"), ("ESALG", "알헤시라스", "Algeciras"),
           ("ESBIO", "빌바오", "Bilbao")],
    "FR": [("FRFOS", "포스쉬르메르(마르세유)", "Fos-sur-Mer"), ("FRLEH", "르아브르", "Le Havre")],
    "GR": [("GRPIR", "피레우스", "Piraeus")],
    "TR": [("TRMER", "메르신", "Mersin"), ("TRAMB", "암바를르(이스탄불)", "Ambarli")],
    "DE": [("DEHAM", "함부르크", "Hamburg"), ("DEBRV", "브레머하펜", "Bremerhaven")],
    "NL": [("NLRTM", "로테르담", "Rotterdam")],
    "BE": [("BEANR", "앤트워프", "Antwerp")],
    "GB": [("GBFXT", "펠릭스토", "Felixstowe"), ("GBSOU", "사우샘프턴", "Southampton")],
    "PL": [("PLGDN", "그단스크", "Gdansk")],
    "US": [("USLAX", "로스앤젤레스", "Los Angeles"), ("USLGB", "롱비치", "Long Beach"), ("USSEA", "시애틀", "Seattle"),
           ("USNYC", "뉴욕", "New York"), ("USSAV", "서배너", "Savannah"), ("USHOU", "휴스턴", "Houston")],
    "CA": [("CAVAN", "밴쿠버", "Vancouver"), ("CAMTR", "몬트리올", "Montreal")],
    "AE": [("AEJEA", "제벨알리(두바이)", "Jebel Ali")],
    "SA": [("SAJED", "제다", "Jeddah"), ("SADMM", "담맘", "Dammam")],
    "AU": [("AUSYD", "시드니", "Sydney"), ("AUMEL", "멜버른", "Melbourne")],
    "BR": [("BRSSZ", "산투스", "Santos")],
    "MX": [("MXZLO", "만사니요", "Manzanillo"), ("MXVER", "베라크루스", "Veracruz")],
    "CL": [("CLSAI", "산안토니오", "San Antonio")],
    "ZA": [("ZADUR", "더반", "Durban")],
    "NG": [("NGAPP", "아파파(라고스)", "Apapa")],
    "VN": [("VNSGN", "호찌민", "Ho Chi Minh"), ("VNHPH", "하이퐁", "Haiphong")],
    "SG": [("SGSIN", "싱가포르", "Singapore")],
    "JP": [("JPTYO", "도쿄", "Tokyo"), ("JPOSA", "오사카", "Osaka")],
    "CN": [("CNSHA", "상하이", "Shanghai"), ("CNNGB", "닝보", "Ningbo")],
}
# 나라 항로 표만으로는 갈리지 않는 항구 — 대서양·아드리아해 쪽 등
EXTRA_LANE = {"ITTRS": "KMDI", "ITGIT": "KMDI", "ITSPE": "KMDI", "ITNAP": "KMDI", "ITGOA": "KMDI",
              "GRPIR": "KMDI", "TRMER": "KMDI", "TRAMB": "KMDI", "DEBRV": "KNEI", "GBSOU": "KNEI", "PLGDN": "KNEI",
              "USSEA": "KUWI", "USHOU": "KUEI", "AEJEA": "KMEI", "SAJED": "KMEI", "SADMM": "KMEI",
              "VNHPH": "KSEI", "JPTYO": "KJI", "JPOSA": "KJI", "CNNGB": "KCI"}

# 출처 자리 — kind: price(운임) · transit(운항 일수) · schedule(출발일·선사)
# status: connected(쓰는 중) · needs_key(키를 넣으면 연결) · review(법무·라이선스 검토 중)
PROVIDERS = [
    {"id": "kcci", "kind": "price", "name": "한국해양진흥공사 KCCI", "status": "connected",
     "gives": "항로별 운임 지수(USD/FEU), 매주 월요일", "note": "항로 평균 시세 — 견적 아님"},
    {"id": "maersk", "kind": "schedule", "name": "머스크 스케줄 API", "env": "MAERSK_CONSUMER_KEY", "status": "needs_key",
     "gives": "실제 배편 출발일·운항 일수·환적(머스크 노선만)",
     "note": "무료, 사용자 본인 키 — 결과는 키 주인 화면에만(공유·캐시 금지). 법무 검토 후 연결"},
    {"id": "carriers", "kind": "schedule", "name": "다른 선사 스케줄(HMM·MSC·Hapag-Lloyd 등)", "status": "review",
     "gives": "선사별 배편", "note": "승인·계약이 필요하거나 상업적 이용이 막혀 있음"},
    {"id": "distance", "kind": "transit", "name": "항로 거리 기반 추정", "status": "review",
     "gives": "바다 위 항해 일수(기항·환적 제외)", "note": "항로망 데이터 라이선스 확인 후 연결 — 실제 운송 기간보다 짧게 나옴"},
]


def providers() -> list[dict]:
    """출처 자리와 상태. 키가 환경에 있어도 어댑터가 없으면 연결된 것으로 말하지 않는다(key_present)."""
    out = []
    for p in PROVIDERS:
        q = {k: v for k, v in p.items() if k != "env"}
        if p.get("env") and os.environ.get(p["env"]) and p["status"] == "needs_key":
            q["status"] = "key_present"
            q["note"] = "키는 있지만 아직 연결하지 않았습니다 — " + p["note"]
        out.append(q)
    return out


def _lane_of(port: str, country: str) -> "str | None":
    if port in rates.PORT_LANE:
        return rates.PORT_LANE[port]
    if port in EXTRA_LANE:
        return EXTRA_LANE[port]
    lanes = rates.COUNTRY_LANES.get(country) or []
    return lanes[0] if lanes else None


def _candidates(dest: dict) -> list[tuple]:
    """도착 후보 — 항구를 주면 그 항구를 맨 앞에, 같은 나라의 다른 항구를 대안으로."""
    ports = list(PORTS.get(dest["country"], []))
    if dest.get("port"):
        mine = [p for p in ports if p[0] == dest["port"]] or [(dest["port"], dest["input"], dest["port"])]
        ports = mine + [p for p in ports if p[0] != dest["port"]]
    return ports


def compare(origin: str, destination: str, container: str = "40", cargo: str = "", *,
            client=None, today=None, weeks: int = rates.WEEKS) -> dict:
    """부산 → 도착 후보 항구마다 카드. 운임은 KCCI 항로 지수, 운항 일수·배편은 출처 연결 전이면 비워 둔다."""
    est = rates.estimate(origin, destination, container, cargo, client=client, today=today, weeks=weeks)
    base = {"kind": "compare", "origin": est.get("origin"), "destination": est.get("destination"),
            "status": est["status"], "reason": est.get("reason"), "notes": est.get("notes", []),
            "source": est.get("source"), "not_included": est.get("not_included"), "container": est.get("container"),
            "providers": providers(), "options": [], "sorts": ["price", "recommended"]}
    if est["status"] == "unknown":
        return base
    d = rates.place(destination)
    ports = _candidates(d)
    lanes = {l["code"]: l for l in est["lanes"]}
    need = {_lane_of(p[0], d["country"]) for p in ports} - set(lanes) - {None}
    if need:      # 대안 항구가 다른 항로에 걸치면 그 항로 값도 같은 표에서
        table = rates.fetch_table(client, today, weeks)
        lanes.update({c: rates._lane(c, table, today or date.today()) for c in need})
    if not ports:  # 항구 표가 없는 나라 — 항로 카드만
        ports = [(None, est["destination"].get("input", ""), "") for _ in est["lanes"][:1]]
    options = []
    for code, ko, en in ports:
        lc = _lane_of(code, d["country"]) if code else est["lanes"][0]["code"]
        lane = lanes.get(lc)
        if not lane:
            continue
        options.append({
            "id": f"{code or lc}",
            "port": {"code": code, "name_ko": ko, "name": en, "asked": bool(d.get("port")) and code == d["port"]},
            "lane": {"code": lane["code"], "name_ko": lane["name_ko"], "name": lane["name"]},
            "price": None if lane.get("usd_per_feu") is None else {
                "usd_per_feu": lane["usd_per_feu"], "as_of": lane["as_of"], "change": lane.get("change"),
                "range": lane.get("range"), "kind": "index", "per": "lane", "provider": "kcci"},
            "transit": {"days": None, "status": "not_connected", "provider": None},
            "sailings": [],
            "tags": [],
        })
    priced = [o for o in options if o["price"]]
    if len({o["price"]["usd_per_feu"] for o in priced}) > 1:     # 값이 갈릴 때만 — 모두 같으면 '가장 싼' 것이 없다
        low = min(o["price"]["usd_per_feu"] for o in priced)
        for o in priced:
            if o["price"]["usd_per_feu"] == low:
                o["tags"].append("cheapest")
    for o in options:
        if o["port"]["asked"]:
            o["tags"].append("asked")
    # 추천 순: 물어본 항구 → 싼 항로 → 표에 적힌 순서. 운항 일수가 연결되면 여기에 더한다.
    order = {id(o): i for i, o in enumerate(options)}
    options.sort(key=lambda o: (not o["port"]["asked"], o["price"]["usd_per_feu"] if o["price"] else 1e12, order[id(o)]))
    if any(o["transit"]["days"] is not None for o in options):
        base["sorts"].append("fastest")
    base["options"] = options
    base["lanes_used"] = sorted({o["lane"]["code"] for o in options})
    return base
