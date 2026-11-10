// 서비스 워커의 상태 — Electron main.js의 store + pushState 자리.
// 오래 남길 것(작업·설정·프로필·배경)은 chrome.storage.local, 탭은 chrome.tabs에서 그때그때 읽는다.
import { broadcast } from './hub.js';
import { downloadsList } from './browserdata.js';
import { CFG, ENGINE_LLM_KEY } from './config.js';

const NEWTAB = `chrome-extension://${chrome.runtime.id}/newtab.html`;
const DEFAULTS = {
  tasks: [],                      // { id, title, status, started, ended, steps[], summary, thumb, tabId, room?, pages? }
  prefs: { notify: true, askProfile: false },
  profile: null,                  // { user, tenant }
  wallpaper: 'sky',
  apiKey: '',                     // 직접 넣은 키 — 없으면 엔진 .env의 키를 프록시로 쓴다
};
export const store = { ...DEFAULTS };
export const runtime = { busy: false, currentTaskId: null, tenantName: null, pickProfile: false };
let loaded = null;

export function loadStore() {
  loaded ??= chrome.storage.local.get(Object.keys(DEFAULTS)).then((v) => {
    Object.assign(store, DEFAULTS, v);
    store.prefs = { ...DEFAULTS.prefs, ...(v.prefs || {}) };
    for (const t of store.tasks) if (t.status === 'working') t.status = 'stopped';   // 서비스 워커가 잠들었다 깨면
  });
  return loaded;
}
let saveTimer = null;
export function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    store.tasks = store.tasks.slice(0, 12);
    chrome.storage.local.set({ tasks: store.tasks, prefs: store.prefs, profile: store.profile, wallpaper: store.wallpaper, apiKey: store.apiKey });
  }, 200);
}

// 엔진이 .env 키로 대신 불러 줄 수 있는지 — 서비스 워커가 잠들고 엔진이 늦게 떠도 되게 짧게 캐시한다
let engineCheckedAt = 0;
let engineMisses = 0;
export async function checkEngineLLM() {
  if (runtime.engineLLMOff) { runtime.engineLLM = false; return false; }
  if (Date.now() - engineCheckedAt < (runtime.engineLLM ? 60000 : 5000)) return runtime.engineLLM;
  engineCheckedAt = Date.now();
  try {
    const r = await fetch(`${CFG.engine}/llm/status`, { method: 'POST', signal: AbortSignal.timeout(3000) });
    runtime.engineLLM = r.ok && (await r.json()).available === true;
    engineMisses = 0;
  } catch {
    // 엔진이 긴 답을 흘리느라 한 번 늦게 답했다고 키가 없다고 하지 않는다 — 쓰던 일이 중간에 멈춘다. 연달아 못 닿을 때만 끈다
    if (!runtime.engineLLM || ++engineMisses >= 3) runtime.engineLLM = false;
  }
  return runtime.engineLLM;
}
export const llmKey = () => store.apiKey || (runtime.engineLLM ? ENGINE_LLM_KEY : '');

export const profile = () => ({ user: store.profile?.user || CFG.user, tenant: store.profile?.tenant || CFG.tenant });

// 화면이 쓰는 탭 정보 — Electron tabInfo()와 같은 모양
const isNewtab = (u) => !u || u === NEWTAB || u.startsWith('chrome://newtab') || u.startsWith('chrome://new-tab-page');
export async function tabInfo() {
  const tabs = await chrome.tabs.query({ currentWindow: true }).catch(() => []);
  return tabs.map((t) => ({
    id: t.id, active: t.active, newtab: isNewtab(t.url || t.pendingUrl),
    title: t.title || '새 탭', url: t.url || t.pendingUrl || '', favicon: t.favIconUrl || '',
    loading: t.status === 'loading',
  }));
}

let pushTimer = null;
export function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    await loadStore();
    await checkEngineLLM();
    const p = profile();
    broadcast('state', {
      tabs: await tabInfo(),
      tasks: store.tasks.map(({ _text, ...t }) => t),
      currentTaskId: runtime.currentTaskId,
      busy: runtime.busy,
      user: p.user, tenant: p.tenant, tenantName: runtime.tenantName || p.tenant,
      prefs: store.prefs, hasKey: !!llmKey(), wallpaper: store.wallpaper,
      pickProfile: runtime.pickProfile,
      panelOpen: true,              // 사이드 패널은 열려 있을 때만 화면이 있다
      bookmarks: [],                 // 즐겨찾기는 Chromium이 맡는다
      downloads: await downloadsList(),
      ...(runtime.extraState?.() || {}),
    });
  }, 30);
}

// 탭이 바뀌면 화면에 알린다
for (const ev of ['onActivated', 'onUpdated', 'onRemoved', 'onCreated', 'onMoved']) chrome.tabs[ev].addListener(pushState);
chrome.windows.onFocusChanged.addListener(pushState);
