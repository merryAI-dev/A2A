// 학습 모드 — browser/renderer의 화면을 그대로 띄운다. 데이터는 서비스 워커의 learn:call(sw/knowledge.js).
import '../shared/bridge.js';
import { createRoot } from 'react-dom/client';
import { AppFrame } from '../ui/AppNav.jsx';
import '../map/map.css';
import Learn from '../../../browser/renderer/src/Learn.jsx';

document.body.dataset.tone = 'light';
createRoot(document.getElementById('root')).render(<AppFrame current="learn"><Learn /></AppFrame>);
