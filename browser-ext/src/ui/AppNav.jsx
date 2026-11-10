// 우리 화면 어디서나 보이는 맨 위 메뉴 — 홈·메리·접점 찾기·학습·업무 지도를 같은 탭에서 오간다.
import Icon from './Icon.jsx';

export const APPS = [
  { name: '메리', page: 'merry', icon: 'page', label: '메리' },
  { name: '접점 찾기', page: 'contacts', icon: 'people', label: '접점 찾기' },
  { name: '학습', page: 'learn', icon: 'spark', label: '학습' },
  { name: '업무 지도', page: 'map', icon: 'graph', label: '업무 지도 · 온톨로지' },
];

export default function AppNav({ current }) {
  const go = (name) => window.a2a.send('nav:go', name);
  const cls = (on) => `flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] ${on ? 'bg-raise font-semibold text-card-ink' : 'text-card-sub hover:bg-raise hover:text-card-ink'}`;
  return (
    <nav id="app-nav" className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-card-line bg-card px-2 text-card-ink">
      <button id="nav-home" className={cls(false)} onClick={() => go('홈')}><Icon name="home" className="size-4" />홈</button>
      <span className="mx-1 h-4 w-px shrink-0 bg-card-line" />
      {APPS.map((a) => (
        <button key={a.page} data-app={a.page} className={`${cls(a.page === current)} shrink-0`} onClick={() => go(a.name)}>
          <Icon name={a.icon} className="size-4" />{a.label}
        </button>
      ))}
    </nav>
  );
}

// 전체 화면 페이지 틀 — 메뉴 아래 칸이 페이지의 기준 상자가 된다(absolute inset-0 화면을 그대로 받는다)
export function AppFrame({ current, children }) {
  return (
    <div className="flex h-screen flex-col">
      <AppNav current={current} />
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}
