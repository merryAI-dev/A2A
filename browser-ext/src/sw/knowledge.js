// 업무 기록 · 업무 지도(온톨로지) · 하네스 개선 · 업무 유형 · SSoT — Electron 앱(browser/)의 모듈을 그대로 싣는다.
// 규칙은 browser/에 하나만 있다. 여기는 서비스 워커에 잇는 자리(Electron main.js의 makeKnowledge·ontoCall)다.
// 파일은 shim/fs.js(IndexedDB)에 쌓인다 — 이 브라우저 프로필 안에만 있고 밖으로 나가지 않는다.
import '../shim/globals.js';
import { ready as fsReady, seed, usage } from '../shim/fs.js';
import cfgText from '../../../browser/collect.config.json?raw';
import { collect } from '../../../browser/events.js';
import { createOntology } from '../../../browser/ontology.js';
import { createWorkTypes } from '../../../browser/worktypes.js';
import { createHarness, MODELS } from '../../../browser/harness.js';
import { createRecall } from '../../../browser/recall.js';
import { createSsotRegistry } from '../../../browser/ssot.js';
import { createInvest } from '../../../browser/invest/index.js';
import { createLearn } from '../../../browser/learn/index.js';
import { createEma } from '../../../browser/ema-mcp.js';
import { createSync, MODES as SYNC_MODES } from '../../../browser/sync.js';
import { loadSafeStorage } from '../shim/electron.js';
import { readFileSync } from '../shim/fs.js';
import { CFG } from './config.js';
import { handle, broadcast, on } from './hub.js';
import { store, llmKey, runtime, loadStore, saveStore, pushState, profile, checkEngineLLM } from './state.js';

const USER_DATA = '/userData';
const DEFAULT_MODEL = 'claude-opus-5-5';

let onto = null;
let harness = null;
let worktypes = null;
let recaller = null;
let ssotReg = null;
let deps = null;                  // tasks.js가 넘겨 준다: { Agent, toolNames, chatChannels, delegate, runModel }
let invest = null;
let learn = null;
let ema = null;
let sync = null;
let emaLoginTab = null;

const changed = () => broadcast('onto:changed');
export const baseModel = () => (MODELS[store.prefs.agentModel] ? store.prefs.agentModel : DEFAULT_MODEL);

// 수집기는 시작하자마자 켠다(탭·채팅 기록) — 온톨로지·하네스는 에이전트 쪽이 Agent를 넘겨 준 뒤에
export const ready = (async () => {
  await fsReady;
  await loadStore();
  seed('/a2a/browser/collect.config.json', cfgText);
  collect.init(USER_DATA, { profile });
  onto = createOntology({
    root: () => collect.root,
    taskInfo: (id) => { const t = store.tasks.find((x) => x.id === id); return t && { title: t.title, status: t.status }; },
  });
})();

