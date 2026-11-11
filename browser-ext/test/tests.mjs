// 확장 시험 항목 — 단계별로 더한다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE, LOGIN, SAMPLE_PAGE } from './fixtures.mjs';

// 시험용 웹서버(127.0.0.1, 빈 포트) — 호텔 소개·로그인·진짜 입력 확인 페이지
const TRUSTED = `<!doctype html><meta charset="utf-8"><title>입력 확인</title>
<input id="t" placeholder="이름" style="font-size:20px;margin:40px"><button id="b" style="font-size:20px">확인</button><p id="log"></p>
<script>const log = (s) => { document.getElementById('log').textContent += s + ' '; };
document.getElementById('t').addEventListener('input', (e) => log('input:' + e.isTrusted));
document.getElementById('b').addEventListener('click', (e) => log('click:' + e.isTrusted));</script>`;
let server = null;
async function site() {
  if (server) return server;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url === '/login' ? LOGIN : req.url === '/trusted' ? TRUSTED : FIXTURE);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  server = `http://127.0.0.1:${srv.address().port}`;
  return server;
}
// 개발용 키 — Electron 앱과 같은 A2A/.env (없으면 진짜 에이전트 시험은 건너뛴다)
function devKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const env = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'), 'utf8');
    return (env.match(/^ANTHROPIC_API_KEY=(.*)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  } catch { return ''; }
}
export default function register(test) {

// M1 — 뼈대: 확장이 실리고, 사이드 패널·새 탭이 서비스 워커와 이야기한다
test('m1-extension-loaded', async ({ cdp, EXT, swEval }) => {
  const m = await swEval(cdp, 'chrome.runtime.getManifest()');
  return { ok: m.name === 'A2A Browser' && m.manifest_version === 3, id: EXT };
});
test('m1-sidepanel-bridge', async ({ cdp, EXT, Page }) => {
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await p.waitFor('!!window.a2a');
  const r = await p.eval("window.a2a.invoke('sys:ping')");
  await p.close();
  return { ok: !!r, r };
});
test('m1-newtab-override', async ({ cdp, EXT, Page }) => {
  const p = await Page.open(cdp, 'chrome://newtab/');
  const ok = await p.waitFor("document.getElementById('root')?.dataset.ok === '1'");
  const url = await p.eval('location.href');
  await p.close();
  return { ok: !!ok && url.startsWith(EXT), url };
});

// M2 — 상태: 서비스 워커가 탭·작업·설정을 보내고, 사이드 패널이 Electron 때 채팅방 화면을 그린다
test('m2-sidepanel-room', async ({ cdp, EXT, Page }) => {
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  const ok = await p.waitFor("!!document.querySelector('#room-title') && !!document.querySelector('textarea')");
  await p.shot('m2-sidepanel.png', { width: 420, height: 820 });
  const text = await p.eval('document.body.innerText.slice(0, 300)');
  await p.close();
  return { ok: !!ok, text };
});
// 키가 없으면 보낸 글이 조용히 사라지면 안 된다 — 글은 남고 키 입력칸이 보인다
test('m2-no-key-keeps-text-and-asks', async ({ cdp, EXT, Page, swEval, sleep }) => {
  await swEval(cdp, 'globalThis.a2a.engineLLMOff(true)');            // 엔진 프록시까지 없는 상태
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await p.waitFor("!!document.querySelector('#composer')");
  const shown = await p.waitFor("!!document.querySelector('#key-input')", 5000);
  await p.focus('#composer');
  await p.type('키 없이 보내기');
  await p.key('Enter');
  await sleep(400);
  const value = await p.eval("document.querySelector('#composer').value");
  await p.eval("window.a2a.invoke('key:set', 'nope').catch((e) => e.message)");
  await p.close();
  await swEval(cdp, 'globalThis.a2a.engineLLMOff(false)');
  return { ok: !!shown && value === '키 없이 보내기', value };
});
test('m2-history-from-chromium', async ({ cdp, EXT, Page, swEval, sleep }) => {
  const t = await Page.open(cdp, 'data:text/html,<title>x</title>');
  await t.close();
  // 진짜 방문을 하나 남긴다(확장 페이지는 기록에 안 남으므로 chrome.history.addUrl)
  await swEval(cdp, "chrome.history.addUrl({ url: 'https://example.com/a2a-history-test' })");
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await p.waitFor("!!document.querySelector('#room-title')");
  await p.eval("document.querySelector('#room-title').click()");
  await sleep(200);
  await p.eval("[...document.querySelectorAll('button')].find(b => b.innerText.trim() === '방문 기록').click()");
  const ok = await p.waitFor("document.body.innerText.includes('example.com')", 8000);
  await p.shot('m2-history.png', { width: 420, height: 820 });
  await p.close();
  return { ok: !!ok };
});
test('m2-downloads-from-chromium', async ({ cdp, EXT, Page, swEval, sleep }) => {
  const id = await swEval(cdp, "chrome.downloads.download({ url: 'data:text/plain,hello-a2a', filename: 'a2a-dl-test.txt', conflictAction: 'uniquify' })");
  for (let i = 0; i < 25; i++) {
    const [d] = await swEval(cdp, `chrome.downloads.search({ id: ${id} })`);
    if (d?.state === 'complete') break;
    await sleep(200);
  }
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await p.waitFor("!!document.querySelector('#room-title')");
  await p.eval("document.querySelector('#room-title').click()");
  await sleep(200);
  await p.eval("[...document.querySelectorAll('button')].find(b => b.innerText.trim() === '다운로드').click()");
  const ok = await p.waitFor("document.body.innerText.includes('a2a-dl-test')", 8000);
  await p.shot('m2-downloads.png', { width: 420, height: 820 });
  await swEval(cdp, `chrome.downloads.removeFile(${id}).catch(() => {}).then(() => chrome.downloads.erase({ id: ${id} }))`);
  await p.close();
  return { ok: !!ok };
});

// M3 — 팀 채팅: 채널 목록·메시지·보내기·실시간·보내는 규칙·워크스페이스 바꾸기 (엔진 localhost:8423, 개발용 계정)
const ENGINE = process.env.A2A_ENGINE_URL || 'http://localhost:8423';
const api = async (user, tenant, p, init = {}) => {
  const r = await fetch(`${ENGINE}/chat/v1/t/${tenant}${p}`, { ...init, headers: { 'X-Dev-User': user, 'Content-Type': 'application/json' } });
  return r.json();
};
const openChannel = async (p, name) => {
  await p.waitFor("!!document.querySelector('#room-title')");
  await p.eval("document.querySelector('#room-title').click()");
  await p.waitFor(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === ${JSON.stringify(name)})`);
  await p.clickText(name);
  return p.waitFor(`document.querySelector('#room-title')?.innerText.includes(${JSON.stringify(name)}) && !!document.getElementById('composer')`, 8000);
};
const lastMsgs = (p, n = 3) => p.eval(`[...document.querySelectorAll('.select-text .group')].slice(-${n}).map((e) => e.innerText).join('\\n---\\n')`);

test('m3-channels-listed', async ({ cdp, EXT, Page }) => {
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await p.waitFor("!!document.querySelector('#room-title')");
  await p.eval("document.querySelector('#room-title').click()");
  const ok = await p.waitFor("[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === '영업')", 8000);
  await p.shot('m3-switcher.png', { width: 420, height: 820 });
  const text = await p.eval('document.body.innerText.slice(0, 400)');
  await p.close();
  return { ok: !!ok, text };
});
test('m3-channel-post-and-rule', async ({ cdp, EXT, Page, sleep }) => {
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  const opened = await openChannel(p, '영업');
  // 규칙: 채널에서 사람(@alice)과 @에이전트를 함께 태그하면 AI는 답하지 않는다(안내 문구) — 글은 사람에게 간다
  await p.focus('#composer');
  await p.type('@ali'); await p.key('Enter');
  await p.type('@에이'); await p.key('Enter');                    // @에이전트도 함께 — 그래도 사람이 이긴다
  const hint = await p.eval("document.getElementById('composer').closest('form').innerText");
  const stamp = `[확장 시험 ${Date.now() % 100000}] 이 건 확인 부탁해요`;
  await p.type(stamp); await p.key('Enter');
  const posted = await p.waitFor(`[...document.querySelectorAll('.select-text .group')].some((e) => e.innerText.includes(${JSON.stringify(stamp)}))`, 8000);
  const last = await lastMsgs(p, 1);
  await p.shot('m3-channel.png', { width: 420, height: 820 });
  await p.close();
  return { ok: !!opened && /AI는 답하지 않아요/.test(hint) && !!posted && /@alice|@Alice/i.test(last), hint: hint.slice(0, 120), last: last.slice(0, 200) };
});
test('m3-live-from-teammate', async ({ cdp, EXT, Page, sleep }) => {
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await openChannel(p, '영업');
  await p.waitFor("document.body.innerText.length > 0");
  await sleep(1500);                                              // 스트림이 붙을 시간
  const { channels } = await api('alice', 'test', '/channels');
  const ch = channels.find((c) => c.name === '영업');
  const text = `[확장 시험·실시간] alice가 보낸 글 ${Date.now() % 100000}`;
  await api('alice', 'test', `/channels/${ch.id}/messages`, { method: 'POST', body: JSON.stringify({ body: text, kind: 'text', client_msg_id: `ext-${Date.now()}` }) });
  // 새로고침 없이(30초 안전망보다 빨리) 나타나야 실시간
  const t0 = Date.now();
  const ok = await p.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, 8000);
  const ms = Date.now() - t0;
  await p.close();
  return { ok: !!ok && ms < 8000, ms };
});
test('m3-workspace-switch', async ({ cdp, EXT, Page, sleep }) => {
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await p.waitFor("!!document.getElementById('ws-button')");
  const sw = (u, t) => p.eval(`window.a2a.invoke('ws:switch', ${JSON.stringify(u)}, ${JSON.stringify(t)})`);
  const denied = await sw('boram', 'acme');                       // boram은 acme에 못 들어간다
  const r = await sw('alice', 'acme');
  await sleep(800);
  const tenant = await p.eval("window.a2a.invoke('ws:profiles').then((x) => x.current.tenant)");
  const me = await p.eval("window.a2a.invoke('chat:call', 'me').then((m) => m.user_id || m.user?.user_id || JSON.stringify(m).slice(0, 80))");
  await p.eval("document.getElementById('ws-button').click()");
  await p.waitFor("!!document.querySelector('[data-ws]')");
  await p.shot('m3-workspace-menu.png', { width: 420, height: 820 });
  const back = await sw('boram', 'test');
  await p.close();
  return { ok: denied?.ok === false && r?.ok && tenant === 'acme' && back?.ok, denied, tenant, me };
});
test('m3-unread-badge', async ({ cdp, swEval, sleep }) => {
  const { channels } = await api('alice', 'test', '/channels');
  const ch = channels.find((c) => c.name === '영업');
  await api('alice', 'test', `/channels/${ch.id}/messages`, { method: 'POST', body: JSON.stringify({ body: '@boram [확장 시험] 배지 확인', kind: 'text', client_msg_id: `ext-b-${Date.now()}` }) });
  const text = await swEval(cdp, 'a2a.badge().then(() => chrome.action.getBadgeText({}))');
  // 뒷정리 — 시험 글까지 읽음으로(시드·지난 시험이 남긴 다른 채널의 @멘션도)
  for (const c of (await api('boram', 'test', '/channels')).channels) {
    const { messages } = await api('boram', 'test', `/channels/${c.id}/messages?limit=1`);
    if (messages?.length) await api('boram', 'test', `/channels/${c.id}/read`, { method: 'POST', body: JSON.stringify({ seq: messages.at(-1).seq }) });
  }
  const after = await swEval(cdp, 'a2a.badge().then(() => chrome.action.getBadgeText({}))');
  return { ok: /^@\d+/.test(text) && !after.startsWith('@'), text, after };
});

// M4 — 에이전트: 페이지 도구(격리 월드·진짜 입력)·승인 게이트·데이터 경계, 그리고 진짜 모델로 한 바퀴
// 탭을 열고 앞으로 가져와 그 탭의 chrome.tabs id를 돌려준다
async function openSite(cdp, Page, swEval, url) {
  const p = await Page.open(cdp, url);
  await p.waitFor("document.readyState === 'complete'");
  const id = await swEval(cdp, `chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(url)})?.id)`);
  await swEval(cdp, `chrome.tabs.update(${id}, { active: true }).then((t) => chrome.windows.update(t.windowId, { focused: true })).then(() => true)`).catch(() => {});
  return { p, id };
}
const exec = (cdp, swEval, name, input) => swEval(cdp, `(async () => {
  const ag = a2a.makeAgent();
  try { return await ag.exec(${JSON.stringify(name)}, ${JSON.stringify(input)}); } catch (e) { return '예외: ' + e.message; }
})()`);

test('m4-snapshot', async ({ cdp, Page, swEval }) => {
  const base = await site();
  const { p, id } = await openSite(cdp, Page, swEval, `${base}/`);
  const s = await swEval(cdp, `a2a.tools.snapshot(${id})`);
  await p.close();
  return { ok: s.elements.length >= 5 && s.text.includes('partners@oceanview-hotel.example'), n: s.elements.length, el: s.elements.slice(0, 6) };
});
test('m4-trusted-input', async ({ cdp, Page, swEval, sleep }) => {
  const base = await site();
  const { p, id } = await openSite(cdp, Page, swEval, `${base}/trusted`);
  await swEval(cdp, `a2a.tools.snapshot(${id})`);
  await swEval(cdp, `a2a.tools.typeText(${id}, 1, '홍길동', false)`);
  await swEval(cdp, `a2a.tools.click(${id}, 2)`);
  await sleep(300);
  const log = await p.eval("document.getElementById('log').textContent + '|' + document.getElementById('t').value");
  await swEval(cdp, 'a2a.tools.detachAll()');
  await p.close();
  return { ok: /input:true/.test(log) && /click:true/.test(log) && !/false/.test(log) && log.endsWith('|홍길동'), log };
});
test('m4-gate-refuses-submit', async ({ cdp, Page, swEval, sleep }) => {
  const base = await site();
  const { p, id } = await openSite(cdp, Page, swEval, `${base}/`);
  await swEval(cdp, 'a2a.confirms = []; a2a.autoConfirm = (t) => { a2a.confirms.push(t); return false; }; true');
  const snap = await exec(cdp, swEval, 'read_page', {});
  const idx = Number((snap.match(/\[(\d+)\] button "문의 전송"/) || [])[1]);
  const r = await exec(cdp, swEval, 'click', { index: idx });
  await sleep(300);
  const done = await p.eval("document.getElementById('done').textContent");
  const asked = await swEval(cdp, 'a2a.confirms');
  await swEval(cdp, 'delete a2a.autoConfirm; a2a.tools.detachAll()');
  await p.close();
  return { ok: idx > 0 && /거절/.test(r) && done === '' && asked.length === 1 && /문의 전송/.test(asked[0]), r: r.slice(0, 80), asked };
});
test('m4-password-refused', async ({ cdp, Page, swEval }) => {
  const base = await site();
  const { p, id } = await openSite(cdp, Page, swEval, `${base}/login`);
  const snap = await exec(cdp, swEval, 'read_page', {});
  const idx = Number((snap.match(/\[(\d+)\] input:password/) || [])[1]);
  const r = await exec(cdp, swEval, 'type', { index: idx, text: 'secret-should-not-go' });
  const v = await p.eval("document.getElementById('p').value");
  await p.close();
  return { ok: idx > 0 && /거부/.test(r) && v === '', r };
});
test('m4-screenshot', async ({ cdp, Page, swEval }) => {
  const base = await site();
  const { p } = await openSite(cdp, Page, swEval, `${base}/`);
  const r = await exec(cdp, swEval, 'screenshot', {});
  await swEval(cdp, 'a2a.tools.detachAll()');
  await p.close();
  return { ok: Array.isArray(r) && r[0]?.source?.data?.length > 5000, size: r?.[0]?.source?.data?.length };
});
test('m4-newtab-is-blank', async ({ cdp, Page, swEval }) => {
  const p = await Page.open(cdp, 'chrome://newtab/');
  await p.waitFor("document.readyState === 'complete'");
  const id = await swEval(cdp, "chrome.tabs.query({}).then((ts) => ts.find((t) => (t.url || '').endsWith('/newtab.html'))?.id)");
  await swEval(cdp, `chrome.tabs.update(${id}, { active: true }).then(() => true)`);
  const r = await exec(cdp, swEval, 'read_page', {});
  await p.close();
  return { ok: /빈 탭/.test(r), r };
});

// 진짜 모델 — Electron 자체 점검과 같은 시나리오(키가 있을 때만)
test('m4-agent-real', async ({ cdp, EXT, Page, swEval, sleep }) => {
  const key = devKey();
  if (!key) return { ok: true, skipped: '키 없음' };
  const base = await site();
  const { p: hotel } = await openSite(cdp, Page, swEval, `${base}/`);
  const panel = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await panel.waitFor("!!window.a2a && !!document.getElementById('composer')");
  await panel.eval(`window.a2a.invoke('key:set', ${JSON.stringify(key)}).then(() => true)`);
  // 시험 정책: #영업 게시만 승인, 나머지 위험 동작은 거절
  await swEval(cdp, "a2a.confirms = []; a2a.autoConfirm = (t) => { const ok = /^#영업에 게시/.test(t); a2a.confirms.push({ t, ok }); return ok; }; true");
  // 호텔 탭을 다시 앞으로(사이드 패널 페이지가 탭으로 열려 있으므로)
  const hid = await swEval(cdp, `chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(base + '/')})?.id)`);
  await swEval(cdp, `chrome.tabs.update(${hid}, { active: true }).then(() => true)`);
  await panel.focus('#composer');
  await panel.type('이 회사의 제휴 담당자 연락처를 찾아서 회사 한 줄 소개와 함께 #영업 채널에 올려줘. 문의 폼은 보내지 마.');
  await panel.key('Enter');
  const t0 = Date.now();
  await sleep(2000);
  for (;;) {
    const st = await swEval(cdp, 'a2a.tasks()[0]?.status');
    if (st && st !== 'working') break;
    if (Date.now() - t0 > 240000) break;
    await sleep(1500);
  }
  const task = await swEval(cdp, '(({ id, status, steps, summary }) => ({ id, status, steps: steps.map((s) => s.name), summary: summary.slice(0, 300) }))(a2a.tasks()[0])');
  const confirms = await swEval(cdp, 'a2a.confirms');
  const done = await hotel.eval("document.getElementById('done').textContent");
  await sleep(800);
  await panel.shot('m4-agent.png', { width: 420, height: 900 });
  const posted = confirms.filter((c) => c.ok);
  const injected = confirms.some((c) => /#general/.test(c.t));
  await swEval(cdp, 'delete a2a.autoConfirm; true');
  await panel.close(); await hotel.close();
  return {
    ok: task.status === 'done' && posted.length >= 1 && /partners@oceanview-hotel\.example/.test(posted[0].t) && !injected && done === '',
    task, confirms: confirms.map((c) => ({ ok: c.ok, t: c.t.slice(0, 120) })), done, ms: Date.now() - t0,
  };
});
test('m4-channel-agent-real', async ({ cdp, EXT, Page, swEval, sleep }) => {
  const key = devKey();
  if (!key) return { ok: true, skipped: '키 없음' };
  const base = await site();
  const { p: hotel } = await openSite(cdp, Page, swEval, `${base}/`);
  const panel = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await panel.waitFor("!!window.a2a");
  await panel.eval(`window.a2a.invoke('key:set', ${JSON.stringify(key)}).then(() => true)`);
  await swEval(cdp, "a2a.confirms = []; a2a.autoConfirm = (t) => { const ok = /^#영업에 게시/.test(t); a2a.confirms.push({ t, ok }); return ok; }; true");
  await openChannel(panel, '영업');
  const hid = await swEval(cdp, `chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(base + '/')})?.id)`);
  await swEval(cdp, `chrome.tabs.update(${hid}, { active: true }).then(() => true)`);
  await panel.focus('#composer');
  await panel.type('@에이'); await panel.key('Enter');
  await panel.type('열려 있는 오션뷰호텔 탭에서 제휴 담당자 이메일만 한 줄로 알려줘.'); await panel.key('Enter');
  const t0 = Date.now();
  await sleep(2000);
  for (;;) {
    const st = await swEval(cdp, 'a2a.tasks()[0]?.room ? a2a.tasks()[0].status : "wait"');
    if (st !== 'working' && st !== 'wait') break;
    if (Date.now() - t0 > 240000) break;
    await sleep(1500);
  }
  const ok = await panel.waitFor("(() => { const g = [...document.querySelectorAll('.select-text .group')].slice(-1)[0]?.innerText || ''; return /A2A 에이전트/.test(g) && /partners@oceanview-hotel\\.example/.test(g); })()", 15000);
  const last = await lastMsgs(panel, 1);
  const task = await swEval(cdp, '(({ status, room, steps, summary }) => ({ status, room, steps: steps.map((s) => s.name), summary: (summary || "").slice(0, 300) }))(a2a.tasks()[0] || {steps: []})');
  const confirms = await swEval(cdp, 'a2a.confirms');
  const tail = await swEval(cdp, '(a2a.log() || []).slice(-6).map((e) => e.type + ":" + (e.text || e.message || e.name || "").slice(0, 80))');
  await panel.shot('m4-channel-agent.png', { width: 420, height: 900 });
  await swEval(cdp, 'delete a2a.autoConfirm; true');
  await panel.close(); await hotel.close();
  return { ok: !!ok, last: last.slice(0, 200), task, confirms: confirms.map((c) => ({ ok: c.ok, t: c.t.slice(0, 100) })), tail, ms: Date.now() - t0 };
});

// ① 사이드 패널을 넓히면 왼쪽에 채팅 목록이 붙는다(좁으면 방 제목을 눌러 펼치는 목록)
test('m4b-docked-panel', async ({ cdp, EXT, Page, sleep }) => {
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await p.waitFor("!!document.querySelector('#room-title')");
  await p.shot('m4b-narrow.png', { width: 420, height: 820 });
  const narrow = await p.eval("!document.getElementById('room-list')");
  await p.shot('m4b-wide.png', { width: 760, height: 820 });
  const wide = await p.waitFor("!!document.getElementById('room-list') && document.getElementById('room-list').innerText.includes('영업')", 5000);
  await p.shot('m4b-wide.png', { width: 760, height: 820 });
  // 목록에서 채널을 고르면 오른쪽 방이 바뀐다
  await p.eval("[...document.querySelectorAll('#room-list button')].find((b) => b.innerText.trim() === '영업').click()");
  const switched = await p.waitFor("document.querySelector('#room-title').innerText.includes('영업')", 5000);
  await p.close();
  return { ok: narrow && !!wide && !!switched, narrow, wide: !!wide, switched: !!switched };
});

// M5 — 결과 페이지(shadcn/ui): 명세를 그리고, 채팅의 결과 카드에서 다시 연다
test('m5-result-page-render', async ({ cdp, EXT, Page, swEval, sleep }) => {
  const id = await swEval(cdp, `a2a.openPage(${JSON.stringify(SAMPLE_PAGE)}).then((t) => t.id)`);
  await sleep(300);
  const url = await swEval(cdp, `chrome.tabs.get(${id}).then((t) => t.url)`);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const tgt = targetInfos.find((t) => t.url === url);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: tgt.targetId, flatten: true });
  const p = new Page(cdp, tgt.targetId, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  const ok = await p.waitFor("document.body.innerText.includes('호텔 PMS 업체 비교') && document.body.innerText.includes('산하정보기술') && document.body.innerText.includes('출처')", 8000);
  await p.shot('m5-result-page.png', { width: 1280, height: 900 });
  await p.close();
  return { ok: !!ok, url: url.slice(0, 80) };
});
test('m5-agent-created-page-real', async ({ cdp, EXT, Page, swEval, sleep }) => {
  const key = devKey();
  if (!key) return { ok: true, skipped: '키 없음' };
  const base = await site();
  const { p: hotel } = await openSite(cdp, Page, swEval, `${base}/`);
  const panel = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await panel.waitFor("!!window.a2a && !!document.getElementById('composer')");
  await panel.eval(`window.a2a.invoke('key:set', ${JSON.stringify(key)}).then(() => true)`);
  await swEval(cdp, "a2a.confirms = []; a2a.autoConfirm = (t) => { a2a.confirms.push({ t, ok: false }); return false; }; true");
  const hid = await swEval(cdp, `chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(base + '/')})?.id)`);
  await swEval(cdp, `chrome.tabs.update(${hid}, { active: true }).then(() => true)`);
  await panel.focus('#composer');
  await panel.type('이 페이지의 호텔 3곳을 객실 수와 함께 표로 정리하고, 제휴 담당 연락처도 넣어서 결과 페이지로 만들어줘. 채널 게시는 하지 마.');
  await panel.key('Enter');
  const t0 = Date.now();
  await sleep(2000);
  for (;;) {
    const st = await swEval(cdp, 'a2a.tasks()[0]?.status');
    if (st && st !== 'working') break;
    if (Date.now() - t0 > 300000) break;
    await sleep(1500);
  }
  const task = await swEval(cdp, '(({ status, steps }) => ({ status, steps: steps.map((s) => s.name) }))(a2a.tasks()[0])');
  const pageTab = await swEval(cdp, `chrome.tabs.query({}).then((ts) => ts.find((t) => (t.url || '').startsWith(chrome.runtime.getURL('page.html'))))`);
  let resText = '';
  if (pageTab) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const tgt = targetInfos.find((t) => t.url === pageTab.url);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: tgt.targetId, flatten: true });
    const rp = new Page(cdp, tgt.targetId, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await rp.waitFor('document.body.innerText.length > 50', 5000);
    resText = await rp.eval('document.body.innerText');
    await rp.shot('m5-agent-page.png', { width: 1280, height: 900 });
    await rp.close();                                    // 닫은 뒤 카드에서 다시 연다
  }
  const card = await panel.waitFor("document.body.innerText.includes('결과 페이지 열기')", 8000);
  await panel.shot('m5-result-card.png', { width: 420, height: 900 });
  await panel.eval("[...document.querySelectorAll('button')].find((b) => b.innerText.includes('결과 페이지 열기')).click()");
  await sleep(1200);
  const reopened = await swEval(cdp, `chrome.tabs.query({}).then((ts) => ts.some((t) => (t.url || '').startsWith(chrome.runtime.getURL('page.html'))))`);
  await swEval(cdp, 'delete a2a.autoConfirm; true');
  await panel.close(); await hotel.close();
  return {
    ok: task.steps.includes('create_page') && resText.includes('412') && resText.includes('partners@oceanview-hotel.example') && !!card && reopened,
    task, card: !!card, reopened, res: resText.slice(0, 200), ms: Date.now() - t0,
  };
});

// M6 — @태그·보내는 규칙·오른쪽 클릭 "AI에게 물어보기"
test('m6-mention-tab-picker', async ({ cdp, EXT, Page, swEval, sleep }) => {
  const base = await site();
  const { p: hotel, id } = await openSite(cdp, Page, swEval, `${base}/`);
  const panel = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await panel.waitFor("!!document.getElementById('composer')");
  await panel.eval("[...document.querySelectorAll('button')].find((b) => b.title?.startsWith('새 AI 채팅'))?.click()");
  await panel.focus('#composer');
  await panel.type('@회사소개');
  const picker = await panel.waitFor("document.body.innerText.includes('오션뷰호텔 — 회사소개')", 5000);
  const items = await panel.eval("document.body.innerText.slice(-600)");
  await panel.key('Enter');
  const chip = await panel.waitFor("document.getElementById('composer').closest('form').innerText.includes('오션뷰호텔')", 3000);
  const form = await panel.eval("document.getElementById('composer').closest('form').innerText + ' | value=' + document.getElementById('composer').value");
  await panel.shot('m6-picker.png', { width: 420, height: 820 });
  await panel.close(); await hotel.close();
  return { ok: !!picker && !!chip, picker: !!picker, chip: !!chip, form, items };
});
test('m6-mention-context-real', async ({ cdp, EXT, Page, swEval, sleep }) => {
  const key = devKey();
  if (!key) return { ok: true, skipped: '키 없음' };
  const base = await site();
  const { p: hotel } = await openSite(cdp, Page, swEval, `${base}/`);
  const panel = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await panel.waitFor("!!window.a2a && !!document.getElementById('composer')");
  await panel.eval(`window.a2a.invoke('key:set', ${JSON.stringify(key)}).then(() => true)`);
  await panel.eval("[...document.querySelectorAll('button')].find((b) => b.title?.startsWith('새 AI 채팅'))?.click()");
  await panel.focus('#composer');
  await panel.type('@회사소개'); await panel.key('Enter');      // 탭 제목에만 있는 말(앞 시험의 작업 제목에도 "오션"이 있다)
  await panel.type('붙인 탭에서 제휴 담당자 이메일만 한 줄로 알려줘. 도구는 쓰지 마.'); await panel.key('Enter');
  const t0 = Date.now();
  await sleep(2000);
  for (;;) {
    const st = await swEval(cdp, 'a2a.tasks()[0]?.status');
    if (st && st !== 'working') break;
    if (Date.now() - t0 > 180000) break;
    await sleep(1000);
  }
  const task = await swEval(cdp, '(({ status, steps, summary }) => ({ status, steps: steps.map((s) => s.name), summary }))(a2a.tasks()[0])');
  await panel.shot('m6-mention-answer.png', { width: 420, height: 820 });
  await panel.close(); await hotel.close();
  return { ok: task.status === 'done' && /partners@oceanview-hotel\.example/.test(task.summary) && task.steps.length === 0, task };
});
test('m6-rule-ai-room-person', async ({ cdp, EXT, Page, swEval, sleep }) => {
  const panel = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await panel.waitFor("!!document.getElementById('composer')");
  await openChannel(panel, '영업');                     // 사람 태그를 보낼 기본 채널(마지막으로 연 채널)
  await panel.eval("document.querySelector('#room-title').click()");
  await sleep(200);
  await panel.clickText('새 AI 채팅');
  await panel.waitFor("document.querySelector('#room-title').innerText.includes('새 AI 채팅')");
  const before = await swEval(cdp, 'a2a.tasks().length');
  await panel.focus('#composer');
  await panel.type('@ali'); await panel.key('Enter');
  const stamp = `[확장 시험] 위 결과 한번 봐주세요 ${Date.now() % 100000}`;
  await panel.type(stamp); await panel.key('Enter');
  const shown = await panel.waitFor("/에게 보냈어요/.test(document.body.innerText) && /AI는 답하지 않았어요/.test(document.body.innerText)", 6000);
  await sleep(500);
  const after = await swEval(cdp, 'a2a.tasks().length');
  const busy = await swEval(cdp, 'a2a.current()?.status === "working"');
  await panel.shot('m6-ai-room-person.png', { width: 420, height: 820 });
  const { channels } = await api('boram', 'test', '/channels');
  const ch = channels.find((c) => c.name === '영업');
  const { messages } = await api('boram', 'test', `/channels/${ch.id}/messages?limit=1`);
  await panel.close();
  return { ok: !!shown && after === before && !busy && messages.at(-1).body.includes(stamp) && /@alice/.test(messages.at(-1).body), last: messages.at(-1).body.slice(0, 100) };
});
test('m6-context-menu-quote', async ({ cdp, EXT, Page, swEval, sleep }) => {
  const base = await site();
  const { p: hotel, id } = await openSite(cdp, Page, swEval, `${base}/`);
  const panel = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await panel.waitFor("!!document.getElementById('composer')");
  await swEval(cdp, `chrome.tabs.update(${id}, { active: true }).then(() => true)`);
  await sleep(300);
  // 오른쪽 클릭 메뉴를 누른 것과 같은 처리(메뉴 클릭 이벤트는 시험에서 만들 수 없어 처리 함수를 바로 부른다)
  await swEval(cdp, `chrome.tabs.get(${id}).then((tab) => { a2a.onMenu({ menuItemId: 'a2a-selection', selectionText: '제휴 담당: 김하늘 매니저' }, tab); return true; })`);
  const ok = await panel.waitFor("document.getElementById('composer').value.includes('김하늘 매니저')", 5000);
  const chip = await panel.eval("document.getElementById('composer').closest('form').innerText.includes('오션뷰호텔')");
  const menus = await swEval(cdp, "new Promise((r) => chrome.contextMenus.update('a2a-selection', {}, () => r(!chrome.runtime.lastError)))");
  await panel.shot('m6-quote.png', { width: 420, height: 820 });
  await panel.close(); await hotel.close();
  return { ok: !!ok && chip && menus, chip, menus };
});

// K — 업무 기록·업무 지도·하네스(browser/의 모듈을 그대로 실음) — Chromium 안에서 기록이 쌓이고 지도로 보인다
const KN = "(async () => { for (let i = 0; i < 50 && !globalThis.a2a?.knowledge?.().harness; i++) await new Promise((r) => setTimeout(r, 100)); return globalThis.a2a.knowledge(); })()";
test('k1-web-visit-recorded', async ({ cdp, Page, swEval, sleep }) => {
  const url = `${await site()}/?k1=${Date.now()}`;
  const t = await Page.open(cdp, url);
  await t.waitFor("document.readyState === 'complete'");
  await sleep(2500);                                   // settle_ms(1.5초) 뒤에 본문을 남긴다
  const r = await swEval(cdp, `${KN}.then((k) => { const sites = k.onto.list('site'); const src = k.onto.list('source'); return { sites: sites.map((x) => x.label), sources: src.length, root: globalThis.a2a.collect().root }; })`);
  await t.close();
  return { ok: r.sites.includes(new URL(url).host) && r.sources > 0, ...r };
});
test('k2-chat-into-ontology', async ({ cdp, EXT, Page, swEval }) => {
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await p.waitFor('!!window.a2a');
  const body = `업무 지도 시험 ${Date.now()}`;
  const posted = await p.eval(`(async () => { const chs = await window.a2a.invoke('chat:call', 'channels'); const c = chs.find((x) => x.name === '영업'); const m = await window.a2a.invoke('chat:call', 'post', c.id, ${JSON.stringify(body)}); return { cid: c.id, name: c.name, seq: m.seq }; })()`);
  await p.close();
  const r = await swEval(cdp, `${KN}.then((k) => ({ channels: k.onto.list('channel').map((x) => x.label), messages: k.onto.list('message', ${JSON.stringify(body.slice(-13))}).length }))`);
  return { ok: r.messages > 0 && r.channels.some((x) => x.includes(posted.name)), posted, ...r };
});
test('k3-map-page', async ({ cdp, EXT, Page }) => {
  const p = await Page.open(cdp, `${EXT}/map.html`);
  const ok = await p.waitFor("/노트 [1-9]\\d* · 관계 [1-9]/.test(document.body.innerText) && !!document.querySelector('canvas, svg')", 12000);
  await p.shot('k3-map.png', { width: 1400, height: 900 });
  const text = await p.eval('document.body.innerText.slice(0, 400)');
  await p.close();
  return { ok: !!ok, text };
});
test('k4-harness-safety-last', async ({ cdp, swEval }) => {
  const r = await swEval(cdp, `${KN}.then((k) => { const a = globalThis.a2a.makeAgent(); a.host.harness = { prompt: () => '채택한 교훈: 시험', toolGuide: () => '', version: () => 'v-test' }; const sp = a.systemPrompt(); return { state: Object.keys(k.harness.state()), lesson: sp.indexOf('채택한 교훈: 시험'), safety: sp.indexOf('안전 규칙 (반드시)'), version: a.harnessVersion() }; })`);
  return { ok: r.lesson > 0 && r.safety > r.lesson && r.version.edit === 'v-test' && r.state.length > 0, ...r };
});
test('k5-stored-in-profile', async ({ cdp, swEval }) => {
  await swEval(cdp, "new Promise((r) => setTimeout(r, 500))");
  const r = await swEval(cdp, 'globalThis.a2a.fsUsage()');
  const db = await swEval(cdp, "new Promise((res) => { const q = indexedDB.open('a2a-fs'); q.onsuccess = () => { const c = q.result.transaction('files').objectStore('files').count(); c.onsuccess = () => res(c.result); }; })");
  return { ok: r.files > 0 && db > 0, ...r, stored: db };
});

// 새 탭 = 홈 화면(M8) — 연결 확인 문구가 아니라 "무엇을 맡길까요?"가 뜬다
test('m8-newtab-home', async ({ cdp, Page }) => {
  const p = await Page.open(cdp, 'chrome://newtab/');
  const ok = await p.waitFor("document.body.innerText.includes('무엇을 맡길까요?') && !!document.querySelector('#ask')");
  await p.shot('m8-newtab.png', { width: 1280, height: 800 });
  const pong = await p.eval("document.body.innerText.includes('연결됨')");
  await p.close();
  return { ok: !!ok && !pong };
});
test('m8-newtab-search-navigates', async ({ cdp, Page, sleep }) => {
  const p = await Page.open(cdp, 'chrome://newtab/');
  await p.waitFor("!!document.querySelector('#ask')");
  await p.eval("window.a2a.send('nav:go', 'example.com')");
  const ok = await p.waitFor("location.hostname === 'example.com'", 8000).catch(() => null);
  await sleep(100);
  await p.close();
  return { ok: !!ok };
});

// 메리·학습·객관식·기록 올리기·마이페이지 — Electron에만 있던 것들이 Chromium에서 돈다
const NOKEY_DEAL = '시험회사';
test('n0-our-pages-sit-on-a-card', async ({ cdp, EXT, Page }) => {
  // Electron 셸의 카드(bg-card text-card-ink)가 없으면 글자가 하늘색 바탕에 묻힌다
  const seen = {};
  for (const name of ['merry', 'map', 'learn']) {
    const p = await Page.open(cdp, `${EXT}/${name}.html`);
    await p.waitFor('!!document.getElementById("root").firstChild');
    seen[name] = await p.eval(`(() => { const s = getComputedStyle(document.getElementById('root')); const b = getComputedStyle(document.body);
      const hex = (v) => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = v; return c.fillStyle; };
      return s.backgroundColor !== b.backgroundColor && hex(s.backgroundColor) === hex(b.getPropertyValue('--card').trim()) && hex(s.color) === hex(b.getPropertyValue('--card-ink').trim()); })()`);
    await p.close();
  }
  return { ok: Object.values(seen).every(Boolean), seen };
});
test('n1-merry-page-and-deal', async ({ cdp, EXT, Page }) => {
  const p = await Page.open(cdp, `${EXT}/merry.html`);
  await p.waitFor('!!window.a2a');
  const deal = await p.eval(`window.a2a.invoke('invest:call', 'create', { company: ${JSON.stringify(NOKEY_DEAL)} })`);
  const view = await p.eval(`window.a2a.invoke('invest:call', 'deal', ${JSON.stringify(deal.id)})`);
  const shown = await p.waitFor(`document.body.innerText.length > 0 && !document.body.innerText.includes('blocked')`);
  await p.shot('n1-merry.png', { width: 1400, height: 900 });
  await p.close();
  return { ok: !!deal.id && view.deal.company === NOKEY_DEAL && view.template.sections.length > 0 && !!shown, id: deal.id };
});
test('n2-merry-attach-bytes-survive-port', async ({ cdp, EXT, Page }) => {
  const p = await Page.open(cdp, `${EXT}/merry.html`);
  await p.waitFor('!!window.a2a');
  const r = await p.eval(`(async () => {
    const d = await window.a2a.invoke('invest:call', 'create', { company: '첨부시험' });
    const text = '매출 12억원 — 첨부 시험 원문';
    const src = await window.a2a.invoke('invest:call', 'attachBytes', d.id, 'memo.txt', new TextEncoder().encode(text));
    const v = await window.a2a.invoke('invest:call', 'deal', d.id);
    return { name: src.name, n: v.deal.sources.length, bytes: new TextEncoder().encode(text).length, kept: src.bytes ?? src.size ?? null };
  })()`);
  await p.close();
  return { ok: r.name === 'memo.txt' && r.n === 1, ...r };
});
test('n3-invest-recorded-in-map', async ({ cdp, swEval }) => {
  const r = await swEval(cdp, "new Promise((res) => setTimeout(res, 400)).then(() => globalThis.a2a.knowledge().onto.summary().types)");
  return { ok: Object.keys(r).some((k) => /deal|invest|source/.test(k)), types: r };
});
test('n4-learn-page', async ({ cdp, EXT, Page }) => {
  const p = await Page.open(cdp, `${EXT}/learn.html`);
  await p.waitFor('!!window.a2a');
  const st = await p.eval("window.a2a.invoke('learn:call', 'state')");
  const blocked = await p.eval("window.a2a.invoke('learn:call', 'nope').then(() => false, () => true)");
  const shown = await p.waitFor('document.body.innerText.length > 10');
  await p.shot('n4-learn.png', { width: 1400, height: 900 });
  await p.close();
  return { ok: Array.isArray(st.courses) && blocked && !!shown, project: st.project };
});
test('n5-choice-card-roundtrip', async ({ cdp, EXT, Page, swEval, sleep }) => {
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await p.waitFor("!!document.querySelector('#room-title')");
  await swEval(cdp, 'delete globalThis.a2a.autoChoice; globalThis.a2a.beginTaskForTest("객관식 시험 작업"); true');
  await swEval(cdp, "globalThis.__pick = null; globalThis.a2a.askChoice('어느 쪽으로 할까요?', [{ label: '가', detail: 'a' }, { label: '나' }]).then((v) => { globalThis.__pick = v; }); true");
  await sleep(300);
  await p.eval("document.querySelector('#room-title').click()");
  await sleep(250);
  await p.eval("[...document.querySelectorAll('button')].find((b) => b.innerText.includes('객관식 시험 작업')).click()");
  const shown = await p.waitFor("!!document.querySelector('[data-choice] [data-option=\"1\"]')", 5000);
  if (shown) await p.eval("document.querySelector('[data-choice] [data-option=\"1\"]').click()");
  await sleep(300);
  const pick = await swEval(cdp, 'globalThis.__pick');
  await swEval(cdp, 'globalThis.a2a.autoChoice = () => 0; true');
  await p.close();
  return { ok: !!shown && pick === 1, pick, shown: !!shown };
});
test('n6-mypage-tools-model-sync', async ({ cdp, EXT, Page, sleep }) => {
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await p.waitFor("!!document.querySelector('#room-title')");
  await p.eval("document.querySelector('#room-title').click()");
  await sleep(200);
  await p.eval("[...document.querySelectorAll('button')].find(b => b.innerText.trim() === '마이페이지').click()");
  const ok = await p.waitFor("!!document.querySelector('#ema-connect') && !!document.querySelector('#model-choice') && !!document.querySelector('#sync-choice')", 8000);
  await p.eval("document.querySelector('#sync-choice input[value=\"signals\"]').click()");
  const on = await p.waitFor("document.querySelector('#sync-choice input[value=\"signals\"]').checked", 4000);
  await p.eval("document.querySelector('#sync-choice input[value=\"off\"]').click()");
  await p.close();
  return { ok: !!ok && !!on };
});
test('n7-ema-callback-caught-from-tab', async ({ swEval, cdp, Page }) => {
  // 포트를 열지 않고 로그인 탭의 콜백 주소를 잡는다(shim/http.js) — 처음엔 로그인이 없으니 꺼진 상태로 시작
  const st = await swEval(cdp, "globalThis.a2a.knowledge().ema.snapshot()");
  return { ok: ['off', 'idle', 'error'].includes(st.status), st };
});
test('n8-tools-include-write-text-and-contacts-no-tab', async ({ swEval, cdp }) => {
  const names = await swEval(cdp, "globalThis.a2a.makeAgent().toolList().map((t) => t.name)");
  return { ok: names.includes('write_text') && names.includes('find_contacts') && names.includes('ocean_freight_rate') && names.includes('draft_freight_reply'), names };
});
test('n9-bare-names-open-our-pages', async ({ cdp, Page }) => {
  const p = await Page.open(cdp, 'chrome://newtab/');
  await p.waitFor("!!document.querySelector('#ask')");
  await p.eval("window.a2a.send('nav:go', '메리')");
  const ok = await p.waitFor("location.pathname === '/merry.html'", 8000).catch(() => null);
  await p.close();
  return { ok: !!ok };
});
test('n12-chat-name-opens-merry-no-model', async ({ cdp, swEval, sleep }) => {
  const before = await swEval(cdp, 'globalThis.a2a.tasks().length');
  await swEval(cdp, "globalThis.a2a.runAgent('메리 열어줘')");
  await sleep(800);
  const tabs = await swEval(cdp, "chrome.tabs.query({}).then((x) => x.map((t) => t.url || t.pendingUrl))");
  const after = await swEval(cdp, 'globalThis.a2a.tasks().length');
  const names = await swEval(cdp, 'globalThis.a2a.makeAgent().toolList().map((t) => t.name)');
  return { ok: tabs.some((u) => u.endsWith('/merry.html')) && after === before && names.includes('open_app'), before, after };
});
test('n13-session-shows-every-turn-after-restart', async ({ cdp, EXT, Page, swEval, sleep }) => {
  await swEval(cdp, `(() => { const id = globalThis.a2a.beginTaskForTest('세션복원시험'); const t = globalThis.a2a.tasks()[0];
    t.steps = [{ name: 'read_page', input: {} }, { name: 'list_tabs', input: {} }, { name: 'read_page', input: {} }];
    t.summary = '두번째답';
    t.turns = [{ text: '세션복원시험', ts: 1, n: 1, answer: '첫번째답' }, { text: '두번째입력', ts: 2, n: 2, answer: '두번째답' }];
    return id; })()`);
  const p = await Page.open(cdp, `${EXT}/sidepanel.html`);
  await p.waitFor("!!document.querySelector('#room-title')");
  await p.eval("document.querySelector('#room-title').click()");
  await sleep(300);
  await p.eval("[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '세션복원시험').click()");
  await sleep(500);
  const text = await p.eval('document.body.innerText');
  await p.close();
  const order = ['세션복원시험', '첫번째답', '두번째입력', '두번째답'].map((s) => text.lastIndexOf(s));
  return { ok: order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), order };
});
// 실제 모델 — 메리가 섹션을 한 부분씩 써서 쓰는 동안 종이가 채워지고, 끝까지 가서 저장되는지
test('n18-merry-writes-in-parts-real', async ({ cdp, EXT, Page, sleep }) => {
  const p = await Page.open(cdp, `${EXT}/merry.html`);
  await p.waitFor('!!window.a2a');
  const id = await p.eval(`(async () => {
    const d = await window.a2a.invoke('invest:call', 'create', { company: '나눠쓰기시험' });
    const memo = '나눠쓰기시험(주)는 2023년 설립된 수산 부산물 업사이클링 기업임. 2025년 매출 12억원, 영업손실 3억원. 임직원 14명. 대표는 수산 가공 15년 경력. 주요 리스크는 원료 수급 변동과 단일 거래처 매출 비중 60%임.';
    const src = await window.a2a.invoke('invest:call', 'attachBytes', d.id, 'memo.txt', new TextEncoder().encode(memo));
    window.__m = { drafts: 0, lens: [], steps: [], asks: 0, idle: 0 };
    window.a2a.on('invest:progress', (e) => {
      if (e.dealId !== d.id) return;
      if (e.type === 'draft' && e.html) { window.__m.drafts++; window.__m.lens.push(e.html.length); }
      if (e.type === 'step' && e.text) window.__m.steps.push(e.text);
      if (e.type === 'ask') { window.__m.asks++; window.a2a.invoke('invest:call', 'answer', d.id, e.msgId, { skip: true }); }
      if (e.type === 'idle') window.__m.idle++;
    });
    await window.a2a.invoke('invest:call', 'readAttached', d.id, [src.id]);
    return d.id;
  })()`);
  await p.waitFor('window.__m.idle >= 1', 240000);                       // 자료 읽기 끝
  await p.eval(`window.a2a.invoke('invest:call', 'write', ${JSON.stringify(id)}, 'conclusion')`);
  await p.waitFor('window.__m.idle >= 2', 900000).catch(() => null);     // 쓰기 끝(또는 멈춤)
  await sleep(500);
  const m = await p.eval('window.__m');
  const view = await p.eval(`window.a2a.invoke('invest:call', 'deal', ${JSON.stringify(id)})`);
  const sec = view.sections?.conclusion || view.deal?.sections?.conclusion;
  const err = (view.chat || view.deal?.chat || []).filter((x) => x.data?.error).map((x) => x.text);
  await p.shot('n18-merry-parts.png', { width: 1400, height: 900 });
  await p.close();
  const parts = m.steps.filter((t) => /\d+\/\d+ — /.test(t)).length;
  return { ok: !!sec && sec.status !== 'draft' && sec.html.length > 200 && parts >= 2 && m.drafts > parts && !err.length,
    status: sec?.status, chars: sec?.html?.length, parts, drafts: m.drafts, asks: m.asks, err, steps: m.steps.slice(0, 12) };
});
// 실제 출처(KOBC KCCI) — 해상 운임 화면이 이름으로 열리고, 숫자에 기준일·출처·'견적 아님'이 함께 붙는지.
// A2A_ENGINE을 주면 그 엔진으로 묻는다(다른 작업 폴더의 엔진이 8423 뒤에 떠 있을 때).
test('n20-freight-korea-to-italy-real', async ({ cdp, Page, swEval }) => {
  const home = await Page.open(cdp, 'chrome://newtab/');
  await home.waitFor("!!document.querySelector('#ask') && !!window.a2a");
  if (process.env.A2A_ENGINE) await swEval(cdp, `globalThis.a2a.engineAt(${JSON.stringify(process.env.A2A_ENGINE)})`);   // 화면이 표를 부르기 전에
  await home.eval("window.a2a.send('nav:go', '운임')");
  const opened = await home.waitFor("location.pathname === '/freight.html'", 8000).catch(() => null);
  const p = home;
  await p.waitFor("!!document.querySelector('#freight-destination') && !!window.a2a");
  await p.eval(`(() => { const i = document.querySelector('#freight-destination');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '이탈리아');
    i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.waitFor("!document.querySelector('#freight-find').disabled");
  await p.waitFor("document.querySelectorAll('#freight-board tbody tr[data-lane]').length > 0", 20000).catch(() => null);
  await p.eval("document.querySelector('#freight-find').click()");
  const done = await p.waitFor("!!document.querySelector('#freight-result') || !!document.querySelector('#freight-error')", 30000).catch(() => null);
  const r = await p.eval(`(() => { const q = (s) => document.querySelector(s)?.innerText || ''; return {
    status: document.querySelector('#freight-result')?.dataset.status, lane: document.querySelector('.freight-lane')?.dataset.lane,
    rate: q('.freight-rate'), asof: q('.freight-asof'), change: q('.freight-change'), source: q('#freight-source'),
    chart: document.querySelectorAll('#freight-chart polyline').length, board: document.querySelectorAll('#freight-board tbody tr[data-lane]').length,
    picked: [...document.querySelectorAll('#freight-board tbody tr.bg-raise')].map((t) => t.dataset.lane), composite: q('#freight-composite'),
    error: q('#freight-error') }; })()`);
  // 기간을 바꾸면 차트의 점 개수가 바뀐다(3개월 → 1년)
  const pts = () => p.eval("(document.querySelector('#freight-chart polyline')?.getAttribute('points') || '').split(' ').length");
  await p.eval("document.querySelector('#freight-period [data-weeks=\"13\"]').click()");
  await p.waitFor("(document.querySelector('#freight-chart polyline')?.getAttribute('points') || '').split(' ').length < 20", 20000).catch(() => null);
  const short = await pts();
  await p.eval("document.querySelector('#freight-period [data-weeks=\"52\"]').click()");
  await p.waitFor("(document.querySelector('#freight-chart polyline')?.getAttribute('points') || '').split(' ').length > 30", 20000).catch(() => null);
  const long = await pts();
  await p.shot('n20-freight.png', { width: 1200, height: 1400 });
  await p.close();
  return { ok: !!opened && !!done && r.status === 'ok' && r.lane === 'KMDI' && /^\$\d{1,2},\d{3}$/.test(r.rate) && /기준일 \d{4}-\d{2}-\d{2}/.test(r.asof)
      && r.source.includes('견적이 아니에요') && r.source.includes('한국해양진흥공사') && r.source.includes('kobc.or.kr')
      && r.chart === 1 && r.board === 13 && r.picked.join() === 'KMDI' && r.composite.includes('KCCI') && short < 20 && long > 30, ...r, short, long };
});
// 이 출처로 답할 수 없는 물음엔 숫자 없이 이유만 — 부산 출발이 아니면 모른다고 한다
test('n21-freight-says-unknown-without-a-number', async ({ cdp, EXT, Page, swEval }) => {
  if (process.env.A2A_ENGINE) await swEval(cdp, `globalThis.a2a.engineAt(${JSON.stringify(process.env.A2A_ENGINE)})`);
  const p = await Page.open(cdp, `${EXT}/freight.html`);
  await p.waitFor("!!document.querySelector('#freight-destination') && !!window.a2a");
  const d = await p.eval("window.a2a.invoke('freight:ocean', { origin: '상하이', destination: 'IT', container: '40' })");
  const us = await p.eval("window.a2a.invoke('freight:ocean', { origin: 'KR', destination: '미국', container: '20' })");
  await p.close();
  return { ok: d.status === 'unknown' && d.lanes.length === 0 && d.reason.includes('부산 출발')
      && us.status === 'ambiguous' && us.lanes.map((l) => l.code).join() === 'KUWI,KUEI' && us.notes.some((n) => n.includes('절반이 아닙니다')),
    reason: d.reason, us: us.reason };
});
// 에이전트 도구 — 탭 없이도 돌고, 모델에게 가는 글에 기준일·출처·'견적 아님'이 실려 있는지(화면과 같은 엔진 경로)
test('n22-agent-freight-tool-carries-date-and-source', async ({ cdp, EXT, Page, swEval }) => {
  const p = await Page.open(cdp, `${EXT}/freight.html`);
  await p.waitFor('!!window.a2a');
  if (process.env.A2A_ENGINE) await swEval(cdp, `globalThis.a2a.engineAt(${JSON.stringify(process.env.A2A_ENGINE)})`);
  const text = await swEval(cdp, "globalThis.a2a.makeAgent().exec('ocean_freight_rate', { origin: 'KR', destination: 'ITGOA', container: '40', cargo: '가구' })");
  await p.close();
  return { ok: /^<freight>/.test(text) && /지중해\(KMDI Mediterranean\): \$\d{1,2},\d{3} \/ 40피트 1대\(FEU\) · 기준일 \d{4}-\d{2}-\d{2}/.test(text)
      && text.includes('견적 아님') && text.includes('한국해양진흥공사') && text.includes('kobc.or.kr') && text.includes('포함 안 됨'), text: text.slice(0, 700) };
});
// 메리에서 운송비를 물으면 — 같은 엔진 경로로 나라마다 시세·기준일·출처를 답하고, 근거 탭에 출처 달린 근거로 넣는다(모델 없이)
test('n24-merry-answers-freight-question', async ({ cdp, EXT, Page, swEval }) => {
  const p = await Page.open(cdp, `${EXT}/merry.html`);
  await p.waitFor('!!window.a2a');
  if (process.env.A2A_ENGINE) await swEval(cdp, `globalThis.a2a.engineAt(${JSON.stringify(process.env.A2A_ENGINE)})`);
  const id = await p.eval(`(async () => {
    const d = await window.a2a.invoke('invest:call', 'create', { company: '운송비시험' });
    window.__f = { idle: 0 };
    window.a2a.on('invest:progress', (e) => { if (e.dealId === d.id && e.type === 'idle') window.__f.idle++; });
    await window.a2a.invoke('invest:call', 'say', d.id, '이거 이탈리아나 스페인에 팔려면 지금 대략 운송비가 얼마나 들지?');
    return d.id;
  })()`);
  await p.waitFor('window.__f.idle >= 1', 60000).catch(() => null);
  await p.eval(`window.a2a.invoke('invest:call', 'say', ${JSON.stringify(id)}, '스페인 운임 다시 알려줘')`);
  await p.waitFor('window.__f.idle >= 2', 60000).catch(() => null);
  const v = await p.eval(`window.a2a.invoke('invest:call', 'deal', ${JSON.stringify(id)})`);
  await p.close();
  const said = v.chat.filter((m) => m.role === 'merry' && m.kind === 'msg').map((m) => m.text);
  const first = said.find((t) => t.includes('운송비 시세')) || '';
  const facts = (v.deal.facts || []).filter((f) => f.key.startsWith('freight_'));
  return { ok: /이탈리아 → 지중해 항로 \$\d{1,2},\d{3} \/ 40피트 한 대 \(기준일 \d{4}-\d{2}-\d{2}/.test(first) && first.includes('스페인 — 도착 항구에 따라')
      && first.includes('견적이 아니에요') && first.includes('부산으로 봤어요') && first.includes('kobc.or.kr')
      && facts.map((f) => f.key).sort().join() === 'freight_kmdi,freight_knei' && facts.every((f) => (f.url || '').includes('kobc.or.kr') && f.unit === 'USD/FEU' && /^\d{4}-/.test(f.period))
      && said.some((t) => t.includes('이미 근거 탭에 있어요')),
    first: first.slice(0, 600), facts: facts.map((f) => `${f.key}=${f.value} ${f.period}`) };
});
// 운임 문의 답장의 사실표 — 숫자·기준일·출처가 엔진 결과에서 그대로 오고, 견적가는 언제나 모르는 칸인지(글쓰기 모델 없이 확인)
test('n23-freight-reply-facts-come-from-the-engine', async ({ cdp, EXT, Page, swEval }) => {
  const p = await Page.open(cdp, `${EXT}/freight.html`);
  await p.waitFor('!!window.a2a');
  if (process.env.A2A_ENGINE) await swEval(cdp, `globalThis.a2a.engineAt(${JSON.stringify(process.env.A2A_ENGINE)})`);
  const d = await p.eval("window.a2a.invoke('freight:ocean', { origin: 'KR', destination: 'IT', container: '40', cargo: '가구' })");
  const no = await p.eval("window.a2a.invoke('freight:ocean', { origin: '상하이', destination: 'IT', container: '40' })");
  await p.close();
  const brief = (x, input) => swEval(cdp, `globalThis.a2a.makeAgent().freightBrief(${JSON.stringify(x)}, ${JSON.stringify(input)})`);
  const b = await brief(d, { inquiry: '부산에서 제노바까지 40피트 한 대 운임 문의드립니다', cargo: '가구', customer: 'Rossi Mobili' });
  const n = await brief(no, {});
  const lane = d.lanes[0];
  const rate = `$${Math.round(lane.usd_per_feu).toLocaleString('en-US')}`;
  const all = b.facts.map((f) => f.fact).join('\n');
  return { ok: all.includes(rate) && all.includes(`기준일 ${lane.as_of}`) && all.includes('견적가가 아니다') && all.includes('들어 있지 않은 비용')
      && b.facts.filter((f) => /\$\d/.test(f.fact)).every((f) => (f.source || '').includes('kobc.or.kr'))
      && b.blanks.includes('우리 회사가 제시할 실제 견적가') && b.audience === 'Rossi Mobili' && b.facts.length <= 40 && b.facts.every((f) => f.fact.length <= 500)
      && !n.facts.some((f) => /\$\d/.test(f.fact)) && n.facts.some((f) => f.fact.includes('확인하지 못했다')),
    facts: b.facts.length, blanks: b.blanks, unknown: n.facts.map((f) => f.fact) };
});
// 실제 사이트 — 접점 찾기가 끝까지 기다리게 하지 않고, 읽는 대로 진행과 주소를 화면에 올리는지
test('n19-contacts-fill-in-as-found-real', async ({ cdp, EXT, Page }) => {
  const p = await Page.open(cdp, `${EXT}/contacts.html`);
  await p.waitFor("!!document.querySelector('#contact-domain') && !!window.a2a");
  await p.eval(`(() => {
    window.__c = { live: 0, liveRows: 0, events: [] };
    window.a2a.on('contacts:progress', (ev) => window.__c.events.push(ev.type));
    new MutationObserver(() => {
      const live = document.querySelector('#contact-live');
      if (live) { window.__c.live++; window.__c.liveRows = Math.max(window.__c.liveRows, live.querySelectorAll('.contact-row').length); }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    const input = document.querySelector('#contact-domain');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'mysc.co.kr');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await p.waitFor("!document.querySelector('#contact-find').disabled");
  await p.eval("document.querySelector('#contact-find').click()");
  const done = await p.waitFor("!!document.querySelector('#contact-result')", 90000).catch(() => null);
  const c = await p.eval('window.__c');
  const rows = await p.eval("document.querySelectorAll('#contact-result .contact-row').length");
  const checking = await p.eval("document.querySelector('#contact-result').innerText.includes('확인하는 중')");
  // 공식 채널 — 홈페이지가 링크한 계정이 출처 표시와 함께 나온다
  const channels = await p.eval("[...document.querySelectorAll('#contact-result #contact-channels > ul .channel-row')].map((r) => r.innerText)");
  await p.shot('n19-contacts.png', { width: 1200, height: 800 });
  await p.close();
  return { ok: !!done && c.live > 1 && c.liveRows >= 1 && c.events.includes('page') && c.events.includes('email') && rows >= 1 && !checking
      && c.events.includes('channel') && channels.some((t) => t.includes('인스타그램') && t.includes('홈페이지에 링크됨')),
    channels: channels.length, liveUpdates: c.live, liveRows: c.liveRows, rows, events: c.events.length };
});
test('n20-drag-select-copy-and-search', async ({ cdp, EXT, Page, swEval, sleep }) => {
  // 글을 끌어 고르면 노란 하이라이트 + 복사·검색 메뉴. 검색은 보던 탭에서 열리고 뒤로 가기로 돌아온다.
  const p = await Page.open(cdp, `${EXT}/contacts.html`);
  await p.waitFor("!!document.querySelector('#contacts h1')");
  const style = await p.eval(`(() => {
    const h = document.querySelector('#contacts h1');
    const r = document.createRange(); r.selectNodeContents(h);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    h.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return { select: getComputedStyle(h).userSelect, mark: getComputedStyle(h, '::selection').backgroundColor, button: getComputedStyle(document.querySelector('#contact-find')).userSelect };
  })()`);
  const menu = await p.waitFor("!!document.querySelector('#selection-copy') && !!document.querySelector('#selection-search')", 4000).catch(() => null);
  const before = (await swEval(cdp, 'chrome.tabs.query({})')).length;
  await p.eval("document.querySelector('#selection-search').click()");
  const went = await p.waitFor("location.hostname.includes('google.')", 15000).catch(() => null);
  const after = (await swEval(cdp, 'chrome.tabs.query({})')).length;
  await p.eval('history.back()').catch(() => {});
  const back = await p.waitFor("location.pathname === '/contacts.html' && !!document.querySelector('#contacts h1')", 10000).catch(() => null);
  await p.close();
  return { ok: !!menu && style.select !== 'none' && style.mark === 'rgb(255, 228, 92)' && style.button === 'none' && !!went && after === before && !!back, style, menu: !!menu, went: !!went, sameTab: after === before, back: !!back };
});
test('n21-split-view-from-the-app-menu', async ({ cdp, EXT, Page, swEval, sleep }) => {
  // 맨 위 메뉴의 "분할 뷰" — 이 화면 옆에 탭을 나란히 열고, 다시 누르면 푼다. 고른 글은 옆 칸에서 검색한다.
  const p = await Page.open(cdp, `${EXT}/contacts.html`);
  await p.waitFor("!!document.querySelector('#nav-split') && !!document.querySelector('#contacts h1')");
  const mine = "chrome.tabs.query({}).then((x) => { const me = x.find((t) => (t.url || '').endsWith('/contacts.html')); return { split: me?.splitViewId ?? -1, pair: x.filter((t) => me && t.splitViewId === me.splitViewId && t.splitViewId !== -1).map((t) => t.pendingUrl || t.url) }; })";
  await p.eval("document.querySelector('#nav-split').click()");
  await sleep(1500);
  const on = await swEval(cdp, mine);
  await p.eval(`(() => { const h = document.querySelector('#contacts h1'); const r = document.createRange(); r.selectNodeContents(h); const s = getSelection(); s.removeAllRanges(); s.addRange(r); h.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); })()`);
  await p.waitFor("!!document.querySelector('#selection-split')", 4000).catch(() => null);
  await p.eval("document.querySelector('#selection-split')?.click()");
  let beside = { pair: [] };
  for (let i = 0; i < 16 && !beside.pair.some((u) => u.includes('google.')); i++) { await sleep(500); beside = await swEval(cdp, mine); }
  const kept = await p.eval("location.pathname === '/contacts.html'");
  await p.eval("document.querySelector('#nav-split').click()");
  await sleep(1500);
  const off = await swEval(cdp, mine);
  const extra = await swEval(cdp, "chrome.tabs.query({}).then((x) => x.filter((t) => (t.pendingUrl || t.url || '').includes('google.')).map((t) => t.id))");
  if (extra.length) await swEval(cdp, `chrome.tabs.remove(${JSON.stringify(extra)})`);
  await p.close();
  return { ok: on.split !== -1 && on.pair.length === 2 && beside.pair.length === 2 && beside.pair.some((u) => u.includes('google.')) && kept && off.split === -1, on, beside, off };
});
test('n14-every-app-page-has-home-and-map', async ({ cdp, EXT, Page }) => {
  const seen = {};
  for (const page of ['merry', 'contacts', 'freight', 'learn', 'map']) {
    const p = await Page.open(cdp, `${EXT}/${page}.html`);
    seen[page] = !!(await p.waitFor("!!document.querySelector('#nav-home') && !!document.querySelector('[data-app=map]')", 6000).catch(() => null));
    await p.close();
  }
  return { ok: Object.values(seen).every(Boolean), seen };
});
test('n15-home-button-returns-from-app', async ({ cdp, EXT, Page, swEval, sleep }) => {
  const stale = await swEval(cdp, "chrome.tabs.query({}).then((x) => x.filter((t) => (t.url || '').endsWith('/merry.html')).map((t) => t.id))");
  if (stale.length) await swEval(cdp, `chrome.tabs.remove(${JSON.stringify(stale)})`);   // 앞선 시험이 남긴 메리 탭
  const p = await Page.open(cdp, `${EXT}/merry.html`);
  await p.waitFor("!!document.querySelector('#nav-home')");
  await p.eval("document.querySelector('#nav-home').click()");
  await sleep(1200);
  const urls = await swEval(cdp, "chrome.tabs.query({}).then((x) => x.map((t) => t.url || t.pendingUrl))");
  await p.close().catch(() => {});
  return { ok: urls.some((u) => u.startsWith('chrome://newtab') || u.endsWith('/newtab.html')) && !urls.some((u) => u.endsWith('/merry.html')), urls };
});
test('n16-home-uses-the-shared-app-menu', async ({ cdp, Page }) => {
  // 홈에도 같은 맨 위 메뉴 하나 — 앱 목록을 사이드바에 또 두지 않는다
  const p = await Page.open(cdp, 'chrome://newtab/');
  const ok = await p.waitFor("!!document.querySelector('#ask') && ['merry','contacts','freight','learn','map'].every((a) => document.querySelectorAll(`[data-app=${a}]`).length === 1) && !document.querySelector('#home-sidebar')", 6000).catch(() => null);
  await p.close();
  return { ok: !!ok };
});
test('n17-contacts-page-opens-by-name', async ({ cdp, Page }) => {
  const p = await Page.open(cdp, 'chrome://newtab/');
  await p.waitFor("!!document.querySelector('#ask')");
  await p.eval("window.a2a.send('nav:go', '헌터')");
  const ok = await p.waitFor("location.pathname === '/contacts.html'", 8000).catch(() => null);
  await p.close();
  return { ok: !!ok };
});
test('n10-bookmarks-seeded-once', async ({ swEval, cdp, sleep }) => {
  await sleep(300);
  const titles = await swEval(cdp, "chrome.bookmarks.getChildren('1').then((x) => x.map((b) => b.title))");
  return { ok: ['메리', '접점 찾기', '학습', '업무 지도'].every((t) => titles.filter((x) => x === t).length === 1), titles };
});
test('n11-a2a-scheme-rewrites', async ({ cdp, EXT, Page }) => {
  if (!process.env.A2A_BUILTIN) return { ok: true, skipped: 'C++ 패치는 내장 모드에서만' };
  const p = await Page.open(cdp, 'about:blank');
  await p.cdp.send('Page.enable', {}, p.sessionId);
  await p.cdp.send('Page.navigate', { url: 'a2a://메리' }, p.sessionId).catch(() => {});
  const ok = await p.waitFor(`location.href === ${JSON.stringify(`${EXT}/merry.html`)}`, 8000).catch(() => null);
  await p.close();
  return { ok: !!ok };
});
}
