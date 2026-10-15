'use strict';
// factory init, factory doctor and factory shim.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeJson, readJson, readText, writeText, exists, mkdirp, nowIso, fail } = require('../lib/util');
const { project, findRoot, pluginPath } = require('../lib/paths');
const git = require('../lib/git');
const recipes = require('./recipes');
const job = require('./job');

const HOOK_MARK = '# installed by software-factory';

// A folder that isn't a repository yet becomes one, and a repository with no commits gets
// a first commit holding your existing files (`git add -A`, so .gitignore applies): task
// worktrees are checked out from that commit, so files left out of it are invisible to
// builders and testers. Files matching policy.secret_paths (.env, keys, credentials) are
// never committed: they stay untracked and are listed. Home and / are refused, so a stray
// /factory:start can't turn your whole home folder into a repository; git identity is
// checked before anything is created.
function identityMissing(dir) {
  const who = (k) => git.run(dir, ['config', k], { allowFail: true }).stdout;
  return !who('user.name') || !who('user.email');
}

const NO_IDENTITY = 'git needs your name and email for the first commit: git config --global user.name "Your Name" && git config --global user.email you@example.com — then run factory init again.';

function secretPolicy(dir) {
  const pol = require('./policy').defaults();
  const over = readJson(path.join(dir, '.factory', 'policy.json'), null);
  return (over && Array.isArray(over.secret_paths) ? over.secret_paths : pol.secret_paths) || [];
}

