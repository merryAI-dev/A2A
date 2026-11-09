// 접점 발굴 도구가 온톨로지 → 하네스 개선 루프를 실제로 타는지 관찰한다.
//   node test/observe-contacts.mjs            (엔진 :8423 필요, 키는 ../.env의 ANTHROPIC_API_KEY)
// 절차: 확장 실은 Chromium 띄움 → 개발 키 주입 → 접점 과제 3개 실행(승인 자동) →
//       업무 지도 요약·신호 → 신호 하나에 교훈 제안 → 재실행 비교(probe) → 채택 →
//       같은 과제 재실행 → 전/후 단계·결과 비교를 JSON으로 출력.
// 모델 호출이 있는 단계(과제 실행·제안·probe)는 키가 없으면 거기서 멈추고 그때까지를 보고한다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const EXT_ID = fs.readFileSync(path.join(ROOT, 'extension-id.txt'), 'utf8').trim();
const CHROMIUM = process.env.A2A_CHROMIUM
  || path.join(os.homedir(), 'dev/chromium/src/out/A2A/Chromium.app/Contents/MacOS/Chromium');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function devKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const env = fs.readFileSync(path.resolve(ROOT, '../.env'), 'utf8');
    return (env.match(/^ANTHROPIC_API_KEY=(.*)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  } catch { return ''; }
}

// ── CDP 최소 구현 ──
function cdp(ws) {
  const sock = new WebSocket(ws);
  let id = 0;
  const wait = new Map();
  const subs = [];
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
    else for (const f of subs) f(m);
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const n = ++id;
    wait.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    sock.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return new Promise((r) => { sock.onopen = () => r({ send, on: (f) => subs.push(f), close: () => sock.close() }); });
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
  await c.send('Runtime.enable', {}, sessionId);
  let last;
  for (let i = 0; i < 40; i++) {
    const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    last = r;
    if (!r.exceptionDetails) break;
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
  for (let i = 0; i < 100; i++) {
    const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) return { proc, ws: m[1], profile };
    await sleep(200);
  }
  throw new Error(`Chromium이 뜨지 않음\n${err.slice(-800)}`);
}

// 과제 하나 실행 — done 이벤트까지 기다리고, 그 작업의 단계·상태를 돌려준다
async function runTask(c, text) {
  await swEval(c, `globalThis.a2a.autoConfirm = () => true`);           // 자동 승인(관찰용)
  await swEval(c, `globalThis.a2a.runAgent(${JSON.stringify(text)}, { fresh: true })`);
  for (let i = 0; i < 240; i++) {
    await sleep(1000);
    const cur = await swEval(c, `globalThis.a2a.current() && globalThis.a2a.current().status`);
    if (cur !== 'working') break;
  }
  return swEval(c, `(() => { const t = globalThis.a2a.tasks()[0];
    const a = t._text || t.summary || '';
    return { title: t.title, status: t.status, steps: t.steps.map((s) => s.name), summary: a.slice(0, 500),
             emails: [...new Set(a.match(/[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}/gi) || [])] }; })()`);
}

const K = `(async () => { for (let i = 0; i < 50 && !globalThis.a2a?.knowledge?.().harness; i++) await new Promise((r) => setTimeout(r, 100)); return true; })()`;

const main = async () => {
  const key = devKey();
  const report = { key: key ? 'present' : 'absent', tasks: [], map: null, signals: [], loop: null };
  const { proc, ws, profile } = await launch();
  const c = await cdp(ws);
  try {
    await swEval(c, K);
    if (!key) {
      report.note = 'ANTHROPIC_API_KEY 없음 — 에이전트 실행·교훈 제안을 건너뜀 (.env에 넣고 다시)';
      console.log(JSON.stringify(report, null, 1));
      return;
    }
    // 키 주입은 제품과 같은 경로(key:set)로 — 사이드 패널 페이지에서 invoke한다
    await pageEval(c, `chrome-extension://${EXT_ID}/sidepanel.html`,
                   `window.a2a.invoke('key:set', ${JSON.stringify(key)})`);
    await sleep(500);

    report.tools = await swEval(c, `globalThis.a2a.makeAgent().toolList().map((t) => t.name)`);
    if (!report.tools.includes('find_contacts')) throw new Error(`find_contacts가 실리지 않음(내장 확장이 옛 빌드?): ${report.tools}`);
    const TASKS = [
      'find_contacts 도구로 mysc.co.kr 담당자 연락 메일을 찾아 정리해줘',
      'find_contacts 도구로 acme-nonexistent-zz9.kr 연락 메일을 찾아줘. 없으면 없다고 말해줘',
      'find_contacts 도구로 anthropic.com에서 제휴 문의에 쓸 메일을 찾아줘',
      // 교훈을 만든 신호와 무관한 도메인 — 그 사례에만 맞춘 개선인지 가른다
      'find_contacts 도구로 crevisse.com 협업 제안을 보낼 메일을 찾아줘',
      'find_contacts 도구로 impactsquare.com 영업 제안을 보낼 메일을 찾아줘',
    ];
    for (const t of TASKS) {
      report.tasks.push(await runTask(c, t));
      await sleep(1500);                                   // 수집 settle
    }
    report.map = await swEval(c, `globalThis.a2a.knowledge().onto.summary()`);
    report.contacts = await swEval(c, `globalThis.a2a.knowledge().onto.list('contact').map((n) => n.label)`);
    report.signals = await swEval(c, `globalThis.a2a.knowledge().harness.signals()
      .map((s) => ({ id: s.id, type: s.type, title: s.title, locked: !!s.locked }))`);

    // 채택은 사람 몫이다 — 여기서는 사람이 납득할 최소 조건(이김·신호 해결·회귀 없음)을 넘은 것만 자동 채택한다.
    const attempts = [];
    let adopted = null, chosen = null;
    for (const target of report.signals.filter((x) => !x.locked).slice(0, 3)) {
      const lesson = await swEval(c, `globalThis.a2a.knowledge().harness.propose(${JSON.stringify(target.id)})`);
      const probe = await swEval(c, `globalThis.a2a.knowledge().harness.probe(${JSON.stringify(lesson.id)})`)
        .catch((e) => ({ error: String(e.message || e) }));
      const v = probe?.verdict;
      const pass = !!v && v.winner === 'B' && v.fixed_signal === true && !(v.regressions || []).length;
      attempts.push({ signal: target, lesson: { id: lesson.id, text: lesson.text, edit: lesson.edit }, pass,
                      probe: probe?.error ? probe : { verdict: v, baselineTools: probe?.baseline?.tools, candidateTools: probe?.candidate?.tools } });
      if (pass) {
        adopted = await swEval(c, `globalThis.a2a.knowledge().harness.adopt(${JSON.stringify(lesson.id)}, 'observer')`);
        chosen = lesson.id;
        break;
      }
    }
    const rerun = [];
    if (adopted) for (const t of TASKS) { rerun.push(await runTask(c, t)); await sleep(1500); }
    report.loop = { attempts, adoptedLesson: chosen, adopted, rerun,
                    liveVersion: await swEval(c, `globalThis.a2a.knowledge().harness.live.version()`) };
    console.log(JSON.stringify(report, null, 1));
  } finally {
    proc.kill();
    await sleep(800);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 늦게 닫히는 프로필 파일 */ }
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
