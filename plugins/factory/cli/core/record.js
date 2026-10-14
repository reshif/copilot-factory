'use strict';
// `factory record`: the single entry point that turns a workflow's result envelope into
// state. It validates the envelope, rejects stale results, re-checks anything it can
// check itself, and writes ledger entries. Agents' claims are never taken at face value
// where the CLI can verify them.

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, writeText, readText, exists, nowIso, fail } = require('../lib/util');
const { pluginPath, jobPaths } = require('../lib/paths');
const { validate } = require('../lib/schema');
const { seal } = require('../lib/seal');
const job = require('./job');
const steps = require('./steps');
const ledger = require('./ledger');
const budgets = require('./budgets');
const contractMod = require('./contract');
const invalidation = require('./invalidation');
const planMod = require('./plan');
const review = require('./review');
const wfargs = require('./wfargs');
const lifecycle = require('./lifecycle');
const decisionTable = require('./decision-table');
const questions = require('./questions');
const docMod = require('./doc');
const intentMod = require('./intent');

// Decide runs in a row whose design record fails the doc templates before the job parks.
const DOC_RETRY_CAP = 3;

// findings.md follows templates/docs/findings.md (findings@1).
function findingsMarkdown(state, topics, answers = [], intentRef = null) {
  const { frontBlock, cell, loadTemplate } = docMod;
  const answered = new Set(answers.map((a) => a.question));
  const unknowns = topics.flatMap((t) => t.unknowns.map((u) => ({ ...u, topic: t.topic })));
  const blocked = unknowns.some((u) => u.blocking && !answered.has(u.question));
  const L = [
    frontBlock({ doc: 'findings', template: loadTemplate('findings').version, job: state.id, title: state.title, status: blocked ? 'blocked' : 'grounded', date: nowIso().slice(0, 10), contract: 'contract.md', related: intentRef ? ['intent-findings.md'] : [] }),
    '',
    `# Findings — ${state.id}: ${state.title}`,
    '',
    '## Summary',
    '',
    'Every claim is cited (file:line, command, or URL) or marked UNVERIFIED.',
    ...(intentRef ? ['', `Builds on the intent research from clarify ([intent-findings.md](intent-findings.md): ${intentRef.evidence} finding(s), ${intentRef.assumptions} evidence-backed assumption(s)); those unknowns were not researched again.`] : []),
    '',
    '| Topic | Claims | Unverified | Unknowns | Blocking |',
    '|---|---|---|---|---|',
    ...topics.map((t) => `| ${cell(t.topic)} | ${t.claims.length} | ${t.claims.filter((c) => c.source === 'UNVERIFIED').length} | ${t.unknowns.length} | ${t.unknowns.filter((u) => u.blocking).length} |`),
    ...(topics.length ? [] : ['| — | 0 | 0 | 0 | 0 |']),
    '',
    '## Topics',
    '',
  ];
  for (const t of topics) {
    L.push(`### ${t.topic}`, '');
    if (!t.claims.length) L.push('_No claims._');
    for (const c of t.claims) L.push(`- ${c.claim} — ${c.source === 'UNVERIFIED' ? '**UNVERIFIED**' : `\`${c.source}\``}`);
    L.push('');
  }
  if (!topics.length) L.push('_No topics._', '');
  L.push('## Unknowns', '');
  for (const u of unknowns) L.push(`- ${u.blocking ? '(blocking) ' : ''}[${u.topic}] ${u.question}${u.blocking ? ` — ${answered.has(u.question) ? 'answered' : 'unanswered'}` : ''}`);
  if (!unknowns.length) L.push('None.');
  L.push('', '## Answers from the human', '');
  for (const a of answers) L.push(`- Q: ${a.question} — A: ${a.answer}`);
  if (!answers.length) L.push('None.');
  L.push('');
  return L.join('\n');
}

function insideJobDir(root, state, p) {
  const dir = jobPaths(root, state.id).dir;
  const abs = path.resolve(root, p);
  return abs.startsWith(dir + path.sep) && exists(abs) ? abs : null;
}

function recClarify(root, state, env) {
  const d = env.data || {};
  const cfg = readJson(pluginPath('config', 'workflows', 'clarify.json'));
  const jp = jobPaths(root, state.id);
  const round = state.counters.clarify_rounds + 1;
  const max = questions.budget(cfg, round, state.policy.limits);
  const log = state.question_log || [];
  const answers = readJson(jp.answers, []);
  // Grounded intent: fold this round's research into the job's record, re-check what the
  // CLI can check (repo quotes, URLs and quotes, the high-risk second-source rule), apply
  // answers, and re-sort unknowns into assumptions and questions.
  const set = intentMod.settings(root, state);
  const prior = intentMod.load(root, state.id);
  let idata = prior && !prior.tampered ? prior : d.scout ? intentMod.empty(state) : null;
  if (idata && d.scout) idata = intentMod.merge(idata, d.scout, round);
  if (idata) {
    idata.evidence = intentMod.checkEvidence(root, idata, { strict: set.budget.strict_second_source });
    idata = intentMod.sort(intentMod.applyAnswers(idata, state, answers));
  }
  // Re-apply the question protocol: every question names its unknown and cites evidence or
  // is the user's call; researchable questions research answered are not asked; then intent
  // first and alone, priority order, budget, never re-ask.
  const g = idata ? questions.ground((d.judge && d.judge.questions) || [], idata) : { questions: (d.judge && d.judge.questions) || [], researchable: [], flagged: [], created: [] };
  if (idata && g.created.length) idata.unknowns.push(...g.created);
  const n = questions.shape(g.questions, { budget: max, asked: questions.askedList(state, answers), startId: log.length });
  state.counters.clarify_rounds = round;
  const intentRounds = (state.counters.intent_rounds || 0) + (n.intent_open ? 1 : 0);
  const crit = d.critique || null;
  const researchableQs = (crit && crit.researchable_questions) || [];
  if (idata) {
    for (const q of n.questions) {
      const u = idata.unknowns.find((x) => x.id === q.unknown);
      if (u && !['answered', 'dropped'].includes(u.resolution)) Object.assign(u, { resolution: 'question', question_id: q.id });
    }
    for (const x of (d.judge && d.judge.dismissed) || []) {
      const u = x.unknown && idata.unknowns.find((y) => y.id === String(x.unknown).toUpperCase());
      if (u && u.resolution === 'question' && !u.question_id) Object.assign(u, { resolution: 'dismissed', note: `dismissed by the judge: ${String(x.reason || '').slice(0, 200)}` });
    }
    // God Eye's researchable questions go back to the scouts next round.
    let nextU = intentMod.nextIds(idata).U;
    for (const q of researchableQs) {
      const key = String(q.question || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key || idata.unknowns.some((u) => u.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === key)) continue;
      nextU += 1;
      idata.unknowns.push({ id: `U-${nextU}`, text: String(q.question).slice(0, 400), kind: q.kind === 'world' ? 'world' : 'repo', impact: 'high', draft: String(q.question).slice(0, 400), research: q.kind === 'world' ? 'web' : 'repo', resolution: 'pending', evidence: [], assumption: null, question_id: null, answer: null, note: q.why ? `God Eye: ${String(q.why).slice(0, 200)}` : 'sent back by God Eye', researched: false, source: 'god-eye', round });
    }
    intentMod.save(root, state.id, idata);
    intentMod.writeContract(root, state, idata);
    intentMod.render(root, state, idata);
  }
  const b = invalidation.current(root, state);
  const parsed = contractMod.parse(contractMod.read(root, state.id));
  const probs = contractMod.problems(parsed);
  // Floor intent_grounded: at medium and high risk a contract problem; at low risk advice.
  const grounded = intentMod.groundedProblems(root, state, { data: idata, parsed });
  const enforce = state.risk !== 'low';
  if (enforce) probs.push(...grounded.map((x) => `Not grounded: ${x}`));
  const warnings = enforce ? [] : grounded.map((x) => `intent_grounded (advisory at low risk): ${x}`);
  const researchView = idata ? (() => {
    const c = intentMod.counts(idata);
    const w = idata.web || {};
    return { unknowns: c.unknowns, evidence: c.evidence, confirmed: c.confirmed, assumptions: c.assumptions, by_kind: c.by_kind, by_resolution: c.by_resolution, web: w.enabled === false ? 'off' : w.available === false ? 'unavailable' : w.enabled ? 'on' : 'n/a', researchable_dropped: g.researchable.length, flagged: g.flagged.length, degraded: (d.scout && d.scout.degraded) || [] };
  })() : null;
  const grounding = idata
    ? { findings: intentMod.topFindings(idata), assumptions: intentMod.assumptionsView(idata), research: researchView, intent_findings: intentMod.files(root, state.id).md, intent_evidence: intentMod.files(root, state.id).json, ...(g.researchable.length ? { researchable_dropped: g.researchable } : {}), ...(g.flagged.length ? { flagged: g.flagged } : {}) }
    : {};
  const researchDetail = idata ? { ...researchView, researchable_asked: n.questions.filter((q) => q.researchable).length, scouted: Boolean(d.scout && d.scout.ran), scouts: ((d.scout && d.scout.scouts) || []).length, verifiers: (d.scout && d.scout.verifiers) || 0 } : null;
  if (idata) {
    ledger.append(root, state.id, {
      kind: 'intent', round,
      unknowns: idata.unknowns.map((u) => ({ id: u.id, kind: u.kind, impact: u.impact, resolution: u.resolution, evidence: u.evidence, ...(u.assumption ? { assumption: u.assumption } : {}), ...(u.question_id ? { question_id: u.question_id } : {}) })).slice(0, 60),
      evidence: idata.evidence.map((e) => ({ id: e.id, unknown: e.unknown, scout: e.scout, source: String(e.source).slice(0, 200), source_tier: e.source_tier, verdict: e.verdict })).slice(0, 80),
      assumptions: intentMod.liveAssumptions(idata).map((a) => ({ id: a.id, unknown: a.unknown, evidence: a.evidence, overridden: Boolean(a.overridden) })),
      questions: n.questions.map((q) => ({ id: q.id, unknown: q.unknown, researchable: Boolean(q.researchable), preference: Boolean(q.preference), evidence: q.evidence || [] })),
      researchable_dropped: g.researchable.map((r) => ({ unknown: r.unknown, assumption: r.assumption })),
      researchable_questions: researchableQs.length,
      scouted: Boolean(d.scout && d.scout.ran),
    });
  }
  // Intent never falls back to an assumption: still unclear after its rounds (or with no budget left) -> park.
  if (n.intent_open && (intentRounds > cfg.limits.intent_rounds || max === 0)) {
    job.save(root, state);
    const open = [...n.questions, ...n.dropped].map((q) => q.question);
    ledger.append(root, state.id, { kind: 'step', step: 'clarify', ok: false, bound: { contract: b.contract }, detail: { round, intent_open: true, intent_rounds: intentRounds - 1, questions: 0, contract_problems: probs, ...(researchDetail ? { research: researchDetail } : {}) } });
    return { status: 'park', park_from: 'clarify', park_reason: `The intent is still unclear after ${intentRounds - 1} round(s) of intent questions; the factory won't guess the why.${open.length ? ` Open: ${open.join(' | ')}` : ''}`, questions: n.questions };
  }
  state.counters.intent_rounds = intentRounds;
  state.question_log = [...log, ...n.questions.map((q) => ({ id: q.id, round, category: q.category, question: q.question, default: q.default, ...(q.unknown ? { unknown: q.unknown, kind: q.kind, evidence: q.evidence || [], preference: Boolean(q.preference), researchable: Boolean(q.researchable) } : {}) }))];
  state.asked_questions = [...new Set([...(state.asked_questions || []), ...n.questions.map((q) => q.question)])];
  if (researchDetail) state.counters.researchable_asked = (state.counters.researchable_asked || 0) + researchDetail.researchable_asked;
  job.save(root, state);
  if (crit) {
    writeJson(path.join(jp.critiquesDir, 'intent.json'), seal({ hash: b.contract, verdict: crit.verdict, intent_confirmed: crit.intent_confirmed !== false, restatement: crit.restatement || null, items: crit.items, researchable_questions: researchableQs, ungrounded_claims: crit.ungrounded_claims || [], at: nowIso() }));
  }
  const intentConfirmed = Boolean(crit && crit.intent_confirmed !== false); // older critiques carry no flag
  const ok = Boolean(crit && crit.verdict === 'approve' && intentConfirmed && !researchableQs.length && !probs.length && !n.questions.length);
  ledger.append(root, state.id, { kind: 'step', step: 'clarify', ok, bound: { contract: b.contract }, detail: { round, questions: n.questions.length, question_ids: n.questions.map((q) => q.id), categories: n.questions.map((q) => q.category), intent_open: n.intent_open, held: n.held.length, dropped: n.dropped.length, degraded: d.degraded || [], contract_problems: probs, ...(researchDetail ? { research: researchDetail } : {}) } });
  const extra = { ...grounding, ...(warnings.length ? { warnings } : {}) };
  if (ok) return { status: 'ok', next_gate: state.epic ? 'EH1' : 'H1', restatement: crit.restatement || null, ...extra, message: `God Eye approved the contract and confirmed the intent.${idata && intentMod.liveAssumptions(idata).length ? ' The evidence-backed assumptions are in the contract; the user can override one with "change A-n <value>" or "drop A-n".' : ''} Next: present it for your approval.` };
  if (n.questions.length) {
    return {
      status: 'needs_user',
      questions: n.questions,
      intent_first: n.intent_open,
      held: n.held.length,
      ...extra,
      message: `Show what research found (findings) and what the factory assumes (assumptions: the user may reply "change A-n <value>" or "drop A-n"), then ask these ${n.questions.length} question(s) as one numbered list (id, question, options, default, and whether the default rests on evidence or is the user's call).${n.intent_open ? ` Intent comes first: ${n.held.length} other question(s) wait until it is settled.` : ''} Record each answer with factory answer --id <Q-n> --answer "...", and an unanswered one takes its default (write it under Assumptions). Update the contract, then run factory next.`,
    };
  }
  if (d.degraded && d.degraded.length) return { status: 'degraded', missing: d.degraded, ...extra, message: `${d.degraded.includes('intent-mapper') ? 'The intent mapper failed twice, so nothing was researched. ' : ''}Analyst(s) failed twice: ${d.degraded.join(', ')}. Ask the user: re-run, or go on without that angle (write it under Assumptions).` };
  if (probs.length) return { status: 'needs_user', problems: probs, ...extra, message: 'Fix these contract problems, then run clarify again.' };
  if (crit && researchableQs.length) return { status: 'needs_user', critique: crit, ...extra, message: `God Eye found ${researchableQs.length} question(s) research can answer: they go back to the scouts. Run factory next: clarify runs again and researches them first (don't ask the user).` };
  if (crit && crit.verdict === 'approve' && !intentConfirmed) return { status: 'needs_user', critique: crit, ...extra, message: 'God Eye could not confirm the intent from the contract: compare its restatement with the Intent section, fix the contract (ask the user one intent question if needed) and run clarify again.' };
  return { status: 'needs_user', critique: crit, ...extra, message: 'God Eye asked for revisions: revise the contract (ask the user where needed) and run clarify again.' };
}

