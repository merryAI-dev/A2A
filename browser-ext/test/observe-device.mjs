// 기기 조회 도구(device_query·find_app)를 에이전트가 실제로 쓰는지 브라우저에서 관찰한다.
//   node test/observe-device.mjs
// 필요: 엔진(app/device 포함)이 A2A_DEV_LLM_PROXY=1로 떠 있을 것 — 모델은 엔진 프록시로 부른다(키를 브라우저에 넣지 않는다).
//   A2A_DIST      실을 확장 폴더(기본 ../dist). 다른 포트의 엔진을 보게 고친 사본을 줄 때 쓴다
//   A2A_CHROMIUM  Chromium 실행 파일(기본 우리 빌드 out/A2A)
// 절차: 확장 실은 Chromium 띄움 → 질문마다 에이전트 실행(승인 요청 문구를 받아 적고 자동 답) →
//       쓴 도구·승인 요청·답을 JSON으로 출력. 마지막 질문은 승인을 거절해 읽지 않는지 본다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.A2A_DIST || path.join(ROOT, 'dist');
const EXT_ID = fs.readFileSync(path.join(ROOT, 'extension-id.txt'), 'utf8').trim();
const CHROMIUM = process.env.A2A_CHROMIUM
  || path.join(os.homedir(), 'dev/chromium/src/out/A2A/Chromium.app/Contents/MacOS/Chromium');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(ws) {
  const sock = new WebSocket(ws);
  let id = 0;
  const wait = new Map();
  sock.onclose = () => { console.error('브라우저와의 연결이 끊겼습니다'); setTimeout(() => process.exit(1), 1500); };
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const n = ++id;
    wait.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    sock.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return new Promise((r) => { sock.onopen = () => r({ send, close: () => sock.close() }); });
}

async function swEval(c, expr) {
  let sw = null;
  for (let i = 0; i < 60 && !sw; i++) {              // 막 떴을 땐 서비스 워커가 늦게 올라온다
    const { targetInfos } = await c.send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXT_ID}/`));
    if (!sw) await sleep(250);
  }
  if (!sw) throw new Error('확장 서비스 워커 없음');
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  let r;
  for (let i = 0; i < 20; i++) {
    r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (!/chrome is not defined/.test(r.exceptionDetails?.exception?.description || '')) break;
    await sleep(250);
  }
  await c.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

async function pageEval(c, url, expr) {
  const { targetId } = await c.send('Target.createTarget', { url });
  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  let last;
  for (let i = 0; i < 40; i++) {
    last = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (!last.exceptionDetails) break;
    await sleep(250);                      // 패널 브리지가 붙을 때까지
  }
  await c.send('Target.closeTarget', { targetId }).catch(() => {});
  if (last.exceptionDetails) throw new Error(last.exceptionDetails.exception?.description || 'pageEval 실패');
  return last.result?.value;
}

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-observe-'));
  const proc = spawn(CHROMIUM, [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    `--load-extension=${DIST}`, `--disable-extensions-except=${DIST}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run', '--no-default-browser-check', '--headless=new', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  proc.on('exit', (code, sig) => console.error(`Chromium 종료 code=${code} sig=${sig}\n${err.slice(-1500)}`));
  for (let i = 0; i < 100; i++) {
    const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) return { proc, ws: m[1], profile };
    await sleep(200);
  }
  throw new Error(`Chromium이 뜨지 않음\n${err.slice(-800)}`);
}

// 질문 하나 — 승인 요청 문구를 받아 적고 allow대로 답한다. 끝나면 쓴 도구와 답을 돌려준다.
async function ask(c, text, allow) {
  await swEval(c, `(globalThis.__confirms = [], globalThis.a2a.autoConfirm = (t) => { globalThis.__confirms.push(t); return ${allow}; }, true)`);
  // 기다리지 않고 띄운다 — runAgent의 약속은 작업이 끝나야 풀린다(중간에 멈추면 관찰도 멈춘다)
  await swEval(c, `(globalThis.a2a.runAgent(${JSON.stringify(text)}, { fresh: true }).catch((e) => { globalThis.__err = String(e); }), true)`);
  let stuck = true;
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    if (i > 2 && (await swEval(c, `globalThis.a2a.current() && globalThis.a2a.current().status`)) !== 'working') { stuck = false; break; }
  }
  if (stuck) {
    console.error('3분 안에 끝나지 않음 — 마지막 사건:', JSON.stringify(await swEval(c, `[globalThis.__err, ...globalThis.a2a.log().slice(-8).map((e) => JSON.stringify(e).slice(0, 300))]`)));
  }
  return swEval(c, `(() => { const t = globalThis.a2a.tasks()[0];
    return { question: ${JSON.stringify(text)}, approval: ${allow} ? '승인' : '거절', status: t.status,
             tools: t.steps.map((s) => s.name), confirms: globalThis.__confirms.map((x) => x.split('\\n')[0]),
             answer: (t._text || t.summary || '').slice(0, 1200) }; })()`);
}

const QUESTIONS = [
  ['지금 이 컴퓨터에서 메모리를 가장 많이 쓰는 프로그램 5개를 알려줘', true],
  ['이 노트북이 기본 보안 기준(디스크 암호화, 방화벽, 게이트키퍼, 시스템 무결성 보호)을 지키는지 점검해줘', true],
  ['이 컴퓨터에 구글 크롬이랑 줌이 설치돼 있어? 지금 실행 중인지도 알려줘', true],
  ['크롬에 깔린 확장 프로그램 목록을 버전과 함께 정리해줘', true],
  ['이 컴퓨터에서 지금 열려 있는 포트를 알려줘', false],          // 거절 — 읽지 않고 그렇게 전해야 한다
];

const main = async () => {
  const { proc, ws, profile } = await launch();
  const c = await cdp(ws);
  const report = { dist: DIST, runs: [] };
  try {
    await swEval(c, `(async () => { for (let i = 0; i < 80 && !globalThis.a2a?.runAgent; i++) await new Promise((r) => setTimeout(r, 100)); return true; })()`);
    console.error('서비스 워커 준비됨');
    // 업무 유형 고르기·지난 기록 붙이기는 끈다(사용자 설정) — 이 관찰은 기기 도구만 본다. 고르기가 떠도 첫 항목으로 답한다
    await pageEval(c, `chrome-extension://${EXT_ID}/sidepanel.html`,
                   `(window.a2a.send('prefs:set', 'worktype', false), window.a2a.send('prefs:set', 'recall', false), new Promise((r) => setTimeout(() => r(true), 500)))`);
    await swEval(c, `(globalThis.a2a.autoChoice = () => 0, true)`);
    report.tools = await swEval(c, `globalThis.a2a.makeAgent().toolList().map((t) => t.name)`);
    for (const [q, allow] of QUESTIONS) {
      const t0 = Date.now();
      const r = await ask(c, q, allow);
      r.seconds = Math.round((Date.now() - t0) / 1000);
      report.runs.push(r);
      console.error(`· ${r.status} ${r.seconds}s [${r.tools.join(', ')}] ${q}`);
      await sleep(1000);
    }
    console.log(JSON.stringify(report, null, 1));
  } finally {
    proc.kill();
    await sleep(800);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 늦게 닫히는 프로필 파일 */ }
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
