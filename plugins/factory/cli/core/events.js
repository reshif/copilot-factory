'use strict';
// The observation log: .factory/log/events.jsonl. Every factory command, every hook
// decision (guard denials, refused replies, stop blocks) and every agent/tool event,
// sealed like the ledger so an auditor can trust it. Writing never throws.

const fs = require('fs');
const path = require('path');
const { seal } = require('../lib/seal');

function append(root, rec) {
  try {
    const f = path.join(root, '.factory', 'log', 'events.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(seal({ ts: new Date().toISOString(), ...rec })) + '\n');
  } catch {
    /* observation must never break the work */
  }
}

// The job a record belongs to and the routing decision in force at that moment.
function context(root, jobId) {
  let job = jobId || null;
  let how = jobId ? 'explicit' : null;
  if (!job) {
    try {
      job = fs.readFileSync(path.join(root, '.factory', 'current'), 'utf8').trim() || null;
      how = job ? 'pointer' : null;
    } catch {
      job = null;
    }
  }
  let decision = null;
  if (job) {
    try {
      decision = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'jobs', job, 'state.json'), 'utf8')).last_decision_id || null;
    } catch {
      decision = null;
    }
  }
  return { job, how, decision_id: decision };
}

module.exports = { append, context };
