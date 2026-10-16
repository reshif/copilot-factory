'use strict';
// The shared loop engine (0.9.0 "loops, not parks"). Every loop that sends work back to an agent
// (clarify's writer ⇄ God Eye, the review-fix, verify-fix and re-verify rounds, the integrator)
// stops on progress, not on a count:
//
//   - each round's open blockers are fingerprinted (check + ref, or the caller's own key);
//   - the loop continues while the open set shrinks (fewer than the fewest seen so far);
//   - after `stall_rounds` (2) rounds without shrinking it escalates: first the agent runs on a
//     stronger model (policy loops.escalate_model, through the existing model fallback: a model
//     the CLI refuses is spawned again without --model), then a diagnosis agent writes the
//     specific question, its options and a recommendation (or a different approach the next
//     round takes);
//   - one more round without progress after the diagnosis stops the loop, and only then does the
//     caller ask the human: with the diagnosis's question, never a bare "resume";
//   - a hard ceiling per loop (policy) stops it whatever the progress (diagnosis first, then stop);
//     the job's agent-run budget stays the absolute ceiling over every loop.
//
// Contract (the 0.10.0 local stop helpers swap to it):
//
//   shouldContinue(loopState, blockers, policy) -> { action, rule, round, open, closed, added,
//                                                   escalation, model, state }
//     loopState  the state returned by the previous call (null or {} for a new loop). Plain JSON:
//                the caller stores it (state.loops[name], clarify.json writer_loop) as it is.
//     blockers   this round's open blockers: objects ({check, ref, …} or {key}) or strings. An
//                empty list means the loop is done.
//     policy     { ceiling, stall_rounds, escalate_model, diagnose } — see policyFor(); a missing
//                key takes the default (ceiling 5, stall_rounds 2, escalate_model "opus",
//                diagnose true).
//   action      'done'      nothing is open: the loop ends well;
//               'continue'  run the next round (on `model` when the loop has escalated);
//               'escalate'  run the next round on the stronger `model` (escalation "model");
//               'diagnose'  run the diagnosis agent first (escalation "diagnosis"); record its
//                           answer with recordDiagnosis(), then call shouldContinue again with
//                           the same blockers: it returns 'stop' (when `then_stop`) or the next
//                           round with the diagnosis's approach;
//               'stop'      the loop is over without converging: ask the human the diagnosis's
//                           question (question(state) builds it), never a bare "resume".
//   rule        why: first_round | progress | stalled | escalate_model | diagnose | no_progress
//               | ceiling | resolved.
//   The same blockers passed again while a diagnosis is pending do not count a new round.
//
// Pure functions: no I/O, no clock other than the `at` stamps in the history.

const DEFAULTS = { ceiling: 5, stall_rounds: 2, escalate_model: 'opus', diagnose: true };

// A blocker's fingerprint: its check and what it points at (case-insensitive), or the caller's key.
function keyOf(b) {
  if (b === null || b === undefined) return '';
  if (typeof b === 'string') return b.trim();
  if (b.key) return String(b.key).trim();
  const ref = String(b.ref || b.file || b.ac || '').trim().toUpperCase();
  return `${b.check || b.kind || b.rule || 'blocker'}|${ref}${b.extra ? `|${b.extra}` : ''}`;
}

function keys(blockers) {
  return [...new Set((blockers || []).map(keyOf).filter(Boolean))].sort();
}

function policyFor(pol = {}, overrides = {}) {
  const loops = (pol && pol.loops) || {};
  const num = (v, d) => (typeof v === 'number' && v > 0 ? Math.floor(v) : d);
  return {
    ceiling: num(overrides.ceiling, num(loops.ceiling, DEFAULTS.ceiling)),
    stall_rounds: num(overrides.stall_rounds, num(loops.stall_rounds, DEFAULTS.stall_rounds)),
    escalate_model: overrides.escalate_model !== undefined ? overrides.escalate_model : typeof loops.escalate_model === 'string' || loops.escalate_model === null ? loops.escalate_model : DEFAULTS.escalate_model,
    diagnose: overrides.diagnose !== undefined ? overrides.diagnose !== false : loops.diagnose !== false,
  };
}

