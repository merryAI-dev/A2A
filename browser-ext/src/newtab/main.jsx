// 새 탭(홈) — 다리(window.a2a)를 먼저 세운 뒤 "무엇을 맡길까요?" 화면을 띄운다.
// 앱 이동은 맨 위 메뉴, 대화·채널·기록은 옆 패널이 맡아서 홈에는 따로 목록을 두지 않는다.
import '../shared/bridge.js';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/index.css';
import NewTab from '../ui/NewTab.jsx';
import Icon from '../ui/Icon.jsx';
import { AppFrame } from '../ui/AppNav.jsx';
import { a2a, useStore } from '../ui/store.js';
import { WALLS } from '../ui/format.js';

function WallpaperPicker({ current }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="absolute right-4 bottom-4 z-10">
      {open && (
        <div id="wall-picker" className="absolute right-0 bottom-10 grid w-[216px] grid-cols-3 gap-2 rounded-[14px] bg-card p-3 text-card-ink shadow-card ring-1 ring-card-line">
          {WALLS.map((w) => (
            <button key={w.id} title={w.name} onClick={() => a2a.send('wallpaper:set', w.id)}
                    className={`wall-${w.id} h-[46px] rounded-[10px] shadow-[inset_0_0_0_1px_rgb(0_0_0/.08)] ${current === w.id ? 'outline-2 outline-offset-2 outline-accent' : ''}`} />
          ))}
        </div>
      )}
      <button id="wall-button" title="배경화면" onClick={() => setOpen((v) => !v)}
              className="grid size-8 place-items-center rounded-[10px] bg-glass text-ink ring-1 ring-glass-line backdrop-blur-md hover:bg-hover">
        <Icon name="palette" className="size-4" />
      </button>
    </div>
  );
}

function Home() {
  const S = useStore((s) => s.S);
  const custom = useStore((s) => s.custom);
  const name = S?.wallpaper;
  const preset = WALLS.find((w) => w.id === name) || WALLS[0];
  const isCustom = name === 'custom' && custom.img;
  const tone = isCustom ? custom.tone : preset.tone;
  useEffect(() => {
    if (S) document.getElementById('root').dataset.ok = '1';      // 시험·진단 — 상태를 받아 화면이 섰다
  }, [!!S]);
  if (!S) return null;                                             // 서비스 워커의 첫 상태를 기다린다
  return (
    <AppFrame current="home">
      {/* 배경화면과 그 톤은 이 칸 안에만 — 바깥(메뉴·브라우저 틀)은 늘 밝다 */}
      <div data-tone={tone} className="absolute inset-0 text-ink">
        {isCustom
          ? <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${custom.img}")` }} />
          : <div className={`absolute inset-0 wall-${preset.id}`} />}
        <div className="absolute inset-0"><NewTab /></div>
        <WallpaperPicker current={name} />
      </div>
    </AppFrame>
  );
}

document.body.dataset.tone = 'light';
createRoot(document.getElementById('root')).render(<Home />);
