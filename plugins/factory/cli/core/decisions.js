'use strict';
// Decision records: one line per routing decision, in .factory/log/decisions.jsonl.
// `factory why` renders a job's path from these.

const { appendJsonl, readJsonl, nowIso } = require('../lib/util');
const { project } = require('../lib/paths');
const { seal, valid } = require('../lib/seal');

function write(root, record) {
  const r = seal({ ts: nowIso(), ...record });
  appendJsonl(project(root).decisionsFile, r);
  return r;
}

function forJob(root, jobId) {
  return readJsonl(project(root).decisionsFile).filter((r) => valid(r) && (!jobId || r.job === jobId));
}

function all(root) {
  return readJsonl(project(root).decisionsFile).filter(valid);
}

module.exports = { write, forJob, all };
