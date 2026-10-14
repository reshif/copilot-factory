'use strict';
// Inspection rules. Each returns findings:
//   { rule, class: deviation | ambiguity | gap, severity: high | medium | low,
//     subject, job, summary, evidence: [..], question }
// deviation = the factory did something its declared rulebook does not allow
// ambiguity = the rules left room, and the system or the human had to improvise
// gap       = something the audit needs is missing or inconsistent

const path = require('path');
const { readJson } = require('./io');
const { isRouting } = require('./observe');
const M = require('./model');

const f = (o) => ({ evidence: [], ...o });

// ---------------------------------------------------------------- R1 seals
function seals(job) {
  const out = [];
  const bad = [];
  if (job.state && !job.stateSealed) bad.push('state.json');
  if (job.lock && !job.lockSealed) bad.push('recipe.lock.json');
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
        const cause = human.find((h) => ['human.deny', 'human.resume', 'human.approve'].includes(h.action) && h.ts <= d.ts && (!h.gate || h.gate === 'A' || h.action !== 'human.approve'));
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
  return out;
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
  const clarifies = job.ledger.filter((e) => e.kind === 'step' && e.step === 'clarify').length;
  if (L.max_intent_rounds !== undefined && clarifies > L.max_intent_rounds + 2 + resumes.filter((r) => r.from === 'clarify').length) {
    out.push(f({ rule: 'R6.clarify_over_cap', class: 'deviation', severity: 'medium', subject: `${job.id}:clarify`, job: job.id, summary: `${clarifies} clarify rounds recorded; the cap is ${L.max_intent_rounds + 2}.`, question: 'How did clarify keep running past its cap?' }));
  }
  return out;
}

// ---------------------------------------------------------------- R7 driver fidelity
const READ_ONLY = new Set(['next', 'doc', 'why', 'job', 'contract', 'help', 'doctor', 'finalize', 'recipe', 'telemetry', 'use', 'lessons:list', 'task:show', 'distill:context', 'plan:validate', 'report', 'init']);
const MUTATING_IN_WAIT = new Set(['record', 'ship', 'task:start', 'task:verify', 'task:state', 'reconcile', 'verify', 'evidence', 'plan:from-contract', 'close', 'epic', 'amend', 'followup', 'distill:done', 'wfargs']);

function cmdKey(e) {
  if (e.cmd === 'task' || e.cmd === 'plan' || e.cmd === 'distill' || e.cmd === 'lessons') return `${e.cmd}:${e.sub}`;
  return e.cmd;
}

function expectationsFor(d) {
  const wf = (workflow, config) => ({
    required: [(e) => e.cmd === 'wfargs' && e.workflow === workflow && (!config || e.config === config), (e) => e.cmd === 'record' && (e.workflow === workflow || !e.workflow) && (!config || !e.config || e.config === config)],
    requiredLabel: `factory wfargs ${workflow}${config ? ` --config ${config}` : ''} and factory record`,
    allowed: new Set(['answer', 'park', 'task:start', 'task:verify', 'task:state', 'reconcile', 'evidence', 'plan:validate', 'contract', 'wfargs', 'record']),
  });
  if (d.action === 'workflow') return wf(d.workflow, d.config);
  if (d.action === 'skill') {
    if (d.skill === 'clarify') return wf('fanout-judge', 'clarify');
    if (d.skill === 'ship') return { required: [(e) => e.cmd === 'ship'], requiredLabel: 'factory ship', allowed: new Set(['report', 'ship', 'pr', 'ci']) };
    if (d.skill === 'distill') return { required: [(e) => cmdKey(e) === 'distill:done'], requiredLabel: 'factory distill done', allowed: new Set(['distill:done', 'lessons:add']) };
    if (d.skill === 'amend') return { required: [(e) => e.cmd === 'amend'], requiredLabel: 'factory amend start/submit', allowed: new Set(['amend']) };
    return { required: [], allowed: new Set() };
  }
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
          out.push(f({ rule: 'R7.not_done', class: 'deviation', severity: 'medium', subject: `${job.id}:${d.id}`, job: job.id, summary: `factory next said ${d.action} "${d.step || d.skill || d.command}", but ${exp.requiredLabel} never ran before the next decision.`, evidence: [d.id], question: 'Did Claude skip or replace the step it was told to run? Is the skill text unclear here?' }));
          break;
        }
      }
    }
    for (const e of evs) {
      const k = cmdKey(e);
      if (READ_ONLY.has(k) || READ_ONLY.has(e.cmd)) continue;
      if (exp.allowed.has(k) || exp.allowed.has(e.cmd)) continue;
      const mutating = MUTATING_IN_WAIT.has(k) || MUTATING_IN_WAIT.has(e.cmd);
      out.push(f({ rule: exp.quiet ? 'R7.acted_while_waiting' : 'R7.unexpected_command', class: 'deviation', severity: exp.quiet && mutating ? 'high' : 'medium', subject: `${job.id}:${d.id}:${k}`, job: job.id, summary: exp.quiet ? `Ran "factory ${e.cmd}${e.sub ? ` ${e.sub}` : ''}" while the job was at ${d.action} "${d.step || ''}" — nothing should change there.` : `Ran "factory ${e.cmd}${e.sub ? ` ${e.sub}` : ''}" while factory next had asked for ${d.action} "${d.step || d.skill || d.command}".`, evidence: [d.id, e.ts], question: 'Was this an improvisation the skills should describe, or a mistake?' }));
    }
  });
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
    if (items.length >= threshold) out.push(f({ rule: 'R9.blocked_finish', class: 'ambiguity', severity: 'low', subject: k, summary: `${k.split('|')[0] === 'stop_block' ? 'Claude claimed "done" while floors failed' : `The ${k.split('|')[1]} role tried to finish without its output`} ${items.length} times.`, question: 'Does the skill or role prompt make "done" clear enough?' }));
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

