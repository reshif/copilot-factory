'use strict';
// The plan probe (0.10.0): before anyone approves a plan, show that its verify commands can run.
//
//   factory plan probe [--job J]
//
// 1. Lint every verify command: a fixed port (parallel worktrees collide), a `sleep` (a race,
//    not a wait), a background `&` (a process nothing stops).
// 2. In a scratch worktree of the base commit, set up the environment the plan's gate binds (the
//    planner's environment.proposed.json, else the confirmed one, else the repo's proposal) and
//    dry-run every verify command there, each with a time cap, the whole probe with a budget.
//    The code is not written yet, so a command is EXPECTED to fail; it must fail for the right
//    reason (no test yet, an assertion), never because the command, a third-party module,
//    settings, a database or a server is missing, and it must end on its own.
// 3. Greenfield (the environment's manifest does not exist yet): the plan needs a bootstrap task
//    (`"bootstrap": true`) that every other task depends on; setup and the dry-run wait for it
//    (realize prepares the bootstrap task's worktree without the environment).
// The scratch worktree is torn down afterwards (teardown, services down, worktree removed). The
// record, .factory/jobs/<job>/probe.json, is sealed and bound to the plan and environment hashes:
// the plan critique reads it, the gate shows it.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson, writeJson, exists, nowIso, hashFile, sha256, stableStringify } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const { seal, valid } = require('../lib/seal');
const git = require('../lib/git');

const FILE = (root, jobId) => path.join(jobPaths(root, jobId).dir, 'probe.json');
const cmdOf = (c) => (typeof c === 'string' ? c : c && c.cmd);

// ---------------------------------------------------------------- lint

