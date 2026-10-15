'use strict';
// challenge records. The CLI, not the reviewers, decides each lane's verdict:
// a lane passes when it has no blocker/major finding that was confirmed or left unverified
// (no verifier result, or the verifier's verdict "unverifiable").
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
// A serious finding stops blocking when a verifier refutes it, or when the human settles a
// carried unverified one (`factory finding accept|dismiss`): accepted (a known risk that
// ships) or dismissed (not a problem).
const SETTLED_BY_HUMAN = ['accepted', 'dismissed'];
const NOT_BLOCKING = ['refuted', ...SETTLED_BY_HUMAN];

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

  // Verdicts on findings carried from an earlier round come marked `carried` (finding ids
  // repeat across rounds: this round's code-1 need not be the carried code-1).
  const verifications = Object.fromEntries((payload.verifications || []).filter((v) => !v.carried).map((v) => [v.finding_id, v]));
  const carriedVerdicts = Object.fromEntries((payload.verifications || []).filter((v) => v.carried).map((v) => [v.finding_id, v]));
  // Serious findings the last round left unverified (verifier timeout, "unverifiable"): kept
  // until a verifier settles them, whether or not a reviewer raises them again.
  const open = isPostMerge || isEpic ? [] : openUnverified(previous);
  // Findings the human accepted or dismissed in an earlier round stay settled if raised again.
  const humanSettled = earlier.flatMap((e) => ((e.detail && e.detail.findings) || []).filter((p) => SETTLED_BY_HUMAN.includes(p.status)));
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
        // The verifier's own "unverifiable" (or no result at all) leaves the finding unverified:
        // it keeps blocking and the review runs again.
        f.status = v && ['confirmed', 'refuted'].includes(v.status) ? v.status : was ? 'confirmed' : 'unverified';
        const byHuman = f.status === 'unverified' && humanSettled.find((p) => sameFinding(p, f));
        if (byHuman) {
          f.status = byHuman.status;
          f.settled = byHuman.settled;
          f.notes.push(`${byHuman.status} by you earlier (${byHuman.id}): ${(byHuman.settled && byHuman.settled.reason) || ''}`.trim());
        }
        if (v && v.status) f.verifier_status = String(v.status);
        if (v && v.status === 'unverifiable') f.notes.push('the verifier could not settle it either way; it keeps blocking');
        if (v && v.reason) f.verification = v.reason;
        if (v && v.evidence) f.verification_evidence = String(v.evidence).slice(0, 2000);
        else if (was && !v) f.verification = `confirmed in round ${was.round}; found again`;
      } else {
        f.status = 'minor';
      }
      findings.push(f);
    }
    const blocking = findings.filter((f) => f.lane === lane.lane && ['blocker', 'major'].includes(f.severity) && !NOT_BLOCKING.includes(f.status));
    lanes[lane.lane] = blocking.length ? 'changes' : 'pass';
  }
  // Carry what was left open. Raised again this round (same finding): this round's copy stands,
  // settled by its own verdict or the carried one's. Not raised again: carried as it was.
  for (const p of open) {
    const v = carriedVerdicts[p.id];
    const again = findings.find((f) => ['blocker', 'major'].includes(f.severity) && sameFinding(p, f));
    if (again) {
      if (again.status === 'unverified' && v && ['confirmed', 'refuted'].includes(v.status)) {
        again.status = v.status;
        again.verifier_status = String(v.status);
        if (v.reason) again.verification = v.reason;
      }
      again.notes.push(`left unverified in round ${p.carried ? p.carried.from_round : p.round} as ${p.id}; raised again`);
      continue;
    }
    // Finding ids restart each round: a new finding may already use this one's id.
    const id = findings.some((f) => f.id === p.id) ? `${p.id.replace(/@r\d+$/, '')}@r${p.carried ? p.carried.from_round : p.round}` : p.id;
    const c = { id, lane: p.lane, severity: p.severity, file: p.file || null, line: p.line || null, summary: p.summary || '', rule: p.rule || null, notes: [...(p.notes || []).filter((n) => !/^carried/.test(n))] };
    c.carried = { from_round: p.carried ? p.carried.from_round : p.round, times: ((p.carried && p.carried.times) || 0) + 1 };
    c.status = v && ['confirmed', 'refuted'].includes(v.status) ? v.status : 'unverified';
    if (v && v.status) c.verifier_status = String(v.status);
    if (v && v.reason) c.verification = v.reason;
    if (v && v.evidence) c.verification_evidence = String(v.evidence).slice(0, 2000);
    c.notes.push(c.status === 'unverified' ? `carried: unverified since round ${c.carried.from_round}; it keeps blocking until a verifier settles it` : `carried from round ${c.carried.from_round}; re-verified: ${c.status}`);
    findings.push(c);
    if (c.status !== 'refuted') lanes[c.lane] = 'changes';
    else if (!lanes[c.lane]) lanes[c.lane] = 'pass';
  }
  const missing = required.filter((l) => !lanes[l]);
  const anyUnverified = findings.some((f) => ['blocker', 'major'].includes(f.severity) && f.status === 'unverified');
  const ok = missing.length === 0 && required.every((l) => lanes[l] === 'pass') && !anyUnverified;
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
    ...(unverified.some((f) => f.carried) ? { carried: unverified.filter((f) => f.carried).map((f) => ({ id: f.id, from_round: f.carried.from_round, times: f.carried.times })) } : {}),
    minor: findings.filter((f) => f.severity === 'minor').length,
    ...(findings.some((f) => f.regression) ? { regressions: findings.filter((f) => f.regression).map((f) => `${f.id} [${f.severity}] ${f.file || ''}${f.line ? `:${f.line}` : ''} was ${f.regression.id} (confirmed in round ${f.regression.round})`) } : {}),
  };
}

