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
  { rule: 'background', re: /(^|[^&>|])&(\s*$|\s+[^&])|\b(setsid|nohup|disown|daemonize|start-stop-daemon)\b|\bdocker\s+(run|compose\s+up)\b[^|;&]*\s-d\b|\b(screen|tmux)\b[^|;&]*\s-d/, message: () => 'starts a background process (&, setsid, nohup, docker -d …) that nothing stops: start and stop it inside the test, or use the environment\'s services' },
];

// ---------------------------------------------------------------- what a dry-run may see

// The environment a dry-run gets: an allowlist, never the user's tokens or credentials, marked as
// an agent's (every human-only verb refuses it, a pty included), tagged so survivors can be found.
const KEEP = /^(PATH|LANG|LANGUAGE|LC_[A-Z_]+|TERM|TZ|SHELL|USER|LOGNAME|PWD|COLUMNS|LINES)$/;
const PROXY = /^(https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY|ALL_PROXY|all_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|npm_config_registry)$/;
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|_KEY$|^KEY$|APIKEY|API_KEY|CREDENTIAL|^AWS_|^GH_|^GITHUB_|^SSH_|^GPG_|^COPILOT_|^NPM_TOKEN|^AZURE_|^GOOGLE_|^GCP_|COOKIE|SESSION)/i;
// `own`: the probe's own directories (its scratch home, temp and caches), never filtered: a path
// can contain a secret-looking variable's value (a temp dir named in a *_TMPDIR or *_SESSION
// variable) and must still be set (else the dry-run and setup silently fall back to the real home).
function probeEnv(root, probeId, extra = {}, own = {}) {
  let allowProxy = false;
  try {
    allowProxy = ((require('./policy').load(root) || {}).decompose || {}).probe_proxy === true;
  } catch {
    allowProxy = false;
  }
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (KEEP.test(k) || (allowProxy && PROXY.test(k))) out[k] = v;
  // what the environment declares (its env block, the probe's own dirs) is kept, except a value
  // carrying one of the user's secrets (a declared `TOKEN: $GH_TOKEN`)
  const secrets = Object.entries(process.env).filter(([k, v]) => SECRET_NAME.test(k) && v && v.length >= 6).map(([, v]) => v);
  for (const [k, v] of Object.entries(extra)) if (!secrets.some((x) => String(v).includes(x))) out[k] = v;
  return { ...out, ...own, CI: '1', FACTORY_PROBE: '1', FACTORY_PROBE_ID: probeId, FACTORY_RUNNER: '1', AI_AGENT: 'factory-probe', PYTHONDONTWRITEBYTECODE: '1' };
}

// Secrets out of anything the probe records or shows (probe.json, the gate, God Eye's input):
// well-known token shapes, key=value pairs that name a secret, and the values of the user's own
// secret-looking environment variables.
function redact(text) {
  let t = String(text || '');
  for (const [k, v] of Object.entries(process.env)) if (SECRET_NAME.test(k) && v && v.length >= 6) t = t.split(v).join(`[redacted ${k}]`);
  return t
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/g, '[redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b([A-Za-z_]*(token|secret|password|passwd|api[_-]?key)[A-Za-z_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=[redacted]');
}

// A process's process group, session and start time (Linux /proc/<pid>/stat; the fields after
// the command name: state is field 3, pgrp 5, session 6, starttime 22).
function procStat(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ');
    return { state: f[0], pgrp: Number(f[2]), sid: Number(f[3]), start: f[19] };
  } catch {
    return null;
  }
}
const procStart = (pid) => (procStat(pid) || {}).start || null;
// Alive, and the same process: a pid the system reused for another process has another start
// time (review m7).
function sameProcess(pid, start) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
  } catch (e) {
    if (!e || e.code !== 'EPERM') return false;
  }
  // a zombie (killed, not yet reaped by its parent) is gone
  if ((procStat(pid) || {}).state === 'Z') return false;
  if (!start) return true;
  const now = procStart(pid);
  return now === null ? true : now === String(start);
}

