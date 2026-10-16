'use strict';
// Amendments: change an approved contract or plan with an impact summary and your approval.
// On approval, approvals and earlier step records are re-bound to the new hashes, and only
// the affected tasks are reopened.

const path = require('path');
const fs = require('fs');
const { readJson, writeJson, readText, writeText, sha256, nowIso, fail, stableStringify, mkdirp, exists } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const job = require('./job');
const ledger = require('./ledger');
const contractMod = require('./contract');
const planMod = require('./plan');
const invalidation = require('./invalidation');

function amendDir(root, state, n) {
  return path.join(jobPaths(root, state.id).amendmentsDir, `A-${n}`);
}

function start(root, { jobId, reason, by }) {
  if (!reason) fail('Say what changed and why (--reason).', 'bad_input');
  const state = job.resolve(root, jobId);
  if (state.amendment && ['open', 'submitted'].includes(state.amendment.status)) fail(`${state.id} already has an amendment in progress.`, 'bad_input');
  const jp = jobPaths(root, state.id);
  const n = (state.amendments_count || 0) + 1;
  const dir = amendDir(root, state, n);
  mkdirp(dir);
  // "Before" is what you approved, not whatever is on disk now (it may already be edited).
  const A = state.approvals || {};
  const cGate = A.H1 || A.EH1;
  const pGate = A.H3 || A.EH3;
  writeText(path.join(dir, 'before-contract.md'), readText((cGate && cGate.snapshot) || jp.contract, ''));
  const planFile = state.epic ? jp.slices : jp.plan;
  if (exists(planFile)) writeText(path.join(dir, `before-${path.basename(planFile)}`), readText((pGate && pGate.snapshot) || planFile, ''));
  const cur = invalidation.current(root, state);
  const b = { contract: cGate ? cGate.hash : cur.contract, plan: pGate ? pGate.hash : cur.plan, design: cur.design };
  state.amendments_count = n;
  state.amendment = { n, status: 'open', reason, by: by || 'you', started_at: nowIso(), before: { contract: b.contract, plan: b.plan, design: b.design }, dir };
  job.save(root, state);
  return { job: state.id, amendment: `A-${n}`, edit: [jp.contract, planFile], next: 'Edit only the affected criteria and tasks, then run factory amend submit.' };
}

function diffAcs(beforeText, afterText) {
  const a = Object.fromEntries(contractMod.parse(beforeText).acs.map((x) => [x.id, x]));
  const b = Object.fromEntries(contractMod.parse(afterText).acs.map((x) => [x.id, x]));
  const changed = [];
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!a[id]) changed.push({ id, change: 'added' });
    else if (!b[id]) changed.push({ id, change: 'removed' });
    else if (stableStringify(a[id]) !== stableStringify(b[id])) changed.push({ id, change: 'changed' });
  }
  return changed;
}

