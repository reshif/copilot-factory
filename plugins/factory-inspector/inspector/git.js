'use strict';
// Read-only git for the outcome rules (R23 work lost, R24 exports removed): is a commit in the
// shipped one, a file's text at a commit, the files a range changed. Every call is read-only and
// a failure (no git, a commit gc'd after the job closed) returns null: the rule then says
// nothing rather than guessing.

const { spawnSync } = require('child_process');

function git(root, args) {
  try {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

const SHA = /^[0-9a-f]{7,64}$/;
const commitExists = (root, c) => SHA.test(String(c || '')) && git(root, ['cat-file', '-e', `${c}^{commit}`]) !== null;

// true / false, or null when it can't be told (a commit is gone)
function isAncestor(root, a, b) {
  if (!commitExists(root, a) || !commitExists(root, b)) return null;
  try {
    const r = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', a, b], { encoding: 'utf8', timeout: 30000 });
    return r.status === 0 ? true : r.status === 1 ? false : null;
  } catch {
    return null;
  }
}

function countBetween(root, from, to) {
  const o = git(root, ['rev-list', '--count', `${from}..${to}`]);
  return o === null ? null : Number(o.trim());
}

function show(root, commit, file) {
  if (!commitExists(root, commit)) return null;
  return git(root, ['show', `${commit}:${file}`]); // null when the file is not there
}

function changedFiles(root, from, to) {
  if (!commitExists(root, from) || !commitExists(root, to)) return null;
  const o = git(root, ['diff', '--name-only', from, to]);
  return o === null ? null : o.split('\n').filter(Boolean);
}

module.exports = { git, isAncestor, countBetween, show, changedFiles, commitExists };
