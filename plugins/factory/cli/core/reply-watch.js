'use strict';
// Dead reply hook detection. Your chat replies ("approve", "deny …", "resume") reach the
// factory only through the prompt hook (hooks/prompt.js), which also stamps every human
// prompt in .factory/turn.json. When `factory next` waits on you and no stamp has arrived
// since it first showed that wait, or none ever has in a repo where the factory already
// waited on you, the hooks are not running in this chat (VS Code: wrong harness, hooks
// off, untrusted folder; a plugin that isn't loaded): typing "approve" in chat would do
// nothing. `factory next` then adds a `notice` saying so, how to diagnose it, and the
// terminal fallback — once per wait (.factory/reply-watch.json remembers which).

const fs = require('fs');
const path = require('path');
const { nowIso } = require('../lib/util');

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(f, v) {
  try {
    fs.writeFileSync(f, JSON.stringify(v) + '\n');
  } catch {
    /* best effort: at worst the notice shows again */
  }
}

// The wait on the human this output stands for, or null when the next move isn't yours.
function humanWait(r) {
  if (!r || !r.job) return null;
  if (r.action === 'gate' && r.gate) return { key: `gate:${r.gate.id}:${r.gate.hash || ''}`, what: `${r.gate.id}`, command: r.gate.id === 'A' ? `factory approve --job ${r.job}` : `factory approve ${r.gate.id} --job ${r.job}`, alt: `factory deny --job ${r.job} --reason "<what must change>"` };
  if (r.action === 'parked') return { key: `parked:${r.reason || ''}`.slice(0, 200), what: 'the park', command: `factory resume --job ${r.job}`, alt: `factory cancel --job ${r.job}` };
  if (r.action === 'wait' && /reply "merged/.test(r.reason || '')) return { key: 'wait:merged', what: 'the merge', command: `factory merged <commit> --job ${r.job}`, alt: null };
  return null;
}

function message(w, never) {
  const why = never ? 'no chat prompt has ever reached the factory\'s prompt hook in this repo' : `no chat prompt has reached the factory's prompt hook since it started waiting on ${w.what}`;
  return [
    `Chat replies aren't reaching the factory: ${why}, so a reply like "approve" typed in chat is NOT applied.`,
    'To fix it: (1) check the harness — the chat title prefix (or the Session Target control) shows it; use Copilot. In the Local harness hooks need chat.useHooks on and a trusted folder (Workspace Trust).',
    '(2) Run "Chat: Configure Hooks" from the Command Palette: the factory plugin\'s hooks.json should be listed.',
    '(3) Open the Output panel, channel "GitHub Copilot Chat Hooks", for hook runs and errors.',
    '(4) In the Copilot CLI, /plugin list should show factory enabled.',
    `Meanwhile, act from your own terminal: ${w.command}${w.alt ? ` (or ${w.alt})` : ''} — it shows a short code on that terminal for you to type back.`,
  ].join(' ');
}

// The notice for this `factory next` output, or null. Records the wait it saw.
function notice(root, r) {
  const w = humanWait(r);
  if (!w) return null;
  const dir = path.join(root, '.factory');
  const watchFile = path.join(dir, 'reply-watch.json');
  const turn = readJson(path.join(dir, 'turn.json'));
  const turnAt = turn && Date.parse(turn.at);
  let watch = readJson(watchFile);
  const key = `${r.job}|${w.key}`;
  const fresh = !watch || watch.key !== key;
  if (fresh) watch = { key, since: nowIso(), shown: false };
  let out = null;
  if (!watch.shown) {
    const never = !turn;
    const stale = !fresh && !(turnAt > Date.parse(watch.since));
    if (never || stale) {
      out = message(w, never);
      watch.shown = true;
    }
  }
  writeJson(watchFile, watch);
  return out;
}

module.exports = { notice, humanWait };