function submit(root, { jobId }) {
  const state = job.resolve(root, jobId);
  const am = state.amendment;
  if (!am || !['open', 'submitted'].includes(am.status)) fail('No open amendment. Start one with factory amend start --reason "…".', 'bad_input');
  const jp = jobPaths(root, state.id);
  const beforeContract = readText(path.join(am.dir, 'before-contract.md'), '');
  const afterContract = readText(jp.contract, '');
  const probs = contractMod.problems(contractMod.parse(afterContract), { requireIntent: false }); // legacy contracts may predate Intent
  if (probs.length) fail(`The amended contract has problems:\n- ${probs.join('\n- ')}`, 'contract_invalid', probs);
  const changedAcs = diffAcs(beforeContract, afterContract);
  let affected = [];
  let planValidation = null;
  const planFile = state.epic ? jp.slices : jp.plan;
  if (exists(planFile)) {
    planValidation = planMod.validate(root, state);
    if (!planValidation.valid) fail(`The amended plan is invalid:\n- ${planValidation.errors.join('\n- ')}`, 'plan_invalid', planValidation.errors);
    const before = readJson(path.join(am.dir, `before-${path.basename(planFile)}`), { tasks: [], slices: [] });
    const after = readJson(planFile, { tasks: [], slices: [] });
    const items = (d) => d.tasks || d.slices || [];
    const bmap = Object.fromEntries(items(before).map((t) => [t.id, t]));
    const ids = changedAcs.map((c) => c.id);
    for (const t of items(after)) {
      const { waves: _w, ...rest } = t;
      const prev = bmap[t.id];
      if (!prev || stableStringify(prev) !== stableStringify(rest) || (t.criteria_ids || []).some((c) => ids.includes(c))) affected.push(t.id);
    }
  }
  if (!changedAcs.length && !affected.length) fail('Nothing changed in the contract or plan.', 'bad_input');
  const doc = {
    amendment: `A-${am.n}`,
    job: state.id,
    reason: am.reason,
    by: am.by,
    changed_criteria: changedAcs,
    affected: affected,
    contract_hash_after: contractMod.hash(root, state),
    plan_hash_after: exists(planFile) ? require('../lib/util').hashFile(planFile) : null,
    submitted_at: nowIso(),
  };
  const file = path.join(am.dir, 'amendment.json');
  writeJson(file, doc);
  state.amendment = { ...am, status: 'submitted', file, hash: sha256(readText(file)), affected_tasks: affected, changed_criteria: changedAcs };
  job.save(root, state);
  const parked = state.status === 'parked';
  return { job: state.id, amendment: doc, ...(parked ? { parked: true } : {}), next: parked ? `Run factory next (or factory drive): it presents gate A. Then reply "approve" (the job is parked; approving the amendment also resumes it, as "resume" would, no separate reply) or "deny <what must change>".` : 'Waiting for your approval: reply "approve" or "deny <what must change>".' };
}

// Called by human.approve for gate A.
function applyApproved(root, state) {
  const am = state.amendment;
  const b = invalidation.current(root, state, job.load);
  const before = am.before;
  const rebind = { contract: [before.contract, b.contract], plan: [before.plan, b.plan], design: [before.design, b.design] };
  const { snapshot } = require('./human');
  for (const gate of ['H1', 'EH1']) if (state.approvals[gate]) state.approvals[gate] = { ...state.approvals[gate], hash: b.contract, rebound_by: `A-${am.n}`, snapshot: snapshot(root, state, gate, b.contract) };
  for (const gate of ['H3', 'EH3']) if (state.approvals[gate] && b.plan) state.approvals[gate] = { ...state.approvals[gate], hash: b.plan, rebound_by: `A-${am.n}`, snapshot: snapshot(root, state, gate, b.plan) };
  // Carry earlier step records forward to the new hashes, with your approval as the reason.
  for (const step of ['clarify', 'ground', 'decide', 'decompose', 'plan_critique']) {
    const last = ledger.freshStep(root, state.id, step, {});
    if (!last) continue;
    const bound = { ...(last.bound || {}) };
    for (const [k, [from, to]] of Object.entries(rebind)) if (bound[k] && bound[k] === from) bound[k] = to;
    ledger.append(root, state.id, { kind: 'step', step, ok: true, bound, detail: { rebound_by: `A-${am.n}` } });
  }
  for (const t of am.affected_tasks || []) {
    if (!state.epic) state.tasks[t] = { ...(state.tasks[t] || {}), needs_work: 'amendment' };
  }
  state.amendment = { ...am, status: 'applied', applied_at: nowIso() };
  delete state.needs_replan;
  // Epic: affected slices' child jobs need a replan.
  if (state.epic) {
    for (const c of state.children || []) {
      const k = job.load(root, c);
      if ((am.affected_tasks || []).includes(k.slice_id) && k.status === 'active') {
        k.needs_replan = `A-${am.n}`;
        job.save(root, k);
      }
    }
  }
}

module.exports = { start, submit, applyApproved, diffAcs };
