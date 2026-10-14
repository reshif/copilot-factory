'use strict';
// Thin synchronous git wrapper. Every call is explicit about its working directory.

const { spawnSync } = require('child_process');
const { fail } = require('./util');

function run(cwd, args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) },
  });
  if (r.error) fail(`git ${args.join(' ')} failed to start: ${r.error.message}`, 'git_error');
  const out = { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  if (!opts.allowFail && r.status !== 0) {
    fail(`git ${args.join(' ')} failed (${r.status}): ${out.stderr || out.stdout}`, 'git_error');
  }
  return out;
}

const git = {
  run,
  out(cwd, args) {
    return run(cwd, args).stdout;
  },
  ok(cwd, args) {
    return run(cwd, args, { allowFail: true }).code === 0;
  },
  isRepo(cwd) {
    return git.ok(cwd, ['rev-parse', '--is-inside-work-tree']);
  },
  toplevel(cwd) {
    return git.out(cwd, ['rev-parse', '--show-toplevel']);
  },
  hasCommits(cwd) {
    return git.ok(cwd, ['rev-parse', '--verify', 'HEAD']);
  },
  currentBranch(cwd) {
    return git.out(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  },
  branchExists(cwd, name) {
    return git.ok(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  },
  revParse(cwd, ref) {
    return git.out(cwd, ['rev-parse', ref]);
  },
  tree(cwd, ref = 'HEAD') {
    return git.out(cwd, ['rev-parse', `${ref}^{tree}`]);
  },
  // Fingerprint of what was built: the top-level tree of `ref` without the
  // .factory-ship/ manifest directory, so committing the ship manifest never
  // makes proof or review stale.
  fingerprint(cwd, ref = 'HEAD') {
    const lines = git
      .out(cwd, ['ls-tree', ref])
      .split('\n')
      .filter((l) => l && !/\t\.factory-ship$/.test(l));
    return require('crypto').createHash('sha256').update(lines.join('\n')).digest('hex');
  },
  isAncestor(cwd, a, b) {
    return git.ok(cwd, ['merge-base', '--is-ancestor', a, b]);
  },
  changedFiles(cwd, from, to) {
    const o = git.out(cwd, ['diff', '--name-only', from, to]);
    return o ? o.split('\n').filter(Boolean) : [];
  },
  hasRemote(cwd, name = 'origin') {
    return git.ok(cwd, ['remote', 'get-url', name]);
  },
  remoteUrl(cwd, name = 'origin') {
    const r = run(cwd, ['remote', 'get-url', name], { allowFail: true });
    return r.code === 0 ? r.stdout : null;
  },
  status(cwd) {
    return git.out(cwd, ['status', '--porcelain']);
  },
};

module.exports = git;