const LINT = [
  { rule: 'fixed_port', re: /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b|--port[= ](\d{2,5})\b|\bPORT=(\d{2,5})\b|\s-p\s+(\d{2,5}):/, message: (m) => `uses the fixed port ${m.slice(1).find(Boolean)}: tasks run in parallel worktrees and collide on it; let the test pick a free port (port 0) or take it from the environment` },
  { rule: 'sleep', re: /(^|[;&|(\s])sleep\s+\d/, message: () => 'waits with sleep: a race on a slow machine and wasted time on a fast one; wait on a readiness check (a health URL, a log line, a retry loop with a deadline)' },
  { rule: 'background', re: /(^|[^&>|])&(\s*$|\s+[^&])/, message: () => 'starts a background process (&) that nothing stops: start and stop it inside the test, or use the environment\'s services' },
];

function lintCommand(cmd) {
  const out = [];
  for (const r of LINT) {
    const m = r.re.exec(String(cmd));
    if (m) out.push({ rule: r.rule, message: r.message(m) });
  }
  return out;
}

// ---------------------------------------------------------------- classification

// Does a task of the plan own a module or path of this name (so its absence is expected)?
function planOwns(plan, name) {
  const n = String(name || '').replace(/^\.\/+/, '');
  if (!n) return false;
  const globs = (plan.tasks || []).flatMap((t) => t.allowed_paths || []).concat((plan.interfaces || []).map((i) => i.file || ''));
  return globs.some((g) => String(g).split(/[/\\]/).some((seg) => seg.replace(/\.(py|js|ts|mjs|cjs)$/, '').replace(/\*+/g, '') === n));
}

const ENV_SIGNS = /ECONNREFUSED|Connection refused|could not connect to server|Is the server running|ImproperlyConfigured|DJANGO_SETTINGS_MODULE|settings are not configured|EADDRINUSE|address already in use|OperationalError|getaddrinfo|Name or service not known|docker: command not found|Cannot connect to the Docker daemon/i;

// What one dry-run says: { class, ok, why }.
//   passes            exit 0 before any change (ok; the critique judges whether it proves anything)
//   fails_as_expected exit != 0 for a reason the build will fix (no test yet, an assertion)
//   missing_binary    the command itself is not there
//   environment       a third-party module, settings, a database or a server is missing
//   timeout           it did not end on its own
function classify(r, plan) {
  const out = String(r.output || '');
  if (r.timed_out || r.code === 124 || r.code === 137) return { class: 'timeout', ok: false, why: `did not finish within ${r.cap}s: a verify command must end on its own (does it wait on a server, a prompt, a loop?)` };
  if (r.code === 0) return { class: 'passes', ok: true, why: 'exits 0 before any change: make sure it tests the change' };
  if (r.code === 127 || /command not found|: not found\b|is not recognized as an internal or external command/i.test(out)) {
    const bin = (/(?:bash: (?:line \d+: )?)?([\w./-]+): (?:command )?not found/.exec(out) || [])[1];
    return { class: 'missing_binary', ok: false, why: `${bin ? `\`${bin}\`` : 'the command'} is not found in the build environment: install it in the environment's setup, or use a command the project has` };
  }
  const py = /No module named ['"]?([\w.]+)['"]?/.exec(out);
  if (py) {
    const top = py[1].split('.')[0];
    if (planOwns(plan, top) || planOwns(plan, py[1].replace(/\./g, '/'))) return { class: 'fails_as_expected', ok: true, why: `${py[1]} is a module the plan creates` };
    return { class: 'environment', ok: false, why: `the module ${py[1]} is not installed in the build environment (and no task creates it): add it to the environment's setup` };
  }
  const nm = /Cannot find module ['"]([^'"]+)['"]/.exec(out);
  if (nm) {
    if (/^[./]/.test(nm[1]) || planOwns(plan, nm[1])) return { class: 'fails_as_expected', ok: true, why: `${nm[1]} is a file the plan creates` };
    return { class: 'environment', ok: false, why: `the package ${nm[1]} is not installed in the build environment: add it to the environment's setup` };
  }
  if (ENV_SIGNS.test(out)) {
    const sign = (ENV_SIGNS.exec(out) || [])[0];
    return { class: 'environment', ok: false, why: `it needs something the environment does not provide (${sign}): a database, a server, settings or a service; add it to the environment (setup, env, services) or make the test provide it` };
  }
  return { class: 'fails_as_expected', ok: true, why: 'fails before the change is built, for a reason the build should fix' };
}

// ---------------------------------------------------------------- running

const hasTimeout = (() => {
  let v = null;
  return () => {
    if (v === null) v = spawnSync('bash', ['-c', 'command -v timeout'], { encoding: 'utf8' }).status === 0;
    return v;
  };
})();

// One command, bounded: GNU timeout signals the whole process group (servers and sleeps a
// command started included); without it, spawnSync's own cap.
function runBounded(cmd, cwd, capSec, env = {}) {
  const started = Date.now();
  const opts = { cwd, encoding: 'utf8', timeout: (capSec + 15) * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: process.env.CI || '1', FACTORY_PROBE: '1', PYTHONDONTWRITEBYTECODE: '1', ...env } };
  const r = hasTimeout() ? spawnSync('timeout', ['-k', '5', String(capSec), 'bash', '-lc', cmd], opts) : spawnSync('bash', ['-lc', cmd], { ...opts, timeout: capSec * 1000 });
  const output = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`;
  return { code: r.status === null ? -1 : r.status, timed_out: Boolean(r.error && r.error.code === 'ETIMEDOUT') || r.status === 124 || r.signal === 'SIGTERM' || r.signal === 'SIGKILL', ms: Date.now() - started, cap: capSec, output: output.length > 4000 ? `…${output.slice(-4000)}` : output };
}

// Is this a greenfield plan: the environment sets things up from manifests the base commit does
// not have yet?
function greenfield(root, base, e) {
  if (!e || !(e.setup || []).length) return false;
  let tracked = [];
  try {
    tracked = git.out(root, ['ls-tree', '-r', '--name-only', base]).split('\n').filter(Boolean);
  } catch {
    tracked = [];
  }
  const { matchesAny } = require('../lib/glob');
  // only a setup that installs from a manifest needs one: `pip install -e .`, `npm ci`, …
  if (!/pip3? install|poetry install|uv sync|npm (ci|install)|pnpm install|yarn( install)?\b|go mod|cargo (build|fetch)|bundle install|invoke build/.test((e.setup || []).join('\n'))) return false;
  const keys = e.cache_key || [];
  if (keys.length) return !tracked.some((f) => matchesAny(f, keys));
  return !tracked.some((f) => /^(pyproject\.toml|setup\.py|setup\.cfg|requirements[\w.-]*\.txt|package\.json|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle)$/.test(f));
}

function settings(state) {
  const L = (state.policy && state.policy.limits) || {};
  return { perCommand: Math.max(5, Math.min(L.probe_command_seconds || 120, L.command_timeout_seconds || 600)), budget: Math.max(30, L.probe_timeout_seconds || 900) };
}

// Is the probe on for this job? policy decompose.plan_probe (the live .factory/policy.json wins,
// then the job's snapshot; default on), and only when the job's recipe plans with the decompose
// workflow and does not turn the probe off for it (`"plan_probe": false` on the step).
function enabled(root, state, ctx = null) {
  let live = {};
  try {
    live = (require('./policy').load(root) || {}).decompose || {};
  } catch {
    live = {};
  }
  const snap = ((state && state.policy) || {}).decompose || {};
  const flag = live.plan_probe !== undefined ? live.plan_probe : snap.plan_probe;
  if (flag === false) return false;
  const c = ctx || require('./steps').context(root, state, require('./job').load);
  const step = c.recipe.steps.find((x) => x.step === 'decompose');
  return Boolean(step && String(step.run).startsWith('workflow:') && step.plan_probe !== false && !state.epic);
}

function run(root, { jobId } = {}) {
  const job = require('./job');
  const envMod = require('./environment');
  const planMod = require('./plan');
  const state = job.resolve(root, jobId);
  if (!enabled(root, state)) return { job: state.id, ok: true, skipped: true, problems: [], commands: [], lint: [], message: 'The plan probe is off for this job (policy decompose.plan_probe, or its recipe).' };
  const jp = jobPaths(root, state.id);
  const plan = readJson(jp.plan, null);
  if (!plan || !Array.isArray(plan.tasks)) return { job: state.id, ok: false, problems: ['No plan.json to probe.'], commands: [], lint: [] };
  const planHash = hashFile(jp.plan);
  const gate = envMod.gateProposal(root, state.id);
  const S = settings(state);
  const started = Date.now();
  const lint = [];
  const problems = [];
  for (const t of plan.tasks) {
    for (const c of t.verify_commands || []) {
      for (const l of lintCommand(cmdOf(c))) {
        lint.push({ task: t.id, cmd: cmdOf(c), ...l });
        problems.push(`${t.id}: \`${cmdOf(c)}\` ${l.message} (${l.rule})`);
      }
    }
  }
  const e = gate.env && !envMod.isNone(gate.env) ? gate.env : null;
  const base = state.base_commit || 'HEAD';
  const green = greenfield(root, base, e);
  const boot = plan.tasks.filter((t) => t.bootstrap === true);
  if (green) {
    if (!boot.length) problems.push(`Greenfield: the build environment's setup (${(e.setup || []).join(' && ')}) needs files no commit has yet (${(e.cache_key || []).join(', ') || 'a manifest'}). Add a bootstrap task first ("bootstrap": true) that creates them, and make every other task depend on it.`);
    else {
      const b = boot[0];
      const late = plan.tasks.filter((t) => t.id !== b.id && !planMod.effectiveDeps(plan.tasks, t.id, plan.interfaces).includes(b.id) && !dependsOn(plan.tasks, t.id, b.id));
      if (late.length) problems.push(`Greenfield: ${late.map((t) => t.id).join(', ')} ${late.length > 1 ? 'do' : 'does'} not depend on the bootstrap task ${b.id}; every task needs the files it creates.`);
    }
  }
  const commands = [];
  let setup = { status: e ? 'pending' : 'none' };
  if (green && boot.length) {
    setup = { status: 'deferred', why: `the environment is set up after ${boot[0].id} (bootstrap) writes its manifests` };
    for (const t of plan.tasks) for (const c of t.verify_commands || []) commands.push({ task: t.id, cmd: cmdOf(c), class: 'deferred', ok: true, why: 'dry-run after the bootstrap task (greenfield)' });
  } else {
    const wt = path.join(root, '.factory', 'worktrees', `_probe-${state.id}-${process.pid}`);
    git.run(root, ['worktree', 'prune'], { allowFail: true });
    const add = git.run(root, ['worktree', 'add', '--detach', wt, base], { allowFail: true });
    if (add.code !== 0) {
      problems.push(`The probe could not create its scratch worktree: ${String(add.stderr || add.stdout || '').trim().slice(0, 300)}`);
    } else {
      let E = null;
      try {
        if (e) {
          const { evidence: _e, notes: _n, source: _s, ...runEnv } = e;
          // the probe's budget bounds setup too
          E = envMod.ensure(root, null, { taskId: 'probe', wt, env: { ...runEnv, timeout_seconds: Math.min(runEnv.timeout_seconds || 1200, S.budget) } });
          if (!E.ok) {
            setup = { status: 'broken', cmd: E.broken.cmd, code: E.broken.code, tail: String(E.broken.tail || '').slice(-800) };
            problems.push(`The build environment does not set up: ${E.broken.reason.slice(0, 600)}. Fix environment.proposed.json (setup, env, services) so every worktree can build.`);
          } else setup = { status: 'ok', ran: (E.ran || []).map((x) => ({ cmd: x.cmd, code: x.code })), cached: Boolean(E.cached) };
        }
        if (!e || (E && E.ok)) {
          // the dry-run writes only into its scratch worktree: home, temp and the usual caches
          // point inside it (an OS sandbox it is not: a command could still name a path outside,
          // which the check after the run reports)
          const box = path.join(wt, '.factory-probe');
          for (const d of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(box, d), { recursive: true });
          const penv = { ...(E && E.env ? envMod.processEnv(E.env, E.vars) : {}), HOME: path.join(box, 'home'), TMPDIR: path.join(box, 'tmp'), TMP: path.join(box, 'tmp'), TEMP: path.join(box, 'tmp'), XDG_CACHE_HOME: path.join(box, 'cache'), npm_config_cache: path.join(box, 'cache', 'npm'), PIP_CACHE_DIR: path.join(box, 'cache', 'pip') };
          const before = rootStatus(root);
          for (const t of plan.tasks) {
            for (const c of t.verify_commands || []) {
              const cmd = cmdOf(c);
              if ((Date.now() - started) / 1000 > S.budget) {
                commands.push({ task: t.id, cmd, class: 'skipped', ok: true, why: `the probe's time budget (${S.budget}s) ran out` });
                continue;
              }
              const r = runBounded(E && E.env ? envMod.wrap(E.env, E.vars, cmd) : cmd, wt, S.perCommand, penv);
              const k = classify(r, plan);
              commands.push({ task: t.id, cmd, code: r.code, ms: r.ms, class: k.class, ok: k.ok, why: k.why, tail: String(r.output || '').trim().split('\n').slice(-12).join('\n').slice(-1200) });
              if (!k.ok) problems.push(`${t.id}: \`${cmd}\` cannot run in the build environment: ${k.why}. Output (tail): ${String(r.output || '').trim().split('\n').slice(-4).join(' | ').slice(-400)}`);
              // undo what a command left behind (a cache, a db file) before the next one
              git.run(wt, ['checkout', '--', '.'], { allowFail: true });
            }
          }
          const after = rootStatus(root);
          if (after !== before) problems.push(`The dry-run changed files in your checkout, outside its scratch worktree (git status before: ${before ? before.split('\n').length : 0} line(s), after: ${after ? after.split('\n').length : 0}): a verify command writes outside the repository's worktree; make it write only under its own directory.`);
        }
      } finally {
        try {
          if (e) {
            const { evidence: _e, notes: _n, source: _s, ...runEnv } = e;
            envMod.teardown(root, null, { taskId: 'probe', wt, env: runEnv });
            if (runEnv.services && runEnv.services.down) spawnSync('bash', ['-lc', envMod.expand(runEnv.services.down, envMod.vars(root, null, 'probe', wt))], { cwd: root, timeout: 600000 });
          }
        } catch {
          /* best effort */
        }
        git.run(root, ['worktree', 'remove', '--force', wt], { allowFail: true });
        try {
          fs.rmSync(wt, { recursive: true, force: true });
        } catch {
          /* gone */
        }
        git.run(root, ['worktree', 'prune'], { allowFail: true });
      }
    }
  }
  const doc = seal({
    version: 1,
    job: state.id,
    at: nowIso(),
    plan: planHash,
    environment: gate.hash,
    environment_name: (gate.env && gate.env.name) || null,
    greenfield: green,
    ok: problems.length === 0,
    ms: Date.now() - started,
    setup,
    lint,
    commands,
    problems,
  });
  writeJson(FILE(root, state.id), doc);
  try {
    require('./events').append(root, { event: 'plan_probe', job: state.id, ok: doc.ok, problems: problems.length, commands: commands.length, ms: doc.ms });
  } catch {
    /* the log is a convenience */
  }
  return { job: state.id, file: FILE(root, state.id), ...doc };
}

