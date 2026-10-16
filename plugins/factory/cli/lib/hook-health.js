'use strict';
// Hook heartbeat (0.8.1). A hook that never runs is silent: VS Code shows its stderr only in the
// Output panel's "GitHub Copilot Chat Hooks" channel, and the launchers in hooks.json always exit
// 0 (a broken hook must not deny every tool). So every hook invocation leaves a trace:
//   - ~/.factory/hooks.log (FACTORY_USER_DIR overrides ~/.factory): one tab-separated line per
//     invocation, written by the hook itself, or by its launcher when it could not start it
//     (script not found, node missing): time, hook, outcome, cwd, detail (which plugin-root
//     variables were set, platform, node version, where the root came from). Capped.
//   - <repo>/.factory/log/hooks.json: { <hook>: { last_seen, outcome, error, … } } when the hook
//     found the repository (throttled: rewritten when the outcome changes or a minute passed).
//   - ~/.factory/plugin-root: the plugin root the factory CLI last ran from. The launchers fall
//     back to it when the host set no PLUGIN_ROOT / COPILOT_PLUGIN_ROOT / CLAUDE_PLUGIN_ROOT and
//     substituted no ${PLUGIN_ROOT} token (VS Code's Local harness on some setups:
//     microsoft/vscode#337374).
// factory doctor reads all three (setup.js hooksHealth).

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_MAX = 256 * 1024;
const LOG_KEEP = 800;
// launcher name (H=factory:<name>) → [script, event argument]
const HOOKS = {
  session: ['session-start.js', 'sessionStart'],
  prompt: ['prompt.js', 'userPromptSubmitted'],
  guard: ['guard.js', 'preToolUse'],
  activity: ['activity.js', 'postToolUse'],
  'subagent-start': ['activity.js', 'subagentStart'],
  'subagent-stop': ['subagent-stop.js', 'subagentStop'],
  stop: ['stop.js', 'agentStop'],
};
const ROOT_VARS = ['PLUGIN_ROOT', 'COPILOT_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT'];

const userDir = () => process.env.FACTORY_USER_DIR || path.join(os.homedir(), '.factory');
const logFile = () => path.join(userDir(), 'hooks.log');
const rootFile = () => path.join(userDir(), 'plugin-root');
const stampFile = (root) => path.join(root, '.factory', 'log', 'hooks.json');

function hookName(script, event) {
  const s = path.basename(String(script || ''));
  for (const [name, [sc, ev]] of Object.entries(HOOKS)) if (sc === s && ev === event) return name;
  return s.replace(/\.js$/, '') || 'unknown';
}

const clean = (v) => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');

function trim(file) {
  try {
    if (fs.statSync(file).size <= LOG_MAX) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.slice(-LOG_KEEP).join('\n') + '\n');
    fs.renameSync(tmp, file);
  } catch {
    /* best effort */
  }
}

// One heartbeat from a hook that ran. Never throws.
function note({ hook, outcome = 'ok', cwd = process.cwd(), root = null, error = null }) {
  const at = new Date().toISOString();
  const detail = {
    vars: ROOT_VARS.filter((k) => process.env[k]),
    platform: process.platform,
    node: process.version,
    ...(process.env.FACTORY_RUNNER === '1' ? { agent: true } : {}),
    ...(error ? { error: clean(error).slice(0, 300) } : {}),
  };
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    fs.appendFileSync(logFile(), `${at}\t${clean(hook)}\t${clean(outcome)}\t${clean(cwd)}\t${JSON.stringify(detail)}\n`);
    trim(logFile());
  } catch {
    /* best effort */
  }
  if (!root) return;
  try {
    const f = stampFile(root);
    let doc = {};
    try {
      doc = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    } catch {
      doc = {};
    }
    const prev = doc[hook];
    if (prev && prev.outcome === outcome && Date.now() - Date.parse(prev.last_seen || 0) < 60000) return;
    doc[hook] = { last_seen: at, outcome, ...(error ? { error: clean(error).slice(0, 300) } : {}), vars: detail.vars, platform: detail.platform, node: detail.node };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmp, f);
  } catch {
    /* best effort */
  }
}

