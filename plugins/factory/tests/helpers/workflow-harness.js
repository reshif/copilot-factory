'use strict';
// Runs a workflows/*.js script outside Claude Code, the way the workflow runtime does:
// top-level await and return, globals args/agent/pipeline/phase/log, no fs or shell.
const fs = require('fs');

function load(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/^export const meta =/m, 'const meta =');
  // eslint-disable-next-line no-new-func
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('args', 'agent', 'pipeline', 'phase', 'log', 'factory', 'Date', 'Math', src);
}

function mathNoRandom() {
  const m = {};
  for (const k of Object.getOwnPropertyNames(Math)) m[k] = Math[k];
  m.random = () => {
    throw new Error('Math.random is not allowed in workflows');
  };
  return m;
}

// `factory` stands in for the runner's deterministic steps (cli/core/runner.js workflowApi):
// tests pass their own ({ verify(id) }), or, for a brief with a project root, verify runs the
// real `task verify` in-process.
function realFactory(brief) {
  const tasks = require('../../cli/core/tasks');
  return {
    verify: async (id) => {
      try {
        return tasks.verify(brief.root, brief.job, id);
      } catch (e) {
        return { task: id, pass: false, error: { code: e.code || 'internal', message: e.message } };
      }
    },
    integrate: async (ids, wave) => {
      try {
        return require('../../cli/core/reconcile').integrateWave(brief.root, brief.job, ids, { wave });
      } catch (e) {
        return { ok: false, kind: 'error', message: e.message, route: {} };
      }
    },
    fetchDeps: async (specs) => {
      try {
        return require('../../cli/core/deps').fetch(brief.root, { jobId: brief.job, add: specs || [] });
      } catch (e) {
        return { packages: [], error: e.message };
      }
    },
    checkLedger: async (entries) => {
      const D = require('../../cli/core/deps');
      const state = require('../../cli/core/job').load(brief.root, brief.job);
      const r = D.checkLedger(brief.root, state, JSON.parse(JSON.stringify(entries || [])));
      return { ok: !r.rejected.length, verified: r.verified.length, rejected: r.rejected.map((x) => ({ probe: x.entry && x.entry.probe, symbol: x.entry && x.entry.symbol, file: x.entry && x.entry.file, line: x.entry && x.entry.line, why: x.why })) };
    },
    probe: async () => {
      try {
        return require('../../cli/core/probe').run(brief.root, { jobId: brief.job });
      } catch (e) {
        return { ok: false, problems: [e.message], commands: [] };
      }
    },
    grant: async (id, paths) => {
      try {
        return require('../../cli/core/tasks').grant(brief.root, brief.job, id, paths);
      } catch (e) {
        return { ok: false, granted: [], refused: (paths || []).map((p) => ({ path: p, why: e.message })) };
      }
    },
    prepare: async (id) => {
      const job = require('../../cli/core/job');
      const state = job.load(brief.root, brief.job);
      const r = require('../../cli/core/environment').ensure(brief.root, state, { taskId: id, wt: tasks.prepareWorktree(brief.root, state, id) });
      return { task: id, ok: r.ok, ...(r.ok ? {} : { broken: r.broken }) };
    },
  };
}

async function run(file, args, agentImpl, factoryImpl) {
  const fn = load(file);
  const calls = [];
  const agentsDir = require('path').join(__dirname, '..', '..', 'agents');
  const agent = async (prompt, opts) => {
    const t = opts && opts.agentType;
    const m = /^factory:([a-z-]+)$/.exec(t || '');
    if (!m || !fs.existsSync(require('path').join(agentsDir, `${m[1]}.agent.md`))) {
      throw new Error(`agent() called without a real factory agentType (got ${JSON.stringify(t)}) for "${opts && opts.label}"`);
    }
    calls.push({ prompt, opts });
    const startedAt = new Date().toISOString();
    const r = await agentImpl(prompt, opts, calls.length);
    // As factory run does: a task builder's reply is recorded for task verify (tasks.afterBuilder).
    const brief = typeof args === 'string' ? JSON.parse(args) : args;
    const bt = brief && brief.workflow === 'realize' && brief.root && /^build (\S+)/.exec((opts && opts.label) || '');
    if (bt) return require('../../cli/core/tasks').afterBuilder(brief.root, brief.job, bt[1], r, { startedAt, label: opts.label });
    return r;
  };
  const pipeline = async (items, f) => Promise.all(items.map((it) => f(it)));
  const forbidden = new Proxy({}, { get: () => () => { throw new Error('Date/Math.random are not allowed in workflows'); } });
  const brief0 = typeof args === 'string' ? JSON.parse(args) : args;
  const verifies = [];
  const base = factoryImpl || (brief0 && brief0.root ? realFactory(brief0) : {});
  const factory = { ...base, verify: async (id) => { verifies.push(id); if (!base.verify) throw new Error('this test gives realize no factory.verify'); return base.verify(id); } };
  const result = await fn(typeof args === 'string' ? args : JSON.stringify(args), agent, pipeline, () => {}, () => {}, factory, forbidden, mathNoRandom());
  calls.verifies = verifies;
  return { result, calls };
}

module.exports = { run, load };
