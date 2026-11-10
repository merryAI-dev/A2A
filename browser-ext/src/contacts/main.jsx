// 접점 찾기 — 회사 도메인으로 공개 페이지의 메일과 공식 채널을 찾는 전용 화면. 일은 엔진(/v1/contacts/discover/stream)이 한다.
// 엔진이 찾는 대로 흘려보내는 진행(읽은 페이지·새로 본 주소)을 바로 보여 주고, 끝나면 검증 결과로 바꾼다.
import '../shared/bridge.js';
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import '../map/map.css';
import Icon from '../ui/Icon.jsx';
import { AppFrame } from '../ui/AppNav.jsx';

const VERIFY = {
  smtp_ok: ['수신 확인', 'text-info'], smtp_rejected: ['없는 주소', 'text-accent'],
  smtp_catch_all: ['모든 주소를 받는 곳 · 개별 확인 불가', 'text-card-sub'], mx_ok: ['메일 서버 있음', 'text-card-sub'],
  no_mx: ['메일 서버 없음', 'text-accent'], unknown: ['확인 못 함', 'text-card-faint'], unchecked: ['확인 안 함', 'text-card-faint'],
  checking: ['확인하는 중…', 'text-card-faint'],
};
const Field = (p) => <input {...p} className={`h-9 rounded-lg bg-field px-3 text-[13px] ring-1 ring-field-line outline-none focus:ring-card-faint ${p.className || ''}`} />;
const Tag = ({ children }) => <span className="rounded bg-raise px-1.5 py-0.5 text-[11px] text-card-sub">{children}</span>;

