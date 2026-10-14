'use strict';
// agentStop gate: the agent may not end its turn while an active change job owes floors
// and nothing is waiting on the human.
//
// Copilot's agentStop payload carries no last assistant message (only transcriptPath,
// stopReason, stop_hook_active; docs/research/hooks.md §4, §8 row 7), so the Claude-era
// "done claim" check can't be the trigger. The rule is now (DESIGN-COPILOT "Stop gate"):
// block when a job the session is on is `active`, not waiting on the human — no pending
// gate, not parked, no unanswered clarify/ground questions, no "ask the user" record
// result since the last `factory next`, last `factory next` action not wait/done/gate/
// parked — and its floors (before_ship, or full once merged) are unmet.
//
// Best effort only: if a last message is available (a Claude-shaped payload, or a readable
// JSONL transcript), a closing question to the user counts as waiting, and a "done" claim
// sharpens the reason and adds the jobs it names. Never required.
//
// Runaway guard: Copilot ends the turn after 8 consecutive blocks (CL 1.0.72). We stop at
// 3 in a row (.factory/stop-blocks.json), log stop_block_cap, and let the turn end. The
// counter restarts when stop_hook_active is false (a fresh stop, not a continuation), on
// every user prompt (prompt.js), and after 30 minutes.

const fs = require('fs');
const path = require('path');
const { safe, emit, findRoot } = require('./lib');

const MAX_BLOCKS = 3;
const COUNTER_TTL_MS = 30 * 60 * 1000;

const THING = '(?:job|feature|fix|bug ?fix|change|changes|work|implementation|task|pr|pull request|refactor|patch|migration|update)';
const CLAIM = new RegExp([
  '\\b(?:all|everything(?: is| has been)?|we\'re|we are|i\'m|i am)\\s+(?:now\\s+)?(?:done|finished|complete|set)\\b',
  '\\bready (?:to|for) (?:merge|ship|review|go)\\b',
  `\\b${THING}s?\\b[^.\\n]{0,40}\\b(?:is|are|has been|have been|'s)\\s+(?:now\\s+)?(?:fully\\s+)?(?:done|complete|completed|finished|ready|shipped|merged|implemented)\\b`,
  `\\b(?:i|we)(?:'ve| have)?\\s+(?:now\\s+)?(?:fully\\s+|successfully\\s+)?(?:completed|finished|wrapped up|shipped|implemented|delivered)\\s+(?:the|this|your|all|that)\\b`,
  '\\b(?:that|this|it)(?:\'s| is)\\s+(?:now\\s+)?(?:all\\s+)?(?:done|complete|finished|shipped)\\b',
  '^\\s*(?:done|shipped|complete|finished)\\s*[.!]*\\s*$',
  '\\b(?:has been|is now|now) shipped\\b',
].join('|'), 'i');
// Questions, conditionals and negations next to the claim are not claims.
const QUESTION = /\?\s*$/;
const CONDITIONAL = /^\W*(?:once|when|after|until|if|before|as soon as)\b/i;
const NEGATION = /\b(?:not|never|no longer|nothing|yet to|almost|nearly)\b|n't\b/i;

