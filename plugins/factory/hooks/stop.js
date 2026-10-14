'use strict';
// agentStop gate: a nudge, not a wall. It blocks the end of a turn AT MOST ONCE per routing
// decision, and only when it is sure the agent abandoned the step `factory next` gave it:
//   - the job is active, a change job, and its floors (before_ship, or full once merged) are unmet;
//   - the router assigned the agent a step (state.last_decision_id) and its last action is
//     not wait / gate / parked / done / questions, and nothing is waiting on the human
//     (pending gate, park, unanswered clarify/ground questions, a "needs the user" record);
//   - no `factory run` is in progress for the job (a live run.lock);
//   - nothing was attempted under that decision (any cli / wfargs / record / run / agent event
//     carrying its decision_id counts: the agent is on it, or it failed in a way it reports);
//   - this turn is factory work: the human's prompt was /factory:… or a factory reply, or a
//     factory command ran during the turn (prompt.js stamps .factory/turn.json). A turn that
//     only answered the user about something else is never blocked;
//   - the turn's last message does not ask the user something (best effort only: Copilot's
//     agentStop payload carries no message and the transcript is often not flushed yet);
//   - the gate has not already blocked this decision (.factory/stop-blocks.json keeps the
//     decision ids it blocked, across turns and continuations).
// When unsure, it allows. Every block is logged as stop_block (the inspector and console read it).

const fs = require('fs');
const path = require('path');
const { safe, emit, findRoot, STOP_MARK } = require('./lib');

const MAX_BLOCKS = 1; // per routing decision
const WAIT_ACTIONS = new Set(['wait', 'gate', 'parked', 'done', 'questions']);
// Commands that only look: running them is not an attempt at the assigned step.
const LOOKS = new Set(['next', 'why', 'help', 'doctor', 'console', 'job', 'contract', 'doc', 'report', 'recipe', 'telemetry', 'use', 'shim']);

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

// The turn ends by asking the user something: the agent is legitimately waiting. Looks at
// the last paragraph (markdown and trailing emoji stripped) for a question mark or a phrase
// that hands the turn to the user.
const ASK = /\?|\b(let me know|reply|respond|answer (?:the|these|this|my)|tell me|please (?:confirm|choose|pick|decide|review|approve|answer)|confirm (?:whether|that|if|which)|would you like|do you want|want me to|should i|shall i|which (?:one|option|do you)|your (?:call|decision|choice|go-ahead|answer|approval|input|review)|waiting (?:for|on) (?:you|your)|awaiting your|once you (?:approve|reply|confirm|decide)|approve or deny|approve\b.*\bdeny|\[y\/n\]|\(y\/n\)|y\/n)\b/i;

