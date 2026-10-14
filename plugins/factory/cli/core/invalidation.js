'use strict';
// Current bindings for a job. A recorded step is fresh only while the binding it
// was recorded against still matches; anything else is stale and must be redone.
//
//   contract    hash of contract.md + work type + risk
//   findings    hash of findings.md
//   design      combined hash of the design record (ADR(s), no-adr, threat model, epic contracts)
//   plan        hash of plan.json (slices.json for an epic)
//   fingerprint git tree of the job branch (what was actually built)
//   children    hash of every child job's merge commit (epic only)

const fs = require('fs');
const path = require('path');
const { hashFile, hashFiles, sha256, exists } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const git = require('../lib/git');
const contract = require('./contract');

function designFiles(root, jobId) {
  const jp = jobPaths(root, jobId);
  if (!exists(jp.dir)) return [];
  const adrs = fs
    .readdirSync(jp.dir)
    .filter((f) => /^adr-\d+.*\.md$/.test(f))
    .map((f) => path.join(jp.dir, f));
  return [...adrs, jp.noAdr, jp.recommendation, jp.threatModel, jp.contractsMd, jp.contractsJson].filter(exists);
}

function hasAdr(root, jobId) {
  return designFiles(root, jobId).some((f) => /\/adr-\d+.*\.md$/.test(f.replace(/\\/g, '/')));
}

function fingerprint(root, state) {
  if (!state.branch) return null;
  try {
    return git.fingerprint(root, state.branch);
  } catch {
    return null;
  }
}

function childrenHash(root, state, loadJob) {
  if (!state.children || !state.children.length) return null;
  const parts = state.children.map((c) => {
    try {
      const s = loadJob(root, c);
      return `${c}:${(s.pr && s.pr.merge_commit) || '-'}:${s.status}`;
    } catch {
      return `${c}:missing`;
    }
  });
  return sha256(parts.sort().join('\n'));
}

function current(root, state, loadJob) {
  const jp = jobPaths(root, state.id);
  const files = designFiles(root, state.id);
  return {
    contract: contract.hash(root, state),
    findings: hashFile(jp.findings),
    design: files.length ? hashFiles(files) : null,
    plan: state.epic ? hashFile(jp.slices) : hashFile(jp.plan),
    fingerprint: fingerprint(root, state),
    children: loadJob ? childrenHash(root, state, loadJob) : null,
  };
}

module.exports = { current, designFiles, hasAdr, fingerprint, childrenHash };