export async function attach(d) {
  await ready;
  deps = d;
  const apiKey = () => llmKey();
  worktypes = createWorkTypes({
    dir: `${USER_DATA}/worktypes`, onto, apiKey, signals: () => harness?.signals() || [],
    onChange: () => { harness?.syncOnto(); changed(); },
  });
  harness = createHarness({
    dir: `${USER_DATA}/harness`, onto, apiKey, Agent: d.Agent, more: () => worktypes.extraNodes(),
    typeOf: (taskId) => worktypes?.typeOf(taskId) || null, typeName: (id) => worktypes?.get(id)?.name || '', currentType: () => d.currentType(),
    toolNames: () => [...d.toolNames(), ...(ema?.agentTools().map((t) => t.name) || [])],
    toolDocs: d.toolDocs, ema: () => ema, chatChannels: d.chatChannels,
    onChange: changed,
  });
  recaller = createRecall({ onto, signals: () => harness.signals(), sameType: (id) => worktypes.tasksOf(id) });
  ssotReg = createSsotRegistry({ dir: `${USER_DATA}/ssot`, onto, worktypes: () => worktypes });
  // EMA Station — 로그인은 A2A 탭에서 사용자가 직접(ema-mcp.js). 콜백은 shim/http.js가 탭 주소로 잡는다.
  await loadSafeStorage();
  ema = createEma({
    openLogin: (url) => chrome.tabs.create({ url }).then((t) => { emaLoginTab = t.id; }),
    closeLogin: () => {
      const id = emaLoginTab;
      emaLoginTab = null;
      if (id != null) setTimeout(() => chrome.tabs.remove(id).catch(() => {}), 1200);
    },
    onChange: pushState,
  });
  ema.connect();                      // 이번 세션에 로그인이 남아 있으면 조용히 다시 붙는다

  sync = createSync({
    root: () => collect.root, engine: () => CFG.engine, profile: () => profile(),
    mode: () => (SYNC_MODES.includes(store.prefs.sync) ? store.prefs.sync : 'off'), onChange: pushState,
  });
  // setInterval은 서비스 워커가 잠들면 멈춘다 — 주기는 chrome.alarms가 맡는다
  chrome.alarms.create('a2a-sync', { periodInMinutes: 5 });

  const send = (ch, ...a) => { broadcast(ch, ...a); if (ch === 'invest:changed') changed(); };
  invest = createInvest({
    userData: USER_DATA, collect, user: () => profile().user, apiKey, worktypes: () => worktypes, ema: () => ema,
    send, pickFiles: async () => [],   // 파일 고르기는 페이지가 한다(src/merry/main.jsx)
    bridge: {
      channels: () => d.chat.channels(),
      post: (cid, text, opts) => d.chat.post(cid, text, opts),
      delegate: (text) => d.delegate(text),
      // 맡긴 작업이 읽은 웹 페이지 — 근거로 가져온다(Electron main.js와 같다)
      reads: (taskId) => {
        const raw = onto.raw();
        const tid = `task:${taskId}`;
        const outE = (id) => (raw.outIdx.get(id) || []).map((i) => raw.edges[i]);
        const steps = [tid, ...outE(tid).filter((e) => e.r === 'has_step').map((e) => e.o)];
        const seen = new Set();
        const pages = [];
        for (const st of steps) for (const e of outE(st)) {
          if (e.r !== 'read' || seen.has(e.o)) continue;
          seen.add(e.o);
          const n = raw.nodes.get(e.o);
          const h = String(n?.props.hash || '').replace(/^sha256:/, '');
          if (!n?.props.url || !h) continue;
          let text = '';
          try { text = readFileSync(`${collect.root}/blobs/${h.slice(0, 2)}/${h}.txt`, 'utf8'); } catch { continue; }
          pages.push({ url: n.props.url, title: n.label, text: text.slice(0, 120000) });
        }
        return pages;
      },
    },
  });
  learn = createLearn({ userData: USER_DATA, projectRoot: null, apiKey, collect, user: () => profile().user, send: broadcast });

  runtime.extraState = () => {
    const id = d.runModel() || baseModel();
    return {
      ema: ema?.snapshot() || { status: 'off' },
      sync: sync?.snapshot() || { mode: 'off' },
      agentModel: { id, label: MODELS[id]?.label || id, base: baseModel(),
                    choices: Object.entries(MODELS).map(([m, x]) => ({ id: m, label: x.label })) },
    };
  };
  pushState();
  return { collect, onto, harness, worktypes, recaller, ema };
}
export { collect, SYNC_MODES, MODELS };
export const knowledge = () => ({ onto, harness, worktypes, recaller, ssotReg, invest, learn, ema, sync });
export function syncChanged() {
  if ((store.prefs.sync || 'off') !== 'off') sync?.run();
  else sync?.stop();
}
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'a2a-sync') return;
  await ready;
  await loadStore();
  if ((store.prefs.sync || 'off') !== 'off') sync?.run();
});