// Processes a dry-run left behind, killed and reported. Found by the probe's tag in their
// environment (Linux /proc), and, for one that cleared its environment (review m1), by the
// dry-run's own session (setsid: a process that only left the process group stays in the session)
// or by a working directory inside the scratch worktree (one that also started a new session
// still runs there).
function survivors(probeId, { sid = null, wt = null } = {}) {
  const out = [];
  let pids = [];
  try {
    pids = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x));
  } catch {
    return out;
  }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let env = '';
    try {
      env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      env = '';
    }
    let ours = Boolean(probeId) && (env.includes(`FACTORY_PROBE_ID=${probeId}\0`) || env.endsWith(`FACTORY_PROBE_ID=${probeId}`));
    if (!ours && sid && Number(pid) !== Number(sid)) ours = (procStat(pid) || {}).sid === Number(sid);
    if (!ours && wt) {
      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        ours = cwd === wt || cwd.startsWith(`${wt}${path.sep}`);
      } catch {
        ours = false;
      }
    }
    if (!ours) continue;
    let cmd = '';
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      cmd = '';
    }
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* gone */
    }
    out.push({ pid: Number(pid), cmd: redact(cmd).slice(0, 200) });
  }
  return out;
}

// Scratch worktrees an earlier probe left (it was killed before its cleanup ran).
function sweep(root, keep = null) {
  const dir = path.join(root, '.factory', 'worktrees');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^_probe-/.test(n));
  } catch {
    return [];
  }
  const removed = [];
  for (const n of names) {
    const wt = path.join(dir, n);
    if (keep && wt === keep) continue;
    // the owner the probe wrote (its pid and that process's start time): a live pid with another
    // start time is a reused pid, not the owner (review m7)
    const owner = readJson(path.join(wt, '.factory-probe', 'owner.json'), null);
    const pid = Number((owner && owner.pid) || (/-(\d+)$/.exec(n) || [])[1]);
    if (pid === process.pid && !(owner && owner.start && owner.start !== procStart(process.pid))) continue;
    let alive = pid !== process.pid && (owner ? sameProcess(pid, owner.start) : sameProcess(pid, null));
    // no owner record (a probe from before, or killed before it wrote one): alive only while young
    if (alive && !owner) {
      try {
        alive = Date.now() - fs.statSync(wt).mtimeMs < 2 * 3600e3;
      } catch {
        alive = false;
      }
    }
    if (alive) continue;
    // what the dead run left running: its tagged processes and anything still inside its worktree
    survivors(owner && owner.probe_id, { wt });
    git.run(root, ['worktree', 'remove', '--force', wt], { allowFail: true });
    try {
      fs.rmSync(wt, { recursive: true, force: true });
    } catch {
      /* gone */
    }
    removed.push(n);
  }
  if (removed.length) git.run(root, ['worktree', 'prune'], { allowFail: true });
  return removed;
}

