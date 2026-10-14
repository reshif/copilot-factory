'use strict';
// Human-only actions. They are reachable two ways and no other:
//   1. your own chat reply, applied by the UserPromptSubmit hook before the model sees it
//   2. the `factory` CLI from a real terminal (stdin and stdout are TTYs), confirmed by
//      typing the job (or lesson) id on the terminal itself (/dev/tty; CONIN$ on Windows)
// The PreToolUse guard also blocks agents from running these subcommands.
//
// A TTY is not proof of a human: VS Code's Local harness runs agent commands in the
// integrated terminal, and tool approvals there can be automatic (Allow all, Autopilot,
// auto-approve settings). So the terminal path also refuses:
//   - an agent `factory run` started (FACTORY_RUNNER=1);
//   - an environment that shows an agent's shell (best effort, see AGENT_ENV: variables
//     some agent harnesses set for the commands they run; absence proves nothing);
// and asks for the typed confirmation, which an agent's one-shot command can't give (it
// raises the bar; it is not proof either). There is no --yes.
//
// Tests run without a terminal through one seam: FACTORY_TEST_HUMAN set to an HMAC of a
// fixed label under the seal secret (which the guard keeps agents from reading), honoured
// only when stdin or stdout is NOT a terminal and never in a factory agent; the "typed"
// text then comes from FACTORY_TEST_HUMAN_INPUT.

const { nowIso, fail, sha256, readJson } = require('../lib/util');
const { pluginPath } = require('../lib/paths');
const git = require('../lib/git');
const job = require('./job');
const steps = require('./steps');
const ledger = require('./ledger');
const decisions = require('./decisions');
const policyMod = require('./policy');

const GATE_IDS = ['H1', 'H2', 'H3', 'HF', 'HS', 'EH1', 'EH2', 'EH3', 'A'];

// Variables agent harnesses set in the shells they run commands in (best effort: a harness
// that sets none is not detected; the user's own terminal sets none of these).
const AGENT_ENV = [
  ['FACTORY_RUNNER', '1'], // an agent `factory run` started
  ['CLAUDECODE', null], // Claude Code's Bash tool
  ['COPILOT_AGENT_PROMPT', null], // Copilot cloud agent
  ['CODEX_SANDBOX', null], // Codex
  ['CODEX_SANDBOX_NETWORK_DISABLED', null],
  ['GEMINI_CLI', null], // Gemini CLI
];

function agentContext(env = process.env) {
  for (const [k, v] of AGENT_ENV) if (env[k] !== undefined && env[k] !== '' && (v === null || env[k] === v)) return k;
  return null;
}

const TEST_LABEL = 'factory test human seam v1';

function testToken() {
  const crypto = require('crypto');
  const fs = require('fs');
  const key = fs.readFileSync(require('../lib/seal').secretFile(), 'utf8').trim();
  return crypto.createHmac('sha256', key).update(TEST_LABEL).digest('hex');
}

// The test seam: never in a terminal, never in a factory agent, only with the right token.
function testSeam() {
  const t = process.env.FACTORY_TEST_HUMAN;
  if (!t || (process.stdin.isTTY && process.stdout.isTTY) || process.env.FACTORY_RUNNER === '1') return false;
  try {
    const want = testToken();
    return want.length === t.length && require('crypto').timingSafeEqual(Buffer.from(want), Buffer.from(t));
  } catch {
    return false;
  }
}

const HUMAN_MSG = 'This is a human-only action. Reply in chat (e.g. "approve") or run it from your own terminal.';

function requireHumanChannel(channel) {
  if (channel === 'chat') return;
  if (channel === 'tty') {
    if (testSeam()) return; // never in a factory agent (FACTORY_RUNNER=1), see testSeam
    const agent = agentContext();
    if (agent) fail(`${HUMAN_MSG} This shell belongs to an agent (${agent} is set), so it does not count as your terminal.`, 'human_only');
    if (process.stdin.isTTY && process.stdout.isTTY) return;
  }
  fail(HUMAN_MSG, 'human_only');
}