function isSecret(rel, globs) {
  const { matchesAny } = require('../lib/glob');
  const name = path.basename(rel);
  if (/\.(example|sample|template|dist)$/i.test(name)) return false; // .env.example & co. are templates, not secrets (policy.secret_exempt)
  return matchesAny(rel, globs) || matchesAny(name, globs.map((g) => g.replace(/^\*\*\//, '')));
}

function firstCommit(root, created, report) {
  if (identityMissing(root)) fail(NO_IDENTITY, 'no_git_identity');
  git.run(root, ['add', '-A', '--', '.', ':(exclude).factory', ':(exclude).factory/**']);
  const staged = git.run(root, ['diff', '--cached', '--name-only', '-z'], { allowFail: true }).stdout.split('\0').filter(Boolean);
  const globs = secretPolicy(root);
  const secrets = staged.filter((f) => isSecret(f, globs));
  for (let i = 0; i < secrets.length; i += 100) git.run(root, ['rm', '--cached', '-q', '--', ...secrets.slice(i, i + 100)]);
  const files = staged.length - secrets.length;
  git.run(root, ['commit', '--allow-empty', '-q', '-m', 'Initial commit (factory init)']);
  created.push(`first commit (${files} file(s))`);
  report.first_commit = { files, commit: git.run(root, ['rev-parse', 'HEAD']).stdout.trim() };
  if (secrets.length) {
    report.left_untracked = secrets;
    report.warning = `Not committed (they look like secrets, policy.secret_paths): ${secrets.join(', ')}. They stay untracked; add them to .gitignore so they are never committed.`;
  }
}

function ensureRepo(cwd, created, report) {
  const dir = path.resolve(cwd);
  if (!git.isRepo(dir)) {
    if (dir === path.resolve(require('os').homedir()) || dir === path.parse(dir).root) {
      fail(`${dir} is your home or root folder; cd into a project folder (or create one) and run factory init there.`, 'home_folder');
    }
    if (identityMissing(dir)) fail(NO_IDENTITY, 'no_git_identity'); // before git init: nothing is left behind
    if (!git.ok(dir, ['init', '-b', 'main'])) git.run(dir, ['init']);
    created.push(path.join(dir, '.git'));
  }
  const root = git.toplevel(dir);
  if (!git.hasCommits(root)) firstCommit(root, created, report);
  return root;
}

// Keep .factory/ and common build caches out of git without touching the user's .gitignore:
// the common-dir info/exclude applies to every worktree, so a verify command that writes
// __pycache__ (or a test cache) never leaves a task or job worktree "dirty". Run at init and
// whenever a worktree is prepared, so repositories initialised earlier get it too.
const EXCLUDES = ['.factory/', '__pycache__/', '*.py[cod]', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.tox/', 'node_modules/.cache/', '.DS_Store'];
function ensureExcludes(root) {
  const commonDir = path.resolve(root, git.out(root, ['rev-parse', '--git-common-dir']));
  const exclude = path.join(commonDir, 'info', 'exclude');
  const ex = readText(exclude, '');
  const have = new Set(ex.split(/\r?\n/).map((l) => l.trim()));
  const add = EXCLUDES.filter((p) => !have.has(p));
  if (!add.length) return null;
  writeText(exclude, `${ex}${ex.endsWith('\n') || !ex ? '' : '\n'}${add.join('\n')}\n`);
  return exclude;
}

// Before a worktree is prepared: the excludes above, and the factory's own commit-msg hook
// brought up to date (never a hook the user wrote).
function ensureGitSetup(root) {
  ensureExcludes(root);
  const hookFile = path.join(path.resolve(root, git.out(root, ['rev-parse', '--git-common-dir'])), 'hooks', 'commit-msg');
  const existing = readText(hookFile, null);
  const want = readText(pluginPath('templates', 'git', 'commit-msg'));
  if (existing !== null && existing.includes(HOOK_MARK) && existing !== want) {
    writeText(hookFile, want);
    fs.chmodSync(hookFile, 0o755);
  }
}

function init(cwd, { baseBranch } = {}) {
  const created = [];
  const report = {};
  const root = ensureRepo(cwd, created, report);
  const p = project(root);
  if (!exists(p.projectFile)) {
    writeJson(p.projectFile, { version: 1, created_at: nowIso(), base_branch: baseBranch || git.currentBranch(root) });
    created.push(p.projectFile);
  }
  if (!exists(p.policyFile)) {
    writeJson(p.policyFile, {});
    created.push(p.policyFile);
  }
  for (const d of [p.jobsDir, p.logDir, path.dirname(p.lessonsFile), p.telemetryDir, p.worktreesDir, p.scratchDir]) mkdirp(d);

  const commonDir = path.resolve(root, git.out(root, ['rev-parse', '--git-common-dir']));
  const exclude = ensureExcludes(root);
  if (exclude) created.push(exclude);

  // commit-msg hook: adds Factory-Job / Factory-Task (and, in fix rounds, Factory-Fix) trailers on factory branches.
  const hooksDir = path.join(commonDir, 'hooks');
  const hookFile = path.join(hooksDir, 'commit-msg');
  const existing = readText(hookFile, null);
  if (existing === null || existing.includes(HOOK_MARK)) {
    mkdirp(hooksDir);
    writeText(hookFile, readText(pluginPath('templates', 'git', 'commit-msg')));
    fs.chmodSync(hookFile, 0o755);
    created.push(hookFile);
  }
  return { root, created, ...report, base_branch: readJson(p.projectFile).base_branch, doctor: doctor(root) };
}

function doctor(cwd) {
  const checks = [];
  const add = (name, ok, detail, level = 'error') => checks.push({ name, ok, level: ok ? 'ok' : level, detail });
  const major = parseInt(process.versions.node.split('.')[0], 10);
  add('node', major >= 18, `Node ${process.versions.node} (needs 18+)`);
  const g = spawnSync('git', ['--version'], { encoding: 'utf8' });
  add('git', g.status === 0, (g.stdout || '').trim() || 'git not found');
  const root = findRoot(cwd);
  add('initialized', Boolean(root), root ? `.factory/ at ${root}` : 'run factory init');
  if (root) {
    add('remote', git.hasRemote(root), git.remoteUrl(root) || 'no "origin" remote: jobs ship in local mode (you merge and reply "merged <sha>")', 'warning');
    const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
    add('github cli', gh.status === 0, gh.status === 0 ? 'gh authenticated' : 'gh missing or not logged in: PRs are not opened automatically', 'warning');
    const id = git.run(root, ['config', 'user.email'], { allowFail: true });
    add('git identity', id.code === 0 && Boolean(id.stdout), id.stdout || 'set git config user.name / user.email (merges and commits need it)');
    const ci = exists(path.join(root, '.github', 'workflows', 'factory-gate.yml'));
    add('ci', ci, ci ? 'factory-gate workflow present' : 'no CI re-verify workflow: run factory ci install (or re-verify locally with factory ci verify)', 'warning');
    const cur = job.current(root);
    add('current job', true, cur || '(none)');
  }
  copilotChecks(add, root);
  const ap = root ? require('./autopilot').recent(root) : null;
  if (ap) add('copilot autopilot', false, `Autopilot continuations were seen in this project (last ${ap.last_at}): Autopilot keeps going past the factory's stops. Use interactive mode for factory work`, 'warning');
  const rc = recipes.checkAll();
  for (const [id, errs] of Object.entries(rc)) add(`recipe ${id}`, errs.length === 0, errs.length ? errs.join('; ') : 'valid');
  const ready = checks.every((c) => c.ok || c.level !== 'error');
  return { ready, checks };
}

// The Copilot CLI that \`factory run\` drives, and settings that would let a session
// answer the human gates by itself (allow-all, autopilot).
function readJsonc(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '');
    return JSON.parse(t.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

function copilotChecks(add, root) {
  const bin = process.env.COPILOT_BIN || 'copilot';
  const [file, args, shell] = require('./runner').command(bin, ['--version']); // same resolution as factory run (copilot.cmd on Windows)
  const v = spawnSync(file, args, { encoding: 'utf8', timeout: 20000, ...(shell ? { shell: true, windowsVerbatimArguments: true } : {}) });
  const version = `${v.stdout || ''}`.trim().split('\n')[0];
  add('copilot cli', v.status === 0, v.status === 0 ? `${bin}: ${version}` : `${bin} not found or failing: install the GitHub Copilot CLI (or set COPILOT_BIN). factory run needs it`, 'warning');
  const allowAll = String(process.env.COPILOT_ALLOW_ALL || '').trim();
  if (allowAll && !/^(0|false|no|off)$/i.test(allowAll)) add('copilot allow-all', false, `COPILOT_ALLOW_ALL=${allowAll} is set: every tool runs without asking in your sessions. Human gates still need your reply, but unset it for factory work`, 'warning');
  const plan = String(process.env.COPILOT_PLAN_THEN_AUTOPILOT || '').trim();
  if (plan && !/^(0|false|no|off)$/i.test(plan)) add('copilot autopilot', false, `COPILOT_PLAN_THEN_AUTOPILOT=${plan} is set: autopilot answers its own questions, so it would approve factory gates. Unset it`, 'warning');
  const home = process.env.COPILOT_HOME || path.join(require('os').homedir(), '.copilot');
  const st = readJsonc(path.join(home, 'settings.json'));
  if (st) {
    const perm = st.permissions || {};
    // factory run pre-approves each role's own tools with --allow-tool, which this setting
    // leaves alone; it only suppresses policy.copilot.permissions "allow-all".
    if (perm.disableBypassPermissionsMode === 'disable' || perm.disableBypassPermissionsMode === 'allow-auto-only') {
      let mode = null;
      try {
        mode = ((require('./policy').load(root) || {}).copilot || {}).permissions || null;
      } catch {
        mode = null;
      }
      const allowAll = mode === 'allow-all';
      add('copilot allow-all flags', !allowAll, allowAll ? `permissions.disableBypassPermissionsMode is "${perm.disableBypassPermissionsMode}" and policy.copilot.permissions is "allow-all": Copilot suppresses --allow-all-tools, so headless agents may stall on permissions. Use the default per-role permissions` : `permissions.disableBypassPermissionsMode is "${perm.disableBypassPermissionsMode}": fine, factory run pre-approves each agent's own tools with --allow-tool`, 'warning');
    }
    if (st.askUser === false) add('copilot askUser', false, `${path.join(home, 'settings.json')} sets askUser: false: sessions work without asking you anything, so factory questions and gates can be skipped. Remove it for factory work`, 'warning');
  }
}

// Links bin/factory and the inspector's bin/factory-inspect into a PATH directory:
// Copilot does not put a plugin's bin/ on PATH. Harmless (symlinks only), so not human-only.
function shim({ dir, force = false } = {}) {
  const target = path.resolve(dir || path.join(require('os').homedir(), '.local', 'bin'));
  mkdirp(target);
  const bins = [
    ['factory', pluginPath('bin', 'factory')],
    ['factory-inspect', path.join(pluginPath(), '..', 'factory-inspector', 'bin', 'factory-inspect')],
  ];
  const linked = [];
  const skipped = [];
  for (const [name, src] of bins) {
    const real = path.resolve(src);
    if (!exists(real)) {
      skipped.push({ name, reason: `${real} not found (is the plugin installed next to factory?)` });
      continue;
    }
    const dest = path.join(target, name);
    let st = null;
    try {
      st = fs.lstatSync(dest);
    } catch {
      st = null;
    }
    if (st && !st.isSymbolicLink() && !force) {
      skipped.push({ name, reason: `${dest} exists and is not a symlink (use --force to replace it)` });
      continue;
    }
    if (st) fs.rmSync(dest, { force: true });
    fs.symlinkSync(real, dest);
    try {
      fs.chmodSync(real, 0o755);
    } catch {
      /* read-only install: the mode is already right */
    }
    linked.push({ name, link: dest, to: real });
  }
  const onPath = (process.env.PATH || '').split(path.delimiter).map((p) => path.resolve(p)).includes(target);
  return { dir: target, linked, skipped, on_path: onPath, ...(onPath ? {} : { hint: `${target} is not on your PATH: add  export PATH="${target}:$PATH"  to your shell profile` }) };
}

module.exports = { init, doctor, shim, ensureExcludes, ensureGitSetup, EXCLUDES };
