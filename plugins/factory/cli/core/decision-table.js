'use strict';
// `factory next`: the deterministic router. Reads state, evaluates the alignment
// vector, applies the decision table, and falls back to recipe order. It writes one
// decision record per routing decision. No LLM decides the next step.

const { sha256, stableStringify, nowIso } = require('../lib/util');
const job = require('./job');
const steps = require('./steps');
const alignment = require('./alignment');
const budgets = require('./budgets');
const decisions = require('./decisions');
const ledger = require('./ledger');
const { matchesAny } = require('../lib/glob');

function park(root, state, reason, from) {
  state.status = 'parked';
  state.park = { reason, at: nowIso(), from: from || null };
  state.pending_gate = { id: 'P', hash: null, docs: [], at: nowIso() };
  job.save(root, state);
}

function ownersOfFindings(ctx, findings) {
  const tasks = steps.planTasks(ctx);
  const owners = new Set();
  for (const f of findings) {
    const hit = tasks.filter((t) => f.file && matchesAny(f.file, t.allowed_paths || []));
    (hit.length ? hit : tasks).forEach((t) => owners.add(t.id));
  }
  return [...owners];
}

function ownersOfFailures(ctx, failures) {
  const tasks = steps.planTasks(ctx);
  const owners = new Set();
  const failedCmds = (failures.commands || []).filter((c) => !c.pass).map((c) => c.cmd);
  const failedAcs = Object.entries(failures.acs || {})
    .filter(([, s]) => s !== 'proven')
    .map(([k]) => k);
  for (const t of tasks) {
    const cmds = (t.verify_commands || []).map((c) => (typeof c === 'string' ? c : c.cmd));
    if (cmds.some((c) => failedCmds.includes(c))) owners.add(t.id);
    if ((t.criteria_ids || []).some((a) => failedAcs.includes(a))) owners.add(t.id);
  }
  if (!owners.size) tasks.forEach((t) => owners.add(t.id));
  return [...owners];
}

function reopenTasks(state, ids, why) {
  state.tasks = state.tasks || {};
  for (const id of ids) {
    state.tasks[id] = { ...(state.tasks[id] || {}), needs_work: why };
  }
}

function stepAction(ctx, s) {
  const { state } = ctx;
  const base = { step: s.step, run: s.run };
  if (s.run.startsWith('skill:')) return { ...base, action: 'skill', skill: s.run.slice(6), mode: s.mode || null };
  if (s.run.startsWith('workflow:')) {
    const a = { ...base, action: 'workflow', workflow: s.run.slice(9), config: s.config || null, mode: s.mode || null, lanes: s.lanes || null };
    if (a.workflow === 'realize') {
      const amendPending = Object.values(state.tasks || {}).some((t) => t.needs_work === 'amendment');
      a.scope = state.fix ? state.fix.kind : amendPending ? 'amendment' : state.resumed ? 'resume' : 'all';
    }
    if (s.step === 'decide') a.threat_model = s.threat_model === 'policy' ? state.risk === 'high' : Boolean(s.threat_model);
    if (s.step === 'decompose' && s.plan_critique) a.plan_critique = true;
    return a;
  }
  if (s.run.startsWith('cli:')) return { ...base, action: 'cli', command: `factory ${s.run.slice(4)} --job ${state.id}` };
  return { ...base, action: s.run };
}

function repeatKey(ctx, action) {
  const { state, b } = ctx;
  const ledgerLen = ledger.all(ctx.root, state.id).filter((e) => e.kind !== 'error' && e.kind !== 'agents').length;
  return sha256(
    stableStringify({
      step: action.step,
      scope: action.scope || null,
      b,
      counters: { ...state.counters, agent_runs: 0, decisions: 0 },
      tasks: state.tasks,
      approvals: state.approvals,
      ledgerLen,
    }),
  );
}

// The key a routing decision is remembered by (state.last_decision).
function decisionKey(result) {
  return `${result.action}:${result.step || ''}:${result.scope || ''}:${(result.gate && result.gate.hash) || ''}`;
}

