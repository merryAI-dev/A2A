// 해상 운임 — 부산에서 떠나는 컨테이너의 구간 운임 지수를 보는 전용 화면. 일은 엔진(/v1/freight/ocean)이 한다.
// 에이전트 도구(ocean_freight_rate)와 같은 경로다. 숫자는 지수(구간 평균 시세)이고 견적이 아니다 — 화면도 그렇게 말한다.
// 시세 화면의 읽는 법을 따른다: 큰 숫자 하나, 그 옆에 부호 붙은 변화량(오르면 빨강·내리면 파랑), 숫자는 자리 맞춘 오른쪽 정렬,
// 색은 변화량에만 쓰고, 기준일과 출처는 숫자 바로 아래에 둔다.
import '../shared/bridge.js';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import '../map/map.css';
import { AppFrame } from '../ui/AppNav.jsx';

const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const Field = (p) => <input {...p} className={`h-9 rounded-lg bg-field px-3 text-[13px] ring-1 ring-field-line outline-none focus:ring-card-faint ${p.className || ''}`} />;
const tone = (n) => (n > 0 ? 'text-up' : n < 0 ? 'text-down' : 'text-card-sub');
const signed = (n, f = (x) => x) => `${n > 0 ? '+' : n < 0 ? '-' : ''}${f(Math.abs(n))}`;

// 추이 선 — 축·눈금 없이 모양만. 마지막 점이 지금 값이다.
function Spark({ points, up }) {
  if (points.length < 2) return null;
  const W = 220, H = 56, vals = points.map((p) => p.value);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * (W - 6) + 3, H - 5 - ((p.value - lo) / span) * (H - 10)]);
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg className={`freight-spark ${up ? 'text-up' : 'text-down'}`} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`${points[0].date}부터 ${points[points.length - 1].date}까지 추이`}>
      <polyline fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" points={xy.map((p) => p.join(',')).join(' ')} />
      <circle cx={lx} cy={ly} r="3" fill="currentColor" />
    </svg>
  );
}

// 최근 범위 안에서 지금 값이 어디쯤인지
function Range({ lane }) {
  const { low, high, weeks } = lane.range;
  const at = high > low ? ((lane.usd_per_feu - low) / (high - low)) * 100 : 50;
  return (
    <div className="mt-4">
      <div className="flex justify-between text-[11.5px] text-card-sub"><span>최근 {weeks}주 범위</span><span className="tabular-nums">{usd(low)} ~ {usd(high)}</span></div>
      <div className="relative mt-1.5 h-1 rounded-full bg-raise">
        <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-card-ink" style={{ left: `${at}%` }} />
      </div>
    </div>
  );
}

function Lane({ lane }) {
  if (lane.usd_per_feu == null) return <div className="freight-lane border-b border-card-line py-5 text-[13px] text-card-sub">{lane.name_ko} — 이번 표에 값이 없어요.</div>;
  const ch = lane.change;
  return (
    <div className="freight-lane border-b border-card-line py-5 last:border-0" data-lane={lane.code}>
      <div className="text-[12px] text-card-sub">부산 → {lane.name_ko} <span className="text-card-faint">{lane.code} · {lane.name}</span></div>
      <div className="mt-1 flex items-end justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-2">
            <b className="freight-rate text-[32px] leading-none font-bold tracking-tight tabular-nums">{usd(lane.usd_per_feu)}</b>
            <span className="text-[12.5px] text-card-sub">40피트 한 대</span>
          </div>
          {ch && (
            <div className={`freight-change mt-1.5 text-[13px] tabular-nums ${tone(ch.abs)}`}>
              {signed(ch.abs, usd)} ({signed(ch.pct, (x) => `${x}%`)}) <span className="text-card-faint">전주 {lane.previous.as_of} 대비</span>
            </div>
          )}
        </div>
        <Spark points={lane.history} up={lane.history[lane.history.length - 1].value >= lane.history[0].value} />
      </div>
      <Range lane={lane} />
      <div className="freight-asof mt-3 text-[11.5px] text-card-sub">기준일 {lane.as_of}{lane.stale ? ' · 공표가 2주 넘게 없었어요' : ''}</div>
    </div>
  );
}

function Freight() {
  const [f, setF] = useState({ origin: '부산', destination: '', container: '40', cargo: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [out, setOut] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const find = async (e) => {
    e.preventDefault();
    if (!f.destination.trim() || busy) return;
    setBusy(true); setErr(''); setOut(null);
    try { setOut(await window.a2a.invoke('freight:ocean', f)); }
    catch (x) { setErr(String(x.message || x)); }
    finally { setBusy(false); }
  };
  return (
    <div id="freight" className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto max-w-[680px] px-6 pt-10 pb-16">
        <h1 className="text-[24px] font-bold tracking-tight">해상 운임</h1>
        <p className="mt-1 mb-6 text-[13px] text-card-sub">부산에서 보내는 컨테이너의 구간별 운임 시세를 공개 지수에서 읽어 기준일·출처와 함께 보여 드려요.</p>
        <form onSubmit={find} className="grid grid-cols-2 gap-2">
          <Field id="freight-origin" placeholder="출발 (부산)" value={f.origin} onChange={set('origin')} />
          <Field id="freight-destination" autoFocus placeholder="도착 나라·항구 (예: 이탈리아, ITGOA)" value={f.destination} onChange={set('destination')} />
          <select id="freight-container" value={f.container} onChange={set('container')} className="h-9 rounded-lg bg-field px-2 text-[13px] ring-1 ring-field-line outline-none">
            <option value="40">40피트 일반</option><option value="20">20피트 일반</option><option value="40HC">40피트 하이큐브</option>
          </select>
          <Field placeholder="화물 (선택 · 예: 가구)" value={f.cargo} onChange={set('cargo')} />
          <button id="freight-find" disabled={!f.destination.trim() || busy} className="col-span-2 mt-1 h-9 rounded-lg bg-card-ink text-[13px] font-semibold text-card disabled:opacity-40">
            {busy ? '읽는 중…' : '운임 보기'}
          </button>
        </form>
        {err && <div id="freight-error" className="mt-4 text-[13px] text-accent">{err}</div>}
        {out && (
          <section id="freight-result" className="mt-6" data-status={out.status}>
            {out.reason && <div id="freight-reason" className="rounded-lg bg-raise px-3 py-2.5 text-[13px]">{out.reason}</div>}
            {out.lanes.map((l) => <Lane key={l.code} lane={l} />)}
            {(out.notes || []).map((n) => <div key={n} className="freight-note mt-3 text-[12.5px] text-warn">{n}</div>)}
            {out.lanes.length > 0 && (
              <div id="freight-source" className="mt-6 rounded-lg bg-raise px-3 py-3 text-[12px] leading-relaxed text-card-sub">
                <b className="font-semibold text-card-ink">지수 기준 시세예요. 견적이 아니에요.</b> 여러 선사 시세를 구간별로 평균한 값이라 실제 계약 운임과 다를 수 있어요.
                <div className="mt-1">들어 있지 않은 것 — {out.not_included.join(', ')}</div>
                <div className="mt-1">출처 — {out.source.publisher} {out.source.name} · {out.source.cadence} ·{' '}
                  <a href={out.source.url} target="_blank" rel="noreferrer" className="break-all text-info hover:underline">{out.source.url.replace(/^https?:\/\//, '')}</a>
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

document.body.dataset.tone = 'light';
createRoot(document.getElementById('root')).render(<AppFrame current="freight"><Freight /></AppFrame>);
