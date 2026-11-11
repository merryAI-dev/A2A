// 분할 뷰 — 한 창에 탭 둘을 나란히(Chromium의 분할 뷰 그대로). 맨 위 메뉴·옆에서 검색·메리가 함께 쓴다.

// 보낸 화면의 탭을 지금 상태로 다시 읽는다 — 연결할 때 받은 탭 정보는 나뉘기 전 것이다
export async function senderTab(port) {
  const id = port?.sender?.tab?.id;
  return (id != null ? await chrome.tabs.get(id).catch(() => null) : null)
    || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] || null;
}
export const inSplit = (t) => Number.isInteger(t?.splitViewId) && t.splitViewId !== chrome.tabs.SPLIT_VIEW_ID_NONE;
// 옆 칸에 url을 연다 — 이미 나뉘어 있으면 옆 칸의 탭을 바꾸고, 아니면 새 탭을 옆에 붙인다
export async function openBeside(tab, url) {
  if (!tab) return chrome.tabs.create(url ? { url } : {});
  if (inSplit(tab)) {
    const other = (await chrome.tabs.query({ windowId: tab.windowId })).find((t) => t.splitViewId === tab.splitViewId && t.id !== tab.id);
    if (other) return url ? chrome.tabs.update(other.id, { url, active: true }) : other;
  }
  return chrome.tabs.create({ ...(url ? { url } : {}), splitWithTabId: tab.id });
}
// 우리 화면(예: merry.html)이 떠 있는 탭 — 지금 보고 있는 창의 것을 먼저
export async function pageTab(page) {
  const url = chrome.runtime.getURL(page);
  const all = await chrome.tabs.query({ url });
  return all.find((t) => t.active && t.windowId != null) || all[0] || null;
}