// Commands that only look: running them is not an attempt at the step factory next chose.
const LOOKS = new Set(['next', 'why', 'help', 'doctor', 'console', 'job', 'contract', 'doc', 'report', 'recipe', 'telemetry', 'finalize', 'use', 'shim', 'task:show', 'lessons:list', 'distill:context']);
const REFUSED_RUN = new Set(['not_waiting_for_workflow', 'run_in_progress', 'copilot_unavailable', 'bad_input']); // nothing was tried

// Was anything tried under the decision in force (a workflow ran, a record or step command
// ran, an agent ran)? A `factory next` with nothing tried since is a re-query, not a repeat.
function attemptedSince(root, state) {
  const id = state.last_decision_id;
  if (!id) return true;
  let lines;
  try {
    lines = require('fs').readFileSync(require('path').join(root, '.factory', 'log', 'events.jsonl'), 'utf8').split('\n');
  } catch {
    return true; // no log: be conservative and count it
  }
  for (const l of lines) {
    if (!l || !l.includes(id)) continue;
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.decision_id !== id) continue;
    if (e.event === 'agent_run') return true;
    if (e.event !== 'cli') continue;
    if (LOOKS.has(e.cmd) || LOOKS.has(`${e.cmd}:${e.sub}`)) continue;
    if (e.cmd === 'run' && REFUSED_RUN.has(e.code)) continue;
    if (e.cmd === 'wfargs' && e.via === 'run') continue; // a run that started counts by its agents and its record
    return true;
  }
  return false;
}

// After "deny" at a gate, the step that produced the document runs again (with the reason
// in its brief) instead of the unchanged document being presented again. Once that step
// has run since the denial, the gate is shown even if the document came out the same.
const PRODUCER = { H1: 'clarify', EH1: 'clarify', H2: 'decide', EH2: 'decide', HF: 'decide', H3: 'decompose', EH3: 'decompose' };

function deniedReroute(ctx, gate) {
  const { root, state } = ctx;
  const from = PRODUCER[gate];
  const producer = from && ctx.recipe.steps.find((s) => s.step === from);
  if (!producer || producer.run.startsWith('cli:')) return null;
  const hash = steps.gateHash(ctx, gate);
  if (!hash) return null;
  const denied = (state.denials || []).filter((d) => d.gate === gate && d.hash === hash).pop();
  if (!denied) return null;
  if (ledger.steps(root, state.id, from).some((e) => e.at > denied.at)) return null;
  const why = denied.reason ? `: "${denied.reason}"` : '';
  const how = producer.run.startsWith('skill:')
    ? `Revise the ${from === 'clarify' ? 'contract' : 'document'} to address it, then run the ${from} step again.`
    : `factory run ${producer.run.slice(9)}${producer.config ? ` --config ${producer.config}` : ''} redoes it; the reason is in its brief.`;
  return { ...stepAction(ctx, producer), denied: { gate, reason: denied.reason || '', at: denied.at }, reason: `You denied ${gate}${why}. ${how}` };
}

// After a local merge the CI re-verify floor is still owed: route `factory ci verify`
// before distill/close instead of letting close fail on it.
function localReverify(ctx, s) {
  const { state, recipe } = ctx;
  const iH4 = recipe.steps.findIndex((x) => x.step === 'H4');
  if (iH4 < 0 || recipe.steps.indexOf(s) <= iH4) return null;
  if (!state.pr || !state.pr.merged || state.pr.mode === 'github') return null;
  const fl = require('./floors').evaluate(ctx, 'full');
  if (!fl.results.some((r) => r.floor === 'ci_reverify' && !r.ok)) return null;
  // Part of finishing the merge step (H4); unlike a PR sync it counts toward the repeat guard.
  return { step: 'H4', run: 'cli:ci verify', action: 'cli', command: `factory ci verify --job ${state.id}`, reason: 'Local merge recorded: re-verify the merge result (the CI re-verify floor).' };
}

