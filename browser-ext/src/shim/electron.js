// browser/ema-mcp.js가 쓰는 Electron 표면만 — 로그인 토큰 보관은 브라우저 세션 메모리(chrome.storage.session).
// 디스크(IndexedDB)에는 자리표시자만 남는다: "평문으로 저장하지 않는다"는 ema-mcp.js의 규칙을 그대로 지키고,
// 서비스 워커가 잠들었다 깨도 로그인은 유지되며, 브라우저를 다시 켜면 다시 로그인한다.
const KEY = 'emaOAuth';
let mem = null;

export async function loadSafeStorage() {
  mem = (await chrome.storage.session.get(KEY))[KEY] ?? null;
}
export const app = { getPath: () => '/userData' };
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(s) {
    mem = s;
    chrome.storage.session.set({ [KEY]: s }).catch((e) => console.warn('[ema] 세션 저장 실패', e));
    return 'session-only';
  },
  decryptString() {
    if (mem == null) throw new Error('이번 브라우저 세션의 로그인이 없습니다');
    return mem;
  },
};
export default { app, safeStorage };