function recGround(root, state, env) {
  const topics = (env.data && env.data.topics) || [];
  const jp = jobPaths(root, state.id);
  const answers = readJson(jp.answers, []);
  const idata = intentMod.load(root, state.id);
  const intentRef = idata && !idata.tampered && fs.existsSync(intentMod.files(root, state.id).md) ? { evidence: idata.evidence.length, assumptions: intentMod.liveAssumptions(idata).length } : null;
  writeText(jp.findings, findingsMarkdown(state, topics, answers, intentRef));
  const answered = new Set(answers.map((a) => a.question));
  const blocking = topics.flatMap((t) => t.unknowns.filter((u) => u.blocking && !answered.has(u.question)).map((u) => u.question));
  const b = invalidation.current(root, state);
  const ok = blocking.length === 0 && topics.length > 0;
  ledger.append(root, state.id, { kind: 'step', step: 'ground', ok, bound: { contract: b.contract }, detail: { topics: topics.length, claims: topics.reduce((n, t) => n + t.claims.length, 0), unverified: topics.reduce((n, t) => n + t.claims.filter((c) => c.source === 'UNVERIFIED').length, 0), blocking, degraded: (env.data && env.data.degraded) || [] } });
  if (blocking.length) return { status: 'needs_user', questions: blocking.map((q) => ({ question: q, why: 'Blocks the design' })), message: `Ask the user, then record each answer with factory answer --job ${state.id} --question "…" --answer "…", and run ground again.` };
  return { status: 'ok', message: `Findings written to ${jp.findings}.` };
}