// The human settles a serious finding the last review left unverified: "accepted" (a known
// risk; it ships and the completion report says so) or "dismissed" (not a problem). Recorded
// as a ledger entry, and the review record is re-recorded with the finding settled and the
// verdicts recomputed, so ship, H4 and close no longer wait on it and it is never carried.
function settle(root, { jobId, id, decision, reason, channel }) {
  const state = job.resolve(root, jobId);
  const status = decision === 'accept' ? 'accepted' : decision === 'dismiss' ? 'dismissed' : null;
  if (!status) fail('finding accept|dismiss <id> --reason "…"', 'bad_input');
  const last = ledger.lastStep(root, state.id, 'challenge');
  const open = openUnverified(last);
  const want = String(id || '').trim();
  const f = open.find((x) => x.id === want) || open.find((x) => x.id.toLowerCase() === want.toLowerCase());
  if (!f) fail(`${want || '(no id)'} is not an open unverified finding of ${state.id}${open.length ? `; open: ${open.map((x) => x.id).join(', ')}` : ' (none is open)'}.`, 'bad_input', { open: open.map((x) => x.id) });
  const settled = { by: 'human', decision: status, reason: String(reason || '').trim(), channel, at: nowIso() };
  const findings = last.detail.findings.map((x) => (x.id === f.id && x.status === 'unverified' ? { ...x, status, settled, notes: [...(x.notes || []), `${status} by you: ${settled.reason}`] } : x));
  const lanes = { ...last.detail.lanes };
  for (const lane of Object.keys(lanes)) lanes[lane] = findings.some((x) => x.lane === lane && ['blocker', 'major'].includes(x.severity) && !NOT_BLOCKING.includes(x.status)) ? 'changes' : 'pass';
  const missing = last.detail.missing || [];
  const required = last.detail.required || Object.keys(lanes);
  const ok = missing.length === 0 && required.every((l) => lanes[l] === 'pass') && !findings.some((x) => ['blocker', 'major'].includes(x.severity) && x.status === 'unverified');
  ledger.append(root, state.id, { kind: 'finding', finding: f.id, decision: status, reason: settled.reason, channel, round: last.detail.round || 1, lane: f.lane, severity: f.severity, file: f.file || null, line: f.line || null, summary: f.summary });
  ledger.append(root, state.id, { kind: 'step', step: last.step, ok, bound: last.bound, detail: { ...last.detail, lanes, findings, settled_by_human: [...((last.detail && last.detail.settled_by_human) || []), f.id] } });
  return { job: state.id, finding: f.id, status, ok, still_open: findings.filter((x) => ['blocker', 'major'].includes(x.severity) && x.status === 'unverified').map((x) => x.id) };
}

// The serious findings a challenge record left unverified (open until a verifier settles them).
function openUnverified(rec) {
  const fs = (rec && rec.detail && rec.detail.findings) || [];
  return fs.filter((f) => ['blocker', 'major'].includes(f.severity) && f.status === 'unverified').map((f) => ({ ...f, round: (rec.detail && rec.detail.round) || 1 }));
}

module.exports = { record, requiredLanes, openUnverified, settle, SETTLED_BY_HUMAN, NOT_BLOCKING };
