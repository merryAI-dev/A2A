// 메리 딜룸 — browser/renderer의 화면을 그대로 띄운다. 데이터는 서비스 워커의 invest:call(sw/knowledge.js).
import '../shared/bridge.js';
import { createRoot } from 'react-dom/client';
import { AppFrame } from '../ui/AppNav.jsx';
import '../map/map.css';
import Merry from '../../../browser/renderer/src/Merry.jsx';

// "자료 첨부"는 Electron에서 메인 프로세스의 파일 창이었다 — 확장에서는 이 페이지의 파일 고르기로 같은 일을 한다
function pickFiles() {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: '.pdf,.txt,.md,.csv' });
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}
const invoke = window.a2a.invoke;
window.a2a.invoke = async (ch, name, ...args) => {
  if (ch !== 'invest:call' || name !== 'attach') return invoke(ch, name, ...args);
  const [dealId] = args;
  const out = [];
  for (const f of (await pickFiles()).slice(0, 10)) {
    out.push(await invoke('invest:call', 'attachBytes', dealId, f.name, new Uint8Array(await f.arrayBuffer())));
  }
  if (out.length) await invoke('invest:call', 'readAttached', dealId, out.map((s) => s.id));
  return out;
};

document.body.dataset.tone = 'light';
createRoot(document.getElementById('root')).render(<AppFrame current="merry"><Merry /></AppFrame>);
