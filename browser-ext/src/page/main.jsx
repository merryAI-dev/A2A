import { createRoot } from 'react-dom/client';
import '../shared/bridge.js';
import './page.css';
import { AppFrame } from '../ui/AppNav.jsx';
import PageApp from './PageApp.jsx';

// 명세는 주소 해시에 base64url(JSON)로 온다 — 메인 프로세스가 넣고, agent.js가 모양을 검사한 것만 온다
function readSpec() {
  try {
    const b64 = location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

const data = readSpec();
document.body.dataset.tone = 'light';   // 다른 화면·브라우저 틀과 같이 늘 밝게
createRoot(document.getElementById('root')).render(<AppFrame scroll><PageApp spec={data?.spec ?? null} /></AppFrame>);