// The chat reply the prompt hook last applied or refused (.factory/last-reply.json), shown
// in `factory next` while no routing decision has been made since: Copilot may drop the
// hook's own message (docs/research/hooks.md §5.3).
function lastReply(root, jobId, decisionBefore) {
  try {
    const r = JSON.parse(require('fs').readFileSync(require('path').join(root, '.factory', 'last-reply.json'), 'utf8'));
    if (r.job && r.job !== jobId) return null;
    if ((r.decision_id || null) !== (decisionBefore || null)) return null;
    return { at: r.at, text: r.text, status: r.status, reply: r.reply || null, message: r.message };
  } catch {
    return null;
  }
}

function decide(root, jobId) {
  const before = job.resolve(root, jobId);
  const r = route(root, jobId);
  const reply = lastReply(root, before.id, before.last_decision_id);
  if (reply) r.last_reply = reply;
  return r;
}

function route(root, jobId) {
  let state = job.resolve(root, jobId);
  const out = (o) => ({ job: state.id, title: state.title, status: state.status, recipe: `${state.recipe.id}@v${state.recipe.version}`, risk: state.risk, ...o });

  if (state.status === 'closed') return out({ action: 'done', reason: 'Job is closed.' });
  if (state.status === 'cancelled' || state.status === 'abandoned') return out({ action: 'done', reason: `Job was ${state.status}.` });
  if (state.status === 'parked') {
    return out({ action: 'parked', reason: state.park.reason, instructions: 'Wait for the human: resume <step> · cancel job · abandon job.' });
  }
  if (state.amendment && state.amendment.status === 'open') {
    return out({ action: 'skill', skill: 'amend', step: 'amend', reason: 'An amendment is open: finish editing, then `factory amend submit`.' });
  }
  if (state.amendment && state.amendment.status === 'submitted') {
    state.pending_gate = { id: 'A', hash: state.amendment.hash, docs: [state.amendment.file], at: nowIso() };
    job.save(root, state);
    return out({ action: 'gate', gate: state.pending_gate, step: 'A', reason: 'Amendment waits for your approval.' });
  }

  if (state.needs_replan && !(state.amendment && ['open', 'submitted'].includes(state.amendment.status))) {
    return record(root, state, null, out({ action: 'skill', skill: 'amend', step: 'amend', rule: 'row2.epic_replan', reason: `The epic's amendment ${state.needs_replan} affects this slice: amend its contract and plan to match.` }));
  }

  const over = budgets.exceeded(root, state);
  if (over) {
    park(root, state, over, 'budget');
    return record(root, state, null, out({ action: 'parked', reason: over, rule: 'cap.budget' }));
  }

  const ctx = steps.context(root, state, job.load);

  // A completed fix round clears itself once every reopened task is rebuilt.
  if (state.fix && ctx.b.fingerprint !== state.fix.fingerprint && steps.allTasksDone(ctx)) {
    state.fix = null;
    job.save(root, state);
  }

  const al = alignment.evaluate(ctx);
  const L = state.policy.limits;
  let action = null;
  let rule = null;

  switch (al.first_failing) {
    case 'contract_approved': {
      const clarify = ctx.recipe.steps.find((s) => s.step === 'clarify');
      const gateStep = ctx.recipe.steps.find((s) => s.step === (state.epic ? 'EH1' : 'H1'));
      action = clarify && !steps.isDone(ctx, clarify) ? stepAction(ctx, clarify) : stepAction(ctx, gateStep);
      rule = 'row1.contract_not_approved';
      break;
    }
    case 'no_drift':
      if (al.detail.drift === 'scope') {
        park(root, state, `Files outside the allowed or into protected paths: ${(al.detail.outside || []).join(', ')}`, 'drift');
        return record(root, state, al, out({ action: 'parked', reason: state.park.reason, rule: 'row2.drift_scope' }));
      }
      action = { action: 'skill', skill: 'amend', step: 'amend', reason: `The approved ${al.detail.drift} changed; it needs an amendment and your approval.` };
      rule = `row2.drift_${al.detail.drift}`;
      break;
    case 'floors_satisfied_so_far': {
      const s = ctx.recipe.steps.find((x) => x.step === al.detail.missing_step);
      action = stepAction(ctx, s);
      rule = 'row3.floor_missing';
      break;
    }
    case 'no_confirmed_serious': {
      state.counters.review_rounds += 1;
      if (state.counters.review_rounds > L.max_review_rounds) {
        park(root, state, `Review rounds used up (${L.max_review_rounds}) with confirmed serious findings still open.`, 'review');
        return record(root, state, al, out({ action: 'parked', reason: state.park.reason, rule: 'cap.review_rounds' }));
      }
      const owners = ownersOfFindings(ctx, al.detail.serious);
      reopenTasks(state, owners, 'review');
      state.fix = { kind: 'fix', source: al.detail.challenge_record, fingerprint: ctx.b.fingerprint, tasks: owners, findings: al.detail.serious.map((f) => f.id) };
      job.save(root, state);
      action = stepAction(ctx, ctx.recipe.steps.find((s) => s.step === 'realize'));
      action.scope = 'fix';
      rule = 'row4.confirmed_serious';
      break;
    }
    case 'acs_proven': {
      state.counters.verify_fix_rounds += 1;
      if (state.counters.verify_fix_rounds > L.max_verify_fix_rounds) {
        park(root, state, `Verify-fix rounds used up (${L.max_verify_fix_rounds}); criteria still unproven.`, 'verify');
        return record(root, state, al, out({ action: 'parked', reason: state.park.reason, rule: 'cap.verify_fix_rounds' }));
      }
      const owners = ownersOfFailures(ctx, al.detail.prove_failures);
      reopenTasks(state, owners, 'verify');
      state.fix = { kind: 'verifyFix', source: al.detail.prove_record, fingerprint: ctx.b.fingerprint, tasks: owners };
      job.save(root, state);
      action = stepAction(ctx, ctx.recipe.steps.find((s) => s.step === 'realize'));
      action.scope = 'verifyFix';
      rule = 'row5.acs_unproven';
      break;
    }
    case 'no_stale_evidence':
      action = stepAction(ctx, ctx.recipe.steps.find((s) => s.step === 'prove'));
      rule = 'row6.stale_evidence';
      break;
    default: {
      const s = ctx.recipe.steps.find((x) => !steps.isDone(ctx, x));
      if (!s) return record(root, state, al, out({ action: 'done', reason: 'Every step is done.', rule: 'order.complete' }));
      const ci = localReverify(ctx, s);
      action = ci || stepAction(ctx, s);
      rule = ci ? 'order.ci_reverify' : 'order.next_step';
    }
  }

  if (action.action === 'gate') {
    const re = deniedReroute(ctx, action.step);
    if (re) {
      action = re;
      rule = 'gate.denied_revise';
    }
  }

  // Caps on loops that live inside a step.
  if (action.step === 'clarify' && state.counters.clarify_rounds >= L.max_intent_rounds + 2) {
    park(root, state, `Clarify is not converging (${state.counters.clarify_rounds} rounds).`, 'clarify');
    return record(root, state, al, out({ action: 'parked', reason: state.park.reason, rule: 'cap.clarify_rounds' }));
  }
  if (action.step === 'decompose' && state.counters.decompose_rounds >= L.max_plan_validate_rounds) {
    park(root, state, `The plan still fails validation after ${state.counters.decompose_rounds} rounds.`, 'decompose');
    return record(root, state, al, out({ action: 'parked', reason: state.park.reason, rule: 'cap.decompose_rounds' }));
  }

  // Gates and merge waits.
  if (action.action === 'gate') {
    const hash = steps.gateHash(ctx, action.step);
    const docs = steps.gateDocs(ctx, action.step);
    if (!state.pending_gate || state.pending_gate.id !== action.step || state.pending_gate.hash !== hash) {
      state.pending_gate = { id: action.step, hash, docs, at: nowIso() };
      job.save(root, state);
    }
    action.gate = state.pending_gate;
  } else if (action.action === 'merge') {
    if (state.pr && state.pr.mode === 'github') {
      const justSynced = String(state.last_decision || '').startsWith('cli:H4:');
      action = justSynced
        ? { ...action, action: 'wait', reason: `PR still open (${state.pr.url || 'see GitHub'}). Merge it on GitHub, then say "continue".` }
        : { ...action, action: 'cli', command: `factory pr sync --job ${state.id}`, reason: 'PR is open: sync its checks and merge status.' };
    } else {
      action = { ...action, action: 'wait', reason: 'Merge the job branch yourself, then reply "merged <commit>".' };
    }
  } else if (action.step === 'children' && (state.children || []).length) {
    const kids = state.children.map((c) => {
      const k = job.load(root, c);
      return { id: c, slice: k.slice_id, status: k.status, depends_on: k.depends_on || [] };
    });
    const closed = new Set(kids.filter((k) => k.status === 'closed').map((k) => k.id));
    const ready = kids.filter((k) => k.status === 'active' && k.depends_on.every((d) => closed.has(d)));
    action = { ...action, action: 'wait', children: kids, ready: ready.map((k) => k.id), reason: ready.length ? `Run slice job ${ready[0].id} next (factory use ${ready[0].id}).` : 'Waiting for slice jobs to finish.' };
  } else if (state.pending_gate && state.pending_gate.id !== 'P') {
    state.pending_gate = null;
    job.save(root, state);
  }

  // Repeat guard: the same step from the same state twice in a row means no progress.
  if (!['gate', 'wait'].includes(action.action) && (action.step !== 'H4' || action.run === 'cli:ci verify')) {
    const key = repeatKey(ctx, action);
    state = job.load(root, state.id);
    if (state.repeat && state.repeat.key === key && state.last_decision === decisionKey(action) && state.last_decision_id && !attemptedSince(root, state)) {
      // Asked again with nothing tried and nothing changed: the same decision, not a new one.
      return out({ ...action, rule, alignment: al.vector, first_failing: al.first_failing, decision_id: state.last_decision_id, requery: true });
    }
    if (state.repeat && state.repeat.key === key) state.repeat.count += 1;
    else state.repeat = { key, count: 1 };
    if (state.repeat.count > L.repeat_guard) {
      park(root, state, `No progress: "${action.step}" chosen ${state.repeat.count} times from the same state.`, 'repeat');
      return record(root, state, al, out({ action: 'parked', reason: state.park.reason, rule: 'cap.repeat_guard' }));
    }
    job.save(root, state);
  }

  return record(root, state, al, out({ ...action, rule, alignment: al.vector, first_failing: al.first_failing }));
}

