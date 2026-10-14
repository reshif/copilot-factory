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

// A folder that isn't a repository yet becomes one, and an empty repository gets an empty
// first commit — never your files: nothing is staged. Home and / are refused, so a stray
// /factory:start can't turn your whole home folder into a repository.
function ensureRepo(cwd, created) {
  const dir = path.resolve(cwd);
  if (!git.isRepo(dir)) {
    if (dir === path.resolve(require('os').homedir()) || dir === path.parse(dir).root) {
      fail(`${dir} is your home or root folder; cd into a project folder (or create one) and run factory init there.`, 'no_git');
    }
    if (!git.ok(dir, ['init', '-b', 'main'])) git.run(dir, ['init']);
    created.push(path.join(dir, '.git'));
  }
  const root = git.toplevel(dir);
  if (!git.hasCommits(root)) {
    const who = (k) => git.run(root, ['config', k], { allowFail: true }).stdout;
    if (!who('user.name') || !who('user.email')) {
      fail('git needs your name and email for the first commit: git config --global user.name "Your Name" && git config --global user.email you@example.com — then run factory init again.', 'no_git_identity');
    }
    git.run(root, ['commit', '--allow-empty', '-q', '-m', 'Initial commit (factory init)']);
    created.push('first commit (empty)');
  }
  return root;
}

function init(cwd, { baseBranch } = {}) {
  const created = [];
  const root = ensureRepo(cwd, created);
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

  // Keep .factory/ out of git without touching the user's .gitignore.
  const commonDir = path.resolve(root, git.out(root, ['rev-parse', '--git-common-dir']));
  const exclude = path.join(commonDir, 'info', 'exclude');
  const ex = readText(exclude, '');
  if (!/^\.factory\/$/m.test(ex)) {
    writeText(exclude, `${ex}${ex.endsWith('\n') || !ex ? '' : '\n'}.factory/\n`);
    created.push(exclude);
  }

  // commit-msg hook: adds Factory-Job / Factory-Task trailers on factory branches.
  const hooksDir = path.join(commonDir, 'hooks');
  const hookFile = path.join(hooksDir, 'commit-msg');
  const existing = readText(hookFile, null);
  if (existing === null || existing.includes(HOOK_MARK)) {
    mkdirp(hooksDir);
    writeText(hookFile, readText(pluginPath('templates', 'git', 'commit-msg')));
    fs.chmodSync(hookFile, 0o755);
    created.push(hookFile);
  }
  return { root, created, base_branch: readJson(p.projectFile).base_branch, doctor: doctor(root) };
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
  copilotChecks(add);
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

function copilotChecks(add) {
  const bin = process.env.COPILOT_BIN || 'copilot';
  const [file, args] = /\.c?js$/.test(bin) ? [process.execPath, [bin, '--version']] : [bin, ['--version']];
  const v = spawnSync(file, args, { encoding: 'utf8', timeout: 20000 });
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
    if (perm.disableBypassPermissionsMode === 'disable' || perm.disableBypassPermissionsMode === 'allow-auto-only') add('copilot allow-all flags', false, `permissions.disableBypassPermissionsMode is "${perm.disableBypassPermissionsMode}": factory run passes --allow-all-tools to its agents, which this setting suppresses, so headless agents may stall on permissions`, 'warning');
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

module.exports = { init, doctor, shim };