// The diagnosis workflow failed before it recorded anything: record a diagnosis that asks the
// human (needs_user), so the loop stops with a question instead of asking for a diagnosis forever.
function fallbackDiagnosis(root, jobId, name, cause) {
  const job = require('./job');
  job.mutate(root, jobId, (state) => {
    const l = state.loops && state.loops[name];
    if (!l || !l.pending || l.pending.kind !== 'diagnosis' || l.diagnosis) return;
    state.loops[name] = { ...recordDiagnosis(l, { cause, needs_user: true, question: null }), segments: l.segments || 0 };
  });
}

function fresh() {
  return { rounds: 0, best: null, stalls: 0, level: 0, last: null, history: [], diagnosis: null, pending: null, stopped: null };
}

// level: 0 the agent's own model, 1 the stronger model, 2 diagnosed (approach given), 3 stopped
function shouldContinue(loopState, blockers, policy) {
  const P = policyFor({}, policy || {});
  const s = { ...fresh(), ...(loopState || {}) };
  s.history = [...(s.history || [])];
  const open = keys(blockers);
  const last = s.last || [];
  const closed = last.filter((k) => !open.includes(k));
  const added = open.filter((k) => !last.includes(k));
  const model = s.level >= 1 && P.escalate_model ? P.escalate_model : null;
  const out = (action, rule, extra = {}) => ({ action, rule, round: s.rounds, open, closed, added, escalation: null, model, ...extra, state: s });

  if (!open.length) {
    // resolved: the next time this loop has blockers it starts from the beginning (a loop that
    // once stopped or escalated does not stay stopped)
    return { ...out('done', 'resolved'), state: { ...fresh(), ...(s.segments ? { segments: s.segments } : {}) } };
  }
  // a diagnosis is pending: the same observation again is not a new round
  if (s.pending) {
    if (s.pending.kind === 'diagnosis' && !s.diagnosis) return out('diagnose', s.pending.rule, { escalation: 'diagnosis' });
    const p = s.pending;
    s.pending = null;
    if (p.then_stop || (s.diagnosis && s.diagnosis.needs_user)) {
      // the ceiling stays the reason when it was; otherwise the loop made no progress
      const rule = p.then_stop ? p.rule : 'no_progress';
      s.level = 3;
      s.stopped = { rule, at: new Date().toISOString(), round: s.rounds };
      return out('stop', rule);
    }
    // the diagnosis gave the agent a different approach: one more round with it
    s.level = 2;
    s.stalls = 0;
    s.rounds += 1;
    s.history.push({ round: s.rounds, open, at: new Date().toISOString(), note: 'after diagnosis' });
    s.history = s.history.slice(-20);
    return out('continue', 'diagnosed', { approach: (s.diagnosis && s.diagnosis.approach) || null, model: P.escalate_model || null });
  }
  if (s.level >= 3) return out('stop', (s.stopped && s.stopped.rule) || 'no_progress');

  const first = s.best === null;
  // progress is by count: fewer open blockers than the best so far, even if they are new ones
  // (a smaller, different set counts). The ceiling bounds the rounds either way, so every loop ends.
  const progress = first || open.length < s.best;
  const stop = (rule) => {
    if (P.diagnose && !s.diagnosis) {
      s.pending = { kind: 'diagnosis', rule, then_stop: true };
      return out('diagnose', rule, { escalation: 'diagnosis' });
    }
    s.level = 3;
    s.stopped = { rule, at: new Date().toISOString(), round: s.rounds };
    return out('stop', rule);
  };
  // the hard ceiling: rounds already run
  if (s.rounds >= P.ceiling) {
    s.last = open;
    return stop('ceiling');
  }
  if (progress) {
    s.best = open.length;
    s.stalls = 0;
  } else s.stalls += 1;
  s.last = open;
  let action = 'continue';
  let rule = first ? 'first_round' : progress ? 'progress' : 'stalled';
  let escalation = null;
  if (!progress) {
    if (s.level === 0 && s.stalls >= P.stall_rounds) {
      if (P.escalate_model) {
        s.level = 1;
        s.stalls = 0;
        action = 'escalate';
        rule = 'escalate_model';
        escalation = 'model';
      } else if (P.diagnose && !s.diagnosis) {
        s.pending = { kind: 'diagnosis', rule: 'diagnose', then_stop: false };
        return out('diagnose', 'diagnose', { escalation: 'diagnosis' });
      } else return stop('no_progress');
    } else if (s.level === 1 && s.stalls >= 1) {
      if (P.diagnose && !s.diagnosis) {
        s.pending = { kind: 'diagnosis', rule: 'diagnose', then_stop: false };
        return out('diagnose', 'diagnose', { escalation: 'diagnosis' });
      }
      return stop('no_progress');
    } else if (s.level === 2 && s.stalls >= 1) return stop('no_progress');
  }
  s.rounds += 1;
  s.history.push({ round: s.rounds, open, at: new Date().toISOString(), rule });
  s.history = s.history.slice(-20);
  const m = s.level >= 1 && P.escalate_model ? P.escalate_model : null;
  return out(action, rule, { escalation, model: m, round: s.rounds });
}

