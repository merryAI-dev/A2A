// 홈 왼쪽 사이드바 — Electron 때의 배치. 앱·AI 채팅·팀 채널을 고르면 앱은 이 탭에서, 대화는 옆 패널에서 열린다.
// 탭과 즐겨찾기는 Chromium 자체 화면이 맡아서 여기엔 두지 않는다.
import { useState } from 'react';
import Icon from './Icon.jsx';
import { APPS } from './AppNav.jsx';
import { Avatar } from './Mentions.jsx';
import { a2a, useStore } from './store.js';
import { WALLS, statusText, STATUS_DOT } from './format.js';

const ROW = 'group flex h-8 w-full items-center gap-2.5 rounded-[9px] pr-2 pl-2.5 text-left text-[13px] text-ink transition-colors hover:bg-hover';
const roomGo = (room) => { a2a.send('room:go', room); a2a.send('panel:set', true); };

function Section({ title, children }) {
  return (
    <section className="mt-3">
      <h6 className="m-0 mb-[3px] flex h-[22px] items-center pl-2.5 text-[11.5px] font-semibold text-sub">{title}</h6>
      {children}
    </section>
  );
}

export default function HomeSidebar() {
  const S = useStore((s) => s.S);
  const me = useStore((s) => s.me);
  const channels = useStore((s) => s.channels);
  const [walls, setWalls] = useState(false);
  const chats = S.tasks.filter((t) => !t.room).slice(0, 8);
  return (
    <aside id="home-sidebar" className="flex min-w-0 flex-col overflow-hidden bg-glass backdrop-blur-2xl backdrop-saturate-150">
      <button onClick={() => roomGo({ kind: 'me' })} className="mx-1.5 mt-3 mb-1 flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left hover:bg-hover">
        <Avatar id={me?.user_id || S.user} name={me?.display_name || S.user} size="ws" />
        <span className="flex min-w-0 flex-1 flex-col leading-tight text-ink">
          <b className="truncate text-[13.5px] font-semibold">{me?.display_name || S.user}</b>
          <span className="truncate text-[11.5px] text-sub">{S.tenantName || S.tenant}</span>
        </span>
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [&::-webkit-scrollbar]:w-0">
        <Section title="앱">
          {APPS.map((a) => (
            <button key={a.page} data-app={a.page} className={ROW} onClick={() => a2a.send('nav:go', a.name)}>
              <Icon name={a.icon} className="size-4 text-sub" /><span className="min-w-0 flex-1 truncate">{a.label}</span>
            </button>
          ))}
        </Section>
        <Section title="AI 채팅">
          <button className={`${ROW} text-sub`} onClick={() => roomGo({ kind: 'ai', id: null })}>
            <Icon name="compose" className="size-4" /><span className="min-w-0 flex-1 truncate">새 AI 채팅</span>
          </button>
          {chats.map((t) => (
            <button key={t.id} title={statusText(t)} className={ROW} onClick={() => roomGo({ kind: 'ai', id: t.id })}>
              <span className={`mx-1 size-[7px] shrink-0 rounded-full ${STATUS_DOT[t.status]}`} />
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
            </button>
          ))}
        </Section>
        <Section title="팀 채널">
          {channels === null && <div className="px-2.5 py-1.5 text-xs text-faint">불러오는 중…</div>}
          {channels?.length === 0 && <div className="px-2.5 py-1.5 text-xs text-faint">채널을 불러오지 못했습니다</div>}
          {channels?.slice(0, 10).map((c) => (
            <button key={c.id} className={ROW} onClick={() => roomGo({ kind: 'channel', id: c.id })}>
              <Icon name={c.visibility === 'private' ? 'lock' : 'hash'} className="size-4 text-sub" />
              <span className={`min-w-0 flex-1 truncate ${c.unread > 0 ? 'font-semibold' : ''}`}>{c.name}</span>
              {c.unread > 0 && <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-sel px-1 text-[10.5px] font-bold">{c.unread > 99 ? '99+' : c.unread}</span>}
            </button>
          ))}
        </Section>
      </div>
      <div className="relative shrink-0 px-2 pt-1.5 pb-2.5">
        {walls && (
          <div className="absolute right-2 bottom-[50px] left-2 z-10 grid grid-cols-3 gap-2 rounded-[14px] bg-card p-3 text-card-ink shadow-[0_10px_40px_rgb(0_0_0/.22)] ring-1 ring-card-line">
            {WALLS.map((w) => (
              <button key={w.id} title={w.name} onClick={() => a2a.send('wallpaper:set', w.id)}
                      className={`wall-${w.id} h-[46px] rounded-[10px] shadow-[inset_0_0_0_1px_rgb(0_0_0/.08)] ${S.wallpaper === w.id ? 'outline-2 outline-offset-2 outline-accent' : ''}`} />
            ))}
          </div>
        )}
        <button className={ROW} onClick={() => roomGo({ kind: 'history' })}><Icon name="clock" className="size-4 text-sub" />방문 기록</button>
        <button className={ROW} onClick={() => roomGo({ kind: 'downloads' })}><Icon name="download" className="size-4 text-sub" />다운로드</button>
        <button className={ROW} onClick={() => setWalls((v) => !v)}><Icon name="palette" className="size-4 text-sub" />배경화면</button>
      </div>
    </aside>
  );
}