function recDecide(root, state, env) {
  const d = env.data || {};
  const a = d.judge || {};
  const jp = jobPaths(root, state.id);
  const paths = (a.paths || []).map((p) => insideJobDir(root, state, p)).filter(Boolean);
  if (!paths.length) fail(`The architect's design record was not found inside ${jp.dir}.`, 'missing_artifact');
  const ctx = steps.context(root, state, job.load);
  const recipeStep = ctx.recipe.steps.find((s) => s.step === 'decide') || {};
  const needThreat = env.threat_model === true || recipeStep.threat_model === true || (recipeStep.threat_model === 'policy' && state.risk === 'high');
  if (needThreat && !exists(jp.threatModel)) fail(`A threat model is required but ${jp.threatModel} does not exist.`, 'missing_artifact');
  const b = invalidation.current(root, state);
  const critiques = d.critiques || [];
  const last = critiques[critiques.length - 1] || null;
  state.counters.decide_rounds += 1;
  job.save(root, state);
  const max = state.policy.limits.max_design_critique_rounds;
  writeJson(path.join(jp.critiquesDir, 'design.json'), seal({ hash: b.design, verdict: last ? last.verdict : 'none', items: last ? last.items : [], rounds: critiques.length, at: nowIso() }));
  // The design record must follow templates/docs (front matter, sections in order, an AC
  // table, a Mermaid architecture diagram in an ADR, a data-flow diagram in a threat model).
  const docProblems = docMod.designProblems(root, state);
  if (docProblems.length) {
    const prior = ledger.steps(root, state.id, 'decide');
    const since = (state.resumed && state.resumed.at) || '';
    let streak = 1;
    for (let i = prior.length - 1; i >= 0 && !prior[i].ok && (prior[i].detail.doc_problems || []).length && prior[i].at > since; i--) streak += 1;
    ledger.append(root, state.id, { kind: 'step', step: 'decide', ok: false, bound: { contract: b.contract, design: b.design }, detail: { kind: a.kind, paths, critique: last ? last.verdict : null, rounds: critiques.length, threat_model: needThreat, doc_problems: docProblems.slice(0, 40) } });
    const list = docProblems.slice(0, 12).map((p) => `- ${p}`).join('\n');
    if (streak >= DOC_RETRY_CAP) return { status: 'park', park_reason: `The design record still breaks the doc templates after ${streak} decide runs:\n${list}`, doc_problems: docProblems, message: 'Parked.' };
    return { status: 'retry', doc_problems: docProblems, message: `The design record does not follow the doc templates (${docProblems.length} problem(s)):\n${list}\nfactory next runs decide again; the architect gets these problems. Check a file with: factory doc check <file>` };
  }
  const h2Step = ctx.recipe.steps.find((s) => ['H2', 'EH2', 'HF'].includes(s.step));
  const humanWillSee = Boolean(h2Step && !(h2Step.when === 'adr' && !invalidation.hasAdr(root, state.id)));
  const approved = last && last.verdict === 'approve';
  const ok = Boolean(approved || (critiques.length >= max && humanWillSee));
  ledger.append(root, state.id, { kind: 'step', step: 'decide', ok, bound: { contract: b.contract, design: b.design }, detail: { kind: a.kind, paths, critique: last ? last.verdict : null, rounds: critiques.length, threat_model: needThreat } });
  if (ok) return { status: 'ok', message: approved ? 'Design critique approved.' : `Design critique still says revise after ${critiques.length} rounds; you will see it at ${h2Step.step}.` };
  return { status: 'park', park_reason: `Design critique did not approve after ${critiques.length} round(s) and no human gate will review it.`, message: 'Parked.' };
}