// The diagnosis agent's answer: { cause, needs_user, approach, question, options, recommendation }.
function recordDiagnosis(loopState, d) {
  const s = { ...fresh(), ...(loopState || {}) };
  const clip = (x, n = 400) => String(x === undefined || x === null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
  const opts = (Array.isArray(d && d.options) ? d.options : []).slice(0, 5).map((o, i) => ({ key: String((o && o.key) || 'abcde'[i]).toLowerCase().slice(0, 2), text: clip(typeof o === 'string' ? o : o && o.text, 240), consequences: clip(o && o.consequences, 240) })).filter((o) => o.text);
  const rec = clip(d && d.recommendation, 60).toLowerCase();
  s.diagnosis = {
    at: new Date().toISOString(),
    cause: clip(d && d.cause, 600),
    needs_user: Boolean(d && d.needs_user),
    approach: clip(d && d.approach, 600) || null,
    question: clip(d && d.question, 400) || null,
    options: opts,
    recommendation: opts.find((o) => o.key === rec || o.text.toLowerCase() === rec) ? (opts.find((o) => o.key === rec) || opts.find((o) => o.text.toLowerCase() === rec)).key : null,
    by: (d && d.by) || 'agent',
  };
  if (!s.pending) s.pending = { kind: 'diagnosed', rule: 'diagnose', then_stop: s.diagnosis.needs_user };
  else s.pending = { ...s.pending, kind: 'diagnosed' };
  return s;
}

// The specific question a stopped loop asks the human: the diagnosis's, or one built from the
// blockers when no diagnosis could run. Always names the blockers, the options and a recommendation.
function question(loopState, { what, blockers = [], fallbackOptions = [], fallbackRecommendation = null } = {}) {
  const s = loopState || {};
  const d = s.diagnosis || null;
  const rule = (s.stopped && s.stopped.rule) || (s.pending && s.pending.rule) || 'no_progress';
  const why = rule === 'ceiling' ? `it reached its ceiling of rounds (${s.rounds})` : `${s.rounds} round(s) left the same ${blockers.length || (s.last || []).length} problem(s) open, also on a stronger model${d ? ' and after a diagnosis' : ''}`;
  const options = d && d.options.length ? d.options : fallbackOptions.map((o, i) => ({ key: 'abcde'[i], text: o.text || o, consequences: o.consequences || '' }));
  const recommendation = d && d.recommendation ? d.recommendation : fallbackRecommendation;
  const q = (d && d.question) || `How should ${what || 'this loop'} go on?`;
  const lines = [`${what ? `${what}: ` : ''}stopped because ${why}.${d && d.cause ? ` Diagnosis: ${d.cause}` : ''}`, `Question: ${q}`];
  for (const o of options) lines.push(`  ${o.key}) ${o.text}${o.key === recommendation ? ' (recommended)' : ''}${o.consequences ? ` — ${o.consequences}` : ''}`);
  lines.push('Reply with your answer in your own words (it resumes the job with them), or one of the exact replies listed.');
  return { rule, question: q, options, recommendation, cause: d ? d.cause : null, text: lines.join('\n'), diagnosed: Boolean(d) };
}

module.exports = { shouldContinue, recordDiagnosis, question, keyOf, keys, policyFor, fresh, DEFAULTS, fallbackDiagnosis };