const user = () => profile().user;
const ontoCall = {
  summary: () => { try { ssotReg?.sync(); } catch (e) { console.warn('[ssot]', e.message); } return { ...onto.summary(), ssot: ssotReg?.stats() || null }; },
  list: (type, q) => onto.list(typeof type === 'string' ? type : null, typeof q === 'string' ? q.slice(0, 100) : ''),
  node: (id) => { if (typeof id !== 'string') return null; const n = onto.node(id); return n && { ...n, ssot: ssotReg?.get(id) || null }; },
  ssotIssue: (id) => ssotReg.issue(String(id), user()),
  ssotSyncAll: () => ({ issued: ssotReg.sync(), ...ssotReg.stats() }),
  graph: (o = {}) => onto.graph({ center: typeof o.center === 'string' ? o.center : null, depth: Math.min(3, Number(o.depth) || 2),
    types: Array.isArray(o.types) ? o.types.map(String) : null, limit: Math.min(800, Number(o.limit) || 400) }),
  harness: () => ({ ...harness.state(), worktypes: worktypes.state().types, models: MODELS, baseModel: baseModel() }),
  propose: (sigId) => harness.propose(String(sigId)),
  probe: (lessonId, model) => harness.probe(String(lessonId), { model: typeof model === 'string' ? model : null }),
  proposeFromProbe: (probeId) => harness.proposeFromProbe(String(probeId)),
  clearTypeEdit: (typeId) => harness.clearType(String(typeId)),
  adopt: (lessonId) => harness.adopt(String(lessonId), user()),
  reject: (lessonId) => harness.reject(String(lessonId), user()),
  rollback: (vid) => harness.rollback(vid === null ? null : String(vid)),
  worktypes: () => worktypes.state(),
  backfillTypes: () => worktypes.backfill(),
  probeType: async (typeId, model) => {
    const t = worktypes.get(String(typeId));
    if (!t || !Object.hasOwn(MODELS, model)) throw new Error('유형이나 모델이 맞지 않아요');
    const a = MODELS[t.model] ? t.model : baseModel();
    if (a === model) throw new Error('지금 쓰는 모델과 같아요');
    const tasks = worktypes.runs(t.id, 2).map((r) => r.id);
    if (!tasks.length) throw new Error('이 유형에 다시 돌릴 작업이 없어요');
    const out = [];
    for (const task of tasks) out.push(await harness.probeModel(task, { a, b: model, typeId: t.id }));
    return out;
  },
  setTypeModel: (typeId, model) => worktypes.setModel(String(typeId), model === null ? null : (Object.hasOwn(MODELS, model) ? model : (() => { throw new Error('모르는 모델'); })())),
  addLesson: (l = {}) => harness.addLesson({ text: String(l.text || ''), edit: l.edit || {}, signal: l.signal || null, task: l.task || null, by: user() }),
  syncNow: () => sync.run(),
  // 주장 튜플 내보내기 — 다운로드 폴더에 JSONL
  exportClaims: async () => {
    const name = `a2a-claims-${new Date().toISOString().slice(0, 10)}.jsonl`;
    const body = onto.claims().map((c) => JSON.stringify(c)).join('\n') + '\n';
    const url = `data:application/x-ndjson;charset=utf-8,${encodeURIComponent(body)}`;
    await chrome.downloads.download({ url, filename: name, saveAs: false });
    return name;
  },
};
handle('onto:call', async (name, ...args) => {
  args = args.filter((x) => !(x && typeof x.postMessage === 'function'));   // 허브가 붙인 포트는 빼고
  if (!Object.hasOwn(ontoCall, name)) throw new Error('blocked');
  await ready;
  if (!harness && name !== 'summary' && name !== 'list' && name !== 'node' && name !== 'graph') throw new Error('아직 준비 중이에요');
  return ontoCall[name](...args);
});
const LEARN_CALLS = new Set(['state', 'start', 'prepare', 'code', 'answer', 'due', 'setStatus', 'setNotes', 'tutor', 'chat', 'remove']);
const noPort = (args) => args.filter((x) => !(x && typeof x.postMessage === 'function'));
async function untilAttached() {
  await ready;
  for (let i = 0; i < 100 && !invest; i++) await new Promise((r) => setTimeout(r, 50));
}
handle('invest:call', async (name, ...args) => {
  await checkEngineLLM();   // 서비스 워커가 방금 깨어났으면 엔진 키를 아직 확인하지 않은 상태다 — 메리가 "키가 없어요"로 멈추지 않게
  if (typeof name !== 'string') throw new Error('blocked');
  await untilAttached();
  await loadStore();
  return invest.call(name, ...noPort(args));
});
handle('learn:call', async (name, ...args) => {
  if (!LEARN_CALLS.has(name)) throw new Error('blocked');
  await untilAttached();
  await loadStore();
  return learn[name](...noPort(args));
});
on('ema:connect', async () => { await untilAttached(); if (!deps.running()) ema.connect({ interactive: true }); });
on('ema:disconnect', async () => { await untilAttached(); if (!deps.running()) ema.disconnect(); });
handle('onto:usage', async () => { await ready; return usage(); });
on('map:open', () => chrome.tabs.create({ url: chrome.runtime.getURL('map.html') }));
on('merry:open', () => chrome.tabs.create({ url: chrome.runtime.getURL('merry.html') }));
on('learn:open', () => chrome.tabs.create({ url: chrome.runtime.getURL('learn.html') }));

globalThis.a2a = { ...(globalThis.a2a || {}), knowledge, collect: () => collect, fsUsage: usage };