// Does this environment's setup fetch code from the network (and so run code nobody approved)?
// (review m2: also the runners that fetch and run a package, clones and fetches, any curl or wget,
// a substituted download, and a URL)
const NETWORK_SETUP = /pip3? install|pipx (run|install)|poetry install|uv (sync|pip|run|tool)|uvx\b|npm (ci|install|i|exec)\b|npx\b|pnpm (install|i|dlx|exec)\b|yarn\b|bunx?\b|go (mod download|get|install|run)|cargo (build|fetch|install)|bundle install|gem install|curl\b|wget\b|git (clone|fetch|pull|submodule)|deno (run|install)|docker (pull|build|run|compose (pull|build|up))|podman (pull|build|run)|invoke build|apt(-get)? install|brew install|<\(|https?:\/\//;

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
const hasSetsid = (() => {
  let v = null;
  return () => {
    if (v === null) v = spawnSync('bash', ['-c', 'command -v setsid'], { encoding: 'utf8' }).status === 0;
    return v;
  };
})();
// `env` is the whole environment (probeEnv). No stdin, no controlling terminal (its own session).
function runBounded(cmd, cwd, capSec, env) {
  const started = Date.now();
  const opts = { cwd, encoding: 'utf8', timeout: (capSec + 15) * 1000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env };
  const inner = hasTimeout() ? ['timeout', '-k', '5', String(capSec), 'bash', '-c', cmd] : ['bash', '-c', cmd];
  const argv = hasSetsid() ? ['setsid', '--wait', ...inner] : inner;
  const r = spawnSync(argv[0], argv.slice(1), hasTimeout() ? opts : { ...opts, timeout: capSec * 1000 });
  const output = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`;
  // with setsid, the command's session id is the child's pid: what stays in it is a survivor (m1)
  return { code: r.status === null ? -1 : r.status, sid: hasSetsid() ? r.pid || null : null, timed_out: Boolean(r.error && r.error.code === 'ETIMEDOUT') || r.status === 124 || r.signal === 'SIGTERM' || r.signal === 'SIGKILL', ms: Date.now() - started, cap: capSec, output: output.length > 4000 ? `…${output.slice(-4000)}` : output };
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
// The probe's mode for this job: false (off), 'lint' (lint only, nothing runs) or 'full' (lint,
// setup in the scratch worktree, and a dry-run of every command lint did not flag).
// policy decompose.plan_probe: false | "lint" | "full" | "auto" (default, also true): "lint" while
// the environment the gate binds is an unconfirmed proposal whose setup installs from the
// network (it would run code nobody approved), "full" otherwise.
function mode(root, state, ctx = null) {
  if (!enabled(root, state, ctx)) return false;
  let live = {};
  try {
    live = (require('./policy').load(root) || {}).decompose || {};
  } catch {
    live = {};
  }
  const snap = ((state && state.policy) || {}).decompose || {};
  const flag = live.plan_probe !== undefined ? live.plan_probe : snap.plan_probe;
  // the human's answer to an interrupted probe (park plan_probe, option a): lint only
  if (state && state.probe_override === 'lint') return 'lint';
  if (flag === 'lint' || flag === 'full') return flag;
  const g = require('./environment').gateProposal(root, state.id);
  return g.status === 'proposed' && NETWORK_SETUP.test(((g.env || {}).setup || []).join('\n')) ? 'lint' : 'full';
}

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
  // the human's answer to an interrupted probe (park plan_probe, option c): no probe for this job
  if (state && state.probe_override === false) return false;
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
  const runMode = mode(root, state);
  const probeId = require('crypto').randomBytes(8).toString('hex');
  const jp = jobPaths(root, state.id);
  const plan = readJson(jp.plan, null);
  if (!plan || !Array.isArray(plan.tasks)) return { job: state.id, ok: false, problems: ['No plan.json to probe.'], commands: [], lint: [] };
  const planHash = hashFile(jp.plan);
  const gate = envMod.gateProposal(root, state.id);
  const S = settings(state);
  // an earlier run that never finished (killed with the drive or factory run): picked up while
  // it still runs, else cleaned up (its process group, its survivors, its scratch worktree) and
  // counted; after MAX_INTERRUPTED in a row the job asks how to probe (review MAJ-2)
  const prior = recover(root, state, { plan: planHash, environment: gate.hash, mode: runMode });
  if (prior) return prior;
  sweep(root);
  const started = Date.now();
  const wtPath = path.join(root, '.factory', 'worktrees', `_probe-${state.id}-${process.pid}`);
  markStarted(root, state, { probeId, plan: planHash, environment: gate.hash, mode: runMode, wt: wtPath, S });
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
  const flagged = new Set(lint.map((l) => `${l.task}\0${l.cmd}`));
  if (runMode === 'lint') {
    setup = { status: 'not_run', why: 'lint-only probe: the proposed environment installs from the network and is not confirmed yet (policy decompose.plan_probe "full" runs it)' };
    for (const t of plan.tasks) for (const c of t.verify_commands || []) commands.push({ task: t.id, cmd: cmdOf(c), class: 'not_run', ok: true, why: 'lint only: not executed' });
  } else if (green && boot.length) {
    setup = { status: 'deferred', why: `the environment is set up after ${boot[0].id} (bootstrap) writes its manifests` };
    for (const t of plan.tasks) for (const c of t.verify_commands || []) commands.push({ task: t.id, cmd: cmdOf(c), class: 'deferred', ok: true, why: 'dry-run after the bootstrap task (greenfield)' });
  } else {
    const wt = wtPath;
    git.run(root, ['worktree', 'prune'], { allowFail: true });
    const add = git.run(root, ['worktree', 'add', '--detach', wt, base], { allowFail: true });
    if (add.code !== 0) {
      problems.push(`The probe could not create its scratch worktree: ${String(add.stderr || add.stdout || '').trim().slice(0, 300)}`);
    } else {
      let E = null;
      // the dry-run writes only into its scratch worktree: home, temp and the usual caches point
      // inside it (an OS sandbox it is not: a command could still name a path outside, which the
      // check after the run reports). Setup, teardown and services get the same home (MAJ-3).
      const box = path.join(wt, '.factory-probe');
      for (const d of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(box, d), { recursive: true });
      // who owns this scratch worktree: the sweep keeps it only while this very process lives (m7)
      writeJson(path.join(box, 'owner.json'), { pid: process.pid, start: procStart(process.pid), probe_id: probeId, job: state.id, at: nowIso() });
      const homeEnv = ownDirs(box);
      const base = probeEnv(root, probeId, {}, homeEnv);
      try {
        if (e) {
          const { evidence: _e, notes: _n, source: _s, ...runEnv } = e;
          // the probe's budget bounds setup too
          // setup runs with the same allowlisted environment (no tokens), no terminal, no login
          // shell (environment.sh runs bash --noprofile --norc under a base environment: a
          // ~/.profile or ~/.bashrc that exports a token never runs) and the scratch home
          E = envMod.withBaseEnv(base, () => envMod.ensure(root, null, { taskId: 'probe', wt, env: { ...runEnv, timeout_seconds: Math.min(runEnv.timeout_seconds || 1200, S.budget) } }));
          if (!E.ok) {
            setup = { status: 'broken', cmd: E.broken.cmd, code: E.broken.code, tail: redact(String(E.broken.tail || '').slice(-800)) };
            problems.push(`The build environment does not set up: ${redact(E.broken.reason.slice(0, 600))}. Fix environment.proposed.json (setup, env, services) so every worktree can build.`);
          } else setup = { status: 'ok', ran: (E.ran || []).map((x) => ({ cmd: x.cmd, code: x.code })), cached: Boolean(E.cached) };
        }
        if (!e || (E && E.ok)) {
          const penv = probeEnv(root, probeId, E && E.env ? envMod.processEnv(E.env, E.vars) : {}, homeEnv);
          const before = rootStatus(root);
          for (const t of plan.tasks) {
            for (const c of t.verify_commands || []) {
              const cmd = cmdOf(c);
              if ((Date.now() - started) / 1000 > S.budget) {
                commands.push({ task: t.id, cmd, class: 'skipped', ok: true, why: `the probe's time budget (${S.budget}s) ran out` });
                continue;
              }
              // a command lint flagged (a background process, a sleep, a fixed port) is not run
              if (flagged.has(`${t.id}\0${cmd}`)) {
                commands.push({ task: t.id, cmd, class: 'lint_skipped', ok: false, why: 'not run: lint flagged it (see the problems)' });
                continue;
              }
              const r = runBounded(E && E.env ? envMod.wrap(E.env, E.vars, cmd) : cmd, wt, S.perCommand, penv);
              const k = classify(r, plan);
              const left = survivors(probeId, { sid: r.sid, wt });
              commands.push({ task: t.id, cmd, code: r.code, ms: r.ms, class: left.length ? 'escaped' : k.class, ok: k.ok && !left.length, why: left.length ? `left ${left.length} process(es) running after it ended (killed): ${left.map((x) => x.cmd).join('; ')}` : k.why, tail: redact(String(r.output || '').trim().split('\n').slice(-12).join('\n')).slice(-1200) });
              if (left.length) problems.push(`${t.id}: \`${cmd}\` left ${left.length} process(es) running after it ended (the probe killed them): ${left.map((x) => x.cmd).join('; ')}. A verify command must stop everything it starts.`);
              else if (!k.ok) problems.push(`${t.id}: \`${cmd}\` cannot run in the build environment: ${k.why}. Output (tail): ${redact(String(r.output || '').trim().split('\n').slice(-4).join(' | ')).slice(-400)}`);
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
            // teardown and services.down are the planner's commands too: the same allowlisted
            // environment, scratch home and no login shell as setup
            envMod.withBaseEnv(base, () => envMod.teardown(root, null, { taskId: 'probe', wt, env: runEnv }));
            if (runEnv.services && runEnv.services.down) spawnSync('bash', ['--noprofile', '--norc', '-c', envMod.expand(runEnv.services.down, envMod.vars(root, null, 'probe', wt))], { cwd: root, timeout: Math.min(600, S.budget) * 1000, stdio: ['ignore', 'pipe', 'pipe'], env: base });
          }
          for (const x of survivors(probeId, { wt })) problems.push(`A process of the probe's setup or services was still running at the end and was killed: ${x.cmd}`);
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
    mode: runMode,
    ok: problems.length === 0,
    ms: Date.now() - started,
    setup,
    lint,
    commands,
    problems: problems.map(redact),
  });
  writeJson(FILE(root, state.id), doc);
  markFinished(root, state.id, probeId);
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

