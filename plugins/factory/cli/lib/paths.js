'use strict';
// Where things live: the plugin's own files and a project's .factory/ directory.

const path = require('path');
const { exists, fail } = require('./util');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function pluginPath(...p) {
  return path.join(PLUGIN_ROOT, ...p);
}

// Walk up from `start` to the first directory holding .factory/project.json.
// Task worktrees live under <root>/.factory/worktrees/, so walking up from one
// still lands on the project root.
function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (exists(path.join(dir, '.factory', 'project.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function requireRoot(start) {
  const root = findRoot(start || process.env.FACTORY_ROOT || process.cwd());
  if (!root) fail('No .factory/ found here or above. Run `factory init` in your repository first.', 'not_initialized');
  return root;
}

function project(root) {
  const f = path.join(root, '.factory');
  return {
    root,
    dir: f,
    projectFile: path.join(f, 'project.json'),
    policyFile: path.join(f, 'policy.json'),
    currentFile: path.join(f, 'current'),
    jobsDir: path.join(f, 'jobs'),
    logDir: path.join(f, 'log'),
    eventsFile: path.join(f, 'log', 'events.jsonl'),
    decisionsFile: path.join(f, 'log', 'decisions.jsonl'),
    lessonsFile: path.join(f, 'lessons', 'lessons.json'),
    telemetryDir: path.join(f, 'telemetry'),
    worktreesDir: path.join(f, 'worktrees'),
    scratchDir: path.join(f, 'scratch'),
  };
}

function jobPaths(root, jobId) {
  const d = path.join(root, '.factory', 'jobs', jobId);
  return {
    dir: d,
    state: path.join(d, 'state.json'),
    contract: path.join(d, 'contract.md'),
    findings: path.join(d, 'findings.md'),
    threatModel: path.join(d, 'threat-model.md'),
    noAdr: path.join(d, 'no-adr.md'),
    recommendation: path.join(d, 'recommendation.md'),
    answers: path.join(d, 'answers.json'),
    contractsMd: path.join(d, 'contracts.md'),
    contractsJson: path.join(d, 'contracts.json'),
    plan: path.join(d, 'plan.json'),
    slices: path.join(d, 'slices.json'),
    critiquesDir: path.join(d, 'critiques'),
    reviewsDir: path.join(d, 'reviews'),
    evidenceDir: path.join(d, 'evidence'),
    ledger: path.join(d, 'ledger.jsonl'),
    budget: path.join(d, 'budget.json'),
    questions: path.join(d, 'questions.json'),
    recipeLock: path.join(d, 'recipe.lock.json'),
    report: path.join(d, 'completion-report.md'),
    amendmentsDir: path.join(d, 'amendments'),
    worktree: path.join(root, '.factory', 'worktrees', jobId),
  };
}

function taskWorktree(root, jobId, taskId) {
  return path.join(root, '.factory', 'worktrees', `${jobId}-${taskId}`);
}

module.exports = { PLUGIN_ROOT, pluginPath, findRoot, requireRoot, project, jobPaths, taskWorktree };
