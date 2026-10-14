'use strict';
// challenge records. The CLI, not the reviewers, decides each lane's verdict:
// a lane passes when it has no blocker/major finding that was confirmed or left unverified.
// Convergence rules (from round 2): a new major in code no commit touched since the last
// round becomes a minor follow-up; a broken pack rule is minor; a broken lesson is a finding.
// A finding confirmed in any earlier round and found again is a regression: it keeps at least
// its old severity and blocks (confirmed unless the verifier refutes it now).

const path = require('path');
const { writeJson, nowIso, fail } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const git = require('../lib/git');
const job = require('./job');
const steps = require('./steps');
const ledger = require('./ledger');
const floors = require('./floors');

const SEVERITIES = ['blocker', 'major', 'minor'];

function requiredLanes(ctx, stepLanes) {
  const { state } = ctx;
  let lanes = [...(state.policy.required_lanes[state.risk] || ['code'])];
  for (const l of stepLanes || []) {
    if (l === 'all') lanes.push(...floors.allLanes(ctx));
    else lanes.push(l);
  }
  if (floors.uiChanged(ctx) && state.risk === 'high') lanes.push('ux');
  return [...new Set(lanes)];
}

// The same finding across rounds: same file and (same lane and rule, or a line within ±10,
// or the same summary). Reviewers reword summaries; they rarely move a bug to another file.
function sameFinding(a, b) {
  if (!a.file || a.file !== b.file) return false;
  if (a.lane && a.lane === b.lane && a.rule && a.rule === b.rule) return true;
  if (a.line && b.line && Math.abs(Number(a.line) - Number(b.line)) <= 10) return true;
  return String(a.summary || '').toLowerCase() === String(b.summary || '').toLowerCase();
}

const rank = (s) => SEVERITIES.indexOf(s); // lower is more severe