// ---------------------------------------------------------------- started, interrupted (review MAJ-2)
//
// Every run that executes anything records itself first in .factory/jobs/<job>/probe.started.json
// (sealed): the plan and environment it probes, its pid and that process's start time, its probe
// id, its scratch worktree and a deadline. A run killed with the drive or factory run (its
// finally never ran) leaves that record unfinished. The next run:
//   - picks it up while it still runs (the same plan, environment and mode): it waits for its
//     result instead of starting a second probe;
//   - else cleans up after it: its process group, every process tagged with its probe id or
//     still inside its scratch worktree, the worktree itself; and counts it as interrupted;
//   - after MAX_INTERRUPTED interrupted runs in a row (a run that finishes resets the count), it
//     does not start again: the job asks how to probe (lint only, run it in your own terminal, or
//     no probe), never a third silent restart.

const STARTED = (root, jobId) => path.join(jobPaths(root, jobId).dir, 'probe.started.json');
const MAX_INTERRUPTED = 2;
const ownDirs = (box) => ({ HOME: path.join(box, 'home'), TMPDIR: path.join(box, 'tmp'), TMP: path.join(box, 'tmp'), TEMP: path.join(box, 'tmp'), XDG_CACHE_HOME: path.join(box, 'cache'), XDG_CONFIG_HOME: path.join(box, 'home', '.config'), XDG_DATA_HOME: path.join(box, 'home', '.local', 'share'), npm_config_cache: path.join(box, 'cache', 'npm'), PIP_CACHE_DIR: path.join(box, 'cache', 'pip') });