// The factory CLI records where it runs from, for the launchers' fallback. Never throws.
function notePluginRoot(pluginRoot) {
  try {
    const f = rootFile();
    let cur = null;
    try {
      cur = fs.readFileSync(f, 'utf8').trim();
    } catch {
      cur = null;
    }
    if (cur === pluginRoot) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${pluginRoot}\n`);
  } catch {
    /* best effort */
  }
}

function readLog() {
  try {
    return fs.readFileSync(logFile(), 'utf8').split('\n').filter(Boolean).map((l) => {
      const [at, hook, outcome, cwd, detail] = l.split('\t');
      let d = {};
      try {
        d = JSON.parse(detail || '{}');
      } catch {
        d = { raw: detail };
      }
      return { at, hook, outcome, cwd, ...d };
    });
  } catch {
    return [];
  }
}

const REMEDY = {
  not_found: 'The host ran the hook without telling it where the plugin is (no PLUGIN_ROOT, COPILOT_PLUGIN_ROOT or CLAUDE_PLUGIN_ROOT, no ${PLUGIN_ROOT} substitution; VS Code on Windows/WSL: microsoft/vscode#337374). Run `factory doctor` once in a terminal of the same machine the hooks run on (here: it records the plugin root in ~/.factory/plugin-root, which the hooks now fall back to), then send a new chat message. If it persists, check the Output panel, channel "GitHub Copilot Chat Hooks".',
  node_missing: 'The hook shell has no `node` on its PATH (a non-login shell does not read ~/.bashrc or ~/.profile). Put node on the system PATH (e.g. a symlink in /usr/local/bin) or install it system-wide, then send a new chat message.',
  failed: 'The hook started but failed: see the error, the Output panel channel "GitHub Copilot Chat Hooks" (VS Code), and `FACTORY_HOOK_DEBUG=1`.',
  node_old: 'The hook shell runs a Node older than 14: put a newer node first on the PATH the hooks get.',
};

// Per hook, for factory doctor: { hook, status: 'ok'|'error'|'never', last_seen, outcome, detail, remedy }.
function health(root) {
  let stamps = {};
  try {
    stamps = JSON.parse(fs.readFileSync(stampFile(root), 'utf8')) || {};
  } catch {
    stamps = {};
  }
  const inRoot = (cwd) => {
    if (!cwd) return false;
    const r = path.resolve(root);
    const c = path.resolve(cwd);
    return c === r || c.startsWith(r + path.sep);
  };
  const log = readLog().filter((l) => inRoot(l.cwd) && l.agent !== true);
  const out = [];
  for (const hook of Object.keys(HOOKS)) {
    const fromLog = log.filter((l) => l.hook === hook || l.hook === `factory:${hook}`).pop() || null;
    const st = stamps[hook] ? { at: stamps[hook].last_seen, outcome: stamps[hook].outcome, error: stamps[hook].error } : null;
    const last = [fromLog && { at: fromLog.at, outcome: fromLog.outcome, error: fromLog.error, vars: fromLog.vars }, st].filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at))).pop() || null;
    if (!last) {
      out.push({ hook, status: 'never', last_seen: null });
      continue;
    }
    const outcome = String(last.outcome || 'ok');
    const kind = outcome.startsWith('not_found') ? 'not_found' : outcome.startsWith('node_missing') ? 'node_missing' : outcome.startsWith('node_old') ? 'node_old' : outcome === 'ok' ? null : 'failed';
    out.push({ hook, status: kind ? 'error' : 'ok', last_seen: last.at, outcome, ...(last.error ? { error: last.error } : {}), ...(kind ? { remedy: REMEDY[kind] } : {}) });
  }
  return out;
}

module.exports = { note, notePluginRoot, health, hookName, readLog, userDir, logFile, rootFile, stampFile, HOOKS, ROOT_VARS, REMEDY };
