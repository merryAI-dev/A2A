// 메리와 함께 쓰기 — 보고서 옆 대화창의 두뇌. 심사역과 주고받으며 쓴다(한 번에 생성하지 않는다).
//
//   섹션 쓰기: 브리핑(구성 + 근거로 못 채우는 판단 질문) → 심사역 답(객관식/직접 입력, 결정으로 기록)
//             → 쓰기(종이에 실시간) → 검증·채점 결과를 대화로 → 도구가 찾은 문제만 고쳐 쓰기
//             → 남은 문제(근거 없는 주장)는 심사역에게 어떻게 할지 묻는다
//   보고서 쓰기: 본문은 대화가 아니라 가운데 문서에 쓴다. 대화는 입력(지시·답)과 진행만 —
//             "목차대로 쭉 써 보자"는 말이나, 한두 번 주고받아 정해진 것이 생긴 뒤의 "이제 쓸까요?" 승낙으로 시작한다
//   심사역 말: 섹션을 고른 상태면 그 섹션을 지시대로 고쳐 쓰고("다음에도 적용할까요?" → 플레이북 교훈),
//             아니면 첨부 자료(PDF)를 직접 읽고 답한다
//   첨부: 자료를 올리면 바로 읽어 근거(쪽·인용)를 뽑고 대화에 알린다
// 질문은 기다린다 — 답이 올 때까지 다음 단계로 가지 않는다. 대화·생각·질문·결정은 모두 업무 지도에 남는다.
const { section: sectionOf, SECTIONS } = require('./template');

const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

