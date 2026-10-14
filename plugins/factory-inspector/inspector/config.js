'use strict';
// On / off / sampling, per recipe, plus clean streaks and automatic re-arming.
//   mode "on"      inspect every closed job of that recipe
//   mode "sample"  inspect one job in N (by job number)
//   mode "off"     don't inspect that recipe (logs are still kept; you can inspect later)
// Turning the whole inspector off is just disabling the plugin.

const { readJson, writeJson, layout } = require('./io');

// Thresholds for the factory-wide and per-job health rules (R10–R19). Edit them in
// .factory/inspect/config.json under "limits"; switch rules off with "rules_off"
// (a rule id like "R18.slow_reply" or a family like "R18").
const LIMITS = {
  hook_errors: 1, // the same hook failure seen this many times
  guard_denials_per_job: 5,
  stop_blocks_per_job: 2,
  replies_refused_per_job: 2,
  replies_unparsed_per_job: 2,
  cli_failures: 3, // the same command failing with the same code in one job
  stale_results_per_job: 2,
  workflow_errors_per_job: 2,
  agent_retries_per_job: 4,
  agent_failures_per_job: 2,
  escalations_per_job: 2,
  step_failures: 3, // the same step recorded as failed (prove/challenge are R6's)
  orphan_agent_minutes: 120,
  parks_per_job: 3,
  resumes_per_job: 3,
  idle_hours: 72,
  reply_hours: 48,
  questions_dropped_per_job: 3, // clarify questions over budget or re-asked, dropped by the CLI
};
const DEFAULTS = { version: 1, mode: 'on', sample_every: 10, settle_after: 20, threshold: 3, recipes: {}, limits: LIMITS, rules_off: [] };

function load(root) {
  const file = readJson(layout(root).config, {}) || {};
  return { ...DEFAULTS, ...file, limits: { ...LIMITS, ...(file.limits || {}) }, rules_off: file.rules_off || [] };
}

function ruleOn(cfg, rule) {
  return !(cfg.rules_off || []).some((p) => rule === p || rule.startsWith(`${p}.`));
}

function save(root, cfg) {
  writeJson(layout(root).config, cfg);
}

function recipeCfg(cfg, id) {
  cfg.recipes[id] = cfg.recipes[id] || { mode: null, sample_every: null, streak: 0, rulebook: null, rearmed_at: null, inspected: 0 };
  return cfg.recipes[id];
}

function modeFor(cfg, id) {
  const r = cfg.recipes[id];
  return { mode: (r && r.mode) || cfg.mode, every: (r && r.sample_every) || cfg.sample_every };
}

function shouldInspect(cfg, recipeId, jobId) {
  const { mode, every } = modeFor(cfg, recipeId);
  if (mode === 'off') return { inspect: false, why: `inspection is off for ${recipeId}` };
  if (mode === 'sample') {
    const n = parseInt(String(jobId).replace(/\D/g, ''), 10) || 0;
    return n % every === 0 ? { inspect: true, why: `sampled (1 in ${every})` } : { inspect: false, why: `not sampled (1 in ${every})` };
  }
  return { inspect: true, why: 'inspection is on' };
}

// The rules changed → the old streak means nothing; inspect everything again.
function rearmIfChanged(cfg, recipeId, rulebook) {
  const r = recipeCfg(cfg, recipeId);
  if (r.rulebook && rulebook && r.rulebook !== rulebook) {
    const was = r.mode;
    r.streak = 0;
    r.mode = null; // back to the global mode (normally "on")
    r.rearmed_at = new Date().toISOString();
    r.rulebook = rulebook;
    return { rearmed: true, was };
  }
  if (!r.rulebook) r.rulebook = rulebook;
  return { rearmed: false };
}

function suggestions(cfg) {
  const out = [];
  for (const [id, r] of Object.entries(cfg.recipes)) {
    const { mode, every } = modeFor(cfg, id);
    if (mode === 'on' && r.streak >= cfg.settle_after) out.push({ recipe: id, streak: r.streak, suggest: `inspect mode ${id} sample ${cfg.sample_every}`, why: `${r.streak} clean jobs in a row on the current rules` });
    if (mode === 'sample' && r.streak >= cfg.settle_after * 3) out.push({ recipe: id, streak: r.streak, suggest: `inspect mode ${id} off`, why: `${r.streak} clean jobs in a row while sampling 1 in ${every}` });
  }
  return out;
}

function setMode(cfg, target, mode, every) {
  if (!['on', 'off', 'sample'].includes(mode)) throw new Error('mode must be on, off or sample');
  const n = every ? parseInt(every, 10) : null;
  if (mode === 'sample' && every && !(n > 0)) throw new Error('sample needs a positive number');
  if (target === 'all') {
    cfg.mode = mode;
    if (n) cfg.sample_every = n;
  } else {
    const r = recipeCfg(cfg, target);
    r.mode = mode;
    if (n) r.sample_every = n;
  }
  return cfg;
}

module.exports = { load, save, recipeCfg, modeFor, shouldInspect, rearmIfChanged, suggestions, setMode, ruleOn, DEFAULTS, LIMITS };