// One line typed on the controlling terminal, read synchronously (the CLI is synchronous).
function readTty(question) {
  const fs = require('fs');
  const win = process.platform === 'win32';
  let inFd;
  let outFd;
  try {
    inFd = fs.openSync(win ? '\\\\.\\CONIN$' : '/dev/tty', win ? 'r' : 'r+');
    outFd = win ? fs.openSync('\\\\.\\CONOUT$', 'w') : inFd;
  } catch {
    fail(`${HUMAN_MSG} (No terminal to confirm on.)`, 'human_only');
  }
  try {
    fs.writeSync(outFd, question);
    const buf = Buffer.alloc(1);
    let line = '';
    for (;;) {
      let n;
      try {
        n = fs.readSync(inFd, buf, 0, 1, null);
      } catch (e) {
        if (e.code === 'EAGAIN') {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          continue;
        }
        throw e;
      }
      if (n === 0) break;
      const c = buf.toString('latin1');
      if (c === '\n' || c === '\r') break;
      if (line.length < 200) line += c;
    }
    return line;
  } finally {
    try {
      fs.closeSync(inFd);
      if (outFd !== inFd) fs.closeSync(outFd);
    } catch {
      /* closed */
    }
  }
}

// The terminal path's typed confirmation: the user types `expected` (a job or lesson id).
// Chat replies need none: the reply itself is the human's words.
function confirmTyped(channel, expected, action) {
  if (channel !== 'tty') return;
  const typed = testSeam() ? String(process.env.FACTORY_TEST_HUMAN_INPUT || '') : readTty(`Type ${expected} to ${action}: `);
  if (typed.trim().toUpperCase() !== String(expected).toUpperCase()) {
    fail(`Not confirmed: you typed "${typed.trim().slice(0, 40)}", not ${expected}. Nothing was done.`, 'not_confirmed');
  }
}

function log(root, state, action, extra = {}) {
  decisions.write(root, { job: state.id, action: `human.${action}`, chosen: action, rule: 'human', during: state.last_decision_id || null, ...extra });
}

function currentGateHash(root, state, gate) {
  if (gate === 'A') return state.amendment ? state.amendment.hash : null;
  const ctx = steps.context(root, state, job.load);
  return steps.gateHash(ctx, gate);
}