function asksUser(msg) {
  const text = String(msg || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_`>#]+/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .trim();
  if (!text) return false;
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paras[paras.length - 1] || '';
  const lines = last.split('\n').map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-3).join('\n');
  return ASK.test(tail);
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

function isUserEntry(e) {
  if (!e || typeof e !== 'object') return false;
  const type = String(e.type || e.kind || '');
  const role = String(e.role || (e.message && e.message.role) || '');
  return type === 'user.message' || type === 'user' || role === 'user';
}

// The last assistant message of the CURRENT turn: an assistant entry after the last user
// entry. null when the transcript has none yet (not flushed) or can't be read.
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
      if (isUserEntry(e)) return null; // the user spoke last: this turn's message isn't written yet
      const t = textOf(e);
      if (t && t.trim()) return t;
    }
  } catch {
    /* unreadable transcript: never required */
  }
  return null;
}

// Waits briefly for the current turn's message (Copilot may not have flushed it when the
// first agentStop hook runs). Only called when the gate is about to block.
function currentMessage(input, waitMs = 600) {
  if (input.lastMessage) return input.lastMessage;
  const until = Date.now() + waitMs;
  for (;;) {
    const m = lastAssistantText(input.transcriptPath);
    if (m || Date.now() >= until || !input.transcriptPath) return m;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

function readLog(root) {
  try {
    const f = path.join(root, '.factory', 'log', 'events.jsonl');
    const st = fs.statSync(f);
    const len = Math.min(st.size, 2 * 1024 * 1024);
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const out = [];
    for (const l of buf.toString('utf8').split('\n')) {
      if (!l) continue;
      try {
        out.push(JSON.parse(l));
      } catch {
        /* a cut first line or a bad one */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Tail of the event log: the last `factory record` and `factory next` for a job.
function lastCli(log, jobId) {
  const out = { record: null, next: null };
  for (let i = log.length - 1; i >= 0 && !(out.record && out.next); i--) {
    const e = log[i];
    if (e.event !== 'cli' || e.job !== jobId) continue;
    if (e.cmd === 'record' && !out.record) out.record = { ...e, i };
    if (e.cmd === 'next' && !out.next) out.next = { ...e, i };
  }
  return out;
}

// Was the assigned step attempted? Any cli / wfargs / record / run / agent event under the
// decision counts (a refused or failed attempt included: the agent reports those itself).
function attempted(log, decisionId) {
  return log.some((e) => e.decision_id === decisionId && (e.event === 'agent_run' || (e.event === 'cli' && !LOOKS.has(e.cmd))));
}

// Did a factory command run during this turn (since the human's prompt)?
function factoryRanSince(log, at) {
  const t0 = Date.parse(at || '');
  if (!Number.isFinite(t0)) return false;
  return log.some((e) => (e.event === 'cli' || e.event === 'agent_run') && Date.parse(e.ts) >= t0);
}

function runInProgress(root, id) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'jobs', id, 'run.lock'), 'utf8'));
    return require('../cli/core/runner').lockAlive(lock);
  } catch {
    return false;
  }
}

// Why the agent is legitimately waiting on the human (or on a run), or null.
function waitingOnHuman(root, state, log = readLog(root)) {
  if (state.status !== 'active') return `job is ${state.status}`;
  if (state.pending_gate) return `waiting at ${state.pending_gate.id}`;
  const lastAction = String(state.last_decision || '').split(':')[0];
  if (WAIT_ACTIONS.has(lastAction)) return `last factory next said ${lastAction}`;
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
  const cli = lastCli(log, state.id);
  if (cli.record && ['needs_user', 'degraded', 'park'].includes(cli.record.status) && (!cli.next || cli.next.i < cli.record.i)) return `last factory record asked for the user (${cli.record.status})`;
  return null;
}

// .factory/stop-blocks.json: { blocked: [decision ids the gate already blocked] }.
function blocksFile(root) {
  return path.join(root, '.factory', 'stop-blocks.json');
}

function readBlocked(root) {
  try {
    const c = JSON.parse(fs.readFileSync(blocksFile(root), 'utf8'));
    return new Set(Array.isArray(c.blocked) ? c.blocked : []);
  } catch {
    return new Set();
  }
}

function writeBlocked(root, set) {
  try {
    fs.writeFileSync(blocksFile(root), JSON.stringify({ blocked: [...set].slice(-200), at: new Date().toISOString() }) + '\n');
  } catch {
    /* best effort */
  }
}

// prompt.js: what started this turn. { at, factory: bool } or null.
function readTurn(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.factory', 'turn.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Decides; returns { block: false, why } or { block: true, owed: [...], claimed }.
function decide(input, root) {
  const job = require('../cli/core/job');
  const steps = require('../cli/core/steps');
  const floors = require('../cli/core/floors');
  const cwd = input.cwd;
  const log = readLog(root);
  // Is this turn factory work at all?
  const turn = readTurn(root);
  const factoryTurn = Boolean(turn && turn.factory) || factoryRanSince(log, turn && turn.at);
  if (!factoryTurn) return { block: false, why: 'not a factory turn' };
  const ids = new Set();
  const cur = job.current(root);
  if (cur) ids.add(cur);
  const wt = cwd.match(/\.factory[\\/]worktrees[\\/](J-\d+)/);
  if (wt) ids.add(wt[1]);
  const blockedBefore = readBlocked(root);
  const owed = [];
  for (const id of ids) {
    let state;
    try {
      state = job.load(root, id);
    } catch {
      continue;
    }
    if (!state || state.status !== 'active' || !state.last_decision_id) continue;
    if (blockedBefore.has(state.last_decision_id)) continue; // at most once per decision
    const ctx = steps.context(root, state, job.load);
    if (ctx.recipe.outcome !== 'change') continue;
    const r = floors.evaluate(ctx, state.pr && state.pr.merged ? 'full' : 'before_ship');
    if (r.ok) continue;
    if (waitingOnHuman(root, state, log)) continue;
    if (runInProgress(root, id)) continue;
    if (attempted(log, state.last_decision_id)) continue;
    owed.push({ state, missing: r.missing });
  }
  if (!owed.length) return { block: false, why: 'nothing owed' };
  const msg = currentMessage(input) || '';
  if (asksUser(msg)) return { block: false, why: 'asks the user' };
  return { block: true, owed, claimed: claims(msg) };
}

if (require.main === module) safe((input) => {
  // Agents started by `factory run` are their own sessions; their result goes through factory record, not this gate.
  if (process.env.FACTORY_RUNNER === '1') return;
  const root = findRoot(input.cwd);
  if (!root) return;
  const d = decide(input, root);
  if (!d.block) return;
  const events = require('../cli/core/events');
  const blocked = readBlocked(root);
  for (const o of d.owed) blocked.add(o.state.last_decision_id);
  writeBlocked(root, blocked);
  for (const o of d.owed) events.append(root, { event: 'stop_block', job: o.state.id, missing: o.missing, claimed: d.claimed, blocks: 1, decision_id: o.state.last_decision_id || null, step: String(o.state.last_decision || '').split(':').slice(0, 2).join(':') || null });
  const list = d.owed.map((o) => {
    const [action, step] = String(o.state.last_decision || '').split(':');
    return `${o.state.id}: factory next asked for ${step || action || 'a step'} and it hasn't been started (floors not met: ${o.missing.join(', ')})`;
  }).join('; ');
  emit({ decision: 'block', reason: `${STOP_MARK} ${d.claimed ? 'Not done' : 'Not finished'} — ${list}. Do that step now (run \`factory next\` to see it), or if you need the user, ask them one clear question and end your turn. This reminder is shown once.` });
});

module.exports = { claims, asksUser, lastAssistantText, waitingOnHuman, decide, MAX_BLOCKS };