function recDecompose(root, state, env) {
  const d = env.data || {};
  const v = planMod.validate(root, state);
  const b = invalidation.current(root, state);
  if (!v.valid) {
    state.counters.decompose_rounds += 1;
    job.save(root, state);
    ledger.append(root, state.id, { kind: 'step', step: 'decompose', ok: false, bound: { plan: b.plan, contract: b.contract }, detail: { errors: v.errors } });
    return { status: 'retry', errors: v.errors, message: 'The plan is still invalid; factory next runs decompose again (the planner gets the errors).' };
  }
  ledger.append(root, state.id, { kind: 'step', step: 'decompose', ok: true, bound: { plan: b.plan, contract: b.contract }, detail: { tasks: v.tasks || v.slices, waves: v.waves || v.layers } });
  if (d.critique) {
    const c = d.critique;
    writeJson(path.join(jobPaths(root, state.id).critiquesDir, 'plan.json'), seal({ hash: b.plan, verdict: c.verdict, items: c.items, at: nowIso() }));
    if (c.verdict === 'approve') ledger.append(root, state.id, { kind: 'step', step: 'plan_critique', ok: true, bound: { plan: b.plan }, detail: {} });
  }
  return { status: 'ok', message: `Plan valid: ${v.tasks || v.slices} ${state.epic ? 'slices' : 'tasks'}.` };
}