function record(root, state, al, result) {
  const key = decisionKey(result);
  const fresh = job.load(root, state.id);
  const isRepeatWait = ['gate', 'wait', 'parked'].includes(result.action) && fresh.last_decision === key;
  if (!isRepeatWait) {
    let b = null;
    try {
      b = steps.context(root, fresh, job.load).b;
    } catch {
      b = null;
    }
    const id = `${state.id}-D${String((fresh.counters.decisions || 0) + 1).padStart(4, '0')}`;
    decisions.write(root, {
      id,
      job: state.id,
      gate_hash: (result.gate && result.gate.hash) || null,
      step: result.step || null,
      workflow: result.workflow || null,
      config: result.config || null,
      command: result.command || null,
      skill: result.skill || null,
      mode: result.mode || null,
      scope: result.scope || null,
      node: state.parent ? `${state.parent}/${state.id}` : state.id,
      recipe: state.recipe.id,
      recipe_version: state.recipe.version,
      state_hash: b ? sha256(stableStringify(b)) : null,
      fingerprint: b ? b.fingerprint : null,
      alignment: al ? al.vector : null,
      first_failing: al ? al.first_failing : null,
      chosen: result.step ? `${result.step}${result.scope && result.scope !== 'all' ? `:${result.scope}` : ''}` : result.action,
      action: result.action,
      rule: result.rule || null,
      budget: { agent_runs: fresh.counters.agent_runs, review_rounds: fresh.counters.review_rounds, verify_fix_rounds: fresh.counters.verify_fix_rounds },
      reason: result.reason || null,
    });
    fresh.last_decision = key;
    fresh.last_decision_id = id;
    fresh.counters.decisions = (fresh.counters.decisions || 0) + 1;
    job.save(root, fresh);
    result.decision_id = id;
  }
  if (!result.decision_id) result.decision_id = fresh.last_decision_id || null;
  return result;
}

module.exports = { decide, park, ownersOfFindings, ownersOfFailures };