function createCopilot({ room, pipe, frn = null, bridge = null, typeDeal = () => {}, send = () => {} }) {
  const busy = new Map();          // dealId → { what, stop }
  const waits = new Map();         // msgId → resolve
  const emit = (dealId, p) => send('invest:progress', { dealId, ...p });

  const say = (dealId, text, extra = {}) => room.say(dealId, { role: 'merry', kind: 'msg', text, ...extra });
  const stepMsg = (dealId, text, section = null) => room.say(dealId, { role: 'merry', kind: 'step', text, section });
  const thought = (dealId) => (label, text) => room.say(dealId, { role: 'merry', kind: 'thinking', label, text: short(text, 6000) });

  // 객관식 질문 — 답이 올 때까지 기다린다. 논의(질문 항목)에도 남긴다
  // 돌려주는 값: 답(문자열) 또는 null(건너뜀). 질문 항목 id는 lastAsked에
  const lastAsked = new Map();
  function ask(dealId, { text, options = null, section = null, why = '', item = true }) {
    const it = item ? room.addItem(dealId, { kind: 'question', text: `${text}${why ? `\n(왜: ${why})` : ''}`, section, options, byAgent: true }) : null;
    const msg = room.say(dealId, { role: 'merry', kind: 'ask', text, section, options, data: { why, itemId: it?.id || null } });
    lastAsked.set(dealId, it?.id || null);
    emit(dealId, { type: 'ask', msgId: msg.id });
    return new Promise((resolve) => waits.set(msg.id, { resolve, dealId, msg, it }));
  }

  // 심사역 답 — choice(선택지) 또는 text(직접), skip
  function answer(dealId, msgId, { choice = null, text = null, skip = false } = {}) {
    const w = waits.get(msgId);
    if (!w || w.dealId !== dealId) throw new Error('기다리는 질문이 아니에요');
    waits.delete(msgId);
    const value = skip ? null : String(choice ?? text ?? '').trim() || null;
    room.updateChat(dealId, msgId, { status: skip ? 'skipped' : 'answered', answer: value });
    if (value) {
      room.say(dealId, { role: 'user', kind: 'msg', text: value, section: w.msg.section });
      if (w.it) room.addItem(dealId, { kind: 'answer', text: value, replyTo: w.it.id, section: w.msg.section });
    }
    w.resolve(value);
    return { ok: true };
  }

  function guard(dealId, what) {
    if (busy.has(dealId)) throw new Error(`메리가 ${busy.get(dealId).what} 중이에요`);
    const st = { what, stopped: false };
    busy.set(dealId, st);
    emit(dealId, { type: 'busy', what });
    return st;
  }
  function release(dealId) {
    busy.delete(dealId);
    for (const [k, w] of waits) if (w.dealId === dealId) { waits.delete(k); room.updateChat(dealId, k, { status: 'skipped' }); w.resolve(null); }
    emit(dealId, { type: 'idle' });
  }
  const run = (dealId, what, fn) => {
    const st = guard(dealId, what);
    (async () => {
      let next = null;                // fn이 함수를 돌려주면 손을 뗀 뒤 이어서 한다(예: 승낙받은 보고서 쓰기)
      try { next = await fn(st); }
      catch (e) { say(dealId, `문제가 생겨 멈췄어요: ${short(e.message || e, 300)}`, { data: { error: true } }); }
      finally { release(dealId); }
      if (typeof next === 'function') next();
    })();
    return { started: true };
  };
  const stopped = (st) => { if (st.stopped) throw new Error('심사역이 멈췄어요'); };

  // 웹 조사 — 검토 열 때 자동으로, 또는 심사역이 "검색해/찾아봐"라고 하면. 실패해도 검토는 계속
  const WANTS_WEB = /(웹|인터넷|검색|찾아\s*(봐|보|줘)|조사|알아\s*봐|기사|뉴스)/;
  // 채널 글에는 [f:id] 대신 사람이 읽는 출처로
  function readableCites(dealId, text) {
    const d = room.get(dealId);
    return String(text || '').replace(/(\[f:[a-z0-9_]+\])+/g, (m) => {
      const ids = [...m.matchAll(/\[f:([a-z0-9_]+)\]/g)].map((x) => x[1]);
      const refs = [...new Set(ids.map((fid) => {
        const f = d.facts.find((x) => x.id === fid);
        if (!f) return null;
        if (f.url) return f.url;
        const src = d.sources.find((x) => x.id === f.sourceId);
        return `${src ? src.name.replace(/\.(pdf|md|txt|json)$/i, '') : '자료'}${f.page ? ` p.${f.page}` : ''}`;
      }).filter(Boolean))];
      return refs.length ? ` (${refs.join(', ')})` : '';
    });
  }

  // 운송비 — "이탈리아나 스페인에 팔려면 운송비가 얼마나?" 같은 물음. 숫자는 엔진이 공개 지수에서 읽은 그대로 쓴다(모델이 옮겨 적지 않는다).
  // 근거 탭에 출처·기준일과 함께 넣어, 보고서를 쓸 때 다른 근거처럼 인용된다. 지수이지 견적이 아니라는 말을 함께 남긴다.
  const FREIGHT_RE = /(운송비|운임|물류비|배송비|운반비|해상\s*운송|선적|컨테이너|freight|shipping)/i;
  // 물량은 메리가 정하지 않는다 — 물음에 없으면 심사역에게 묻고, 고른 값은 결정으로 남긴다(업무 지도의 합의)
  const VOLUME_OPTIONS = ['월 1대', '월 2대', '월 4대', '연 100대'];
  const freightVolumeTopic = '운송비 계산에 쓸 연간 물량(40피트)';
  async function freightFlow(dealId, text) {
    stepMsg(dealId, '공개 운임 지수(한국해양진흥공사 KCCI)에서 시세를 읽는 중…');
    let r = await bridge.freight(text, {});
    const priced0 = (r.results || []).some((x) => (x.lanes || []).some((l) => l.usd_per_feu != null));
    if (priced0 && !r.volume?.per) {
      // 이미 정한 물량이 있으면 그대로, 없으면 묻는다
      const prior = room.get(dealId).decisions.filter((x) => !x.supersededBy && x.topic === freightVolumeTopic).pop();
      const v = prior?.chosen || await ask(dealId, {
        text: `1년 운송비도 계산해 볼까요? 40피트 컨테이너를 얼마나 보낼지 정해 주세요.${r.volume?.count ? ` (말씀하신 ${r.volume.text}이(가) 한 달인지 1년인지 알려 주세요)` : ''}`,
        options: VOLUME_OPTIONS, why: '지난 52주 지수로 1년 운송비 범위를 계산합니다(지금 시세·평균·최저·최고)', item: false });
      if (v) {
        if (!prior && VOLUME_OPTIONS.includes(v)) {
          try { room.decide(dealId, { topic: freightVolumeTopic, chosen: v, rationale: '운송비 질문에 대한 심사역 판단 — 1년 운송비 범위 계산용' }); } catch (e) { stepMsg(dealId, `결정 기록 실패: ${short(e.message, 80)}`); }
        }
        r = await bridge.freight(`${text} ${v}`, {});
      }
    }
    if (!r.destinations?.length) {
      say(dealId, '어느 나라나 항구로 보낼지 알려 주시면 그 항로의 지금 운임 시세를 찾아 드릴게요(예: 이탈리아, 스페인 바르셀로나, ITGOA).');
      return;
    }
    const u = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
    const pct = (c) => (c ? `, 전주 대비 ${c.abs >= 0 ? '+' : '-'}${u(Math.abs(c.abs))}(${c.pct >= 0 ? '+' : ''}${c.pct}%)` : '');
    const lines = [], facts = [], body = [];
    let src = null;
    for (const x of r.results) {
      const where = x.destination?.input || '';
      const priced = (x.lanes || []).filter((l) => l.usd_per_feu != null);
      if (!priced.length) { lines.push(`· ${where} — 지수로는 답할 수 없어요: ${x.reason || '이유 미상'}`); continue; }
      src = src || x.source;
      const one = (l) => `${l.name_ko} 항로 ${u(l.usd_per_feu)} / 40피트 한 대 (기준일 ${l.as_of}${pct(l.change)}, 최근 ${l.range.weeks}주 ${u(l.range.low)}~${u(l.range.high)})`;
      lines.push(priced.length > 1
        ? `· ${where} — 도착 항구에 따라 항로가 갈려요:\n${priced.map((l) => `   ${one(l)}`).join('\n')}`
        : `· ${where} → ${one(priced[0])}`);
      for (const l of priced) {
        const quote = `부산 → ${l.name_ko}(${l.code}) ${u(l.usd_per_feu)}/FEU, 기준일 ${l.as_of}${pct(l.change)}`;
        body.push(quote);
        facts.push({ key: `freight_${l.code.toLowerCase()}`, label: `해상운임 부산→${l.name_ko} (40ft)`, value: l.usd_per_feu, unit: 'USD/FEU',
                     period: l.as_of, quote, section: '', basis: 'web', url: x.source?.url });
      }
      for (const l of priced) {
        const p = l.projection;
        if (!p) continue;
        if (p.status !== 'ok') { lines.push(`   1년 운송비: 계산하지 않았어요 — ${p.reason}`); continue; }
        const c = Object.fromEntries(p.cases.map((k) => [k.key, k]));
        lines.push(`   1년 운송비(${p.per_ko} ${p.count}대 → 1년 ${p.per_year}대, 40피트): 지금 시세면 ${u(c.now.annual_usd)}(${c.now.formula}), 지난 ${p.weeks}주 평균이면 ${u(c.avg.annual_usd)} — 범위 ${u(c.low.annual_usd)}~${u(c.high.annual_usd)}`);
      }
      for (const n of x.notes || []) lines.push(`   주의: ${n}`);
    }
    let added = 0;
    if (facts.length) {
      const seen = new Set(room.get(dealId).facts.map((f) => `${f.key}|${f.period}`));
      const fresh = facts.filter((f, i, a) => !seen.has(`${f.key}|${f.period}`) && a.findIndex((g) => g.key === f.key) === i);
      if (fresh.length) {
        const s = room.addSource(dealId, { name: `해상 운임 지수 KCCI ${fresh[0].period}.txt`, kind: 'web', mime: 'text/plain', url: src.url,
          buf: Buffer.from(`${src.publisher} ${src.name}\n${src.url}\n가져온 시각 ${src.fetched_at}\n\n${body.join('\n')}\n\n지수(항로 평균 시세)이며 견적이 아님.`, 'utf8') });
        added = room.addFacts(dealId, s.id, fresh, { byAgent: true }).length;
      }
    }
    const out = [`지금 운송비 시세예요 — 공개 지수 기준이고, 견적이 아니에요.${r.origin_assumed ? ' 출발지는 부산으로 봤어요(물음에 출발지가 없어서).' : ''}`, '', ...lines];
    if (src) {
      out.push('', `들어 있지 않은 것: ${(r.results.find((x) => x.not_included)?.not_included || []).join(', ')}`,
        `출처: ${src.publisher} ${src.name} · ${src.cadence} — ${src.url}`,
        added ? `근거 탭에 운임 ${added}개를 출처·기준일과 함께 넣었어요 — 보고서에 운송비를 쓰면 이 근거로 인용돼요. 기간별 추이는 '해상 운임' 화면에서 볼 수 있어요.`
          : `같은 기준일의 운임은 이미 근거 탭에 있어요. 기간별 추이는 '해상 운임' 화면에서 볼 수 있어요.`);
    }
    // 화면에도 — 메리 옆 칸(분할 뷰)에 해상 운임 화면을 같은 질문으로 채워 연다
    const first = r.results.find((x) => (x.lanes || []).some((l) => l.usd_per_feu != null));
    if (first && bridge.showFreight) {
      const vol = r.volume?.per ? r.volume : null;
      try {
        await bridge.showFreight({ to: first.destination?.input, n: vol?.count, per: vol?.per, size: vol?.size });
        out.push('옆 칸에 해상 운임 화면을 열어 같은 조건으로 채웠어요 — 추이 그래프와 1년 운송비 범위를 거기서 볼 수 있어요.');
      } catch (e) { stepMsg(dealId, `해상 운임 화면을 열지 못했어요: ${short(e.message, 80)}`); }
    }
    say(dealId, out.join('\n'));
  }

  // 사내 팀 채널에 올리기 — 초안을 보여 주고 대화창에서 승인받은 뒤에만(홈 에이전트와 같은 기준)
  const POST_RE = /(보내|올려|공유|게시|전달)/;
  async function postFlow(dealId, text) {
    if (!bridge?.channels) { say(dealId, '팀 채팅에 연결돼 있지 않아요.'); return; }
    let chans = [];
    try { chans = await bridge.channels(); } catch (e) { say(dealId, `채널 목록을 못 가져왔어요: ${short(e.message, 120)}`); return; }
    const names = chans.map((c) => c.name);
    // "#general에", "@투자-비공개로"처럼 조사가 붙어도 — 실제 채널 이름 중 가장 긴 앞부분 일치
    const tokens = (text.match(/[#@][\w가-힣-]+/g) || []).map((x) => x.slice(1));
    let name = null;
    for (const t of tokens) { const hit = names.filter((n) => t.startsWith(n)).sort((a, b) => b.length - a.length)[0]; if (hit) { name = hit; break; } }
    if (!name) {
      name = await ask(dealId, { text: '어느 채널에 올릴까요?', options: names.slice(0, 6), item: false });
      if (!name || !names.includes(name)) { say(dealId, '채널을 고르지 않아 올리지 않았어요.'); return; }
    }
    const ch = chans.find((c) => c.name === name);
    let last = 0;
    const draft = await pipe.answer(dealId, `${text}\n\n[메리에게] 이 답은 사내 채널 #${name}에 그대로 올라갑니다. 채널 글로 바로 쓸 수 있게 짧고 분명하게 쓰고, 대화 상대에게 하는 말("복사해서 올려 주세요" 등)은 넣지 마세요.`, {
      onThought: thought(dealId),
      onText: (_d, all) => { const now = Date.now(); if (now - last > 200) { last = now; emit(dealId, { type: 'reply', text: all }); } },
    });
    emit(dealId, { type: 'reply', text: null });
    const body = readableCites(dealId, draft).trim().slice(0, 7800);
    say(dealId, `#${name}에 올릴 글이에요:\n\n${body}`, { data: { draft: true } });
    const ok = await ask(dealId, { text: `이대로 #${name}에 올릴까요? (🤖 표시로 올라갑니다)`, options: ['올리기', '취소'], item: false });
    if (ok !== '올리기') { say(dealId, '올리지 않았어요.'); return; }
    const m = await bridge.post(ch.id, body, { taskId: `deal-${dealId}` });
    room.action(dealId, { kind: 'post', text: body, data: { channel: name, cid: ch.id, seq: m?.seq ?? null, approved_by: 'reviewer' } });
    say(dealId, `#${name}에 올렸어요.`);
  }

  // 홈 에이전트에게 맡기기 — 같은 에이전트(브라우저 탭·EMA·승인 게이트 그대로). 읽은 웹 페이지는 출처 URL이 달린 근거로
  async function browse(dealId, text) {
    if (!bridge?.delegate) return webLook(dealId, text);
    const d = room.get(dealId);
    stepMsg(dealId, '홈 에이전트에게 맡겼어요 — AI 패널에서 진행이 보이고, 누르기·입력·게시는 평소처럼 승인을 받습니다.');
    let r;
    try {
      r = await bridge.delegate(`[메리 딜룸 · ${d.company}${d.frn ? ` · FRN ${d.frn}` : ''} 투자 검토] ${text}\n찾은 사실은 출처 URL과 함께 정리해 주세요. 메일 발송·외부 게시·로그인은 하지 마세요.`);
    } catch (e) {
      stepMsg(dealId, `홈 에이전트를 쓸 수 없어 메리가 직접 웹 검색할게요(${short(e.message, 80)})`);
      return webLook(dealId, text);
    }
    room.action(dealId, { kind: 'delegate', text: `${text}\n\n[에이전트 답]\n${r.answer}`, data: { agent_task_id: r.taskId, status: r.status }, mode: 'shadow' });
    const pages = (bridge.reads?.(r.taskId) || []).slice(0, 6);
    let n = 0;
    for (const p of pages) {
      const src = room.addSource(dealId, { name: `웹 · ${short(p.title || p.url, 60)}.txt`, buf: Buffer.from(`${p.url}\n\n${p.text}`, 'utf8'), kind: 'web', mime: 'text/plain', url: p.url });
      try { n += (await pipe.extract(dealId, src.id, { onThought: thought(dealId) })).n; } catch (e) { stepMsg(dealId, `${short(p.url, 60)} 정리 실패: ${short(e.message, 80)}`); }
    }
    say(dealId, `홈 에이전트가 ${pages.length}개 페이지를 읽었고, 근거 ${n}개를 출처 링크와 함께 넣었어요(웹 공개자료 — 회사 자료로 확인 전까지는 보도 기준).${r.answer ? `\n\n[에이전트 답]\n${short(r.answer, 1500)}` : ''}`);
  }

  async function webLook(dealId, focus) {
    stepMsg(dealId, `공개 웹에서 ${room.get(dealId).company}을(를) 찾아보는 중…${focus ? ` (요청: ${short(focus, 60)})` : ''}`);
    try {
      const r = await pipe.research(dealId, { focus, hooks: { onThought: thought(dealId) } });
      const facts = room.get(dealId).facts.filter((f) => f.basis === 'web').slice(-r.n);
      say(dealId, `웹에서 공개 사실 ${r.n}개를 찾았어요(출처 링크 포함 — 회사 자료로 확인 전까지는 보도 기준).\n${facts.slice(0, 10).map((f) => `· ${f.label}: ${short(f.value, 60)}${f.url ? ` — ${f.url}` : ''}`).join('\n')}${r.summary ? `\n\n${r.summary}` : ''}${r.notFound?.length ? `\n못 찾은 것: ${r.notFound.slice(0, 5).join(', ')}` : ''}`);
    } catch (e) { stepMsg(dealId, `웹 조사 실패: ${short(e.message || e, 160)}`); }
  }

  // ── 섹션 함께 쓰기 ──
  function write(dealId, key) {
    const s = sectionOf(key);
    if (!s) throw new Error('모르는 섹션');
    return run(dealId, `${s.title} 쓰기`, (st) => writeOne(dealId, key, st));
  }

  // 섹션 하나를 종이에 쓴다. batch(목차대로 이어 쓰기)면 대화에는 진행과 질문만 남기고, 끝난 뒤의 처리 질문은 모아서 알린다
  async function writeOne(dealId, key, st, { batch = false } = {}) {
    const s = sectionOf(key);
    {
      const d = room.get(dealId);
      const cx = room.latestCompute(dealId);
      stepMsg(dealId, `${s.title} — 근거 ${d.facts.length}개, 유효한 결정 ${d.decisions.filter((x) => !x.supersededBy).length}개${cx ? `, 계산 변수 ${Object.keys(cx.vars).length}개` : ', 가정이 아직 잠기지 않음'}로 시작합니다`, key);
      if (!d.facts.length && !batch) say(dealId, '아직 읽은 자료가 없어요. IR·재무제표를 첨부해 주시면 근거를 뽑아 쓰겠습니다. 지금은 뼈대만 쓰고 숫자 칸은 [확인 필요]로 남길게요.', { section: key });
      // 쓰다 멈춘 섹션이면 구성을 다시 잡지 않고 다음 부분부터 잇는다
      const prev = pipe.resumable(d.sections[key]);
      let b;
      if (prev) {
        b = { outline: prev.progress.outline, questions: [], note: '' };
        say(dealId, `지난번에 ${prev.progress.done}/${b.outline.length}까지 썼어요. 다음 부분부터 이어서 쓸게요.`, { section: key });
      } else {
        b = await pipe.brief(dealId, key, { onThought: thought(dealId) });
        stopped(st);
        if (!batch) say(dealId, `이렇게 쓰려고 해요. 한 부분씩 써서 바로 종이에 올리고, 여쭤볼 것은 그 부분을 쓰기 직전에 물을게요.\n${b.outline.map((x, i) => `${i + 1}. ${x}`).join('\n')}${b.note ? `\n\n${b.note}` : ''}`, { section: key });
      }
      // 질문은 그 답이 필요한 부분을 쓰기 직전에 — 그 앞부분은 기다리지 않고 먼저 종이에 올라간다
      const partOf = (q) => Math.min(Math.max((Number(q.part) || 1) - 1, 0), Math.max(b.outline.length - 1, 0));
      const askOne = async (q) => {
        const v = await ask(dealId, { text: q.text, options: q.options?.length ? q.options : null, section: key, why: q.why });
        stopped(st);
        // 선택지를 고른 답만 결정(탐색 단계)으로 — 업무 지도에 "누가 무엇을 근거로 정했나"로 남는다. 직접 쓴 말은 답으로만
        if (v && q.options?.includes(v)) {
          const qid = lastAsked.get(dealId);
          try { room.decide(dealId, { topic: short(q.text, 120), chosen: v, rationale: `${s.title} 작성 중 메리 질문에 대한 심사역 판단${q.why ? ` — ${q.why}` : ''}`, evidence: qid ? [qid] : [], resolves: qid ? [qid] : [], section: key }); } catch (e) { stepMsg(dealId, `결정 기록 실패: ${short(e.message, 80)}`); }
        } else if (v && WANTS_WEB.test(v)) await browse(dealId, v);
      };
      const beforePart = async (i) => { stopped(st); for (const q of b.questions.filter((x) => partOf(x) === i)) await askOne(q); };
      if (b.outline.length < 2) await beforePart(0);            // 나눠 쓰지 않는 짧은 섹션은 먼저 다 묻는다
      let last = 0;
      const r = await pipe.writeSection(dealId, key, {
        brief: b,
        hooks: {
          beforePart,
          onThought: thought(dealId),
          onStep: (t) => emit(dealId, { type: 'step', section: key, text: t }),
          onDraft: (html) => { const now = Date.now(); if (now - last > 250) { last = now; emit(dealId, { type: 'draft', section: key, html }); } },
          onCheck: (c) => stepMsg(dealId, c.problems.length
            ? `검증 ${c.round ? '(고친 뒤) ' : ''}— 체크리스트 ${Math.round(c.score * 100)}%, 주장 ${c.claims}개 중 근거 불일치 ${c.unsupported}개. ${c.round ? '' : `문제 ${c.problems.length}개만 고쳐 쓸게요.`}\n${c.problems.slice(0, 6).map((p) => `· ${short(p, 140)}`).join('\n')}`
            : `검증 통과 — 체크리스트 ${Math.round(c.score * 100)}%, 주장 ${c.claims}개 모두 근거와 맞음`, key),
        },
      });
      emit(dealId, { type: 'draft', section: key, html: null });
      stopped(st);
      const bad = r.unsupportedClaims || [];
      if (batch) { stepMsg(dealId, `${s.title} — 문서에 올림 (체크리스트 ${r.summary.score}%${bad.length ? `, 근거 미확인 문장 ${bad.length}개` : ''})`, key); return { unsupported: bad.length }; }
      say(dealId, `${s.title}을(를) 종이에 올렸어요 (체크리스트 ${r.summary.score}%${r.summary.rounds ? ', 한 번 고쳐 씀' : ''}). 고칠 곳은 이 대화로 말씀해 주세요.`, { section: key });
      if (bad.length) {
        const v = await ask(dealId, {
          text: `근거로 확인되지 않은 문장이 ${bad.length}개 남았어요:\n${bad.slice(0, 5).map((c) => `· "${short(c.text, 90)}"`).join('\n')}\n어떻게 할까요?`,
          options: ['[확인 필요]로 표시', '지우기', '그대로 두기(제가 확인)'], section: key, item: false,
        });
        stopped(st);
        if (v === '[확인 필요]로 표시' || v === '지우기') {
          const cur = room.get(dealId).sections[key];
          await pipe.writeSection(dealId, key, { base: cur.html, refine: false, instruction: `${v === '지우기' ? '다음 문장을 지우세요' : '다음 문장 끝에 [확인 필요: 근거 없음]을 붙이세요'}:\n${bad.map((c) => `- ${c.text}`).join('\n')}`,
            hooks: { onThought: thought(dealId), onDraft: (html) => emit(dealId, { type: 'draft', section: key, html }) } });
          emit(dealId, { type: 'draft', section: key, html: null });
          say(dealId, v === '지우기' ? '그 문장들을 지웠어요.' : '[확인 필요]로 표시했어요.', { section: key });
        } else if (v) {
          room.decide(dealId, { topic: `${s.title} 근거 미확인 문장 처리`, chosen: '심사역이 직접 확인하고 그대로 둠', section: key });
        }
      }
      return { unsupported: bad.length };
    }
  }

  // ── 목차대로 이어 쓰기 — 아직 안 쓴(또는 쓰다 멈춘) 섹션을 순서대로 문서에. 대화에는 본문을 쓰지 않는다 ──
  const BODY = SECTIONS.filter((x) => x.key !== 'cover');
  const todo = (dealId) => { const d = room.get(dealId); return BODY.filter((x) => !d.sections[x.key] || pipe.resumable(d.sections[x.key])); };
  function writeAll(dealId) {
    return run(dealId, '보고서 쓰기', async (st) => {
      const keys = todo(dealId);
      if (!keys.length) { say(dealId, '목차의 섹션을 모두 문서에 써 두었어요. 고칠 섹션을 고르고 말씀해 주세요.'); return; }
      say(dealId, `목차대로 ${keys.length}개 섹션을 가운데 문서에 씁니다. 본문은 문서에 올리고, 여기에는 진행과 여쭤볼 것만 남길게요. 멈추려면 멈춤을 누르세요.`);
      const flagged = [];
      for (const [i, x] of keys.entries()) {
        stopped(st);
        emit(dealId, { type: 'step', section: x.key, text: `${x.title} (${i + 1}/${keys.length})` });
        const r = await writeOne(dealId, x.key, st, { batch: true });
        if (r?.unsupported) flagged.push(`${x.title} ${r.unsupported}개`);
      }
      say(dealId, `${keys.length}개 섹션을 문서에 올렸어요. 고칠 곳은 문서에서 그 섹션을 고른 뒤 여기에 말씀해 주세요.${flagged.length ? `\n근거로 확인되지 않은 문장이 남은 섹션: ${flagged.join(', ')}` : ''}`);
    });
  }

  // 정해진 것이 생겼으면 "이제 쓸까요?" — 검토마다 한 번만 묻는다. 승낙하면 true
  const offered = new Set();
  async function offerWrite(dealId) {
    const d = room.get(dealId);
    const live = d.decisions.filter((x) => !x.supersededBy);
    if (offered.has(dealId) || !live.length || Object.keys(d.sections).length) return false;
    offered.add(dealId);
    const v = await ask(dealId, {
      text: `지금까지 정한 것으로 투심보고서 초안을 가운데 문서에 쓸까요?\n${live.slice(-5).map((x) => `· ${short(x.topic, 60)} → ${short(x.chosen, 60)}`).join('\n')}\n근거 ${d.facts.length}개를 쓰고, 아직 못 받은 자료는 [확인 필요]로 남깁니다.`,
      options: ['목차대로 쓰기', '아직이요'], item: false,
    });
    return v === '목차대로 쓰기';
  }
  // 대화로 쓰라고 한 말 — 본문을 대화에 쓰지 않고 문서 쓰기로 돌린다
  const WANTS_WRITE = /(써|쓰자|쓸까|쓰기|작성|채워)/;
  const WANTS_ALL = /(목차|보고서|투심|전체|전부|모두|쭉|처음부터|나머지|끝까지)/;
  const named = (text) => { const t = text.replace(/\s/g, '').toLowerCase(); return BODY.find((x) => t.includes(x.title.replace(/^[IVX]+\.\s*/, '').replace(/\s*\(.*\)$/, '').replace(/\s/g, '').toLowerCase())); };

  // ── 심사역이 대화창에 쓴 말 ──
  function user(dealId, text, { section = null } = {}) {
    text = String(text || '').trim().slice(0, 8000);
    if (!text) throw new Error('내용이 비었어요');
    // 질문을 기다리는 중이면 그 질문의 직접 답으로
    const pending = [...waits.entries()].find(([, w]) => w.dealId === dealId);
    if (pending) return answer(dealId, pending[0], { text });
    room.say(dealId, { role: 'user', kind: 'msg', text, section });
    // 채널에 올려 달라는 말(#채널/@채널 + 보내·올려·공유) — 섹션 고쳐 쓰기보다 먼저
    if (/[#@][\w가-힣-]+/.test(text) && POST_RE.test(text) || /(채널|팀)[^\n]{0,12}(보내|올려|공유|게시)/.test(text)) {
      return run(dealId, '채널에 올리기', () => postFlow(dealId, text));
    }
    if (bridge?.freight && FREIGHT_RE.test(text)) return run(dealId, '운송비 찾기', () => freightFlow(dealId, text));
    if (WANTS_WEB.test(text)) return run(dealId, '웹 찾기', () => browse(dealId, text));
    if (!section && WANTS_WRITE.test(text)) {
      const one = named(text);
      if (one) return write(dealId, one.key);
      if (WANTS_ALL.test(text)) return writeAll(dealId);
    }
    const sec = section && room.get(dealId).sections[section];
    if (sec) {
      const s = sectionOf(section);
      return run(dealId, `${s.title} 고쳐 쓰기`, async (st) => {
        room.addItem(dealId, { kind: 'comment', text: `[${s.title} 수정 지시] ${text}`, section });
        const r = await pipe.writeSection(dealId, section, { base: sec.html, instruction: text,
          hooks: { onThought: thought(dealId), onStep: (t) => emit(dealId, { type: 'step', section, text: t }),
            onDraft: (html) => emit(dealId, { type: 'draft', section, html }) } });
        emit(dealId, { type: 'draft', section, html: null });
        stopped(st);
        say(dealId, `말씀대로 고쳤어요 (체크리스트 ${r.summary.score}%${r.summary.unsupported ? `, 근거 불일치 ${r.summary.unsupported}` : ''}).`, { section });
        // 사람의 수정은 가장 좋은 교훈 — 다음 보고서에도 쓸지 묻는다(ACE식 플레이북)
        const v = await ask(dealId, { text: '이 지시를 다음 보고서에도 적용할까요?', options: ['이 섹션의 교훈으로 저장', '이번만'], section, item: false });
        if (v === '이 섹션의 교훈으로 저장') { pipe.addLesson(section, text, 'human'); say(dealId, '플레이북에 저장했어요. 다음 보고서의 이 섹션부터 붙습니다.', { section }); }
      });
    }
    return run(dealId, '답하기', async () => {
      let last = 0;
      const out = await pipe.answer(dealId, text, {
        onThought: thought(dealId),
        onText: (_d, all) => { const now = Date.now(); if (now - last > 200) { last = now; emit(dealId, { type: 'reply', text: all }); } },
      });
      emit(dealId, { type: 'reply', text: null });
      say(dealId, out || '(답을 만들지 못했어요)');
      if (await offerWrite(dealId)) return () => writeAll(dealId);
    });
  }

  // ── 첨부 — 올리면 바로 읽는다 ──
  function attached(dealId, sources) {
    if (!sources.length) return { started: false };
    room.say(dealId, { role: 'user', kind: 'msg', text: `📎 ${sources.map((s) => s.name).join(', ')}` });
    return run(dealId, '자료 읽기', async (st) => {
      for (const src of sources) {
        stepMsg(dealId, `${src.name}을(를) 읽는 중…`);
        const r = await pipe.extract(dealId, src.id, { onThought: thought(dealId) });
        stopped(st);
        const facts = room.get(dealId).facts.filter((f) => f.sourceId === src.id);
        const by = {};
        for (const f of facts) by[f.section || '기타'] = (by[f.section || '기타'] || 0) + 1;
        // 받기로 한 자료가 들어왔는지 — 열린 요청과 대조
        let matched = [];
        try { matched = await pipe.matchRequests(dealId, src.id); } catch { /* 대조 실패는 넘어간다 */ }
        for (const m of matched) room.updateItem(dealId, m.item, { status: m.status === 'partial' ? 'partial' : 'received', evidence: m.facts || [] }, { note: m.note || src.name });
        if (matched.length) {
          const items = room.get(dealId).items;
          say(dealId, `요청했던 자료 중 ${matched.length}개가 들어왔어요:\n${matched.map((m) => `· ${m.status === 'partial' ? '(일부) ' : ''}${short(items.find((x) => x.id === m.item)?.text, 80)}`).join('\n')}\n남은 요청: ${items.filter((x) => x.kind === 'request' && x.status === 'open').length}개`);
        }
        say(dealId, `${src.name}에서 근거 ${r.n}개를 뽑았어요(쪽 번호·원문 인용 포함).\n${Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `· ${sectionOf(k)?.title || k}: ${n}개`).join('\n')}${r.notes ? `\n${r.notes}` : ''}`);
      }
      if (!room.latestPack(dealId)) say(dealId, '가정이 아직 잠기지 않았어요. 가정·계산 탭에서 "근거로 초안 만들기" 후 잠그면 밸류에이션 숫자를 계산해서 쓸 수 있어요.');
    });
  }

  // ── FRN 연결: 대표·앵커의 지시를 붙여 넣으면 검토를 연다 ──
  // 확정하지 않는다: 단계는 '발굴', 지시 속 숫자는 [미확인 주장], 할 일은 "부족한 자료를 받아 내기"
  function intake(text, { instructor = '', channel = '' } = {}) {
    text = String(text || '').trim().slice(0, 8000);
    if (!text) throw new Error('지시 내용이 비었어요');
    const tmp = `intake_${Date.now()}`;
    let dealId = null, goWrite = false;
    busy.set(tmp, { what: '지시 읽기' });
    send('invest:progress', { type: 'intake', state: 'start' });
    (async () => {
      try {
        const p = await pipe.parseDirective(text, {}) || {};
        const code = (p.frn || (text.match(/\b[A-Z]{3}-[A-Z]{2}-\d{2}-\d{3}\b/) || [])[0] || '').trim() || null;
        // FRN 등록 정보(EMA) — 읽기 전용 도구로
        let reg = null, regErr = null;
        if (code && frn) { try { reg = await frn.get(code); } catch (e) { regErr = e.message; } }
        else if (!code && p.company && frn) { try { reg = await frn.search(p.company); } catch (e) { regErr = e.message; } }
        const regName = reg && (reg.match(/"name"\s*:\s*"([^"]{1,80})"/) || [])[1];
        const company = (regName || p.company || code || '이름 미상 기업').replace(/\s*\(.*?\)\s*$/, '');
        const deal = room.create({ company, fund: p.fund || '', amount: Number(p.amount_hint) || null, frn: code });
        dealId = deal.id;
        busy.delete(tmp);
        busy.set(dealId, { what: '검토 열기', stopped: false });
        send('invest:progress', { type: 'intake', state: 'deal', dealId });
        typeDeal(dealId);
        const dr = room.directive(dealId, { text, instructor: instructor || p.instructor || '', assignees: p.assignees || [], ask: p.ask || '', fund: p.fund || '', channel });
        room.say(dealId, { role: 'user', kind: 'msg', text: `[${dr.instructor}의 지시]\n${text}` });
        // 지시 원문을 자료로(대화·답변에서 다시 읽게), 속 숫자는 미확인 주장 근거로
        const dsrc = room.addSource(dealId, { name: `지시 — ${dr.instructor}.txt`, buf: Buffer.from(text, 'utf8'), kind: 'directive', mime: 'text/plain' });
        const claims = (p.claims || []).map((c, i) => ({ key: `claim_${i + 1}`, label: c.label || `주장 ${i + 1}`, value: c.value ?? c.text, unit: c.unit || '', period: c.period || '', quote: c.text || '', section: c.section || '', basis: 'claim' }));
        if (claims.length) room.addFacts(dealId, dsrc.id, claims, { byAgent: true });
        if (reg) {
          const rsrc = room.addSource(dealId, { name: `FRN ${code || company}.json`, buf: Buffer.from(reg, 'utf8'), kind: 'frn', mime: 'text/plain' });
          stepMsg(dealId, `EMA에서 FRN ${code || ''} 등록 정보를 가져왔어요 — 근거로 정리하는 중…`);
          try { await pipe.extract(dealId, rsrc.id, { onThought: thought(dealId) }); } catch (e) { stepMsg(dealId, `등록 정보 정리 실패: ${short(e.message, 120)}`); }
        } else {
          say(dealId, code ? `FRN ${code} 등록 정보를 못 가져왔어요${regErr ? `(${short(regErr, 120)})` : ''}. EMA가 연결돼 있으면 다시 시도할 수 있어요.` : '지시에 FRN 코드가 없어요. 회사 이름으로 EMA를 찾지 못했습니다.');
        }
        say(dealId, `${company} 검토를 열었어요${code ? ` (FRN ${code})` : ''}. 지시 속 숫자 ${claims.length}개는 확인 전 주장으로만 남겼고, 결론은 내리지 않습니다.${p.context?.length ? `\n상황: ${p.context.join(' / ')}` : ''}`);
        // 공개 웹에서 먼저 찾아본다 — 받을 자료 목록이 웹으로 확인되는 것까지 요청하지 않게
        await webLook(dealId, '');
        // 무엇을 받아 내야 하는가
        const g = await pipe.gaps(dealId, { onThought: thought(dealId) }) || {};
        for (const r of (g.requests || []).slice(0, 14)) {
          room.addItem(dealId, { kind: 'request', text: `${r.what}${r.why ? `\n(왜: ${r.why})` : ''}`, section: r.section || null, from: r.from || null, priority: r.priority || null, byAgent: true });
        }
        if (g.summary) say(dealId, `지금 상태 — 확정 아님\n${g.summary}`);
        if (g.request_message) say(dealId, `${dr.assignees?.length ? `${dr.assignees.join(', ')}님께` : '회사에'} 보낼 자료 요청 초안이에요(보내지 않았어요 — 복사해서 쓰세요).\n\n${g.request_message}`, { data: { draft: true } });
        for (const q of pipe.normQuestions(g.questions).slice(0, 3)) {
          const v = await ask(dealId, { text: q.text, options: q.options?.length ? q.options : null, why: q.why });
          if (v && q.options?.includes(v)) {
            const qid = lastAsked.get(dealId);
            try { room.decide(dealId, { topic: short(q.text, 120), chosen: v, rationale: `검토 착수 시 심사역 판단${q.why ? ` — ${q.why}` : ''}`, evidence: qid ? [qid] : [], resolves: qid ? [qid] : [], kind: 'scoping' }); } catch (e) { stepMsg(dealId, `결정 기록 실패: ${short(e.message, 100)}`); }
          } else if (v && WANTS_WEB.test(v)) await browse(dealId, v);
        }
        say(dealId, `받을 자료 ${room.get(dealId).items.filter((x) => x.kind === 'request' && x.status === 'open').length}개를 논의·결정 탭의 "받을 자료"에 올렸어요. 자료가 오면 여기로 끌어다 놓아 주세요 — 들어온 것은 제가 체크합니다.`);
        goWrite = await offerWrite(dealId);
      } catch (e) {
        if (dealId) say(dealId, `검토를 여는 중 문제가 생겼어요: ${short(e.message || e, 300)}`, { data: { error: true } });
        else send('invest:progress', { type: 'intake', state: 'error', text: short(e.message || e, 300) });
      } finally {
        busy.delete(tmp);
        if (dealId) release(dealId);
        send('invest:progress', { type: 'intake', state: 'done', dealId });
        if (goWrite) writeAll(dealId);
      }
    })();
    return { started: true };
  }

  return {
    write, writeAll, user, answer, attached, intake,
    stop: (dealId) => { const st = busy.get(dealId); if (st) { st.stopped = true; release(dealId); } return { ok: true }; },
    state: (dealId) => ({ busy: busy.get(dealId)?.what || null, waiting: [...waits.entries()].filter(([, w]) => w.dealId === dealId).map(([k]) => k) }),
  };
}

module.exports = { createCopilot };
