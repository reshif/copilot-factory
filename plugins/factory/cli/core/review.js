'use strict';
// challenge records. The CLI, not the reviewers, decides each lane's verdict:
// a lane passes when it has no blocker/major finding that was confirmed or left unverified.
// Convergence rules (from round 2): a new major in code unchanged since the last
// round becomes a minor follow-up; a broken pack rule is minor; a broken lesson is a finding.

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

function sameFinding(a, b) {
  return a.file === b.file && String(a.summary || '').toLowerCase() === String(b.summary || '').toLowerCase();
}

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

  const previous = isPostMerge || isEpic ? null : ledger.lastStep(root, state.id, step);
  const round = previous && previous.bound && previous.bound.fingerprint !== ctx.b.fingerprint ? (previous.detail.round || 1) + 1 : (previous && previous.detail.round) || 1;
  const commit = state.branch ? git.revParse(root, state.branch) : null;
  let unchanged = null;
  if (previous && previous.detail && previous.detail.commit && commit && round >= 2) {
    const changed = new Set(git.changedFiles(root, previous.detail.commit, commit));
    unchanged = (f) => f && !changed.has(f);
  }

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
      const prevFindings = (previous && previous.detail && previous.detail.findings) || [];
      const isNew = !prevFindings.some((p) => sameFinding(p, f));
      if (unchanged && isNew && f.severity !== 'minor' && unchanged(f.file) && !(raw.rule && /^lesson:/.test(raw.rule))) {
        f.notes.push(`downgraded from ${f.severity}: new in round ${round} on code unchanged since the last round`);
        f.severity = 'minor';
      }
      if (['blocker', 'major'].includes(f.severity)) {
        const v = verifications[f.id];
        f.status = v && ['confirmed', 'refuted'].includes(v.status) ? v.status : 'unverified';
        if (v && v.reason) f.verification = v.reason;
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
  };
}

module.exports = { record, requiredLanes };
