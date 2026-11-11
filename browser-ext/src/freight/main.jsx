// 해상 운임 — 부산에서 떠나는 컨테이너의 항로별 운임 지수를 보는 전용 화면. 일은 엔진(/v1/freight/ocean·board)이 한다.
// 에이전트 도구(ocean_freight_rate)·메리와 같은 경로다. 숫자는 지수(구간 평균 시세)이고 견적이 아니다 — 화면도 그렇게 말한다.
// 첫 화면부터 시장 전체가 보인다: 종합지수 → 고른 항로의 기간별 추이(축·눈금·마우스 오버) → 13개 항로 표.
// 시세 화면의 읽는 법을 따른다: 큰 숫자 하나, 부호 붙은 변화량(오르면 빨강·내리면 파랑), 자리 맞춘 오른쪽 정렬,
// 색은 변화량에만 쓰고, 기준일과 출처는 숫자 가까이에 둔다.
import '../shared/bridge.js';
import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState } from 'react';
import '../map/map.css';
import { AppFrame } from '../ui/AppNav.jsx';

const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const num = (n) => Math.round(n).toLocaleString('en-US');
const Field = (p) => <input {...p} className={`h-9 rounded-lg bg-field px-3 text-[13px] ring-1 ring-field-line outline-none focus:ring-card-faint ${p.className || ''}`} />;
const tone = (n) => (n > 0 ? 'text-up' : n < 0 ? 'text-down' : 'text-card-sub');
const signed = (n, f = (x) => x) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${f(Math.abs(n))}`;
const PERIODS = [[13, '3개월'], [26, '6개월'], [52, '1년'], [156, '3년']];
const LINE = ['text-card-ink', 'text-info'];          // 차트에 함께 그리는 항로(최대 둘)

// 보기 좋은 눈금 — 범위를 1·2·5 단위로 나눈다
function ticks(lo, hi, n = 4) {
  const raw = (hi - lo) / n || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw);
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step / 2; v += step) out.push(v);
  return out;
}

// 기간 추이 — y축 눈금·가로선, x축 달 표시, 마우스를 올리면 그 주의 값
function Chart({ lanes }) {
  const box = useRef(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState(null);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, Math.round(e.contentRect.width))));
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const series = lanes.filter((l) => l.history?.length > 1);
  if (!series.length) return <div ref={box} className="h-[240px]" />;
  const H = 240, L = 8, R = 56, T = 12, B = 26;
  const dates = series[0].history.map((p) => p.date);
  const vals = series.flatMap((l) => l.history.map((p) => p.value));
  const tk = ticks(Math.min(...vals), Math.max(...vals));
  const lo = tk[0], hi = tk[tk.length - 1] === tk[0] ? tk[0] + 1 : tk[tk.length - 1];
  const x = (i) => L + (i / (dates.length - 1)) * (w - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const at = (l, d) => l.history.find((p) => p.date === d);
  // 달이 바뀌는 첫 주에만 x축 글자 — 겹치지 않게 간격을 둔다
  const months = [];
  dates.forEach((d, i) => { if (i === 0 || d.slice(0, 7) !== dates[i - 1].slice(0, 7)) months.push([i, d]); });
  const every = Math.max(1, Math.ceil(months.length / Math.floor((w - L - R) / 64)));
  const move = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - L) / (w - L - R)) * (dates.length - 1));
    setHover(i >= 0 && i < dates.length ? i : null);
  };
  const hd = hover != null ? dates[hover] : null;
  return (
    <div ref={box} className="relative">
      <svg id="freight-chart" width={w} height={H} onMouseMove={move} onMouseLeave={() => setHover(null)} role="img"
        aria-label={`${series.map((l) => l.name_ko).join('·')} ${dates[0]}부터 ${dates[dates.length - 1]}까지 추이`}>
        {tk.map((v) => (
          <g key={v}>
            <line x1={L} x2={w - R} y1={y(v)} y2={y(v)} className="stroke-card-line" strokeWidth="1" />
            <text x={w - R + 8} y={y(v) + 4} className="fill-card-faint text-[11px] tabular-nums">{num(v)}</text>
          </g>
        ))}
        {months.filter((_, k) => k % every === 0).map(([i, d]) => (
          <text key={d} x={x(i)} y={H - 6} className="fill-card-faint text-[11px]" textAnchor={i === 0 ? 'start' : 'middle'}>
            {d.slice(5, 7) === '01' || i === 0 ? `${d.slice(2, 4)}.${d.slice(5, 7)}` : `${Number(d.slice(5, 7))}월`}
          </text>
        ))}
        {series.map((l, k) => (
          <g key={l.code} className={LINE[k]}>
            <polyline fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"
              points={l.history.map((p) => `${x(dates.indexOf(p.date))},${y(p.value)}`).join(' ')} />
            <circle cx={x(dates.length - 1)} cy={y(l.history[l.history.length - 1].value)} r="3.5" fill="currentColor" />
          </g>
        ))}
        {hd && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="stroke-card-faint" strokeDasharray="3 3" />
            {series.map((l, k) => at(l, hd) && <circle key={l.code} className={LINE[k]} cx={x(hover)} cy={y(at(l, hd).value)} r="4" fill="currentColor" />)}
          </g>
        )}
      </svg>
      {hd && (
        <div className="pointer-events-none absolute top-1 rounded-md bg-card px-2.5 py-1.5 text-[12px] shadow-card ring-1 ring-card-line"
          style={{ left: Math.min(x(hover) + 10, w - 170) }}>
          <div className="text-card-sub">{hd} 주</div>
          {series.map((l, k) => at(l, hd) && (
            <div key={l.code} className="flex justify-between gap-4 tabular-nums">
              <span className={LINE[k]}>● <span className="text-card-ink">{l.name_ko}</span></span><b>{usd(at(l, hd).value)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 작은 추이 — 표 안에서 모양만
function Spark({ points }) {
  if (!points || points.length < 2) return null;
  const W = 84, H = 24, vals = points.map((p) => p.value);
  const lo = Math.min(...vals), span = Math.max(...vals) - lo || 1;
  return (
    <svg width={W} height={H} className="text-card-faint" aria-hidden="true">
      <polyline fill="none" stroke="currentColor" strokeWidth="1.3" points={points.map((p, i) => `${(i / (points.length - 1)) * (W - 2) + 1},${H - 2 - ((p.value - lo) / span) * (H - 4)}`).join(' ')} />
    </svg>
  );
}

// ── 경로 비교(스카이스캐너식) — 도착 항구마다 카드. 운임은 연결된 지수, 운항 일수·배편은 출처를 연결하면 채워진다 ──
const TAG = { cheapest: '가장 저렴한 항로', asked: '물어본 항구' };
const SORTS = [['recommended', '추천'], ['price', '저렴한 순'], ['fastest', '빠른 순']];
const STATUS = { connected: ['연결됨', 'text-ok'], needs_key: ['키를 넣으면 연결', 'text-warn'], key_present: ['키 있음 · 연결 전', 'text-warn'], review: ['검토 중', 'text-card-faint'] };

function RouteCard({ o, origin }) {
  const p = o.price;
  return (
    <li className="route-card rounded-xl bg-card px-4 py-3.5 ring-1 ring-card-line hover:ring-card-faint" data-port={o.port.code || ''}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="w-[76px] shrink-0">
            <div className="text-[15px] font-semibold">{origin}</div>
            <div className="text-[11px] text-card-faint">KRPUS</div>
          </div>
          <div className="min-w-[110px] flex-1 text-center">
            <div className="route-transit text-[11.5px] text-card-sub">{o.transit.days != null ? `${o.transit.days}일` : '운항 일수 · 연결 전'}</div>
            <div className="relative my-1 h-px bg-card-line"><span className="absolute -top-[3px] right-0 size-[7px] rounded-full bg-card-faint" /></div>
            <div className="text-[11px] text-card-faint">{o.lane.name_ko} 항로</div>
          </div>
          <div className="w-[118px] shrink-0 text-right">
            <div className="truncate text-[15px] font-semibold">{o.port.name_ko}</div>
            <div className="text-[11px] text-card-faint">{o.port.code || o.lane.code}</div>
          </div>
        </div>
        <div className="w-[150px] shrink-0 border-l border-card-line pl-4 text-right max-sm:w-full max-sm:border-0 max-sm:pl-0">
          {p ? (
            <>
              <b className="route-price text-[20px] font-bold tabular-nums">{usd(p.usd_per_feu)}</b>
              <div className="text-[11px] text-card-sub">40피트 · 항로 지수</div>
              <div className="text-[11px] text-card-faint tabular-nums">기준일 {p.as_of}</div>
            </>
          ) : <div className="text-[12px] text-card-faint">운임 없음</div>}
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11.5px]">
        {o.tags.map((t) => <span key={t} className={`rounded px-1.5 py-0.5 ${t === 'cheapest' ? 'bg-accent-soft text-accent' : 'bg-raise text-card-sub'}`}>{TAG[t] || t}</span>)}
        <span className="route-sailings text-card-faint">
          {o.sailings.length ? `배편 ${o.sailings.length}개` : '출발일·선사 · 선사 스케줄 연결 전'}
        </span>
      </div>
    </li>
  );
}

function Routes({ cmp, origin }) {
  const [sort, setSort] = useState('recommended');
  const list = useMemo(() => {
    const xs = [...cmp.options];
    if (sort === 'price') xs.sort((a, b) => (a.price?.usd_per_feu ?? 1e12) - (b.price?.usd_per_feu ?? 1e12));
    if (sort === 'fastest') xs.sort((a, b) => (a.transit.days ?? 1e9) - (b.transit.days ?? 1e9));
    return xs;
  }, [cmp, sort]);
  const sameLane = cmp.lanes_used?.length === 1 && cmp.options.length > 1;
  return (
    <section id="freight-routes" className="mt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div id="route-sorts" className="flex rounded-lg bg-raise p-0.5 text-[12.5px]">
          {SORTS.map(([k, label]) => {
            const on = cmp.sorts.includes(k);
            return (
              <button key={k} data-sort={k} disabled={!on} onClick={() => setSort(k)}
                title={on ? '' : '운항 일수 출처가 연결되면 켜져요'}
                className={`h-8 rounded-md px-3 ${sort === k ? 'bg-card font-semibold text-card-ink shadow-sel' : 'text-card-sub hover:text-card-ink'} disabled:cursor-not-allowed disabled:opacity-40`}>{label}</button>
            );
          })}
        </div>
        <span className="text-[12px] text-card-sub">도착 후보 {cmp.options.length}곳</span>
      </div>
      {sameLane && <div className="mt-2 text-[12px] text-card-sub">이 항구들은 모두 {cmp.options[0].lane.name_ko} 항로라 운임 지수가 같아요 — 항구별 차이는 선사 스케줄을 연결하면 보여요.</div>}
      <ul className="mt-3 space-y-2">{list.map((o) => <RouteCard key={o.id} o={o} origin={origin} />)}</ul>
    </section>
  );
}

function Providers({ list }) {
  return (
    <section id="freight-providers" className="mt-8">
      <h2 className="text-[13px] font-semibold">비교에 쓰는 출처</h2>
      <ul className="mt-2 divide-y divide-card-line rounded-lg ring-1 ring-card-line">
        {list.map((p) => {
          const [label, color] = STATUS[p.status] || [p.status, 'text-card-sub'];
          return (
            <li key={p.id} data-provider={p.id} data-status={p.status} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2.5 text-[12.5px]">
              <b className="font-semibold">{p.name}</b>
              <span className={`text-[11.5px] ${color}`}>{label}</span>
              <span className="w-full text-[11.5px] text-card-sub">{p.gives} — {p.note}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Freight() {
  const [f, setF] = useState({ origin: '부산', destination: '', container: '40', cargo: '' });
  const [weeks, setWeeks] = useState(52);
  const [board, setBoard] = useState(null);
  const [pick, setPick] = useState(['KMDI']);          // 차트에 그릴 항로
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [out, setOut] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    let live = true;
    window.a2a.invoke('freight:board', { weeks }).then((b) => live && setBoard(b), (x) => live && setErr(String(x.message || x)));
    return () => { live = false; };
  }, [weeks]);

  const find = async (e) => {
    e.preventDefault();
    if (!f.destination.trim() || busy) return;
    setBusy(true); setErr(''); setOut(null);
    try {
      const d = await window.a2a.invoke('freight:compare', { ...f, weeks: 13 });
      setOut(d);
      if (d.lanes_used?.length) setPick(d.lanes_used.slice(0, 2));
    } catch (x) { setErr(String(x.message || x)); }
    finally { setBusy(false); }
  };

  const lanes = useMemo(() => (board?.lanes || []).filter((l) => pick.includes(l.code)).sort((a, b) => pick.indexOf(a.code) - pick.indexOf(b.code)), [board, pick]);
  const toggle = (code) => setPick((p) => (p.includes(code) ? (p.length > 1 ? p.filter((c) => c !== code) : p) : [p[p.length - 1], code].slice(-2)));
  const comp = board?.composite;
  const src = board?.source || out?.source;

  return (
    <div id="freight" className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-6 pt-10 pb-16">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[24px] font-bold tracking-tight">해상 운임</h1>
            <p className="mt-1 text-[13px] text-card-sub">부산에서 떠나는 컨테이너의 항로별 운임 시세 — 공개 지수, 매주 월요일 공표</p>
          </div>
          {comp && (
            <div id="freight-composite" className="text-right">
              <div className="text-[11.5px] text-card-sub">종합지수 KCCI · {comp.as_of}</div>
              <div className="flex items-baseline justify-end gap-2 tabular-nums">
                <b className="text-[20px] font-bold">{num(comp.value)}</b><span className="text-[11.5px] text-card-sub">pt</span>
                {comp.change && <span className={`text-[12.5px] ${tone(comp.change.abs)}`}>{signed(comp.change.abs, num)} ({signed(comp.change.pct, (v) => `${v}%`)})</span>}
              </div>
            </div>
          )}
        </div>

        <form onSubmit={find} className="mt-6 grid grid-cols-[1fr_1.4fr_auto_1fr_auto] gap-2 max-sm:grid-cols-2">
          <Field id="freight-origin" placeholder="출발 (부산)" value={f.origin} onChange={set('origin')} />
          <Field id="freight-destination" autoFocus placeholder="도착 나라·항구 (예: 이탈리아, ITGOA)" value={f.destination} onChange={set('destination')} />
          <select id="freight-container" value={f.container} onChange={set('container')} className="h-9 rounded-lg bg-field px-2 text-[13px] ring-1 ring-field-line outline-none">
            <option value="40">40피트</option><option value="20">20피트</option><option value="40HC">40HC</option>
          </select>
          <Field placeholder="화물 (선택)" value={f.cargo} onChange={set('cargo')} />
          <button id="freight-find" disabled={!f.destination.trim() || busy} className="h-9 rounded-lg bg-card-ink px-4 text-[13px] font-semibold text-card disabled:opacity-40">
            {busy ? '읽는 중…' : '운임 보기'}
          </button>
        </form>
        {err && <div id="freight-error" className="mt-3 text-[13px] text-accent">{err}</div>}

        {out && (
          <section id="freight-result" className="mt-5" data-status={out.status}>
            {out.reason && out.status === 'unknown' && <div id="freight-reason" className="rounded-lg bg-raise px-3 py-2.5 text-[13px]">{out.reason}</div>}
            {out.options.length > 0 && <Routes cmp={out} origin={out.origin?.input || '부산'} />}
            {(out.notes || []).map((n) => <div key={n} className="freight-note mt-3 text-[12.5px] text-warn">{n}</div>)}
          </section>
        )}

        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-x-3 text-[13px]">
              {lanes.map((l, k) => (
                <span key={l.code} className="flex items-center gap-1.5"><span className={`${LINE[k]} text-[10px]`}>●</span><b className="font-semibold">부산 → {l.name_ko}</b>
                  {l.usd_per_feu != null && <span className="tabular-nums text-card-sub">{usd(l.usd_per_feu)}</span>}</span>
              ))}
              <span className="text-[11.5px] text-card-faint">표에서 항로를 누르면 둘까지 겹쳐 봐요</span>
            </div>
            <div id="freight-period" className="flex rounded-lg bg-raise p-0.5 text-[12px]">
              {PERIODS.map(([n, label]) => (
                <button key={n} data-weeks={n} onClick={() => setWeeks(n)}
                  className={`h-7 rounded-md px-2.5 ${weeks === n ? 'bg-card font-semibold text-card-ink shadow-sel' : 'text-card-sub hover:text-card-ink'}`}>{label}</button>
              ))}
            </div>
          </div>
          <div className="mt-3">{board ? <Chart lanes={lanes} /> : <div className="grid h-[240px] place-items-center text-[13px] text-card-faint">지수 표를 읽는 중…</div>}</div>
          <div className="text-right text-[11px] text-card-faint">USD / 40피트 한 대(FEU) · 주간</div>
        </section>

        {board && (
          <section className="mt-8">
            <h2 className="text-[13px] font-semibold">부산발 항로 전체 <span className="font-normal text-card-sub">· 기준일 {board.lanes.find((l) => l.as_of)?.as_of}</span></h2>
            <table id="freight-board" className="mt-2 w-full text-[13px]">
              <thead>
                <tr className="border-b border-card-line text-[11.5px] text-card-sub">
                  <th className="py-2 text-left font-normal">항로</th>
                  <th className="py-2 text-right font-normal">지금</th>
                  <th className="py-2 text-right font-normal">전주 대비</th>
                  <th className="py-2 text-right font-normal max-sm:hidden">{PERIODS.find(([n]) => n === weeks)?.[1]} 범위</th>
                  <th className="py-2 pl-4 text-right font-normal max-sm:hidden">추이</th>
                </tr>
              </thead>
              <tbody>
                {board.lanes.map((l) => (
                  <tr key={l.code} data-lane={l.code} onClick={() => toggle(l.code)}
                    className={`cursor-pointer border-b border-card-line last:border-0 hover:bg-raise ${pick.includes(l.code) ? 'bg-raise' : ''}`}>
                    <td className="py-2.5 pl-1">
                      {pick.includes(l.code) && <span className={`${LINE[pick.indexOf(l.code)]} mr-1 text-[9px]`}>●</span>}
                      {l.name_ko} <span className="text-[11px] text-card-faint">{l.code}</span>
                    </td>
                    <td className="py-2.5 text-right font-semibold tabular-nums">{l.usd_per_feu != null ? usd(l.usd_per_feu) : '—'}</td>
                    <td className={`py-2.5 text-right tabular-nums ${tone(l.change?.abs || 0)}`}>{l.change ? `${signed(l.change.abs, num)} (${signed(l.change.pct, (v) => `${v}%`)})` : '—'}</td>
                    <td className="py-2.5 text-right tabular-nums text-card-sub max-sm:hidden">{l.range ? `${num(l.range.low)}~${num(l.range.high)}` : '—'}</td>
                    <td className="py-1 pl-4 text-right max-sm:hidden"><Spark points={l.history} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {out?.providers && <Providers list={out.providers} />}

        {src && (
          <div id="freight-source" className="mt-8 rounded-lg bg-raise px-3 py-3 text-[12px] leading-relaxed text-card-sub">
            <b className="font-semibold text-card-ink">지수 기준 시세예요. 견적이 아니에요.</b> 여러 선사 시세를 항로별로 평균한 값이라 실제 계약 운임과 다를 수 있어요.
            <div className="mt-1">들어 있지 않은 것 — {(board?.not_included || out?.not_included || []).join(', ')}</div>
            <div className="mt-1">출처 — {src.publisher} {src.name} · {src.cadence} ·{' '}
              <a href={src.url} target="_blank" rel="noreferrer" className="break-all text-info hover:underline">{src.url.replace(/^https?:\/\//, '')}</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

document.body.dataset.tone = 'light';
createRoot(document.getElementById('root')).render(<AppFrame current="freight"><Freight /></AppFrame>);
