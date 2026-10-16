'use strict';
// Model safety (review B1): the per-role default models must never break an account that cannot
// use them (an older CLI, an org that has not enabled a model, a plan without it, BYOK).
//
//   - policy.agents.models_enabled: false (or agents.models: "default") in the live
//     .factory/policy.json runs every role on the Copilot session default, for running jobs too.
//   - A turn the CLI refused because of its --model is spawned again once without --model
//     (agent_model_fallback event); the id is skipped for the rest of the run and remembered in
//     .factory/cache/rejected-models.json for REJECT_TTL_DAYS, so later runs skip it too.
//   - factory doctor reports the CLI version and warns below the release that added a default id.
//
// The CLI's wording for an unusable --model is not documented: changelog 0.0.421 says only
// "Error when --model flag specifies an unavailable model" (docs/research/copilot-cli-usage.md
// §2). So a rejection is matched conservatively: a non-zero exit, no assistant reply in the
// output, and text that names the model (the word or the id) together with a refusal word.

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, nowIso } = require('../lib/util');

const REJECT_TTL_DAYS = 3;
// The release that added each default id (copilot-cli changelog: 1.0.89 "Adding support for
// claude-opus-5.5", 1.0.94 "Add Claude Haiku 5.5 to model selection and --model completions").
// claude-sonnet-5.5 has no changelog entry: unknown, so no version warning for it.
const MIN_CLI = { 'claude-opus-5.5': '1.0.89', 'claude-haiku-5.5': '1.0.94' };

const cacheFile = (root) => path.join(root, '.factory', 'cache', 'rejected-models.json');

// The live switch: every role on the session default.
function modelsOff(policy) {
  const a = (policy && policy.agents) || {};
  return a.models_enabled === false || a.models === 'default' || a.models === null;
}

function loadRejected(root, now = Date.now()) {
  const doc = readJson(cacheFile(root), null) || {};
  const out = new Map();
  for (const [id, v] of Object.entries(doc.models || {})) {
    if (v && v.at && now - Date.parse(v.at) < REJECT_TTL_DAYS * 864e5) out.set(id, v);
  }
  return out;
}

function noteRejected(root, id, detail) {
  try {
    const doc = readJson(cacheFile(root), null) || { version: 1, models: {} };
    doc.models = doc.models || {};
    doc.models[id] = { at: nowIso(), detail: String(detail || '').slice(0, 300) };
    fs.mkdirSync(path.dirname(cacheFile(root)), { recursive: true });
    writeJson(cacheFile(root), doc);
  } catch {
    /* the in-run memory still skips it */
  }
}

const REFUSAL = /\b(not available|unavailable|not supported|unsupported|unknown|invalid|not found|not enabled|not allowed|no access|does not exist|isn't available|not recognized|not permitted|disabled)\b/i;

// The CLI refused the turn because of its --model: the reason line, or null.
function rejection(r, id) {
  if (!r || !id || r.code === 0 || r.timedOut) return null;
  const out = String(r.stdout || '');
  if (/"type"\s*:\s*"assistant\.message"/.test(out) && /"content"\s*:\s*"[^"]/.test(out)) return null; // the agent answered: not a startup refusal
  const lines = `${r.stderr || ''}\n${out}`.split('\n').map((l) => l.trim()).filter(Boolean);
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hit = lines.find((l) => (new RegExp(esc, 'i').test(l) || /\bmodels?\b/i.test(l)) && REFUSAL.test(l));
  return hit ? hit.slice(0, 300) : null;
}

const parseVersion = (s) => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s || ''));
  return m ? m.slice(1).map(Number) : null;
};
const below = (v, min) => {
  const a = parseVersion(v);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

// Doctor: which default ids this CLI version predates.
function versionWarnings(version, ids) {
  return [...new Set(ids)].filter((id) => MIN_CLI[id] && below(version, MIN_CLI[id])).map((id) => ({ id, min: MIN_CLI[id] }));
}

module.exports = { modelsOff, loadRejected, noteRejected, rejection, versionWarnings, parseVersion, cacheFile, MIN_CLI, REJECT_TTL_DAYS };
