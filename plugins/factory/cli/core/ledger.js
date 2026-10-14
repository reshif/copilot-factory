'use strict';
// Append-only evidence ledger per job. Every completed step and every piece of
// AC evidence is recorded here with the hash or fingerprint it is bound to.

const { appendJsonl, readJsonl, nowIso } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const { seal, valid } = require('../lib/seal');

// Entries are sealed; a line appended by hand has no valid seal and is ignored.
function append(root, jobId, entry) {
  const e = seal({ at: nowIso(), job: jobId, ...entry });
  appendJsonl(jobPaths(root, jobId).ledger, e);
  return e;
}

function all(root, jobId) {
  return readJsonl(jobPaths(root, jobId).ledger).filter((e) => valid(e) && e.job === jobId);
}

function steps(root, jobId, step) {
  return all(root, jobId).filter((e) => e.kind === 'step' && e.step === step);
}

function lastStep(root, jobId, step) {
  const s = steps(root, jobId, step);
  return s.length ? s[s.length - 1] : null;
}

// The most recent successful record of `step` whose binding still matches `bound`
// (every key given in `bound` must be equal). Returns null when stale or absent.
function freshStep(root, jobId, step, bound = {}) {
  const s = steps(root, jobId, step).filter((e) => e.ok);
  for (let i = s.length - 1; i >= 0; i--) {
    const b = s[i].bound || {};
    if (Object.entries(bound).every(([k, v]) => b[k] === v)) return s[i];
  }
  return null;
}

function stepStatus(root, jobId, step, bound = {}) {
  const last = lastStep(root, jobId, step);
  if (!last) return 'never';
  if (freshStep(root, jobId, step, bound)) return 'fresh';
  return last.ok ? 'stale' : 'failed';
}

function evidence(root, jobId, fingerprint) {
  return all(root, jobId).filter((e) => e.kind === 'evidence' && (!fingerprint || e.fingerprint === fingerprint));
}

module.exports = { append, all, steps, lastStep, freshStep, stepStatus, evidence };
