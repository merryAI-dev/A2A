// 개발 환경 기본값 — Electron 앱(main.js CFG)과 같다. 실제 로그인을 붙이면 계정은 하나만 남는다.
// 엔진 프록시를 쓸 때 진짜 키 대신 SDK에 넘기는 자리표시자 — 진짜 키는 엔진 .env에만 있다
export const ENGINE_LLM_KEY = 'a2a-engine-proxy';
// 이름으로 여는 우리 화면 — 주소창·채팅·에이전트 도구가 같은 표를 쓴다
const OUR_PAGES = { 홈: 'newtab.html', 메리: 'merry.html', 학습: 'learn.html', 업무지도: 'map.html', 온톨로지: 'map.html', 접점: 'contacts.html', 접점찾기: 'contacts.html', 헌터: 'contacts.html', 운임: 'freight.html', 해상운임: 'freight.html', 물류: 'freight.html' };
export const ourPage = (name) => OUR_PAGES[String(name).trim().replace(/^a2a:\/\//, '').replace(/\s+/g, '')];
export const ourUrl = (name) => { const p = ourPage(name); return p && (p === 'newtab.html' ? 'chrome://newtab/' : chrome.runtime.getURL(p)); };
export const CFG = {
  engine: 'http://localhost:8423',
  web: 'http://localhost:3200',
  user: 'boram',
  tenant: 'test',
  devUsers: ['boram', 'alice', 'bob', 'carol', 'acme_ceo'],
};