function recRealize(root, state, env) {
  const reported = (env.data && env.data.tasks) || [];
  const ctx = steps.context(root, state, job.load);
  const table = [];
  for (const r of reported) {
    const done = steps.taskDone(ctx, r.id);
    const outcome = done ? 'done' : r.outcome === 'done' ? 'not_verified' : r.outcome;
    state.tasks[r.id] = { ...(state.tasks[r.id] || {}), outcome, outcome_reason: r.summary || '', outcome_at: nowIso() };
    table.push({ id: r.id, outcome, attempts: r.attempts, summary: r.summary });
  }
  job.save(root, state);
  const bad = table.filter((t) => t.outcome !== 'done');
  if (bad.length) {
    return { status: 'park', park_reason: `Tasks not done: ${bad.map((t) => `${t.id} (${t.outcome})`).join(', ')}. Nothing partial ships.`, tasks: table, message: 'Parked with a per-task table.' };
  }
  return { status: 'ok', tasks: table, message: 'Every task in scope is built and verified.' };
}

function recReconcile(root, state, env) {
  const d = env.data || {};
  const ctx = steps.context(root, state, job.load);
  if (d.integrator && d.integrator.status === 'behavioural_conflict') {
    return { status: 'park', park_reason: `Behavioural conflict while integrating: ${d.integrator.summary}`, message: 'Parked.' };
  }
  if (!steps.isDone(ctx, { step: 'reconcile' })) {
    return { status: 'park', park_reason: `Integration did not complete: ${(d.integrator && d.integrator.summary) || 'no result'}`, message: 'Parked.' };
  }
  return { status: 'ok', message: `Integrated at fingerprint ${ctx.b.fingerprint.slice(0, 12)}.` };
}

