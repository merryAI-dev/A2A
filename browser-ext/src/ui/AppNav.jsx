// 우리 화면 어디서나 보이는 맨 위 메뉴 — 앱(홈·메리·접점 찾기·해상 운임·학습·업무 지도)을 오가는 길은 여기 하나다.
// 탭과 홈 단추는 브라우저 탭 줄이, 대화·채널·기록은 옆 패널이 맡는다 — 같은 목록을 다른 곳에 또 두지 않는다.
import Icon from './Icon.jsx';

export const APPS = [
  { name: '메리', page: 'merry', icon: 'page', label: '메리' },
  { name: '접점 찾기', page: 'contacts', icon: 'people', label: '접점 찾기' },
  { name: '해상 운임', page: 'freight', icon: 'globe', label: '해상 운임' },
  { name: '학습', page: 'learn', icon: 'spark', label: '학습' },
  { name: '업무 지도', page: 'map', icon: 'graph', label: '업무 지도 · 온톨로지' },
];

export default function AppNav({ current }) {
  const go = (name) => window.a2a.send('nav:go', name);
  const cls = (on) => `flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] ${on ? 'bg-card font-semibold text-card-ink' : 'text-card-sub hover:bg-card hover:text-card-ink'}`;
  return (
    <nav id="app-nav" className="no-print flex h-10 shrink-0 items-center gap-1 overflow-x-auto bg-raise px-2 text-card-ink">
      <button id="nav-home" className={cls(current === 'home')} onClick={() => go('홈')}><Icon name="home" className="size-4" />홈</button>
      <span className="mx-1 h-4 w-px shrink-0 bg-card-line" />
      {APPS.map((a) => (
        <button key={a.page} data-app={a.page} className={`${cls(a.page === current)} shrink-0`} onClick={() => go(a.name)}>
          <Icon name={a.icon} className="size-4" />{a.label}
        </button>
      ))}
    </nav>
  );
}

// 전체 화면 페이지 틀 — 메뉴는 브라우저 틀과 같은 면에 이어지고, 아래 칸이 종이처럼 얹힌다.
// 아래 칸이 페이지의 기준 상자다(absolute inset-0 화면을 그대로 받는다). scroll이면 그 칸이 스크롤한다.
export function AppFrame({ current, scroll = false, children }) {
  return (
    <div id="app-frame" className="flex h-screen flex-col bg-raise">
      <AppNav current={current} />
      <div id="app-sheet" className={`relative min-h-0 flex-1 rounded-tl-lg bg-card text-card-ink ${scroll ? 'overflow-y-auto' : 'overflow-hidden'}`}>{children}</div>
    </div>
  );
}
