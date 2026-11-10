// 새 탭 — 다리(window.a2a)를 먼저 세운 뒤 Electron 때의 홈 화면("무엇을 맡길까요?")을 그대로 띄운다
import '../shared/bridge.js';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/index.css';
import NewTab from '../ui/NewTab.jsx';
import HomeSidebar from '../ui/HomeSidebar.jsx';
import { useStore } from '../ui/store.js';
import { WALLS } from '../ui/format.js';

function Home() {
  const S = useStore((s) => s.S);
  const custom = useStore((s) => s.custom);
  const name = S?.wallpaper;
  const preset = WALLS.find((w) => w.id === name) || WALLS[0];
  const isCustom = name === 'custom' && custom.img;
  const tone = isCustom ? custom.tone : preset.tone;
  useEffect(() => { document.body.dataset.tone = tone; }, [tone]);
  useEffect(() => {
    if (S) document.getElementById('root').dataset.ok = '1';      // 시험·진단 — 상태를 받아 화면이 섰다
  }, [!!S]);
  if (!S) return null;                                             // 서비스 워커의 첫 상태를 기다린다
  return (
    <>
      {isCustom
        ? <div className="fixed inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${custom.img}")` }} />
        : <div className={`fixed inset-0 wall-${preset.id}`} />}
      <div className="fixed inset-0 grid grid-cols-[248px_minmax(0,1fr)]">
        <HomeSidebar />
        <main className="relative min-w-0"><NewTab /></main>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')).render(<Home />);