function record(root, { jobId, payload, step = 'challenge' }) {
  const state = job.resolve(root, jobId);
  const ctx = steps.context(root, state, job.load);
  const isEpic = Boolean(state.epic);
  const isPostMerge = step === 'post_merge_challenge';
  if (!isEpic && !isPostMerge && payload.fingerprint && payload.fingerprint !== ctx.b.fingerprint) {
    fail('These reviews are for an older build (the fingerprint changed). Run the review again on the current build.', 'stale');
  }
  const stepDef = ctx.recipe.steps.find((s) => s.step === step) || {};
  const required = isEpic ? ['conformance'] : isPostMerge ? stepDef.lanes || ['code', 'security'] : requiredLanes(ctx, payload.lanes_requested || stepDef.lanes);

  const earlier = isPostMerge || isEpic ? [] : ledger.steps(root, state.id, step);
  const previous = earlier.length ? earlier[earlier.length - 1] : null;
  const round = previous && previous.bound && previous.bound.fingerprint !== ctx.b.fingerprint ? (previous.detail.round || 1) + 1 : (previous && previous.detail.round) || 1;
  const commit = state.branch ? git.revParse(root, state.branch) : null;
  // "Unchanged" means no commit touched the file since the last round, not an empty net diff:
  // a fix followed by its revert is a change.
  let unchanged = null;
  if (previous && previous.detail && previous.detail.commit && commit && round >= 2) {
    const prevCommit = previous.detail.commit;
    const memo = new Map();
    unchanged = (f) => {
      if (!f) return false;
      if (!memo.has(f)) memo.set(f, !git.run(root, ['log', '--format=%H', `${prevCommit}..${commit}`, '--', f], { allowFail: true }).stdout);
      return memo.get(f);
    };
  }
  // Every finding confirmed serious in an earlier round (of this job, this step).
  const confirmedBefore = earlier
    .flatMap((e) => ((e.detail && e.detail.findings) || []).filter((p) => p.status === 'confirmed' && ['blocker', 'major'].includes(p.severity)).map((p) => ({ ...p, round: e.detail.round || 1 })))
    .filter((p) => p.round < round);
  const prevFindings = earlier.flatMap((e) => (e.detail && e.detail.findings) || []);

  const verifications = Object.fromEntries((payload.verifications || []).map((v) => [v.finding_id, v]));
  const findings = [];
  const lanes = {};
  for (const lane of payload.lanes || []) {
    let n = 0;
    for (const raw of lane.findings || []) {
      n += 1;
      const f = {
        id: raw.id || `${lane.lane}-${n}`,
        lane: lane.lane,
        severity: SEVERITIES.includes(raw.severity) ? raw.severity : 'minor',
        file: raw.file || null,
        line: raw.line || null,
        summary: raw.summary || '',
        rule: raw.rule || null,
        notes: [],
      };
      if (raw.rule && /^pack:/.test(raw.rule) && f.severity !== 'minor') {
        f.severity = 'minor';
        f.notes.push('pack rule: minor by convention');
      }
      // A finding confirmed in an earlier round that is found again is a regression: it keeps
      // at least its old severity, is never downgraded, and blocks unless refuted now.
      // A minor nit near a fixed bug is not the bug: by line alone only a serious finding
      // matches; a minor one matches by rule or summary.
      const strong = (p) => (p.rule && p.rule === f.rule && p.lane === f.lane) || String(p.summary || '').toLowerCase() === String(f.summary || '').toLowerCase();
      const was = confirmedBefore.filter((p) => sameFinding(p, f) && (f.severity !== 'minor' || strong(p))).sort((a, b) => rank(a.severity) - rank(b.severity))[0];
      if (was) {
        f.regression = { round: was.round, id: was.id, severity: was.severity };
        if (rank(was.severity) < rank(f.severity)) {
          f.notes.push(`raised from ${f.severity} to ${was.severity}: confirmed in round ${was.round} (${was.id})`);
          f.severity = was.severity;
        }
        f.notes.push(`regression: confirmed in round ${was.round} as ${was.id} and found again`);
      }
      const isNew = !prevFindings.some((p) => sameFinding(p, f));
      if (!was && unchanged && isNew && f.severity !== 'minor' && unchanged(f.file) && !(raw.rule && /^lesson:/.test(raw.rule))) {
        f.notes.push(`downgraded from ${f.severity}: new in round ${round} on code unchanged since the last round`);
        f.severity = 'minor';
      }
      if (['blocker', 'major'].includes(f.severity)) {
        const v = verifications[f.id];
        f.status = v && ['confirmed', 'refuted'].includes(v.status) ? v.status : was ? 'confirmed' : 'unverified';
        if (v && v.reason) f.verification = v.reason;
        else if (was && !v) f.verification = `confirmed in round ${was.round}; found again`;
      } else {
        f.status = 'minor';
      }
      findings.push(f);
    }
    const blocking = findings.filter((f) => f.lane === lane.lane && ['blocker', 'major'].includes(f.severity) && f.status !== 'refuted');
    lanes[lane.lane] = blocking.length ? 'changes' : 'pass';
  }
  const missing = required.filter((l) => !lanes[l]);
  const ok = missing.length === 0 && required.every((l) => lanes[l] === 'pass');
  const dir = path.join(jobPaths(root, state.id).reviewsDir, `round-${round}${isPostMerge ? '-post-merge' : ''}`);
  writeJson(path.join(dir, 'scoreboard.json'), { at: nowIso(), fingerprint: ctx.b.fingerprint, commit, required, lanes, findings, missing });
  const bound = isEpic ? { children: ctx.b.children } : isPostMerge ? {} : { fingerprint: ctx.b.fingerprint };
  ledger.append(root, state.id, { kind: 'step', step, ok, bound, detail: { round, commit, required, lanes, missing, findings } });
  const confirmed = findings.filter((f) => ['blocker', 'major'].includes(f.severity) && f.status === 'confirmed');
  const unverified = findings.filter((f) => ['blocker', 'major'].includes(f.severity) && f.status === 'unverified');
  return {
    job: state.id,
    ok,
    round,
    required,
    lanes,
    missing,
    confirmed: confirmed.map((f) => `${f.id} [${f.severity}] ${f.file || ''}${f.line ? `:${f.line}` : ''} ${f.summary}`),
    unverified: unverified.map((f) => f.id),
    minor: findings.filter((f) => f.severity === 'minor').length,
    ...(findings.some((f) => f.regression) ? { regressions: findings.filter((f) => f.regression).map((f) => `${f.id} [${f.severity}] ${f.file || ''}${f.line ? `:${f.line}` : ''} was ${f.regression.id} (confirmed in round ${f.regression.round})`) } : {}),
  };
}

module.exports = { record, requiredLanes };
