'use strict';
// Inspection rules. Each returns findings:
//   { rule, class: deviation | ambiguity | gap, severity: high | medium | low,
//     subject, job, summary, evidence: [..], question }
// deviation = the factory did something its declared rulebook does not allow
// ambiguity = the rules left room, and the system or the human had to improvise
// gap       = something the audit needs is missing or inconsistent

const path = require('path');
const { readJson } = require('./io');
const { isRouting, openAgents } = require('./observe');
const M = require('./model');

const f = (o) => ({ evidence: [], ...o });

// ---------------------------------------------------------------- R1 seals
function seals(job) {
  const out = [];
  const bad = [];
  if (job.state && !job.stateSealed) bad.push('state.json');
  if (job.lock && !job.lockSealed) bad.push('recipe.lock.json');
  if (job.intent && job.intentSealed === false) bad.push('intent-evidence.json');
  const ledgerBad = job.ledgerLines.filter((l) => !l.torn && (!l.sealed || (l.rec && l.rec.job && l.rec.job !== job.id))); // torn lines: R11
  if (ledgerBad.length) bad.push(`ledger.jsonl lines ${ledgerBad.map((l) => l.line).slice(0, 10).join(', ')}`);
  const decBad = job.decisionLines.filter((d) => !d.sealed);
  if (decBad.length) bad.push(`decisions.jsonl lines ${decBad.map((d) => d.line).slice(0, 10).join(', ')}`);
  const evBad = job.eventLines.filter((e) => !e.sealed);
  if (evBad.length) bad.push(`events.jsonl lines ${evBad.map((e) => e.line).slice(0, 10).join(', ')}`);
  if (bad.length) {
    out.push(f({ rule: 'R1.seals', class: 'deviation', severity: 'high', subject: job.id, job: job.id, summary: `Records written outside the factory CLI: ${bad.join('; ')}`, evidence: bad, question: 'Who or what wrote these, and should the job be re-run from a clean state?' }));
  }
  if (!job.lock) {
    out.push(f({ rule: 'R1.no_rulebook', class: 'gap', severity: 'medium', subject: job.id, job: job.id, summary: 'No recipe.lock.json: there is no declared rulebook to audit this job against.', question: 'Was this job created by an older factory version? If so, mark it wontfix.' }));
  }
  return out;
}

// ---------------------------------------------------------------- R2 intended recipe
function intendedRecipe(job) {
  const out = [];
  const { lock, state } = job;
  if (!lock || !lock.recipe) return out;
  const inputs = lock.inputs || {};
  if (state && (state.work_type !== inputs.work_type || state.risk !== inputs.risk || Boolean(state.epic) !== Boolean(inputs.epic))) {
    out.push(f({ rule: 'R2.inputs_changed', class: 'deviation', severity: 'high', subject: job.id, job: job.id, summary: `The job's inputs changed after the recipe was chosen (locked: ${inputs.work_type}/${inputs.risk}, now: ${state.work_type}/${state.risk}).`, question: 'Did the work type or risk change without an amendment?' }));
  }
  const eff = M.effectiveRisk(lock.risk_floor, inputs.work_type, inputs.risk_proposed || inputs.risk);
  if (eff !== inputs.risk) {
    out.push(f({ rule: 'R2.risk_floor', class: 'deviation', severity: 'high', subject: job.id, job: job.id, summary: `Risk ${inputs.risk} doesn't match the policy floor for ${inputs.work_type} (expected ${eff}).`, question: 'Was the risk lowered below its policy floor?' }));
  }
  const expected = M.selectRecipe(lock.selection, { work_type: inputs.work_type, risk: eff, epic: inputs.epic });
  if (expected !== lock.id || (state && state.recipe && state.recipe.id !== lock.id)) {
    out.push(f({ rule: 'R2.recipe_selection', class: 'deviation', severity: 'high', subject: job.id, job: job.id, summary: `The selection rules give "${expected}" for these inputs, but the job ran "${(state && state.recipe && state.recipe.id) || lock.id}".`, evidence: [`recipe.lock.json: ${lock.id}`], question: 'Why did this job run a different recipe than the rules choose?' }));
  }
  if (lock.recipe_hash && M.recipeHash(lock.recipe) !== lock.recipe_hash) {
    out.push(f({ rule: 'R2.lock_hash', class: 'deviation', severity: 'high', subject: job.id, job: job.id, summary: 'The locked recipe does not match its own recorded hash.', question: 'Was recipe.lock.json edited?' }));
  }
  const wrongVersion = job.decisions.filter((d) => isRouting(d) && (d.recipe !== lock.id || d.recipe_version !== lock.version));
  if (wrongVersion.length) {
    out.push(f({ rule: 'R2.recipe_drift', class: 'deviation', severity: 'high', subject: job.id, job: job.id, summary: `${wrongVersion.length} routing decision(s) used a different recipe or version than the one locked (${lock.id} v${lock.version}).`, evidence: wrongVersion.slice(0, 5).map((d) => d.id), question: 'Did the recipe change while the job was running?' }));
  }
  // The plugin's current copy of the same recipe version should be identical.
  const pluginRecipe = lock.plugin && lock.plugin.root ? readJson(path.join(lock.plugin.root, 'recipes', `${lock.id}.json`), null) : null;
  if (pluginRecipe && pluginRecipe.version === lock.version && M.recipeHash(pluginRecipe) !== lock.recipe_hash) {
    out.push(f({ rule: 'R2.unversioned_edit', class: 'gap', severity: 'medium', subject: `${lock.id}@v${lock.version}`, job: job.id, summary: `recipes/${lock.id}.json changed without a version bump: jobs on "v${lock.version}" no longer mean the same thing.`, question: `Bump ${lock.id} to v${lock.version + 1}?` }));
  }
  return out;
}