function Email({ e }) {
  const [copied, setCopied] = useState(false);
  const [label, color] = VERIFY[e.verify?.status] || VERIFY.unknown;
  const src = e.sources?.[0];
  const copy = async () => { await navigator.clipboard.writeText(e.address); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  return (
    <li className="contact-row border-b border-card-line py-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-[14px] font-semibold select-text">{e.address}</b>
        <button title="주소 복사" onClick={copy} className="grid size-6 place-items-center rounded-md text-card-sub hover:bg-raise">
          <Icon name={copied ? 'check' : 'copy'} className="size-3.5" />
        </button>
        {e.generic && <Tag>대표 주소</Tag>}
        {!e.same_domain && <Tag>다른 도메인</Tag>}
        <span className={`text-[11.5px] ${color}`} title={e.verify?.detail || ''}>{label}</span>
      </div>
      {src && (
        <div className="mt-1 text-[12px] leading-relaxed text-card-sub">
          “{src.quote}”{' '}
          <a href={src.url} target="_blank" rel="noreferrer" className="break-all text-info hover:underline">{src.url}</a>
        </div>
      )}
      {e.method === 'pattern' && <div className="mt-1 text-[12px] text-card-sub">이 회사의 메일 형식으로 추측한 주소입니다({e.pattern}). 출처가 없으니 보내기 전에 확인하세요.</div>}
    </li>
  );
}

const Channel = ({ c }) => (
  <li className="channel-row flex flex-wrap items-baseline gap-x-2 border-b border-card-line py-2 text-[13px] last:border-0">
    <b className="w-[92px] shrink-0 font-semibold">{c.site}</b>
    <a href={c.url} target="_blank" rel="noreferrer" className="break-all text-info hover:underline">{c.url.replace(/^https?:\/\/(www\.)?/, '')}</a>
    <span className="text-[11.5px] text-card-sub">
      {c.method === 'linked' ? '홈페이지에 링크됨' : c.mentions_domain ? '계정 페이지에 회사 도메인이 적혀 있음' : '이름만 같음'}
    </span>
  </li>
);

// 공식 채널 — 홈페이지가 링크했거나 계정 페이지에 회사 도메인이 적힌 것만 위에, 이름만 같은 계정은 접어 둔다
function Channels({ list }) {
  const sure = list.filter((c) => c.method === 'linked' || c.mentions_domain);
  const maybe = list.filter((c) => !(c.method === 'linked' || c.mentions_domain));
  if (!list.length) return null;
  return (
    <div id="contact-channels" className="mt-7">
      <h2 className="text-[13px] font-semibold">공식 채널</h2>
      {sure.length > 0 ? <ul className="mt-1">{sure.map((c) => <Channel key={c.url} c={c} />)}</ul>
        : <div className="mt-1 text-[12px] text-card-sub">홈페이지가 직접 링크한 계정은 찾지 못했어요.</div>}
      {maybe.length > 0 && (
        <details className="mt-2 text-[12px] text-card-sub">
          <summary className="cursor-pointer select-none">이름만 같은 계정 {maybe.length}개 — 이 회사 것인지 확인이 필요해요</summary>
          <ul className="mt-1">{maybe.map((c) => <Channel key={c.url} c={c} />)}</ul>
        </details>
      )}
    </div>
  );
}

function Contacts() {
  const [f, setF] = useState({ domain: '', company: '', person_first: '', person_last: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [out, setOut] = useState(null);
  const [live, setLive] = useState(null);          // 찾는 중 — { pages, at, step, emails }
  const run = useRef('');
  useEffect(() => window.a2a.on('contacts:progress', (ev) => {
    if (ev.run !== run.current) return;
    setLive((l) => {
      if (!l) return l;
      if (ev.type === 'page') return { ...l, pages: ev.pages, at: ev.url, step: '' };
      if (ev.type === 'email') return { ...l, emails: [...l.emails, { ...ev.email, verify: { status: 'checking' } }] };
      if (ev.type === 'channel') return { ...l, channels: [...l.channels, ev.channel] };
      if (ev.type === 'step') return { ...l, step: ev.text };
      return l;
    });
  }), []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const find = async (e) => {
    e.preventDefault();
    if (!f.domain.trim() || busy) return;
    run.current = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setBusy(true); setErr(''); setOut(null); setLive({ pages: 0, at: '', step: '', emails: [], channels: [] });
    try { setOut(await window.a2a.invoke('contacts:find', { ...f, run: run.current })); setLive(null); }
    catch (x) { setErr(String(x.message || x)); }      // 멈춰도 그때까지 본 주소는 화면에 남긴다
    finally { setBusy(false); }
  };
  const shown = out?.emails || live?.emails || [];
  const found = shown.filter((x) => x.method !== 'pattern');
  const guessed = shown.filter((x) => x.method === 'pattern');
  return (
    <div id="contacts" className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-6 pt-10 pb-16">
        <h1 className="text-[24px] font-bold tracking-tight">접점 찾기</h1>
        <p className="mt-1 mb-6 text-[13px] text-card-sub">회사 도메인을 넣으면 공개 페이지에서 메일 주소와 공식 채널을 찾아 출처와 함께 보여 드려요.</p>
        <form onSubmit={find} className="grid grid-cols-2 gap-2">
          <Field id="contact-domain" autoFocus className="col-span-2" placeholder="회사 도메인 (예: mysc.co.kr)" value={f.domain} onChange={set('domain')} />
          <Field placeholder="회사 이름 (선택)" className="col-span-2" value={f.company} onChange={set('company')} />
          <Field placeholder="담당자 이름 (선택 · 영문, 예: Hana)" value={f.person_first} onChange={set('person_first')} />
          <Field placeholder="담당자 성 (선택 · 영문, 예: Park)" value={f.person_last} onChange={set('person_last')} />
          <button id="contact-find" disabled={!f.domain.trim() || busy} className="col-span-2 mt-1 h-9 rounded-lg bg-card-ink text-[13px] font-semibold text-card disabled:opacity-40">
            {busy ? '찾는 중…' : '메일 찾기'}
          </button>
        </form>
        {err && <div className="mt-4 text-[13px] text-accent">{err}</div>}
        {!out && live && (
          <section id="contact-live" className="mt-8">
            <div className="text-[13px] text-card-sub">
              {busy ? (live.step || `페이지 ${live.pages}장을 읽었어요${live.at ? ` · ${live.at.replace(/^https?:\/\//, '')}` : ' · 첫 페이지를 여는 중…'}`) : `페이지 ${live.pages}장까지 읽고 멈췄어요 — 아래는 그때까지 본 주소예요(검증 전).`}
              {' '}· 주소 {live.emails.length}개
            </div>
            {found.length > 0 && <ul className="mt-3">{found.map((e) => <Email key={e.address} e={e} />)}</ul>}
            <Channels list={live.channels} />
          </section>
        )}
        {out && (
          <section id="contact-result" className="mt-8">
            <div className="text-[13px] text-card-sub">{out.domain} · 페이지 {out.pages.length}장을 읽었어요{out.errors?.length ? ` · ${out.errors.length}장 실패` : ''}{out.patterns?.length ? ` · 메일 형식 ${out.patterns.map((p) => p.pattern).join(', ')}` : ''}</div>
            {!out.emails.length && <div className="mt-4 text-[14px]">공개 페이지에서 메일 주소를 찾지 못했어요.</div>}
            {found.length > 0 && <ul className="mt-3">{found.map((e) => <Email key={e.address} e={e} />)}</ul>}
            {guessed.length > 0 && (
              <>
                <h2 className="mt-6 text-[13px] font-semibold">추측한 주소</h2>
                <ul className="mt-1">{guessed.map((e) => <Email key={e.address} e={e} />)}</ul>
              </>
            )}
            <Channels list={out.channels || []} />
          </section>
        )}
      </div>
    </div>
  );
}

document.body.dataset.tone = 'light';
createRoot(document.getElementById('root')).render(<AppFrame current="contacts"><Contacts /></AppFrame>);