// ---------------------------------------------------------------- health: R10–R19
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

// R12–R18 for one job, from its own events, ledger and decisions.
function jobHealth(job, L, now) {
  const out = [];
  const ev = job.events;
  const id = job.id;
  const status = job.state && job.state.status;
  // R12 hook pushback in this job
  const pushback = [
    ['guard_deny', 'guard_denials_per_job', 'R12.guard_denials', 'guard denials', (items) => `top: ${[...groupBy(items, (e) => norm(e.reason, 70)).entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 2).map(([r, x]) => `${x.length}× ${r}`).join('; ')}`, 'Are the agents\' instructions unclear about this boundary, or is the boundary wrong for this job?'],
    ['stop_block', 'stop_blocks_per_job', 'R12.stop_blocks', 'blocked "done" claims', (items) => `floors still missing: ${[...new Set(items.flatMap((e) => e.missing || []))].slice(0, 5).join(', ')}`, 'Why does Claude keep calling this job done while floors fail?'],
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
    out.push(f({ rule: 'R13.cli_failures', class: 'ambiguity', severity: 'medium', subject: `${id}:${k}`, job: id, latest: latest(items), summary: `"factory ${cmd}" failed ${items.length} times in ${id} with ${code}.`, evidence: [...new Set(items.map((e) => e.decision_id).filter(Boolean))].slice(0, 6), question: 'Is Claude retrying blindly? Does the skill say what to do on this error?' }));
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
  const escalated = [];
  for (const [, items] of groupBy(runs, (a) => `${a.workflow}|${String(a.label || '').replace(/\s*(#\d+|\(retry\))$/, '')}`)) {
    escalated.push(...items.slice(1).filter((a) => a.model && a.model !== items[0].model));
  }
  if (escalated.length >= L.escalations_per_job) out.push(f({ rule: 'R14.escalations', class: 'ambiguity', severity: 'low', subject: id, job: id, latest: latest(escalated, 'at'), summary: `${escalated.length} agent run(s) in ${id} were escalated to a stronger model: ${escalated.slice(0, 4).map((a) => `${a.label} → ${a.model}`).join(', ')}.`, question: 'Is the first-attempt model too weak for these tasks?' }));
  for (const [step, items] of groupBy(job.ledger.filter((e) => e.kind === 'step' && e.ok === false && !['prove', 'challenge'].includes(e.step)), (e) => e.step)) {
    if (items.length >= L.step_failures) out.push(f({ rule: 'R14.step_failures', class: 'ambiguity', severity: 'medium', subject: `${id}:${step}`, job: id, latest: latest(items, 'at'), summary: `"${step}" was recorded as failed ${items.length} times in ${id}.`, question: `What keeps ${step} from passing?` }));
  }
  // R15 agents that started and never stopped
  const open = new Map();
  for (const e of ev) {
    if (e.event === 'SubagentStart' && e.agent_id) open.set(e.agent_id, e);
    if (e.event === 'SubagentStop' && e.agent_id) open.delete(e.agent_id);
  }
  const ended = ['closed', 'cancelled', 'abandoned'].includes(status);
  const orphans = [...open.values()].filter((s) => ended || hours(s.ts, now) * 60 >= L.orphan_agent_minutes);
  if (orphans.length) out.push(f({ rule: 'R15.orphaned_agents', class: 'gap', severity: 'low', subject: id, job: id, latest: latest(orphans), summary: `${orphans.length} agent(s) in ${id} started and never reported stopping${ended ? ` before the job ${status}` : ` within ${L.orphan_agent_minutes} min`}: ${orphans.slice(0, 4).map((s) => `${s.agent_type || 'agent'} since ${s.ts}`).join(', ')}.`, evidence: orphans.slice(0, 6).map((s) => s.agent_id), question: 'Did these agents crash or time out? Were their results lost?' }));
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
  const intentParks = clarify.filter((e) => e.ok === false && e.detail.intent_open);
  if (intentParks.length) out.push(f({ rule: 'R19.intent_parked', class: 'ambiguity', severity: 'medium', subject: id, job: id, latest: latest(intentParks, 'at'), summary: `${id} parked ${intentParks.length} time(s) because the intent was still unclear after ${Math.max(...intentParks.map((e) => e.detail.intent_rounds || 0))} intent round(s).`, question: 'Was the request too vague to start, or were the intent questions badly put?' }));
  const dropped = clarify.reduce((n, e) => n + (Number(e.detail.dropped) || 0), 0);
  if (dropped >= L.questions_dropped_per_job) out.push(f({ rule: 'R19.question_overrun', class: 'ambiguity', severity: 'low', subject: id, job: id, latest: latest(clarify.filter((e) => e.detail.dropped), 'at'), summary: `Clarify in ${id} proposed ${dropped} question(s) beyond the round budget or already asked; the CLI dropped them (limit ${L.questions_dropped_per_job}).`, question: 'Does the judge ignore the question budget or the never-re-ask list in its brief?' }));
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

module.exports = { AGENT_FAILED, inspectJob, inspectGlobal, jobHealth, factoryHealth, seals, intendedRecipe, conformance, gates, evidenceChain, loops, driverFidelity, consistency, friction, expectationsFor };