function recChallenge(root, state, env) {
  const d = env.data || {};
  const lanes = (d.lanes || []).map((l) => ({ lane: l.lane, findings: l.findings || [] }));
  const missingLanes = (d.degraded || []).filter(Boolean);
  const step = env.mode === 'post_merge' ? 'post_merge_challenge' : 'challenge';
  const res = review.record(root, { jobId: state.id, step, payload: { fingerprint: env.fingerprint, lanes, verifications: d.verifications || [], lanes_requested: env.lanes_requested } });
  if (step === 'post_merge_challenge') {
    if (res.confirmed.length) {
      const fresh = job.load(root, state.id);
      const ch = ledger.lastStep(root, state.id, step);
      const serious = ch.detail.findings.filter((f) => f.status === 'confirmed' && ['blocker', 'major'].includes(f.severity));
      const fu = lifecycle.followup(root, { jobId: fresh.id, findings: serious });
      // Post-merge review is recorded as done either way; the follow-up job carries the fix.
      ledger.append(root, state.id, { kind: 'step', step, ok: true, bound: {}, detail: { followup: fu.followup } });
      return { status: 'ok', followup: fu.followup, message: `Confirmed problems after merge: opened follow-up ${fu.followup}. ${state.id} will close; the merged job is never reopened.` };
    }
    if (!res.ok) return { status: 'retry', ...res, message: 'Post-merge review incomplete (lanes missing or findings unverified); factory next runs it again.' };
    return { status: 'ok', ...res, message: 'Post-merge review passed.' };
  }
  return { status: res.ok ? 'ok' : res.confirmed.length ? 'fix' : 'retry', degraded: missingLanes, ...res, message: res.ok ? 'All required lanes pass.' : res.confirmed.length ? 'Confirmed serious findings: factory next schedules a fix round.' : `Lanes missing or findings unverified (${[...res.missing, ...res.unverified].join(', ')}); factory next runs the review again.` };
}

