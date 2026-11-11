// A2A 서비스 워커 — 상태·탭·작업·에이전트·팀 채팅 다리(Electron main.js의 확장판).
import '../shim/globals.js';
import { on, handle, broadcast } from './hub.js';
import { store, runtime, loadStore, saveStore, pushState, profile } from './state.js';
import { CFG, ourUrl } from './config.js';
import { httpUrl } from './agent.js';
import { MODELS, SYNC_MODES, syncChanged } from './knowledge.js';
import './browserdata.js';
import './chat.js';
import './tasks.js';
import './menus.js';

// 툴바 버튼을 누르면 사이드 패널이 열리게
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
loadStore().then(pushState);

// 에이전트 패널은 브라우저의 일부다 — 창마다 처음 한 번 연다. 사용자가 닫으면 다시 열지 않는다
// (서비스 워커가 깰 때마다 열리지 않게 연 창을 세션 저장소에 적어 둔다).
async function openAgentPanel(win) {
  if (win.type !== 'normal' || win.incognito) return;
  const { panelOpened = [] } = await chrome.storage.session.get('panelOpened');
  if (panelOpened.includes(win.id)) return;
  await chrome.storage.session.set({ panelOpened: [...panelOpened, win.id] });
  chrome.sidePanel.open({ windowId: win.id }).catch((e) => console.warn('[panel]', e.message));
}
// 즐겨찾기에 우리 화면을 처음 한 번 넣는다(Electron 사이드바의 메리·학습·업무 지도 자리)
async function seedBookmarks() {
  const { bookmarksSeeded } = await chrome.storage.local.get('bookmarksSeeded');
  if (bookmarksSeeded) return;
  await chrome.storage.local.set({ bookmarksSeeded: true });
  for (const [title, page] of [['메리', 'merry.html'], ['학습', 'learn.html'], ['업무 지도', 'map.html']]) {
    await chrome.bookmarks.create({ parentId: '1', title, url: chrome.runtime.getURL(page) }).catch((e) => console.warn('[bookmarks]', e.message));
  }
}
// 나중에 생긴 화면은 이미 쓰던 프로필에도 한 번 넣는다
async function seedContactsBookmark() {
  const { contactsSeeded } = await chrome.storage.local.get('contactsSeeded');
  if (contactsSeeded) return;
  await chrome.storage.local.set({ contactsSeeded: true });
  await chrome.bookmarks.create({ parentId: '1', title: '접점 찾기', url: chrome.runtime.getURL('contacts.html') }).catch((e) => console.warn('[bookmarks]', e.message));
}
seedBookmarks().then(seedContactsBookmark);
chrome.windows.onCreated.addListener(openAgentPanel);
chrome.windows.getAll().then((all) => all.forEach(openAgentPanel)).catch(() => {});

on('ui:ping', () => {});
// 홈에서 고른 대화를 옆 패널이 연다
on('room:go', (room) => broadcast('room:go', room));
on('ui:hello', () => { pushState(); broadcast('hello', { at: Date.now() }); });
handle('sys:ping', () => ({ pong: true, id: chrome.runtime.id, version: chrome.runtime.getManifest().version }));

// ── 탭 ── (Electron의 tab:* — 실제 탭은 Chromium이 맡고 우리는 고르기·열기만)
on('tab:switch', async (id) => {
  if (!Number.isInteger(id)) return;
  const t = await chrome.tabs.update(id, { active: true }).catch(() => null);
  if (t) chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
});
// 새 탭의 '검색' 칸 — 주소면 열고, 아니면 검색(Electron resolveInput과 같은 규칙). 그 새 탭 자리에서 연다.
const searchUrl = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
on('nav:go', async (raw, port) => {
  const input = String(raw || '').trim();
  if (!input) return;
  const tabId = port?.sender?.tab?.id;
  const open = (url) => (tabId != null ? chrome.tabs.update(tabId, { url }) : chrome.tabs.create({ url }));
  // 우리 화면 — a2a://메리, 또는 그냥 "메리"(Electron 주소창과 같다)
  const page = ourUrl(input);
  if (page) return open(page);
  const looksUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) || /^[^\s]+\.[a-z]{2,}(\/|:|$)/i.test(input) || /^localhost(:\d+)?/.test(input);
  const url = looksUrl ? httpUrl(input) : searchUrl(input);
  if (url) open(url);
});
// 화면에서 끌어 고른 글 검색 — 여느 브라우저처럼 보던 탭에서 연다(뒤로 가기로 돌아온다).
// 사이드 패널에서 고른 글은 패널 옆의 지금 탭에서 연다.
on('search:text', async (raw, port) => {
  const q = String(raw || '').trim().slice(0, 500);
  if (!q) return;
  const tabId = port?.sender?.tab?.id ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  if (tabId != null) chrome.tabs.update(tabId, { url: searchUrl(q) });
  else chrome.tabs.create({ url: searchUrl(q) });
});
// 메리·학습의 근거 링크 — 새 탭으로
on('bookmark:open', (url) => { const u = httpUrl(String(url || '')); if (u) chrome.tabs.create({ url: u }); });
on('tab:new', (url) => chrome.tabs.create(typeof url === 'string' && /^https?:\/\//.test(url) ? { url } : {}));

// ── 설정 ──
on('prefs:set', async (key, value) => {
  await loadStore();
  if (key === 'notify' && typeof value === 'boolean') store.prefs.notify = value;
  else if (key === 'askProfile' && typeof value === 'boolean') store.prefs.askProfile = value;
  else if ((key === 'worktype' || key === 'recall') && typeof value === 'boolean') store.prefs[key] = value;
  else if (key === 'agentModel' && Object.hasOwn(MODELS, value)) store.prefs.agentModel = value;
  else if (key === 'sync' && SYNC_MODES.includes(value)) { store.prefs.sync = value; saveStore(); syncChanged(); }
  else return;
  saveStore();
  pushState();
});
on('wallpaper:set', async (name) => { await loadStore(); store.wallpaper = String(name).slice(0, 32); saveStore(); pushState(); });
// 개발용 API 키 — 마이페이지에서 넣는다(운영에선 엔진 프록시로 바꾼다)
handle('key:set', async (k) => {
  await loadStore();
  if (typeof k !== 'string' || (k && !/^sk-ant-[\w-]{20,}$/.test(k.trim()))) throw new Error('Anthropic API 키 모양이 아닙니다');
  store.apiKey = k.trim();
  saveStore();
  pushState();
  return { ok: true };
});

// 작업 열기 — 그 작업이 일하던 탭으로
on('task:open', async (id) => {
  await loadStore();
  const t = store.tasks.find((x) => x.id === id);
  if (t?.tabId) chrome.tabs.update(t.tabId, { active: true }).catch(() => {});
});

// A2A 웹앱에서 열기(채널 머리의 ↗)
on('web:open', () => chrome.tabs.create({ url: `${CFG.web}/?as=${encodeURIComponent(profile().user)}` }));