// Keep a copy of what was approved, so an amendment can diff against it later.
function snapshot(root, state, gate, hash) {
  const path = require('path');
  const fs = require('fs');
  const { jobPaths } = require('../lib/paths');
  const jp = jobPaths(root, state.id);
  const src = ['H1', 'EH1'].includes(gate) ? jp.contract : ['H3', 'EH3'].includes(gate) ? (state.epic ? jp.slices : jp.plan) : null;
  if (!src || !fs.existsSync(src)) return null;
  const dir = path.join(jp.dir, 'approved');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${gate}-${hash.slice(0, 12)}${path.extname(src)}`);
  fs.copyFileSync(src, dest);
  return dest;
}

function approve(root, { jobId, gate, channel, via }) {
  requireHumanChannel(channel);
  const state = job.resolve(root, jobId);
  const pending = state.pending_gate;
  if (!pending || pending.id === 'P') fail(`${state.id} has no gate waiting for approval${pending && pending.id === 'P' ? ' (it is parked: reply "resume", "cancel job" or "abandon job")' : ''}.`, 'no_gate');
  if (gate && gate !== pending.id) fail(`${state.id} is waiting at ${pending.id}, not ${gate}.`, 'wrong_gate');
  const now = currentGateHash(root, state, pending.id);
  if (pending.id === 'A' && state.amendment) {
    const doc = require('../lib/util').readJson(state.amendment.file, {});
    const cur = require('./invalidation').current(root, state);
    if (cur.contract !== doc.contract_hash_after || (doc.plan_hash_after && cur.plan !== doc.plan_hash_after)) {
      fail('The contract or plan changed after the amendment was submitted. Run factory amend submit again, then approve.', 'stale_gate');
    }
  }
  if (!now || now !== pending.hash) {
    fail(`The ${pending.id} document changed after it was presented (or is still being drafted). Ask Copilot to present it again, then approve.`, 'stale_gate');
  }
  confirmTyped(channel, state.id, `approve ${pending.id}`);
  state.approvals[pending.id] = { hash: now, at: nowIso(), via: via || channel, snapshot: snapshot(root, state, pending.id, now) };
  state.pending_gate = null;
  if (pending.id === 'A') require('./amend').applyApproved(root, state);
  job.save(root, state);
  log(root, state, 'approve', { channel, gate: pending.id, hash: now });
  return { job: state.id, gate: pending.id, hash: now, message: `Approved ${pending.id} for ${state.id} (hash ${now.slice(0, 12)}).` };
}

function deny(root, { jobId, reason, channel }) {
  requireHumanChannel(channel);
  const state = job.resolve(root, jobId);
  const pending = state.pending_gate;
  if (!pending || pending.id === 'P') fail(`${state.id} has no gate waiting.`, 'no_gate');
  if (!String(reason || '').trim()) fail(`Say what must change: reply "deny <what must change>" (for example "deny cover negative numbers too"). Nothing was denied; ${pending.id} is still waiting.`, 'needs_reason');
  confirmTyped(channel, state.id, `deny ${pending.id}`);
  state.denials.push({ gate: pending.id, hash: pending.hash, at: nowIso(), reason: reason || '' });
  if (pending.id === 'A') {
    state.amendment.status = 'open';
  }
  job.save(root, state);
  log(root, state, 'deny', { channel, gate: pending.id, reason });
  return { job: state.id, gate: pending.id, message: `Denied ${pending.id} for ${state.id}: ${reason || '(no reason given)'}. Copilot should revise it and present it again.` };
}

function resume(root, { jobId, step, channel }) {
  requireHumanChannel(channel);
  const state = job.resolve(root, jobId);
  if (state.status !== 'parked') fail(`${state.id} is not parked (status: ${state.status}).`, 'not_parked');
  confirmTyped(channel, state.id, 'resume it');
  const from = state.park && state.park.from;
  // One more round of whatever ran out.
  const L = state.policy.limits;
  const oneMore = (key, max) => {
    state.counters[key] = Math.min(state.counters[key], Math.max(0, max - 1));
  };
  if (from === 'review') oneMore('review_rounds', L.max_review_rounds);
  if (from === 'verify') oneMore('verify_fix_rounds', L.max_verify_fix_rounds);
  if (from === 'clarify') {
    oneMore('clarify_rounds', L.max_intent_rounds + 2);
    // Parked on unclear intent: one more intent round, with a question budget.
    const IL = readJson(pluginPath('config', 'workflows', 'clarify.json')).limits.intent_rounds;
    if ((state.counters.intent_rounds || 0) >= IL) {
      state.counters.intent_rounds = IL - 1;
      oneMore('clarify_rounds', L.max_intent_rounds - 1);
    }
  }
  if (from === 'decompose') oneMore('decompose_rounds', L.max_plan_validate_rounds);
  if (from === 'budget') state.policy.limits.max_agent_runs_per_job = Math.ceil(state.policy.limits.max_agent_runs_per_job * 1.5);
  state.repeat = { key: null, count: 0 };
  state.status = 'active';
  state.resumed = { at: nowIso(), from, step: step || null };
  state.park = null;
  state.pending_gate = null;
  job.save(root, state);
  log(root, state, 'resume', { channel, from, step });
  return { job: state.id, message: `Resumed ${state.id}${from ? ` (one more ${from} round allowed)` : ''}. Copilot continues with factory next.` };
}

function stop(root, { jobId, kind, channel, reason }) {
  requireHumanChannel(channel);
  if (!['cancelled', 'abandoned'].includes(kind)) fail('kind must be cancelled or abandoned', 'bad_input');
  const state = job.resolve(root, jobId);
  confirmTyped(channel, state.id, kind === 'cancelled' ? 'cancel it' : 'abandon it');
  state.status = kind;
  state.pending_gate = null;
  state.stopped = { at: nowIso(), reason: reason || '' };
  job.save(root, state);
  log(root, state, kind, { channel, reason });
  return { job: state.id, message: `${state.id} ${kind}. Its files are kept under .factory/jobs/${state.id}.` };
}

function waive(root, { jobId, floor, reason, channel }) {
  requireHumanChannel(channel);
  const doc = policyMod.floorsFile();
  if (!doc.waivable.includes(floor)) fail(`"${floor}" cannot be waived. Waivable: ${doc.waivable.join(', ')}`, 'not_waivable');
  if (!reason) fail('A waiver needs a reason.', 'bad_input');
  const state = job.resolve(root, jobId);
  confirmTyped(channel, state.id, `waive ${floor}`);
  state.waivers[floor] = { reason, at: nowIso() };
  job.save(root, state);
  log(root, state, 'waive', { channel, floor, reason });
  return { job: state.id, message: `Waived ${floor} for ${state.id}: ${reason}` };
}

function merged(root, { jobId, commit, channel }) {
  requireHumanChannel(channel);
  const state = job.resolve(root, jobId);
  if (!state.branch) fail('This job has no branch to merge.', 'bad_input');
  if (!state.pr) fail(`${state.id} has not been shipped yet.`, 'not_shipped');
  let sha;
  try {
    sha = git.revParse(root, `${commit}^{commit}`);
  } catch {
    fail(`Commit ${commit} not found in this repository.`, 'bad_input');
  }
  if (!git.isAncestor(root, state.pr.head || state.branch, sha)) fail(`${commit} does not contain the shipped job branch.`, 'bad_input');
  if (!git.isAncestor(root, sha, state.base_branch)) fail(`${commit} is not on ${state.base_branch}.`, 'bad_input');
  confirmTyped(channel, state.id, `record its merge at ${sha.slice(0, 12)}`);
  state.pr.merged = true;
  state.pr.merge_commit = sha;
  state.pr.merged_at = nowIso();
  state.pr.merged_via = channel;
  job.save(root, state);
  log(root, state, 'merged', { channel, commit: sha });
  return { job: state.id, message: `Recorded merge of ${state.id} at ${sha.slice(0, 12)}.` };
}

// "change A-3 <value>" / "drop A-3": override an evidence-backed assumption. The contract
// section is rewritten, so its hash changes like any contract edit: an H1 presented with the
// old text can't be approved, and after H1 it is drift (amend). Counted as overridden.
function changeAssumption(root, { jobId, id, value, drop = false, channel }) {
  requireHumanChannel(channel);
  confirmTyped(channel, job.resolve(root, jobId).id, `${drop ? 'drop' : 'change'} ${id}`);
  const r = require('./intent').override(root, { jobId, id, value, drop, via: channel });
  const state = job.resolve(root, r.job);
  log(root, state, drop ? 'drop_assumption' : 'change_assumption', { channel, assumption: r.assumption, value: r.value ? r.value.slice(0, 200) : null, was: String(r.was || '').slice(0, 200) });
  return r;
}

function confirmAc(root, { jobId, ac, channel }) {
  requireHumanChannel(channel);
  const state = job.resolve(root, jobId);
  const ctx = steps.context(root, state, job.load);
  if (!ctx.b.fingerprint) fail('Nothing built yet to confirm against.', 'bad_input');
  confirmTyped(channel, state.id, `confirm ${String(ac).toUpperCase()}`);
  ledger.append(root, state.id, { kind: 'evidence', ac: ac.toUpperCase(), type: 'human', fingerprint: ctx.b.fingerprint, pass: true, source: `human:${channel}` });
  log(root, state, 'confirm_ac', { channel, ac });
  return { job: state.id, message: `Confirmed ${ac.toUpperCase()} for ${state.id} on the current build. Run factory verify run to include it.` };
}

// Trailing punctuation, emoji and spaces are tone, not content: "Approve!", "approve 👍".
const TRAILING = /[\s.!,;:…\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]+$/u;

// Parse a chat reply. Only a whole message that is exactly a factory command counts.
function parseReply(text) {
  const t = String(text || '').trim().replace(TRAILING, '');
  if (!t || t.includes('\n')) return null;
  let m;
  const J = '(J-\\d+)';
  if ((m = t.match(new RegExp(`^approve(?:\\s+${J})?(?:\\s+(${GATE_IDS.join('|')}))?$`, 'i')))) return { cmd: 'approve', jobId: m[1] && m[1].toUpperCase(), gate: m[2] && m[2].toUpperCase() };
  if ((m = t.match(new RegExp(`^deny(?:\\s+${J})?(?:(?:\\s*[:\u2014\u2013-]\\s*|\\s+)(.*))?$`, 'i')))) return { cmd: 'deny', jobId: m[1] && m[1].toUpperCase(), reason: (m[2] || '').trim() };
  if ((m = t.match(new RegExp(`^resume(?:\\s+${J})?(?:\\s+(.*))?$`, 'i')))) return { cmd: 'resume', jobId: m[1] && m[1].toUpperCase(), step: (m[2] || '').trim() || null };
  if ((m = t.match(new RegExp(`^(cancel|abandon)\\s+job(?:\\s+${J})?(?:\\s+(.*))?$`, 'i')))) return { cmd: m[1].toLowerCase() === 'cancel' ? 'cancel' : 'abandon', jobId: m[2] && m[2].toUpperCase(), reason: (m[3] || '').trim() };
  if ((m = t.match(/^(accept|reject)\s+lesson\s+(L\d+)(?:\s+(.*))?$/i))) return { cmd: `${m[1].toLowerCase()}_lesson`, lessonId: m[2].toUpperCase(), reason: (m[3] || '').trim() };
  if ((m = t.match(new RegExp(`^waive(?:\\s+${J})?\\s+([a-z_:]+)\\s+(.+)$`, 'i')))) return { cmd: 'waive', jobId: m[1] && m[1].toUpperCase(), floor: m[2], reason: m[3].trim() };
  if ((m = t.match(new RegExp(`^merged(?:\\s+${J})?\\s+([0-9a-f]{7,40})$`, 'i')))) return { cmd: 'merged', jobId: m[1] && m[1].toUpperCase(), commit: m[2] };
  if ((m = t.match(new RegExp(`^confirm\\s+((?:E-)?AC-\\d+)(?:\\s+${J})?$`, 'i')))) return { cmd: 'confirm', ac: m[1], jobId: m[2] && m[2].toUpperCase() };
  if ((m = t.match(new RegExp(`^change(?:\\s+${J})?\\s+(A-\\d+)(?:\\s*[:=\u2014\u2013-]\\s*|\\s+(?:to\\s+)?)(\\S.*)$`, 'i')))) return { cmd: 'change_assumption', jobId: m[1] && m[1].toUpperCase(), id: m[2].toUpperCase(), value: m[3].trim() };
  if ((m = t.match(new RegExp(`^drop(?:\\s+${J})?\\s+(A-\\d+)(?:\\s+${J})?$`, 'i')))) return { cmd: 'drop_assumption', jobId: (m[1] || m[3]) && (m[1] || m[3]).toUpperCase(), id: m[2].toUpperCase() };
  return null;
}

// The exact forms, for "that was not applied" hints.
const REPLY_FORMS = ['approve [J-0001] [H1]', 'deny [J-0001] <reason>', 'resume [J-0001] [step]', 'cancel job [J-0001] [reason]', 'abandon job [J-0001] [reason]', 'waive [J-0001] <floor> <reason>', 'merged [J-0001] <sha>', 'confirm AC-1 [J-0001]', 'change [J-0001] A-3 <new value>', 'drop [J-0001] A-3', 'accept lesson L4', 'reject lesson L4 [reason]'];
const VERBS = ['approve', 'approved', 'deny', 'denied', 'resume', 'cancel', 'abandon', 'waive', 'merged', 'merge', 'confirm', 'accept', 'reject', 'lgtm'];
// Common words: only a near miss when the message is about an assumption id ("change A3 x", "drop a-3 now").
const ASSUMPTION_VERBS = ['change', 'drop'];

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// A short message that looks like a reply but isn't one ("aprove", "approve the plan
// please", "cancel"): { word, verb, forms } or null. It never applies anything.
function nearMiss(text) {
  const t = String(text || '').trim().replace(TRAILING, '');
  if (!t || t.includes('\n') || parseReply(t)) return null;
  const words = t.split(/\s+/);
  if (words.length > 6) return null;
  const w = words[0].toLowerCase().replace(/[^a-z]/g, '');
  const aid = words.slice(1, 3).some((x) => /^a-?\d+[.:,]?$/i.test(x));
  const av = ASSUMPTION_VERBS.find((v) => v === w || editDistance(v, w) <= 1);
  if (av) return aid ? { word: words[0], verb: av, forms: REPLY_FORMS } : null;
  if (w.length < 4) return null;
  const verb = VERBS.find((v) => v === w || (v.length >= 5 && editDistance(v, w) <= (v.length >= 7 ? 2 : 1)));
  return verb ? { word: words[0], verb, forms: REPLY_FORMS } : null;
}

function applyReply(root, parsed, channel = 'chat') {
  const lessons = require('./lessons');
  switch (parsed.cmd) {
    case 'approve':
      return approve(root, { jobId: parsed.jobId, gate: parsed.gate, channel });
    case 'deny':
      return deny(root, { jobId: parsed.jobId, reason: parsed.reason, channel });
    case 'resume':
      return resume(root, { jobId: parsed.jobId, step: parsed.step, channel });
    case 'cancel':
      return stop(root, { jobId: parsed.jobId, kind: 'cancelled', channel, reason: parsed.reason });
    case 'abandon':
      return stop(root, { jobId: parsed.jobId, kind: 'abandoned', channel, reason: parsed.reason });
    case 'accept_lesson':
      return lessons.decide(root, { id: parsed.lessonId, accept: true, channel });
    case 'reject_lesson':
      return lessons.decide(root, { id: parsed.lessonId, accept: false, reason: parsed.reason, channel });
    case 'waive':
      return waive(root, { jobId: parsed.jobId, floor: parsed.floor, reason: parsed.reason, channel });
    case 'merged':
      return merged(root, { jobId: parsed.jobId, commit: parsed.commit, channel });
    case 'confirm':
      return confirmAc(root, { jobId: parsed.jobId, ac: parsed.ac, channel });
    case 'change_assumption':
      return changeAssumption(root, { jobId: parsed.jobId, id: parsed.id, value: parsed.value, channel });
    case 'drop_assumption':
      return changeAssumption(root, { jobId: parsed.jobId, id: parsed.id, drop: true, channel });
    default:
      fail(`Unknown reply command ${parsed.cmd}`);
  }
}

module.exports = { snapshot, GATE_IDS, requireHumanChannel, confirmTyped, agentContext, testToken, AGENT_ENV, approve, deny, resume, stop, waive, merged, confirmAc, changeAssumption, parseReply, nearMiss, REPLY_FORMS, applyReply, sha256 };