function rootStatus(root) {
  try {
    return git.run(root, ['status', '--porcelain', '--untracked-files=all'], { allowFail: true }).stdout;
  } catch {
    return '';
  }
}

function dependsOn(tasks, id, on, seen = new Set()) {
  if (seen.has(id)) return false;
  seen.add(id);
  const t = tasks.find((x) => x.id === id);
  return Boolean(t && (t.depends_on || []).some((d) => d === on || dependsOn(tasks, d, on, seen)));
}

// The probe record for the plan as it is now, or null (none, stale, or edited by hand).
function current(root, state) {
  const p = readJson(FILE(root, state.id), null);
  if (!p || !valid(p)) return null;
  const jp = jobPaths(root, state.id);
  if (!exists(jp.plan) || p.plan !== hashFile(jp.plan)) return null;
  if (p.environment !== require('./environment').gateProposal(root, state.id).hash) return null;
  return p;
}

// A fingerprint of the problems, to tell a loop that makes progress from one that does not.
function problemKey(p) {
  return sha256(stableStringify([...((p && p.problems) || [])].map((x) => String(x).replace(/Output \(tail\):.*$/, '')).sort()));
}

module.exports = { enabled, run, current, classify, lintCommand, greenfield, planOwns, problemKey, FILE, LINT };