// Which agents ran, as the workflow saw them: sealed, so the console and the inspector
// can show the crew per step without trusting a file an agent could edit. Written for
// results that count (and for errors), never for a stale envelope that was thrown away.
function recordRoster(root, state, env) {
  ledger.append(root, state.id, {
    kind: 'agents', workflow: env.workflow, config: env.config || null, mode: env.mode || null,
    decision_id: state.last_decision_id || null, status: env.status,
    agent_runs: (env.budgets && env.budgets.used && env.budgets.used.agent_runs) || 0,
    agents: (env.agents || []).slice(0, 200).map((a) => ({ label: String(a.label).slice(0, 120), agent_type: String(a.agent_type).slice(0, 60), model: a.model ? String(a.model).slice(0, 60) : null, retry: Boolean(a.retry), outcome: a.outcome ? String(a.outcome).slice(0, 40) : null })),
  });
}

function apply(root, { jobId, file, envelope }) {
  const env = envelope || readJson(file, null);
  if (!env) fail(`No envelope found${file ? ` in ${file}` : ''}`, 'bad_input');
  const errs = validate(readJson(pluginPath('schemas', 'envelope.json')), env);
  if (errs.length) fail(`Envelope invalid:\n- ${errs.join('\n- ')}`, 'bad_envelope', errs);
  const state = job.resolve(root, jobId || env.job);
  if (state.id !== env.job) fail(`Envelope is for ${env.job}, not ${state.id}`, 'bad_input');
  if (state.status !== 'active') fail(`${state.id} is ${state.status}; nothing recorded.`, 'not_active');

  budgets.addAgentRuns(state, env.budgets && env.budgets.used && env.budgets.used.agent_runs);
  job.save(root, state);
  if (env.status === 'error') {
    recordRoster(root, state, env);
    ledger.append(root, state.id, { kind: 'error', workflow: env.workflow, config: env.config || null, summary: env.summary });
    return { job: state.id, status: 'error', message: `Workflow reported an error: ${env.summary}. factory next will retry once, then park.` };
  }
  const expected = wfargs.currentInputHash(root, state, env);
  if (expected && expected !== env.input_hash) {
    return { job: state.id, status: 'stale', message: 'The inputs changed while the workflow ran (contract, findings, design or build). Nothing recorded; run factory next.' };
  }
  recordRoster(root, state, env);

  let res;
  const fresh = job.load(root, state.id);
  switch (env.workflow) {
    case 'fanout-judge':
      if (env.config === 'clarify') res = recClarify(root, fresh, env);
      else if (env.config === 'decide') res = recDecide(root, fresh, env);
      else if (env.config === 'challenge') res = recChallenge(root, fresh, env);
      else fail(`Unknown config ${env.config}`, 'bad_envelope');
      break;
    case 'ground':
      res = recGround(root, fresh, env);
      break;
    case 'decompose':
      res = recDecompose(root, fresh, env);
      break;
    case 'realize':
      res = recRealize(root, fresh, env);
      break;
    case 'reconcile':
      res = recReconcile(root, fresh, env);
      break;
    default:
      fail(`Unknown workflow ${env.workflow}`, 'bad_envelope');
  }
  if (res.status === 'park') decisionTable.park(root, job.load(root, state.id), res.park_reason, res.park_from || env.workflow);
  return { job: state.id, workflow: env.workflow, config: env.config || null, ...res };
}

function answer(root, { jobId, id, question, answer: a }) {
  const state = job.resolve(root, jobId);
  const logged = id ? (state.question_log || []).find((q) => q.id === String(id).toUpperCase()) : null;
  if (id && !logged) fail(`No question ${id} was asked in ${state.id}.`, 'bad_input');
  const q = logged ? logged.question : question;
  if (!q || !a) fail('Need --answer and either --id Q-n or --question "...".', 'bad_input');
  const f = jobPaths(root, state.id).answers;
  const list = readJson(f, []);
  list.push({ ...(logged ? { id: logged.id, category: logged.category } : {}), question: q, answer: a, at: nowIso() });
  writeJson(f, list);
  return { job: state.id, ...(logged ? { id: logged.id } : {}), answers: list.length };
}

module.exports = { apply, answer, findingsMarkdown };
