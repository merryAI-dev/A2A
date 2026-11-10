// browser/ema-mcp.js의 OAuth 콜백 서버 자리 — 확장(MV3)은 포트를 열 수 없다.
// 포트를 열지 않고, 로그인 탭이 http://127.0.0.1:<port>/callback?... 로 넘어가는 순간을 잡아 같은 처리기를 부른다.
const servers = new Map();            // port → handler

function dispatch(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return; }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') return;
  const handler = servers.get(Number(u.port));
  if (!handler) return;
  const key = `${u.port}${u.pathname}${u.search}`;
  if (seen.has(key)) return;
  seen.add(key);
  handler({ url: `${u.pathname}${u.search}`, method: 'GET', headers: {} }, { writeHead() {}, end() {} });
}
const seen = new Set();
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  const url = info.url || tab.pendingUrl || tab.url;
  if (url) dispatch(url);
});

export function createServer(handler) {
  let port = 0;
  return {
    once() { return this; },
    listen(p, _host, cb) { port = p || 47823; servers.set(port, handler); cb?.(); return this; },
    address: () => ({ port }),
    close() { servers.delete(port); seen.clear(); },
  };
}
export default { createServer };
export const __dispatchForTest = dispatch;