// ---------------------------------------------------------------- R3 sequence conformance
function conformance(job) {
  const out = [];
  const recipe = job.lock && job.lock.recipe;
  if (!recipe) return out;
  const routing = job.decisions.filter(isRouting).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const human = job.decisions.filter((d) => !isRouting(d));
  let maxIdx = -1;
  let rewound = false;
  for (const d of routing) {
    if (!d.step) continue;
    const idx = M.stepIndex(recipe, d.step);
    if (idx === -1) {
      if (!M.SPECIAL_STEPS.has(d.step)) {
        out.push(f({ rule: 'R3.step_not_in_recipe', class: 'deviation', severity: 'high', subject: `${job.id}:${d.step}`, job: job.id, summary: `Routed to "${d.step}", which is not a step of ${recipe.id}.`, evidence: [d.id], question: 'Which rule produced a step outside the recipe?' }));
      }
      continue;
    }
    // Every earlier step must have been completed — unless the records can't tell.
    for (const prior of recipe.steps.slice(0, idx)) {
      if (['H4', 'close', 'distill', 'post_merge_challenge'].includes(prior.step)) continue;
      const done = M.completedBy(job, prior, d.ts);
      if (done === false && !(d.rule && M.REWIND_RULES.test(d.rule))) {
        out.push(f({ rule: 'R3.skipped_step', class: 'deviation', severity: 'high', subject: `${job.id}:${prior.step}->${d.step}`, job: job.id, summary: `Reached "${d.step}" before "${prior.step}" was completed.`, evidence: [d.id], question: `How did ${d.step} start without ${prior.step}?` }));
        break;
      }
    }
    if (idx < maxIdx) {
      if (d.rule && M.REWIND_RULES.test(d.rule)) rewound = true;
      else if (!rewound) {
        const cause = human.find((h) => ['human.deny', 'human.resume', 'human.approve', 'human.change_assumption', 'human.drop_assumption'].includes(h.action) && h.ts <= d.ts && (!h.gate || h.gate === 'A' || h.action !== 'human.approve'));
        if (!cause) {
          const from = recipe.steps[maxIdx].step;
          out.push(f({ rule: 'R3.unexplained_rewind', class: 'ambiguity', severity: 'low', subject: `${job.id}:${from}->${d.step}`, job: job.id, summary: `Went back from "${from}" to "${d.step}" with no recorded cause (no failing check, denial, resume or amendment).`, evidence: [d.id], question: 'Was an approved or recorded document edited by hand? If that is a normal way of working, should it go through an amendment?' }));
        }
      }
    } else {
      if (idx > maxIdx) rewound = false;
      maxIdx = Math.max(maxIdx, idx);
    }
  }
  // A closed job must show every step that leaves evidence.
  if (job.state && job.state.status === 'closed') {
    for (const s of recipe.steps) {
      if (s.step === 'close') continue;
      const done = M.completedBy(job, s, null);
      if (done === false) {
        out.push(f({ rule: 'R3.closed_without_step', class: 'deviation', severity: 'high', subject: `${job.id}:${s.step}`, job: job.id, summary: `Closed without any record of "${s.step}".`, question: `Should ${recipe.id} jobs be able to close without ${s.step}?` }));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- R4 gate integrity
function gates(job) {
  const out = [];
  const routing = job.decisions.filter(isRouting).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  for (const a of job.decisions.filter((d) => d.action === 'human.approve')) {
    const presented = routing.filter((d) => d.action === 'gate' && d.step === a.gate && d.ts <= a.ts);
    const last = presented[presented.length - 1];
    if (!last) {
      out.push(f({ rule: 'R4.unpresented_gate', class: 'deviation', severity: 'high', subject: `${job.id}:${a.gate}@${a.ts}`, job: job.id, summary: `${a.gate} was approved but never presented as a gate.`, evidence: [a.ts], question: 'How was an approval recorded without a presented gate?' }));
    } else if (last.gate_hash && a.hash && last.gate_hash !== a.hash) {
      out.push(f({ rule: 'R4.hash_mismatch', class: 'deviation', severity: 'high', subject: `${job.id}:${a.gate}@${a.ts}`, job: job.id, summary: `${a.gate} was approved for a different document than the one presented.`, evidence: [last.id, a.ts], question: 'What changed between presenting and approving?' }));
    }
  }
  const recipe = job.lock && job.lock.recipe;
  for (const [g, v] of Object.entries((job.state && job.state.approvals) || {})) {
    if (v.via === 'policy') {
      const def = recipe && recipe.steps.find((s) => s.step === g);
      if (!(def && def.auto)) out.push(f({ rule: 'R4.policy_approval', class: 'deviation', severity: 'high', subject: `${job.id}:${g}`, job: job.id, summary: `${g} was approved by policy, but the recipe gives it no automatic approval.`, question: 'Which path auto-approved this gate?' }));
    } else if (!['chat', 'tty'].includes(v.via)) {
      out.push(f({ rule: 'R4.unknown_channel', class: 'deviation', severity: 'high', subject: `${job.id}:${g}`, job: job.id, summary: `${g} was approved through "${v.via}", which is not a human channel.`, question: 'Where did this approval come from?' }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- R5 evidence chain
function evidenceChain(job) {
  const out = [];
  const ok = (step) => job.ledger.filter((e) => e.kind === 'step' && e.step === step && e.ok);
  const has = (step, fp, before) => ok(step).some((e) => e.bound && e.bound.fingerprint === fp && e.at <= before);
  for (const c of ok('challenge').filter((e) => e.bound && e.bound.fingerprint)) {
    if (!has('prove', c.bound.fingerprint, c.at)) out.push(f({ rule: 'R5.review_unproven_build', class: 'deviation', severity: 'high', subject: `${job.id}:challenge@${c.bound.fingerprint.slice(0, 12)}`, job: job.id, summary: 'A review passed on a build that had no passing proof.', evidence: [c.at], question: 'How did review run before verification on this build?' }));
  }
  for (const p of ok('prove')) {
    if (p.bound && p.bound.fingerprint && !has('reconcile', p.bound.fingerprint, p.at)) out.push(f({ rule: 'R5.proof_unintegrated', class: 'deviation', severity: 'high', subject: `${job.id}:prove@${p.bound.fingerprint.slice(0, 12)}`, job: job.id, summary: 'A proof was recorded on a build that was never integrated.', evidence: [p.at], question: 'Which build was verified?' }));
  }
  for (const s of ok('ship')) {
    const fp = s.bound && s.bound.fingerprint;
    if (fp && (!has('prove', fp, s.at) || !has('challenge', fp, s.at))) out.push(f({ rule: 'R5.shipped_unverified', class: 'deviation', severity: 'high', subject: `${job.id}:ship@${fp.slice(0, 12)}`, job: job.id, summary: 'Shipped a build without both a passing proof and a passing review on that exact build.', evidence: [s.at], question: 'How did ship pass its floors?' }));
  }
  return [...out, ...lostFindings(job), ...doneWithoutBuilder(job)];
}

// Outcome integrity: a blocker/major finding left unverified by a review round (verifier
// timeout, "unverifiable") that no later round settled (confirmed or refuted), yet the job
// shipped or a later round passed. Older factory versions let such a finding vanish when the next
// reviewer did not raise it again; now it is carried until settled.
function lostFindings(job) {
  const rounds = job.ledger.filter((e) => e.kind === 'step' && e.step === 'challenge' && e.detail && Array.isArray(e.detail.findings)).sort((a, b) => (a.at < b.at ? -1 : 1));
  const ships = job.ledger.filter((e) => e.kind === 'step' && e.step === 'ship' && e.ok).map((e) => e.at);
  const lost = [];
  rounds.forEach((r, i) => {
    for (const x of r.detail.findings.filter((y) => SERIOUS.has(y.severity) && y.status === 'unverified')) {
      const later = rounds.slice(i + 1);
      if (!later.length) continue;
      // The same finding in a later round: the same issue (file and rule, summary or nearby
      // line), or the carried copy of this one (its id, possibly renamed "code-1@r1"). An id
      // alone proves nothing: ids restart every round.
      const from = x.carried ? x.carried.from_round : r.detail.round || 1;
      const same = (y) => sameIssue(x, y, false) || (baseId(y.id) === baseId(x.id) && (y.carried ? y.carried.from_round === from : !x.file && !y.file && String(x.summary || '').toLowerCase() === String(y.summary || '').toLowerCase()));
      // settled by a verifier, or by the human (factory finding accept|dismiss, with a reason)
      const settled = later.some((e) => e.detail.findings.some((y) => same(y) && ['confirmed', 'refuted', 'accepted', 'dismissed'].includes(y.status)));
      const carried = later[later.length - 1].detail.findings.some((y) => same(y) && y.status === 'unverified');
      if (settled || carried) continue;
      const passedAfter = later.find((e) => e.ok);
      const shipped = ships.find((t) => t > r.at);
      if (passedAfter || shipped) lost.push({ x, round: r.detail.round || 1, at: (passedAfter && passedAfter.at) || shipped, shipped: Boolean(shipped) });
    }
  });
  if (!lost.length) return [];
  const seen = new Set();
  const uniq = lost.filter((l) => !seen.has(l.x.id) && seen.add(l.x.id));
  return [f({ rule: 'R5.unverified_finding_lost', class: 'deviation', severity: 'high', subject: job.id, job: job.id, latest: latest(uniq, 'at'), summary: `${uniq.length} serious finding(s) left unverified in a review round were never settled, yet ${uniq.some((l) => l.shipped) ? 'the job shipped' : 'a later round passed'}: ${uniq.slice(0, 4).map((l) => `${l.x.id} [${l.x.severity}] ${l.x.file || ''}${l.x.line ? `:${l.x.line}` : ''} (round ${l.round})`).join('; ')}.`, evidence: uniq.slice(0, 6).map((l) => `round ${l.round}: ${l.x.id}`), question: 'Did the verifier time out and the next reviewer not raise it again? Was the bug real?' })];
}

// Outcome integrity: a task counted as done although its builder did not finish: a tester
// ran after its builder returned nothing (or blocked) in the same realize run, or the state
// records a done task whose latest builder reply was not "done".
function doneWithoutBuilder(job) {
  const hits = [];
  for (const e of job.ledger.filter((x) => x.kind === 'agents' && x.workflow === 'realize')) {
    const lastBuild = {};
    for (const a of e.agents || []) {
      const m = /^(build|test) (\S+)/.exec(a.label || '');
      if (!m) continue;
      if (m[1] === 'build') lastBuild[m[2]] = a.outcome;
      else if (a.outcome === 'pass' && lastBuild[m[2]] && lastBuild[m[2]] !== 'done') hits.push({ task: m[2], why: `tested and passed after its builder came back ${lastBuild[m[2]]}`, at: e.at });
    }
  }
  for (const [id, t] of Object.entries((job.state && job.state.tasks) || {})) {
    if (t.outcome === 'done' && t.builder && t.builder.outcome !== 'done') hits.push({ task: id, why: `marked done, but its latest builder reply was ${t.builder.outcome}`, at: t.outcome_at || null });
  }
  if (!hits.length) return [];
  return [f({ rule: 'R5.done_without_builder', class: 'deviation', severity: 'high', subject: job.id, job: job.id, latest: latest(hits.filter((h) => h.at), 'at'), summary: `${hits.length} task result(s) in ${job.id} counted work its builder did not finish: ${hits.slice(0, 4).map((h) => `${h.task} ${h.why}`).join('; ')}.`, evidence: [...new Set(hits.map((h) => h.task))], question: 'Was a stale branch verified (a crashed, timed-out or blocked builder)? Does the task branch hold its dependencies?' })];
}

// ---------------------------------------------------------------- R6 loop accounting
function loops(job) {
  const out = [];
  const L = (job.lock && job.lock.limits) || {};
  const resumes = job.decisions.filter((d) => d.action === 'human.resume');
  const count = (rule) => job.decisions.filter((d) => isRouting(d) && d.rule === rule).length;
  const checks = [
    ['row4.confirmed_serious', L.max_review_rounds, 'review', 'review'],
    ['row5.acs_unproven', L.max_verify_fix_rounds, 'verify', 'verify-fix'],
  ];
  for (const [rule, max, from, name] of checks) {
    if (max === undefined) continue;
    const allowed = max + resumes.filter((r) => r.from === from).length;
    const n = count(rule);
    if (n > allowed) out.push(f({ rule: 'R6.rounds_over_cap', class: 'deviation', severity: 'medium', subject: `${job.id}:${rule}`, job: job.id, summary: `${n} ${name} rounds, but the cap allows ${allowed} (${max} + ${allowed - max} resume(s)).`, question: `How did ${name} rounds exceed the cap?` }));
  }
  const clarifySteps = job.ledger.filter((e) => e.kind === 'step' && e.step === 'clarify');
  const v2 = clarifySteps.filter((e) => e.detail && e.detail.ledger && Number.isInteger(e.detail.ledger.ceiling));
  if (v2.length) {
    // clarify v2: the hard ceiling counts rounds that were not degraded; each round records the
    // ceiling it ran under (max_intent_rounds, plus what resumes allowed)
    const over = v2.filter((e) => e.detail.ledger.counted > e.detail.ledger.ceiling);
    if (over.length) out.push(f({ rule: 'R6.clarify_over_cap', class: 'deviation', severity: 'medium', subject: `${job.id}:clarify`, job: job.id, summary: `Clarify ran ${over[over.length - 1].detail.ledger.counted} counted rounds; the ceiling it recorded was ${over[over.length - 1].detail.ledger.ceiling}.`, question: 'How did clarify keep running past its ceiling?' }));
  } else if (L.max_intent_rounds !== undefined && clarifySteps.length > L.max_intent_rounds + 2 + resumes.filter((r) => r.from === 'clarify').length) {
    out.push(f({ rule: 'R6.clarify_over_cap', class: 'deviation', severity: 'medium', subject: `${job.id}:clarify`, job: job.id, summary: `${clarifySteps.length} clarify rounds recorded; the cap is ${L.max_intent_rounds + 2}.`, question: 'How did clarify keep running past its cap?' }));
  }
  return out;
}

// ---------------------------------------------------------------- R7 driver fidelity
// shim (a symlink on PATH) and console (a read-only snapshot / server) change no job state;
// `intent show` only prints clarify's research.
const READ_ONLY = new Set(['next', 'doc', 'why', 'job', 'contract', 'intent', 'clarify:status', 'help', 'doctor', 'finalize', 'recipe', 'telemetry', 'use', 'lessons:list', 'task:show', 'distill:context', 'plan:validate', 'report', 'init', 'shim', 'console', 'env:show', 'env:check', 'env:propose']);
// Steps `factory run` runs itself as child commands (via "run"): task verify after a builder,
// the environment's setup in a worktree, the per-wave integration. Part of the workflow the
// decision asked for, never the driver's improvisation.
const RUNNER_STEPS = new Set(['task:verify', 'env:prepare', 'reconcile:wave']);
// Human actions run from the user's own terminal, not driver commands: `factory assumption
// change|drop` (the guard blocks agents from it). Judged by their human.* decision (R20), not R7.
const HUMAN_ACTIONS = new Set(['assumption', 'finding']);
// The human-only verbs. One that went through (ok, channel tty: the CLI accepted the terminal
// as the user's, with the typed confirmation) is the user acting, a legitimate channel: not a
// driver deviation. A refused attempt (human_only) is still judged: that was an agent trying.
const HUMAN_VERBS = new Set(['approve', 'deny', 'resume', 'cancel', 'abandon', 'waive', 'merged', 'confirm', 'reseal', 'assumption', 'finding', 'env:set', 'lessons:accept', 'lessons:reject', 'lessons:promote', 'clarify:split']);

function humanFromTerminal(e) {
  return e.event === 'cli' && e.ok !== false && (HUMAN_VERBS.has(cmdKey(e)) || HUMAN_VERBS.has(e.cmd));
}
const MUTATING_IN_WAIT = new Set(['record', 'ship', 'task:start', 'task:verify', 'task:state', 'reconcile', 'verify', 'evidence', 'plan:from-contract', 'close', 'epic', 'amend', 'followup', 'distill:done', 'wfargs']);

function cmdKey(e) {
  if (['task', 'plan', 'distill', 'lessons', 'clarify', 'env', 'reconcile'].includes(e.cmd)) return `${e.cmd}:${e.sub}`;
  return e.cmd;
}

function expectationsFor(d) {
  const wf = (workflow, config) => ({
    required: [(e) => e.cmd === 'wfargs' && e.workflow === workflow && (!config || e.config === config), (e) => e.cmd === 'record' && (e.workflow === workflow || !e.workflow) && (!config || !e.config || e.config === config)],
    requiredLabel: `factory wfargs ${workflow}${config ? ` --config ${config}` : ''} and factory record`,
    allowed: new Set(['answer', 'clarify:note', 'park', 'task:start', 'task:verify', 'task:state', 'reconcile', 'evidence', 'plan:validate', 'contract', 'wfargs', 'record']),
  });
  if (d.action === 'workflow') return wf(d.workflow, d.config);
  if (d.action === 'skill') {
    if (d.skill === 'clarify') return wf('fanout-judge', 'clarify');
    if (d.skill === 'ship') return { required: [(e) => e.cmd === 'ship'], requiredLabel: 'factory ship', allowed: new Set(['report', 'ship', 'pr', 'ci']) };
    if (d.skill === 'distill') return { required: [(e) => cmdKey(e) === 'distill:done'], requiredLabel: 'factory distill done', allowed: new Set(['distill:write', 'distill:done', 'lessons:add']) };
    if (d.skill === 'amend') return { required: [(e) => e.cmd === 'amend'], requiredLabel: 'factory amend start/submit', allowed: new Set(['amend']) };
    return { required: [], allowed: new Set() };
  }
  if (d.action === 'evidence') return { required: [(e) => e.cmd === 'evidence'], requiredLabel: 'factory evidence add', allowed: new Set(['evidence']) };
  if (d.action === 'cli' && d.command) {
    const words = d.command.replace(/^factory\s+/, '').split(/\s+/).filter((w) => w && !w.startsWith('--') && !/^J-\d+$/.test(w));
    const [cmd, sub] = words;
    return {
      required: [(e) => e.cmd === cmd && (!sub || e.sub === sub)],
      requiredLabel: `factory ${words.join(' ')}`,
      allowed: new Set([cmd, `${cmd}:${sub}`, ...(cmd === 'close' ? ['ci'] : []), ...(cmd === 'epic' ? ['use'] : [])]),
    };
  }
  // gate, wait, parked, done: nothing should change state
  return { required: [], allowed: new Set(['report', ...(d.action === 'wait' ? ['ci', 'use'] : [])]), quiet: true };
}

function driverFidelity(job) {
  const out = [];
  const routing = job.decisions.filter(isRouting).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const cli = job.events.filter((e) => e.event === 'cli');
  routing.forEach((d, i) => {
    if (!d.id) return;
    const windowClosed = i < routing.length - 1;
    const evs = cli.filter((e) => e.decision_id === d.id && e.cmd !== 'next');
    const exp = expectationsFor(d);
    if (windowClosed) {
      for (let r = 0; r < exp.required.length; r++) {
        if (!evs.some(exp.required[r])) {
          out.push(f({ rule: 'R7.not_done', class: 'deviation', severity: 'medium', subject: `${job.id}:${d.id}`, job: job.id, summary: `factory next said ${d.action} "${d.step || d.skill || d.command}", but ${exp.requiredLabel} never ran before the next decision.`, evidence: [d.id], question: 'Did Copilot skip or replace the step it was told to run? Is the skill text unclear here?' }));
          break;
        }
      }
    }
    for (const e of evs) {
      const k = cmdKey(e);
      if (READ_ONLY.has(k) || READ_ONLY.has(e.cmd) || HUMAN_ACTIONS.has(e.cmd) || humanFromTerminal(e)) continue;
      if (e.via === 'run' && RUNNER_STEPS.has(k)) continue;
      // `factory run` logs its own wfargs / agent_run / record lines, which are judged here;
      // a `cmd: run` line is only written when the run failed before or around them, and a
      // failed run changed nothing by itself (R13 counts repeated failures).
      if (e.cmd === 'run') continue;
      if (exp.allowed.has(k) || exp.allowed.has(e.cmd)) continue;
      const mutating = MUTATING_IN_WAIT.has(k) || MUTATING_IN_WAIT.has(e.cmd);
      out.push(f({ rule: exp.quiet ? 'R7.acted_while_waiting' : 'R7.unexpected_command', class: 'deviation', severity: exp.quiet && mutating ? 'high' : 'medium', subject: `${job.id}:${d.id}:${k}`, job: job.id, summary: exp.quiet ? `Ran "factory ${e.cmd}${e.sub ? ` ${e.sub}` : ''}" while the job was at ${d.action} "${d.step || ''}" — nothing should change there.` : `Ran "factory ${e.cmd}${e.sub ? ` ${e.sub}` : ''}" while factory next had asked for ${d.action} "${d.step || d.skill || d.command}".`, evidence: [d.id, e.ts], question: 'Was this an improvisation the skills should describe, or a mistake?' }));
    }
  });
  // One note per job when the user acted from the terminal and never through a chat reply:
  // fine, but often the sign that chat replies don't reach the factory (the prompt hook
  // isn't running: VS Code harness, hooks off, untrusted folder).
  const fromTty = cli.filter(humanFromTerminal);
  const human = job.decisions.filter((d) => /^human\./.test(String(d.action || '')));
  const viaTty = human.filter((d) => d.channel === 'tty');
  const viaChat = human.filter((d) => d.channel === 'chat');
  if ((fromTty.length || viaTty.length) && !viaChat.length) {
    const verbs = [...new Set(fromTty.map((e) => `${e.cmd}${e.sub ? ` ${e.sub}` : ''}`).concat(viaTty.map((d) => String(d.action).replace(/^human\./, ''))))].slice(0, 5);
    out.push(f({ rule: 'R7.terminal_approvals', class: 'gap', severity: 'low', subject: `${job.id}:terminal`, job: job.id, summary: `The human actions in ${job.id} came from the terminal (${verbs.join(', ')}), none from a chat reply. That is a legitimate channel, but chat replies may not be reaching the factory (the prompt hook not running).`, evidence: [...fromTty.map((e) => e.ts), ...viaTty.map((d) => d.ts)].filter(Boolean).slice(0, 6), question: 'Do chat replies like "approve" work in this setup? If not, check the hooks (README: Use it in VS Code — harness, Chat: Configure Hooks, the VS Code logs for hook errors, the hooks node check of factory doctor, chat.useHooks, Workspace Trust; /plugin list in the CLI).' }));
  }
  return out;
}

// ---------------------------------------------------------------- R8 cross-job consistency
function consistency(obs) {
  const out = [];
  const byKey = new Map();
  for (const job of Object.values(obs.jobs)) {
    const rk = M.rulebookKey(job.lock);
    if (!rk) continue;
    for (const d of job.decisions.filter(isRouting)) {
      if (!d.first_failing || d.first_failing === 'no_drift' || !d.rule || d.rule.startsWith('cap.')) continue;
      const k = `${job.lock.id}|${rk}|${d.first_failing}`;
      if (!byKey.has(k)) byKey.set(k, new Map());
      const m = byKey.get(k);
      m.set(d.rule, [...(m.get(d.rule) || []), d.id]);
    }
  }
  for (const [k, m] of byKey) {
    if (m.size > 1) {
      const [recipe, , check] = k.split('|');
      out.push(f({ rule: 'R8.divergent_routing', class: 'ambiguity', severity: 'medium', subject: k, summary: `In ${recipe}, the same failing check "${check}" was routed by different rules: ${[...m.keys()].join(', ')}.`, evidence: [...m.values()].map((ids) => ids[0]), question: 'Which route is intended for this situation?' }));
    }
  }
  // Same inputs and same selection rules must give the same recipe.
  const bySel = new Map();
  for (const job of Object.values(obs.jobs)) {
    if (!job.lock || !job.lock.inputs) continue;
    const k = `${job.lock.selection_hash}|${job.lock.inputs.work_type}|${job.lock.inputs.risk}|${Boolean(job.lock.inputs.epic)}`;
    if (!bySel.has(k)) bySel.set(k, new Map());
    bySel.get(k).set(job.lock.id, [...(bySel.get(k).get(job.lock.id) || []), job.id]);
  }
  for (const [k, m] of bySel) {
    if (m.size > 1) out.push(f({ rule: 'R8.inconsistent_selection', class: 'deviation', severity: 'high', subject: k, summary: `Jobs with the same inputs and selection rules ran different recipes: ${[...m.entries()].map(([r, j]) => `${r} (${j.join(', ')})`).join('; ')}.`, question: 'How can identical inputs pick different recipes?' }));
  }
  return out;
}

// ---------------------------------------------------------------- R9 friction patterns
function friction(obs, threshold) {
  const out = [];
  const group = (items, keyFn) => {
    const m = new Map();
    for (const it of items) {
      const k = keyFn(it);
      if (k) m.set(k, [...(m.get(k) || []), it]);
    }
    return m;
  };
  const ev = obs.events;
  for (const [k, items] of group(ev.filter((e) => e.event === 'guard_deny'), (e) => `${e.agent_type || 'main session'}|${String(e.reason || '').replace(/[\w./-]*\/[\w./-]*/g, '<path>').slice(0, 90)}`)) {
    if (items.length >= threshold) {
      const [who, reason] = k.split('|');
      out.push(f({ rule: 'R9.guard_friction', class: 'ambiguity', severity: 'medium', subject: k, summary: `${who} hit the same guard denial ${items.length} times: ${reason}`, evidence: [...new Set(items.map((i) => i.job).filter(Boolean))], question: 'Is the boundary unclear in that role\'s instructions, or is the boundary wrong?' }));
    }
  }
  for (const [k, items] of group(ev.filter((e) => e.event === 'reply_refused'), (e) => e.code || 'unknown')) {
    if (items.length >= threshold) out.push(f({ rule: 'R9.replies_refused', class: 'ambiguity', severity: 'medium', subject: k, summary: `Your chat replies were refused ${items.length} times (${k}).`, question: 'Is the reply format or the gate presentation unclear?' }));
  }
  for (const [k, items] of group(ev.filter((e) => e.event === 'cli' && e.cmd === 'record' && e.ok === false), (e) => `${e.code || 'error'}`)) {
    if (items.length >= threshold) out.push(f({ rule: 'R9.record_refused', class: 'ambiguity', severity: 'medium', subject: k, summary: `factory record refused ${items.length} workflow results (${k}).`, evidence: [...new Set(items.map((i) => i.job).filter(Boolean))], question: 'Do briefs and envelopes disagree, or do inputs change while workflows run?' }));
  }
  for (const [k, items] of group(ev.filter((e) => ['stop_block', 'subagent_block'].includes(e.event)), (e) => `${e.event}|${e.role || ''}`)) {
    if (items.length >= threshold) out.push(f({ rule: 'R9.blocked_finish', class: 'ambiguity', severity: 'low', subject: k, summary: `${k.split('|')[0] === 'stop_block' ? 'The stop gate blocked the end of a turn while floors failed' : `The ${k.split('|')[1]} role tried to finish without its output`} ${items.length} times.`, question: 'Does the skill or role prompt make "done" clear enough?' }));
  }
  const dec = obs.decisions;
  for (const [rule, parks] of group(dec.filter((d) => d.action === 'parked' && d.rule && d.rule.startsWith('cap.')), (d) => d.rule)) {
    if (parks.length < threshold) continue;
    const resumed = parks.filter((p) => dec.some((h) => h.action === 'human.resume' && h.job === p.job && h.ts > p.ts)).length;
    if (resumed / parks.length >= 0.8) out.push(f({ rule: 'R9.cap_overridden', class: 'ambiguity', severity: 'medium', subject: rule, summary: `${rule} parked ${parks.length} jobs and you resumed ${resumed} of them.`, question: 'Is this cap too tight for real work?' }));
  }
  for (const [floor, items] of group(dec.filter((d) => d.action === 'human.waive'), (d) => d.floor)) {
    const jobs = new Set(items.map((i) => i.job));
    if (jobs.size >= threshold) out.push(f({ rule: 'R9.repeated_waiver', class: 'ambiguity', severity: 'medium', subject: floor, summary: `"${floor}" was waived in ${jobs.size} jobs.`, evidence: [...jobs], question: 'Is a setup step missing (e.g. CI), or does this floor not fit?' }));
  }
  for (const [gate, items] of group(dec.filter((d) => d.action === 'human.deny'), (d) => d.gate)) {
    if (items.length >= threshold) out.push(f({ rule: 'R9.gate_denials', class: 'ambiguity', severity: 'low', subject: gate, summary: `${items.length} denials at ${gate}: drafts are weakest at this stage.`, evidence: items.slice(0, 5).map((i) => i.reason).filter(Boolean), question: `What do the ${gate} drafts keep getting wrong?` }));
  }
  // Same step chosen over and over in one job, outside fix rounds.
  for (const job of Object.values(obs.jobs)) {
    const r = job.decisions.filter(isRouting).sort((a, b) => (a.ts < b.ts ? -1 : 1));
    let run = 1;
    for (let i = 1; i < r.length; i++) {
      const same = r[i].step && r[i].step === r[i - 1].step && r[i].rule === 'order.next_step' && !['gate', 'wait'].includes(r[i].action);
      run = same ? run + 1 : 1;
      if (run === threshold) out.push(f({ rule: 'R9.stuck_step', class: 'ambiguity', severity: 'medium', subject: `${job.id}:${r[i].step}`, job: job.id, summary: `"${r[i].step}" was chosen ${threshold} times in a row without progress.`, evidence: r.slice(i - threshold + 1, i + 1).map((d) => d.id), question: 'What keeps this step from completing?' }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- health: R10–R22
// Everything the factory reports about itself — hook failures, hook pushback, CLI
// failures, workflow and agent trouble, parks, idle jobs, slow gates — checked against
// the thresholds in config "limits". Findings carry `latest` (newest evidence) so a
// finding you marked fixed reopens only on new evidence.

const latest = (items, k = 'ts') => items.map((x) => x && x[k]).filter(Boolean).sort().pop() || null;
const norm = (s, n = 90) => String(s || '').replace(/[\w./-]*\/[\w./-]*/g, '<path>').replace(/\bJ-\d+(-[DT]\d+)?\b/g, '<id>').replace(/\b[0-9a-f]{7,64}\b/g, '<hash>').slice(0, n);
const groupBy = (items, keyFn) => {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k) m.set(k, [...(m.get(k) || []), it]);
  }
  return m;
};
const hours = (a, b) => (Date.parse(b) - Date.parse(a)) / 36e5;
const AGENT_FAILED = new Set(['no_result', 'error', 'failed', 'exhausted', 'timeout', 'crashed']);
const ENFORCING_HOOKS = new Set(['guard', 'stop', 'prompt']);

// R10 / R11 / R13.cli_crash: factory-wide, from every log line regardless of job.
function factoryHealth(obs, L) {
  const out = [];
  const ev = obs.events;
  for (const [k, items] of groupBy(ev.filter((e) => e.event === 'hook_error'), (e) => `${e.hook || 'unknown'}|${norm(e.message, 120)}`)) {
    if (items.length < (L.hook_errors || 1)) continue;
    const [hook, msg] = k.split('|');
    const enforcing = ENFORCING_HOOKS.has(hook);
    out.push(f({ rule: 'R10.hook_errors', class: 'gap', severity: enforcing ? 'high' : 'medium', subject: k, latest: latest(items), summary: `The factory's ${hook} hook failed ${items.length} time(s): ${msg}${enforcing ? ' — while it fails, it enforces nothing (it falls back to "allow").' : '.'}`, evidence: [...new Set(items.map((i) => i.job).filter(Boolean))].slice(0, 10).concat(items.slice(-3).map((i) => i.ts)), question: `What breaks the ${hook} hook, and what slipped through while it was failing?` }));
  }
  for (const [k, items] of groupBy(obs.inspectorHookErrors || [], (e) => `${e.hook || 'unknown'}|${norm(e.message, 120)}`)) {
    if (items.length < (L.hook_errors || 1)) continue;
    out.push(f({ rule: 'R10.inspector_hook_errors', class: 'gap', severity: 'medium', subject: k, latest: latest(items), summary: `The inspector's own ${k.split('|')[0]} hook failed ${items.length} time(s): ${k.split('|')[1]}`, evidence: items.slice(-3).map((i) => i.ts), question: 'Is the inspector missing jobs or replies because its hook fails?' }));
  }
  const torn = [...obs.torn.events.map((n) => `events.jsonl line ${n}`), ...obs.torn.decisions.map((n) => `decisions.jsonl line ${n}`)];
  for (const j of Object.values(obs.jobs)) torn.push(...(j.ledgerTorn || []).map((n) => `${j.id}/ledger.jsonl line ${n}`));
  if (torn.length) out.push(f({ rule: 'R11.torn_lines', class: 'gap', severity: 'medium', subject: 'logs', summary: `${torn.length} log line(s) are not valid JSON (a crashed or concurrent write, or a hand edit): ${torn.slice(0, 6).join(', ')}${torn.length > 6 ? ', …' : ''}.`, evidence: torn.slice(0, 20), question: 'Did a factory process crash mid-write, or did two write the same log at once?' }));
  const crashes = ev.filter((e) => e.event === 'cli' && e.ok === false && e.code === 'internal');
  for (const [k, items] of groupBy(crashes, (e) => `${e.cmd}${e.sub ? ` ${e.sub}` : ''}`)) {
    out.push(f({ rule: 'R13.cli_crash', class: 'gap', severity: 'high', subject: k, latest: latest(items), summary: `"factory ${k}" crashed with an internal error ${items.length} time(s) — a bug in the factory, not a refusal.`, evidence: [...new Set(items.map((i) => i.job).filter(Boolean))].slice(0, 10), question: `What makes factory ${k} crash, and did a job move on without it?` }));
  }
  return out;
}

// R12–R22 for one job, from its own events, ledger, decisions and intent record.
function jobHealth(job, L, now) {
  const out = [];
  const ev = job.events;
  const id = job.id;
  const status = job.state && job.state.status;
  // R12 hook pushback in this job
  const pushback = [
    ['guard_deny', 'guard_denials_per_job', 'R12.guard_denials', 'guard denials', (items) => `top: ${[...groupBy(items, (e) => norm(e.reason, 70)).entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 2).map(([r, x]) => `${x.length}× ${r}`).join('; ')}`, 'Are the agents\' instructions unclear about this boundary, or is the boundary wrong for this job?'],
    ['stop_block', 'stop_blocks_per_job', 'R12.stop_blocks', 'stop-gate blocks', (items) => `floors still missing: ${[...new Set(items.flatMap((e) => e.missing || []))].slice(0, 5).join(', ')}`, 'Why does Copilot keep ending its turn on this job while floors fail?'],
    ['reply_refused', 'replies_refused_per_job', 'R12.replies_refused', 'refused chat replies', (items) => `codes: ${[...new Set(items.map((e) => e.code || 'unknown'))].join(', ')}`, 'Was the gate presented clearly? Did the document change after it was shown?'],
    ['reply_unparsed', 'replies_unparsed_per_job', 'R12.replies_unparsed', 'messages that looked like replies but weren\'t applied', (items) => `e.g. "${items[0].word}" (meant ${items[0].verb}?)`, 'Are the reply forms hard to remember?'],
  ];
  for (const [event, limit, rule, what, detail, question] of pushback) {
    const items = ev.filter((e) => e.event === event);
    if (items.length >= L[limit]) out.push(f({ rule, class: 'ambiguity', severity: 'medium', subject: id, job: id, latest: latest(items), summary: `${id}: ${items.length} ${what} (limit ${L[limit]}); ${detail(items).replace(/\.+$/, '')}.`, evidence: [...new Set(items.map((e) => e.decision_id).filter(Boolean))].slice(0, 6), question }));
  }
  // R13 CLI failures and stale results
  const cli = ev.filter((e) => e.event === 'cli');
  for (const [k, items] of groupBy(cli.filter((e) => e.ok === false && e.code !== 'internal'), (e) => `${e.cmd}${e.sub ? ` ${e.sub}` : ''}|${e.code || 'error'}`)) {
    if (items.length < L.cli_failures) continue;
    const [cmd, code] = k.split('|');
    out.push(f({ rule: 'R13.cli_failures', class: 'ambiguity', severity: 'medium', subject: `${id}:${k}`, job: id, latest: latest(items), summary: `"factory ${cmd}" failed ${items.length} times in ${id} with ${code}.`, evidence: [...new Set(items.map((e) => e.decision_id).filter(Boolean))].slice(0, 6), question: 'Is Copilot retrying blindly? Does the skill say what to do on this error?' }));
  }
  const stale = cli.filter((e) => e.cmd === 'record' && e.status === 'stale');
  if (stale.length >= L.stale_results_per_job) out.push(f({ rule: 'R13.stale_results', class: 'ambiguity', severity: 'medium', subject: id, job: id, latest: latest(stale), summary: `${stale.length} workflow results in ${id} were thrown away as stale (inputs changed while the workflow ran).`, evidence: [...new Set(stale.map((e) => e.workflow).filter(Boolean))], question: 'What keeps changing the contract, design or build while workflows run?' }));
  // R14 workflows and agents
  const errors = job.ledger.filter((e) => e.kind === 'error');
  if (errors.length >= L.workflow_errors_per_job) out.push(f({ rule: 'R14.workflow_errors', class: 'ambiguity', severity: 'medium', subject: id, job: id, latest: latest(errors, 'at'), summary: `${errors.length} workflow errors in ${id}: ${errors.slice(-3).map((e) => `${e.workflow}${e.config ? `/${e.config}` : ''}: ${norm(e.summary, 60)}`).join('; ')}.`, question: 'Is a workflow failing for the same reason each time?' }));
  const degraded = job.ledger.filter((e) => e.kind === 'step' && e.detail && Array.isArray(e.detail.degraded) && e.detail.degraded.length);
  const degradedRecords = cli.filter((e) => e.cmd === 'record' && e.status === 'degraded');
  for (const [step, items] of groupBy(degraded, (e) => e.step)) {
    out.push(f({ rule: 'R14.degraded', class: 'ambiguity', severity: 'medium', subject: `${id}:${step}`, job: id, latest: latest(items, 'at'), summary: `${step} in ${id} went on without ${[...new Set(items.flatMap((e) => e.detail.degraded))].join(', ')} (agents with no result after a retry).`, question: 'Was it right to go on without that angle? Why do those agents fail?' }));
  }
  if (!degraded.length && degradedRecords.length) out.push(f({ rule: 'R14.degraded', class: 'ambiguity', severity: 'medium', subject: `${id}:record`, job: id, latest: latest(degradedRecords), summary: `${degradedRecords.length} workflow result(s) in ${id} came back degraded (agents failed twice).`, question: 'Why do those agents fail?' }));
  const runs = job.ledger.filter((e) => e.kind === 'agents').flatMap((e) => (e.agents || []).map((a) => ({ ...a, at: e.at, workflow: e.workflow })));
  const retries = runs.filter((a) => a.retry || /#([2-9]|\d{2,})$/.test(a.label || ''));
  if (retries.length >= L.agent_retries_per_job) out.push(f({ rule: 'R14.agent_retries', class: 'ambiguity', severity: 'low', subject: id, job: id, latest: latest(retries, 'at'), summary: `${retries.length} agent retries in ${id} (limit ${L.agent_retries_per_job}): ${[...groupBy(retries, (a) => a.agent_type).entries()].map(([t, x]) => `${t} ×${x.length}`).join(', ')}.`, question: 'Are these prompts or schemas hard to satisfy first time?' }));
  const failed = runs.filter((a) => AGENT_FAILED.has(a.outcome));
  if (failed.length >= L.agent_failures_per_job) out.push(f({ rule: 'R14.agent_failures', class: 'ambiguity', severity: 'medium', subject: id, job: id, latest: latest(failed, 'at'), summary: `${failed.length} agent runs in ${id} came back failed: ${[...groupBy(failed, (a) => `${a.agent_type} (${a.outcome})`).entries()].map(([t, x]) => `${t} ×${x.length}`).join(', ')}.`, question: 'Which role keeps failing, and why?' }));
  // Agents `factory run` started (agent_run events): timeouts, crashes (non-zero exit) and a
  // Copilot CLI that could not be started or used at all. The roster above only says "no result".
  const agentRuns = job.events.filter((e) => e.event === 'agent_run');
  const timeouts = agentRuns.filter((e) => e.outcome === 'timeout');
  if (timeouts.length) out.push(f({ rule: 'R14.agent_timeouts', class: 'ambiguity', severity: 'medium', subject: id, job: id, latest: latest(timeouts), summary: `${timeouts.length} agent run(s) in ${id} timed out: ${[...groupBy(timeouts, (a) => a.agent_type || a.role || 'agent').entries()].map(([t, x]) => `${t} ×${x.length}`).join(', ')}.`, evidence: timeouts.slice(0, 6).map((a) => a.label || a.agent_type || a.ts), question: 'Is the agent timeout (policy.limits.agent_timeout_seconds) too short for this work, or did the agent hang?' }));
  const unavailable = [...agentRuns.filter((e) => e.code === 'copilot_unavailable' || e.outcome === 'copilot_unavailable' || /ENOENT|No authentication information found|not signed in/i.test((e.errors || []).join(' '))), ...cli.filter((e) => e.code === 'copilot_unavailable')];
  const crashes = agentRuns.filter((e) => ['failed', 'crashed', 'error'].includes(e.outcome) && !unavailable.includes(e));
  if (crashes.length >= L.agent_failures_per_job) out.push(f({ rule: 'R14.agent_crashes', class: 'ambiguity', severity: 'medium', subject: id, job: id, latest: latest(crashes), summary: `${crashes.length} agent process(es) in ${id} exited with an error: ${[...groupBy(crashes, (a) => `${a.agent_type || a.role || 'agent'} (exit ${a.exit})`).entries()].map(([t, x]) => `${t} ×${x.length}`).join(', ')}.`, evidence: crashes.slice(0, 6).map((a) => norm((a.errors || [])[0] || a.label || '', 80)), question: 'What made these Copilot sessions fail (rate limit, model, permissions)?' }));
  if (unavailable.length) out.push(f({ rule: 'R14.copilot_unavailable', class: 'gap', severity: 'high', subject: id, job: id, latest: latest(unavailable), summary: `factory run could not use the Copilot CLI in ${id} (${unavailable.length} time(s)): ${norm(String((unavailable[0].errors || [])[0] || unavailable[0].message || unavailable[0].code || ''), 100)}.`, question: 'Is copilot installed, on PATH (or COPILOT_BIN set) and signed in where factory run starts it?' }));
  const escalated = [];
  for (const [, items] of groupBy(runs, (a) => `${a.workflow}|${String(a.label || '').replace(/\s*(#\d+|\(retry\))$/, '')}`)) {
    escalated.push(...items.slice(1).filter((a) => a.model && a.model !== items[0].model));
  }
  if (escalated.length >= L.escalations_per_job) out.push(f({ rule: 'R14.escalations', class: 'ambiguity', severity: 'low', subject: id, job: id, latest: latest(escalated, 'at'), summary: `${escalated.length} agent run(s) in ${id} were escalated to a stronger model: ${escalated.slice(0, 4).map((a) => `${a.label} → ${a.model}`).join(', ')}.`, question: 'Is the first-attempt model too weak for these tasks?' }));
  // A round that stopped to ask the user (outcome needs_user; before it was recorded: a clarify
  // round with questions, a ground round with blocking unknowns) is not a failure.
  const askedUser = (e) => (e.detail && (e.detail.outcome === 'needs_user' || (e.step === 'clarify' && Number(e.detail.questions) > 0) || (e.step === 'ground' && Array.isArray(e.detail.blocking) && e.detail.blocking.length > 0)));
  for (const [step, items] of groupBy(job.ledger.filter((e) => e.kind === 'step' && e.ok === false && !['prove', 'challenge'].includes(e.step) && !askedUser(e)), (e) => e.step)) {
    if (items.length >= L.step_failures) out.push(f({ rule: 'R14.step_failures', class: 'ambiguity', severity: 'medium', subject: `${id}:${step}`, job: id, latest: latest(items, 'at'), summary: `"${step}" was recorded as failed ${items.length} times in ${id}.`, question: `What keeps ${step} from passing?` }));
  }
  // R15 agents that started and never stopped
  const ended = ['closed', 'cancelled', 'abandoned'].includes(status);
  const orphans = openAgents(ev).filter((s) => ended || hours(s.ts, now) * 60 >= L.orphan_agent_minutes);
  if (orphans.length) out.push(f({ rule: 'R15.orphaned_agents', class: 'gap', severity: 'low', subject: id, job: id, latest: latest(orphans), summary: `${orphans.length} agent(s) in ${id} started and never reported stopping${ended ? ` before the job ${status}` : ` within ${L.orphan_agent_minutes} min`}: ${orphans.slice(0, 4).map((s) => `${s.agent_type || 'agent'} since ${s.ts}`).join(', ')}.`, evidence: orphans.slice(0, 6).map((s) => s.agent_id || `${s.agent_type || 'agent'}@${s.ts}`), question: 'Did these agents crash or time out? Were their results lost?' }));
  // R16 parks and resumes
  const parks = [...job.decisions.filter((d) => d.action === 'parked'), ...cli.filter((e) => (e.cmd === 'park' && e.ok) || (e.cmd === 'record' && e.status === 'park')).map((e) => ({ ts: e.ts, reason: e.cmd === 'park' ? 'parked by hand' : `${e.workflow || 'workflow'} parked it` }))];
  const resumes = job.decisions.filter((d) => d.action === 'human.resume');
  if (parks.length >= L.parks_per_job) out.push(f({ rule: 'R16.park_loop', class: 'ambiguity', severity: 'medium', subject: `${id}:parks`, job: id, latest: latest(parks), summary: `${id} was parked ${parks.length} times (limit ${L.parks_per_job}): ${[...new Set(parks.map((p) => p.rule || p.reason).filter(Boolean))].slice(0, 3).join(', ')}.`, evidence: parks.slice(0, 6).map((p) => p.id).filter(Boolean), question: 'Is this job too big or unclear for its recipe?' }));
  if (resumes.length >= L.resumes_per_job) out.push(f({ rule: 'R16.resumed_past_caps', class: 'ambiguity', severity: 'medium', subject: `${id}:resumes`, job: id, latest: latest(resumes), summary: `${id} was resumed past its caps ${resumes.length} times (limit ${L.resumes_per_job}).`, question: 'Are the caps too tight, or should this job have been re-scoped?' }));
  // R17 active with no activity
  if (status === 'active' && !job.state.pending_gate) {
    const last = [latest(ev), latest(job.decisions), latest(job.ledger, 'at'), job.state.updated_at, job.state.created_at].filter(Boolean).sort().pop();
    if (last && hours(last, now) >= L.idle_hours) out.push(f({ rule: 'R17.idle_job', class: 'gap', severity: 'low', subject: id, job: id, summary: `${id} is active but nothing has happened for ${Math.round(hours(last, now))} h (since ${last}).`, question: 'Was it forgotten, or should it be parked or cancelled?' }));
  }
  // R18 slow human replies at gates
  const routing = job.decisions.filter(isRouting).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  for (const g of routing.filter((d) => d.action === 'gate' && d.step)) {
    const reply = job.decisions.filter((d) => ['human.approve', 'human.deny'].includes(d.action) && (!d.gate || d.gate === g.step) && d.ts >= g.ts).sort((a, b) => (a.ts < b.ts ? -1 : 1))[0];
    const waited = hours(g.ts, reply ? reply.ts : now);
    if (reply && waited >= L.reply_hours) out.push(f({ rule: 'R18.slow_reply', class: 'ambiguity', severity: 'low', subject: `${id}:${g.step}`, job: id, latest: reply.ts, summary: `${g.step} in ${id} waited ${Math.round(waited)} h for your reply (limit ${L.reply_hours} h).`, evidence: [g.id], question: `Is ${g.step} hard to review, or does it arrive at a bad time?` }));
  }
  // R19 clarify: parked on unclear intent; questions over budget or re-asked
  const clarify = job.ledger.filter((e) => e.kind === 'step' && e.step === 'clarify' && e.detail);
  // Only the park entry (record.js writes it with intent_open, questions 0 and no question
  // ids); the ordinary needs_user round that asks an intent question is not a park.
  const intentParks = clarify.filter((e) => e.ok === false && e.detail.intent_open && (e.detail.parked === true || (!Array.isArray(e.detail.question_ids) && !e.detail.questions)));
  if (intentParks.length) out.push(f({ rule: 'R19.intent_parked', class: 'ambiguity', severity: 'medium', subject: id, job: id, latest: latest(intentParks, 'at'), summary: `${id} parked ${intentParks.length} time(s) because the intent was still unclear after ${Math.max(...intentParks.map((e) => e.detail.intent_rounds || 0))} intent round(s).`, question: 'Was the request too vague to start, or were the intent questions badly put?' }));
  // clarify v2: rounds in a row that settled and asked nothing (the CLI parks after its own
  // limit; this flags the pattern even when a resume let it go on), and settled issues the
  // agents kept raising again (the ledger folded them as notes)
  let streak = 0;
  let worst = 0;
  let worstAt = null;
  for (const e of clarify) {
    const lg = e.detail.ledger;
    if (!lg || lg.degraded) continue;
    streak = lg.progress ? 0 : streak + 1;
    if (streak > worst) { worst = streak; worstAt = e.at; }
  }
  if (worst >= L.clarify_stalled_rounds) out.push(f({ rule: 'R19.clarify_stalled', class: 'ambiguity', severity: 'medium', subject: id, job: id, latest: worstAt, summary: `Clarify in ${id} went ${worst} round(s) in a row without settling, deferring or asking anything (limit ${L.clarify_stalled_rounds}).`, question: 'What kept it from settling: research that cannot reach its sources, a question nobody answers, or a contract problem the editor cannot fix?' }));
  const reraised = clarify.reduce((n, e) => n + (Number((e.detail.ledger || {}).reraised) || 0), 0);
  if (reraised >= L.reraised_per_job) out.push(f({ rule: 'R19.issues_reraised', class: 'ambiguity', severity: 'low', subject: id, job: id, latest: latest(clarify.filter((e) => (e.detail.ledger || {}).reraised), 'at'), summary: `Agents raised settled clarify issues again ${reraised} time(s) in ${id} (the ledger folded them as notes; limit ${L.reraised_per_job}).`, question: 'Do the analysts, the judge or God Eye ignore the settled list in their brief, or is a settled answer unclear?' }));
  const dropped = clarify.reduce((n, e) => n + (Number(e.detail.dropped) || 0), 0);
  if (dropped >= L.questions_dropped_per_job) out.push(f({ rule: 'R19.question_overrun', class: 'ambiguity', severity: 'low', subject: id, job: id, latest: latest(clarify.filter((e) => e.detail.dropped), 'at'), summary: `Clarify in ${id} proposed ${dropped} question(s) beyond the round budget or already asked; the CLI dropped them (limit ${L.questions_dropped_per_job}).`, question: 'Does the judge ignore the question budget or the never-re-ask list in its brief?' }));
  out.push(...groundedIntent(job, L));
  out.push(...reviewRegressions(job), ...reconcileDrops(job));
  return out;
}

// R21 review regressions: a finding confirmed serious in one challenge round and found again in
// a later one — the fix was lost (reverted, merged over, rebuilt from stale code). High when the
// later round let it through (downgraded, minor, or not confirmed); medium when it blocked again.
// Same finding: same file and (same lane and rule, or a line within ±10, or the same summary);
// a minor finding matches by rule or summary only.
const SERIOUS = new Set(['blocker', 'major']);
const reportedSerious = (x) => SERIOUS.has(x.severity) || (x.notes || []).some((n) => /^downgraded from (blocker|major)/.test(String(n)));
const baseId = (id) => String(id || '').replace(/@r\d+$/, '');
function sameIssue(a, b, minor) {
  if (!a.file || a.file !== b.file) return false;
  const rule = a.rule && a.rule === b.rule && a.lane === b.lane;
  const summary = String(a.summary || '').toLowerCase() === String(b.summary || '').toLowerCase();
  if (minor) return Boolean(rule || summary);
  return Boolean(rule || summary || (a.line && b.line && Math.abs(Number(a.line) - Number(b.line)) <= 10));
}
function reviewRegressions(job) {
  const id = job.id;
  const rounds = job.ledger.filter((e) => e.kind === 'step' && e.step === 'challenge' && e.detail && Array.isArray(e.detail.findings)).sort((a, b) => (a.at < b.at ? -1 : 1));
  const confirmed = [];
  const items = [];
  for (const e of rounds) {
    const round = e.detail.round || 1;
    for (const x of e.detail.findings) {
      const prior = confirmed.find((p) => p.round < round && sameIssue(p.f, x, !reportedSerious(x)));
      if (!prior && !x.regression) continue;
      const blocked = SERIOUS.has(x.severity) && x.status === 'confirmed';
      items.push({ at: e.at, round, f: x, prior: prior || { round: x.regression.round, f: { id: x.regression.id, severity: x.regression.severity } }, blocked });
    }
    for (const x of e.detail.findings) if (SERIOUS.has(x.severity) && x.status === 'confirmed') confirmed.push({ round, f: x });
  }
  const seen = new Set();
  const uniq = items.filter((i) => !seen.has(`${i.round}|${i.f.id}`) && seen.add(`${i.round}|${i.f.id}`));
  if (!uniq.length) return [];
  const through = uniq.filter((i) => !i.blocked);
  return [f({ rule: 'R21.review_regression', class: through.length ? 'deviation' : 'ambiguity', severity: through.length ? 'high' : 'medium', subject: id, job: id, latest: latest(uniq, 'at'), summary: `${uniq.length} finding(s) confirmed in an earlier review round came back in ${id}${through.length ? `, ${through.length} let through (${through.slice(0, 3).map((i) => `${i.f.id} as ${i.f.severity}/${i.f.status}`).join(', ')})` : ' (blocked again)'}: ${uniq.slice(0, 4).map((i) => `${i.f.file}${i.f.line ? `:${i.f.line}` : ''} round ${i.round} = ${i.prior.f.id} [${i.prior.f.severity}] of round ${i.prior.round}`).join('; ')}.`, evidence: uniq.slice(0, 6).map((i) => `round ${i.round}: ${i.f.id}`), question: 'How was the fix lost — a task rebuilt from stale code, a conflict resolved by dropping it, or a fix round that never merged the job branch?' })];
}

// R22 reconcile drops: integration tried to drop lines already-merged tasks or fix rounds had
// added (the CLI's regression guard caught it and undid the merge).
function reconcileDrops(job) {
  const id = job.id;
  const drops = job.ledger.filter((e) => e.kind === 'step' && e.step === 'reconcile' && e.ok === false && e.detail && e.detail.regression);
  if (!drops.length) return [];
  const files = [...new Set(drops.flatMap((e) => e.detail.regression.files || []))];
  return [f({ rule: 'R22.reconcile_drop', class: 'deviation', severity: 'high', subject: id, job: id, latest: latest(drops, 'at'), summary: `Reconcile in ${id} would have dropped merged or fixed work ${drops.length} time(s) (${files.slice(0, 5).join(', ')}): ${String(drops[drops.length - 1].detail.message || '').slice(0, 200)}`, evidence: files.slice(0, 10), question: 'Did the integrator resolve a conflict by picking a side, or was a task built from a base without the other task\'s change?' })];
}

// R20 grounded intent: what clarify's research could not spare the user.
//   - questions asked although their unknown was researchable (repo or world kind), with the
//     reason research gave (web off, no web access, sources disagree, budget spent…)
//   - evidence-backed assumptions the user changed or dropped (a learning signal: research
//     settled them, the user disagreed)
// From the job's kind:'intent' ledger entries, its human.* decisions and, when present,
// its intent-evidence.json (for the reasons and what research had said).
const WEB_OFF = /web off|policy/i;
function intentSummary(job) {
  const rounds = job.ledger.filter((e) => e.kind === 'intent');
  const data = job.intent && job.intentSealed !== false ? job.intent : null;
  const unknowns = new Map(((data && data.unknowns) || []).map((u) => [u.id, u]));
  const asked = new Map();
  for (const r of rounds) for (const q of r.questions || []) if (q.researchable && q.id && !asked.has(q.id)) asked.set(q.id, { ...q, at: r.at });
  const researchable = [...asked.values()].map((q) => {
    const u = unknowns.get(q.unknown) || {};
    return { id: q.id, unknown: q.unknown || null, kind: u.kind || null, reason: u.note || 'research did not settle it', at: q.at };
  });
  const decisions = job.decisions.filter((d) => ['human.change_assumption', 'human.drop_assumption'].includes(d.action));
  const byId = new Map();
  for (const d of decisions) byId.set(d.assumption, { id: d.assumption, action: d.action === 'human.drop_assumption' ? 'dropped' : 'changed', value: d.value || null, was: d.was || null, at: d.ts });
  for (const a of (data && data.assumptions) || []) {
    if (byId.has(a.id) || !(a.overridden || a.dropped)) continue;
    byId.set(a.id, { id: a.id, action: a.dropped ? 'dropped' : 'changed', value: a.override ? a.override.value : null, was: a.statement || null, at: (a.override && a.override.at) || a.dropped_at || null });
  }
  return { rounds: rounds.length, researchable, overridden: [...byId.values()], researched: Boolean(rounds.length || data) };
}

function groundedIntent(job, L) {
  const out = [];
  const id = job.id;
  const s = intentSummary(job);
  if (!s.researched) return out;
  if (s.researchable.length >= L.researchable_asked_per_job) {
    const allOff = s.researchable.every((q) => WEB_OFF.test(q.reason));
    out.push(f({ rule: 'R20.researchable_asked', class: 'ambiguity', severity: allOff ? 'low' : 'medium', subject: id, job: id, latest: latest(s.researchable, 'at'), summary: `Clarify in ${id} asked you ${s.researchable.length} question(s) research could have answered: ${s.researchable.slice(0, 4).map((q) => `${q.id}${q.unknown ? ` (${q.unknown}${q.kind ? `, ${q.kind}` : ''})` : ''} — ${String(q.reason).slice(0, 80)}`).join('; ')}.`, evidence: s.researchable.slice(0, 6).map((q) => q.id), question: allOff ? 'Web research is off for this repository: is that still the right setting (policy intent_research.web)?' : 'Why could research not settle these: no web access, a budget too small for this risk, or sources that disagree?' }));
  }
  if (s.overridden.length >= L.assumptions_overridden_per_job) {
    out.push(f({ rule: 'R20.assumption_overridden', class: 'ambiguity', severity: 'low', subject: id, job: id, latest: latest(s.overridden, 'at'), summary: `You overrode ${s.overridden.length} evidence-backed assumption(s) in ${id}: ${s.overridden.slice(0, 4).map((a) => `${a.id} ${a.action}${a.value ? ` to "${String(a.value).slice(0, 50)}"` : ''}${a.was ? ` (research said: ${String(a.was).slice(0, 60)})` : ''}`).join('; ')}.`, evidence: s.overridden.slice(0, 6).map((a) => a.id), question: 'Was the evidence wrong or out of date, or is this something only you could know (it should have been a question)?' }));
  }
  return out;
}

function inspectJob(job, { limits, now } = {}) {
  const base = [...seals(job), ...intendedRecipe(job), ...conformance(job), ...gates(job), ...evidenceChain(job), ...loops(job), ...driverFidelity(job)];
  return limits ? [...base, ...jobHealth(job, limits, now || new Date().toISOString())] : base;
}

function inspectGlobal(obs, threshold, { limits } = {}) {
  const out = [...consistency(obs), ...friction(obs, threshold), ...(limits ? factoryHealth(obs, limits) : [])];
  const orphan = obs.unsealed.decisions.length + obs.unsealed.events.length;
  if (orphan) {
    const jobsTouched = new Set([...obs.unsealed.decisions, ...obs.unsealed.events].map((x) => x.job).filter(Boolean));
    if (!jobsTouched.size) out.push(f({ rule: 'R1.unattributed_lines', class: 'deviation', severity: 'high', subject: 'logs', summary: `${orphan} unsealed line(s) in the factory logs that belong to no job.`, question: 'What wrote into the logs outside the CLI and hooks?' }));
  }
  return out;
}

module.exports = { AGENT_FAILED, HUMAN_ACTIONS, inspectJob, intentSummary, groundedIntent, reviewRegressions, reconcileDrops, inspectGlobal, jobHealth, factoryHealth, seals, intendedRecipe, conformance, gates, evidenceChain, loops, driverFidelity, consistency, friction, expectationsFor };
