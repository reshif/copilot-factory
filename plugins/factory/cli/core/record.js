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
  ledger.append(root, state.id, { kind: 'step', step: 'ground', ok, bound: { contract: b.contract }, detail: { ...(blocking.length ? { outcome: 'needs_user' } : {}), topics: topics.length, claims: topics.reduce((n, t) => n + t.claims.length, 0), unverified: topics.reduce((n, t) => n + t.claims.filter((c) => c.source === 'UNVERIFIED').length, 0), blocking, degraded: (env.data && env.data.degraded) || [] } });
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
  // A broken build environment parks the job once with its reason; tasks it stopped keep
  // their state (no attempt was spent on it).
  const eb = env.data && env.data.environment_broken;
  if (eb) {
    for (const r of reported.filter((x) => x.outcome !== 'pending')) {
      const done = steps.taskDone(ctx, r.id);
      state.tasks[r.id] = { ...(state.tasks[r.id] || {}), outcome: done ? 'done' : r.outcome, outcome_reason: r.summary || '', outcome_at: nowIso() };
    }
    job.save(root, state);
    const reason = String(eb.reason || 'environment broken').slice(0, 1500);
    require('./events').append(root, { event: 'environment_broken', job: state.id, task: eb.task || null, cmd: eb.cmd || null, code: eb.code === undefined ? null : eb.code, reason: reason.slice(0, 500) });
    return { status: 'park', park_from: 'environment', park_reason: `${reason} — no builder attempt was spent. Fix the environment (factory env check shows it; factory env set changes it), then reply "resume".`, tasks: reported.map((r) => ({ id: r.id, outcome: r.outcome, attempts: r.attempts, summary: r.summary })), environment_broken: eb, message: 'Parked: the build environment is broken.' };
  }
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
    const last = ledger.lastStep(root, state.id, 'reconcile');
    if (last && !last.ok && last.detail && last.detail.regression) {
      // P3.3: the task whose merge dropped the lines is rebuilt on the merged code, once,
      // automatically (task start brings the integrated job branch into it); only a second
      // regression on it parks.
      const dropped = last.detail.regression.dropped || [];
      const planIds = new Set(steps.planTasks(ctx).map((t) => t.id));
      const hit = [...new Set(dropped.map((d) => d.task).filter((t) => t && planIds.has(t)))];
      const fresh = job.load(root, state.id);
      const again = hit.filter((id) => (((fresh.tasks || {})[id] || {}).auto_rebuild || {}).regression);
      if (hit.length && !again.length) {
        const at = nowIso();
        for (const id of hit) {
          const lines = dropped.filter((d) => d.task === id).slice(0, 10).map((d) => ({ cmd: `merge ${id} into the job branch`, code: 1, output: `Merging ${id} would drop ${d.file}: "${String(d.line).slice(0, 160)}" (${d.by}). Rebuild on the integrated branch and keep that line (change it only if the contract asks for it).` }));
          const t = fresh.tasks[id] || {};
          fresh.tasks[id] = { ...t, needs_work: 'integration', integration_failure: { at, wave: null, failures: lines }, auto_rebuild: { ...(t.auto_rebuild || {}), regression: at } };
        }
        job.save(root, fresh);
        require('./events').append(root, { event: 'recovery', job: state.id, kind: 'regression', action: 'rebuild', tasks: hit, reason: String(last.detail.message || '').slice(0, 300) });
        return { status: 'retry', recovery: { kind: 'regression', action: 'rebuild', tasks: hit }, message: `Reconcile regression: ${hit.join(', ')} ${hit.length > 1 ? 'are' : 'is'} rebuilt on the merged code automatically (once, before parking); factory next runs realize.` };
      }
      return { status: 'park', park_kind: 'regression', park_reason: `Reconcile regression: ${last.detail.message || 'merged or fixed lines were dropped'}${again.length ? ` (${again.join(', ')} already rebuilt once on the merged code)` : ''}`, message: 'Parked: integrating would drop work already merged or fixed.' };
    }
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
  // A serious finding no verifier could settle is re-verified each round (with twice the time),
  // never dropped; after max_reverify_rounds tries the job parks for the human.
  if (!res.ok && !res.confirmed.length && (res.carried || []).length) {
    const L = state.policy.limits || {};
    const allowed = (L.max_reverify_rounds || 3) + ((state.counters || {}).reverify_bonus || 0);
    const stuck = res.carried.filter((c) => c.times > allowed);
    if (stuck.length) {
      return { status: 'park', park_from: 'reverify', degraded: missingLanes, ...res, park_reason: `Serious review finding(s) still unverified after ${allowed} re-verification round(s): ${stuck.map((c) => c.id).join(', ')}. They block ship until a verifier settles them; "resume" re-verifies once more.`, message: 'Parked: a serious finding could not be verified.' };
    }
  }
  return { status: res.ok ? 'ok' : res.confirmed.length ? 'fix' : 'retry', degraded: missingLanes, ...res, message: res.ok ? 'All required lanes pass.' : res.confirmed.length ? 'Confirmed serious findings: factory next schedules a fix round.' : `Lanes missing or findings unverified (${[...res.missing, ...res.unverified].join(', ')}); factory next runs the review again${(res.carried || []).length ? ', re-verifying the unverified ones with twice the time' : ''}.` };
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
    case 'clarify':
      res = require('./clarify').record(root, fresh, env);
      break;
    case 'fanout-judge':
      if (env.config === 'decide') res = recDecide(root, fresh, env);
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
  if (res.status === 'park') {
    const now = job.load(root, state.id);
    const lastNeeds = (id) => {
      const h = ((now.tasks || {})[id] || {}).history || [];
      const e = [...h].reverse().find((x) => (x.needs_paths || []).length);
      return e ? e.needs_paths : [];
    };
    const tasks = (res.tasks || []).map((t) => ({ id: t.id, outcome: t.outcome, summary: t.summary || '', needs_paths: lastNeeds(t.id) }));
    const p = decisionTable.park(root, now, res.park_reason, res.park_from || env.workflow, { tasks, kind: res.park_kind });
    res.park = { kind: p.kind, next: p.next };
  }
  return { job: state.id, workflow: env.workflow, config: env.config || null, ...res };
}

