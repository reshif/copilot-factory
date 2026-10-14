'use strict';
// Runs a workflows/*.js script outside Claude Code, the way the workflow runtime does:
// top-level await and return, globals args/agent/pipeline/phase/log, no fs or shell.
const fs = require('fs');

function load(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/^export const meta =/m, 'const meta =');
  // eslint-disable-next-line no-new-func
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('args', 'agent', 'pipeline', 'phase', 'log', 'Date', 'Math', src);
}

function mathNoRandom() {
  const m = {};
  for (const k of Object.getOwnPropertyNames(Math)) m[k] = Math[k];
  m.random = () => {
    throw new Error('Math.random is not allowed in workflows');
  };
  return m;
}

async function run(file, args, agentImpl) {
  const fn = load(file);
  const calls = [];
  const agentsDir = require('path').join(__dirname, '..', '..', 'agents');
  const agent = async (prompt, opts) => {
    const t = opts && opts.agentType;
    const m = /^factory:([a-z-]+)$/.exec(t || '');
    if (!m || !fs.existsSync(require('path').join(agentsDir, `${m[1]}.md`))) {
      throw new Error(`agent() called without a real factory agentType (got ${JSON.stringify(t)}) for "${opts && opts.label}"`);
    }
    calls.push({ prompt, opts });
    return agentImpl(prompt, opts, calls.length);
  };
  const pipeline = async (items, f) => Promise.all(items.map((it) => f(it)));
  const forbidden = new Proxy({}, { get: () => () => { throw new Error('Date/Math.random are not allowed in workflows'); } });
  const result = await fn(typeof args === 'string' ? args : JSON.stringify(args), agent, pipeline, () => {}, () => {}, forbidden, mathNoRandom());
  return { result, calls };
}

module.exports = { run, load };