function claims(msg) {
  return String(msg || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .some((s) => {
      const m = CLAIM.exec(s);
      if (!m || QUESTION.test(s) || CONDITIONAL.test(s) || /\b(?:once|when|if|until|after|before|whether)\s+(?:the\s+)?$/i.test(s.slice(0, m.index))) return false;
      return !NEGATION.test(s.slice(Math.max(0, m.index - 25), m.index + m[0].length));
    });
}

// The turn ends on a question to the user: the agent is legitimately waiting.
function asksUser(msg) {
  const lines = String(msg || '').trim().split(/\n+/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && /\?\s*[*_`)"']*\s*$/.test(lines[lines.length - 1]);
}

// Text of an assistant entry in whatever JSONL shape the transcript uses (undocumented and
// not a stable API: Copilot session events, Claude transcripts, plain role/content lines).
function textOf(e) {
  if (!e || typeof e !== 'object') return null;
  const flat = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x && x.type === 'text' ? x.text : '')).join('\n') : null);
  const type = String(e.type || e.kind || '');
  const role = String(e.role || (e.message && e.message.role) || (e.data && e.data.role) || '');
  if (role === 'assistant' || /^assistant(\.message)?$/.test(type)) {
    return flat(e.content) || flat(e.message && e.message.content) || flat(e.data && (e.data.content || e.data.text || e.data.message)) || flat(e.text) || null;
  }
  return null;
}

function lastAssistantText(file) {
  try {
    if (!file) return null;
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const t = textOf(e);
      if (t && t.trim()) return t;
    }
  } catch {
    /* unreadable transcript: never required */
  }
  return null;
}

// Tail of the event log: the last `factory record` and `factory next` for a job.
function lastCli(root, jobId) {
  const out = { record: null, next: null };
  try {
    const f = path.join(root, '.factory', 'log', 'events.jsonl');
    const st = fs.statSync(f);
    const len = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && !(out.record && out.next); i--) {
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (e.event !== 'cli' || e.job !== jobId) continue;
      if (e.cmd === 'record' && !out.record) out.record = { ...e, i };
      if (e.cmd === 'next' && !out.next) out.next = { ...e, i };
    }
  } catch {
    /* no log yet */
  }
  return out;
}

// Why the agent is legitimately waiting on the human, or null.
function waitingOnHuman(root, state) {
  if (state.status !== 'active') return `job is ${state.status}`;
  if (state.pending_gate) return `waiting at ${state.pending_gate.id}`;
  const lastAction = String(state.last_decision || '').split(':')[0];
  if (['wait', 'done', 'gate', 'parked'].includes(lastAction)) return `last factory next said ${lastAction}`;
  const { readJson } = require('../cli/lib/util');
  const { jobPaths } = require('../cli/lib/paths');
  const ledger = require('../cli/core/ledger');
  const answers = readJson(jobPaths(root, state.id).answers, []);
  const answeredIds = new Set(answers.map((a) => a.id).filter(Boolean));
  const answeredQs = new Set(answers.map((a) => a.question));
  const clarify = ledger.lastStep(root, state.id, 'clarify');
  const openQ = clarify && !clarify.ok && clarify.detail ? (clarify.detail.question_ids || []).filter((id) => !answeredIds.has(id)) : [];
  if (openQ.length) return `clarify questions unanswered (${openQ.join(', ')})`;
  const ground = ledger.lastStep(root, state.id, 'ground');
  const blocking = ground && !ground.ok && ground.detail ? (ground.detail.blocking || []).filter((q) => !answeredQs.has(q)) : [];
  if (blocking.length) return `${blocking.length} blocking question(s) from ground unanswered`;
  const cli = lastCli(root, state.id);
  if (cli.record && ['needs_user', 'degraded', 'park'].includes(cli.record.status) && (!cli.next || cli.next.i < cli.record.i)) return `last factory record asked for the user (${cli.record.status})`;
  return null;
}

function counterFile(root) {
  return path.join(root, '.factory', 'stop-blocks.json');
}

function readCounter(root) {
  try {
    const c = JSON.parse(fs.readFileSync(counterFile(root), 'utf8'));
    if (!(Date.now() - Date.parse(c.at) < COUNTER_TTL_MS)) return 0;
    return Number(c.count) || 0;
  } catch {
    return 0;
  }
}

function writeCounter(root, count) {
  try {
    if (!count) fs.rmSync(counterFile(root), { force: true });
    else fs.writeFileSync(counterFile(root), JSON.stringify({ count, at: new Date().toISOString() }) + '\n');
  } catch {
    /* best effort */
  }
}

if (require.main === module) safe((input) => {
  // Agents started by `factory run` are their own sessions; their result goes through factory record, not this gate.
  if (process.env.FACTORY_RUNNER === '1') return;
  const cwd = input.cwd;
  const root = findRoot(cwd);
  if (!root) return;
  const msg = input.lastMessage || lastAssistantText(input.transcriptPath) || '';
  const claimed = claims(msg);
  let count = input.stopHookActive === false ? 0 : readCounter(root);
  const job = require('../cli/core/job');
  const ids = new Set();
  const cur = job.current(root);
  if (cur) ids.add(cur);
  const wt = cwd.match(/\.factory[\\/]worktrees[\\/](J-\d+)/);
  if (wt) ids.add(wt[1]);
  if (claimed) for (const m of msg.matchAll(/\bJ-\d{4,}\b/g)) ids.add(m[0]);
  const steps = require('../cli/core/steps');
  const floors = require('../cli/core/floors');
  const events = require('../cli/core/events');
  const owed = [];
  for (const id of ids) {
    let state;
    try {
      state = job.load(root, id);
    } catch {
      continue; // named but not a job here
    }
    if (!state || state.status !== 'active') continue;
    const ctx = steps.context(root, state, job.load);
    if (ctx.recipe.outcome !== 'change') continue;
    // Merging is the human's step: before it, only pre-ship floors can be owed by the agent.
    const r = floors.evaluate(ctx, state.pr && state.pr.merged ? 'full' : 'before_ship');
    if (r.ok) continue;
    if (waitingOnHuman(root, state)) continue;
    owed.push({ state, missing: r.missing });
  }
  // Ending on a question to the user is waiting too — unless it claims done.
  if (!owed.length || (!claimed && asksUser(msg))) {
    writeCounter(root, 0);
    return;
  }
  if (count >= MAX_BLOCKS) {
    for (const o of owed) events.append(root, { event: 'stop_block_cap', job: o.state.id, missing: o.missing, blocks: count, decision_id: o.state.last_decision_id || null });
    writeCounter(root, 0);
    return;
  }
  count += 1;
  writeCounter(root, count);
  for (const o of owed) events.append(root, { event: 'stop_block', job: o.state.id, missing: o.missing, claimed, blocks: count, decision_id: o.state.last_decision_id || null });
  const list = owed.map((o) => `${o.state.id} (${o.missing.join(', ')})`).join('; ');
  emit({
    decision: 'block',
    reason: `[factory] ${claimed ? 'Not done' : 'Not finished'}: floors not met for ${list}, and nothing is waiting on the user. Run \`factory next\` (or the factory command from session start) and keep going. If you truly need the user, ask them one clear question and end your turn with it.`,
  });
});

module.exports = { claims, asksUser, lastAssistantText, waitingOnHuman, MAX_BLOCKS };