function readStarted(root, jobId) {
  const s = readJson(STARTED(root, jobId), null);
  return s && valid(s) ? s : null;
}

function markStarted(root, state, { probeId, plan, environment, mode: m, wt, S }) {
  const prev = readStarted(root, state.id);
  const interrupted = prev && prev.finished && ['died', 'overdue'].includes(prev.outcome) ? prev.interrupted || 0 : 0;
  // setup (bounded by the budget), the dry-run (the budget), one command's overrun, services
  const deadline = Date.now() + (2 * S.budget + S.perCommand + 120) * 1000;
  writeJson(STARTED(root, state.id), seal({ version: 1, job: state.id, plan, environment, mode: m, probe_id: probeId, pid: process.pid, pid_start: procStart(process.pid), wt, at: nowIso(), deadline_at: new Date(deadline).toISOString(), interrupted, finished: false }));
}

function markFinished(root, jobId, probeId) {
  const st = readStarted(root, jobId);
  if (st && st.probe_id === probeId) writeJson(STARTED(root, jobId), seal({ ...st, finished: true, outcome: 'done', interrupted: 0, ended_at: nowIso() }));
}

function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
  } catch {
    /* no wait available: poll */
  }
}

// An unfinished run's leftovers, gone: its process group (when it leads one: factory run starts
// every CLI step detached), the process itself, every process tagged with its probe id or still
// inside its scratch worktree, and the worktree.
function killRun(root, st) {
  if (st.pid && st.pid !== process.pid && sameProcess(st.pid, st.pid_start)) {
    const ps = procStat(st.pid);
    try {
      if (ps && ps.pgrp === Number(st.pid)) process.kill(-Number(st.pid), 'SIGKILL');
      else process.kill(Number(st.pid), 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  const wt = st.wt && String(st.wt).startsWith(path.join(root, '.factory', 'worktrees', '_probe-')) ? st.wt : null;
  const left = survivors(st.probe_id, { wt });
  if (wt) {
    git.run(root, ['worktree', 'remove', '--force', wt], { allowFail: true });
    try {
      fs.rmSync(wt, { recursive: true, force: true });
    } catch {
      /* gone */
    }
    git.run(root, ['worktree', 'prune'], { allowFail: true });
  }
  return left;
}

// The question the job parks with after MAX_INTERRUPTED interrupted runs.
function interruptedQuestion(jobId, n) {
  return {
    question: `The plan probe was interrupted ${n} times before it finished (factory run or the drive was stopped while it ran). How should this plan be probed?`,
    options: [
      { key: 'a', text: 'Lint only for this job: check the verify commands without running them (the gate shows nothing ran)' },
      { key: 'b', text: `I run it in my own terminal: factory plan probe --job ${jobId}, then reply resume (its result is used)` },
      { key: 'c', text: 'No probe for this job: the plan gate says it was not probed' },
    ],
    recommendation: 'b',
  };
}

function needsAnswer(state, n) {
  const reason = `The plan probe was interrupted ${n} times before it finished; it is not started again silently.`;
  return { job: state.id, ok: false, needs_answer: true, interrupted: n, question: interruptedQuestion(state.id, n), problems: [reason], commands: [], lint: [], message: `${reason} ${state.id} asks how to probe the plan (a: lint only, b: run factory plan probe in your own terminal, c: no probe).` };
}

// Before a run: what an earlier, unfinished one left. Returns a result to use instead of
// running (its picked-up record, or the question after MAX_INTERRUPTED), or null to go on.
function recover(root, state, { plan, environment, mode: m }) {
  let st = readStarted(root, state.id);
  if (!st) return null;
  if (!st.finished && !(st.pid === process.pid && st.pid_start === procStart(process.pid))) {
    const same = st.plan === plan && st.environment === environment && st.mode === m;
    const overdue = () => Date.now() > Date.parse(st.deadline_at || 0) + 120000;
    // still running, on this very plan: wait for its result (never a second probe beside it)
    if (same && sameProcess(st.pid, st.pid_start) && !overdue()) {
      while (sameProcess(st.pid, st.pid_start) && !overdue()) {
        const r = current(root, state);
        if (r && r.at >= st.at) return { job: state.id, file: FILE(root, state.id), picked_up: true, ...r };
        sleepMs(250);
      }
      sleepMs(200);
      const r = current(root, state);
      if (r && r.at >= st.at) return { job: state.id, file: FILE(root, state.id), picked_up: true, ...r };
      st = readStarted(root, state.id) || st;
      if (st.finished) return null;
    }
    const alive = sameProcess(st.pid, st.pid_start);
    // a run for another plan or environment that still goes on: superseded, stopped, not counted
    const superseded = alive && !same && !overdue();
    const left = killRun(root, st);
    const interrupted = superseded ? st.interrupted || 0 : (st.interrupted || 0) + 1;
    const outcome = superseded ? 'superseded' : alive ? 'overdue' : 'died';
    writeJson(STARTED(root, state.id), seal({ ...st, finished: true, outcome, interrupted, killed: left.length, ended_at: nowIso() }));
    try {
      require('./events').append(root, { event: 'plan_probe_interrupted', job: state.id, probe_id: st.probe_id, outcome, interrupted, killed: left.length });
    } catch {
      /* the log is a convenience */
    }
    st = readStarted(root, state.id);
  }
  // (while the job is parked on that question, the human's own run in their terminal goes ahead)
  const asked = state.status === 'parked' && state.park && state.park.kind === 'plan_probe';
  if (st && (st.interrupted || 0) >= MAX_INTERRUPTED && !asked) return needsAnswer(state, st.interrupted);
  return null;
}

// The probe record for the plan as it is now, or null (none, stale, or edited by hand).
function current(root, state) {
  const p = readJson(FILE(root, state.id), null);
  if (!p || !valid(p)) return null;
  const jp = jobPaths(root, state.id);
  if (!exists(jp.plan) || p.plan !== hashFile(jp.plan)) return null;
  if (p.environment !== require('./environment').gateProposal(root, state.id).hash) return null;
  // a record made in another mode (lint only, full) is not this one's
  const m = mode(root, state);
  if (m && p.mode && p.mode !== m) return null;
  return p;
}

// A fingerprint of the problems, to tell a loop that makes progress from one that does not.
function problemKey(p) {
  return sha256(stableStringify([...((p && p.problems) || [])].map((x) => String(x).replace(/Output \(tail\):.*$/, '')).sort()));
}

module.exports = { recover, readStarted, markStarted, interruptedQuestion, procStat, sameProcess, ownDirs, STARTED, MAX_INTERRUPTED, mode, probeEnv, redact, survivors, sweep, NETWORK_SETUP, enabled, run, current, classify, lintCommand, greenfield, planOwns, problemKey, FILE, LINT };
