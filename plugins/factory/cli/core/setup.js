'use strict';
// factory init and factory doctor.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeJson, readJson, readText, writeText, exists, mkdirp, nowIso, fail } = require('../lib/util');
const { project, findRoot, pluginPath } = require('../lib/paths');
const git = require('../lib/git');
const recipes = require('./recipes');
const job = require('./job');

const HOOK_MARK = '# installed by software-factory';

function init(cwd, { baseBranch } = {}) {
  if (!git.isRepo(cwd)) fail('Not a git repository. Run git init and make a first commit, then factory init.', 'no_git');
  const root = git.toplevel(cwd);
  if (!git.hasCommits(root)) fail('The repository has no commits yet. Make a first commit, then run factory init.', 'no_commits');
  const p = project(root);
  const created = [];
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
  const rc = recipes.checkAll();
  for (const [id, errs] of Object.entries(rc)) add(`recipe ${id}`, errs.length === 0, errs.length ? errs.join('; ') : 'valid');
  const ready = checks.every((c) => c.ok || c.level !== 'error');
  return { ready, checks };
}

module.exports = { init, doctor };