// `factory answer`: during clarify (until H1) the user's words go to clarify v3 as a reply
// (factory clarify reply); an id names the sheet decision ("2", "D-1.2") or the item. After H1
// (ground's blocking questions) the answer is recorded by its question text, as before.
function answer(root, { jobId, id, ref, question, answer: a, acceptDefault = false, via = 'cli' }) {
  const state = job.resolve(root, jobId);
  const clarifyMod = require('./clarify');
  const R = String(ref || id || '').trim();
  if (clarifyMod.inClarify(state)) {
    const words = acceptDefault ? 'ok' : String(a || '').trim();
    if (!words) fail('Need the answer: factory answer "<the user\'s words>" (or factory clarify reply "…").', 'bad_input');
    const m = /^(?:D-\d+\.)?(\d{1,2})$/i.exec(R);
    const text = m ? `${m[1]}: ${words}` : words;
    return clarifyMod.reply(root, { jobId: state.id, text, via });
  }
  const logged = R ? (state.question_log || []).find((q) => q.id === R.toUpperCase()) : null;
  if (R && !logged) fail(`No question ${R} was asked in ${state.id}.`, 'bad_input');
  const q = logged ? logged.question : question;
  if (!q || (!a && !acceptDefault)) fail('Need the answer: factory answer --question "..." --answer "...".', 'bad_input');
  const f = jobPaths(root, state.id).answers;
  const list = readJson(f, []);
  list.push({ ...(logged ? { id: logged.id, category: logged.category } : {}), question: q, answer: a, via, at: nowIso() });
  writeJson(f, list);
  return { job: state.id, ...(logged ? { id: logged.id } : {}), answers: list.length };
}

module.exports = { apply, answer, findingsMarkdown };
