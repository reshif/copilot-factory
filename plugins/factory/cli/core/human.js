'use strict';
// Human-only actions. They are reachable two ways and no other:
//   1. your own chat reply, applied by the UserPromptSubmit hook before the model sees it
//   2. the `factory` CLI from a real terminal (stdin and stdout are TTYs), confirmed by
//      typing a short random code shown on the terminal itself (/dev/tty; CONOUT$/CONIN$ on
//      Windows)
// The PreToolUse guard also blocks agents from running these subcommands.
//
// A TTY is not proof of a human: VS Code's Local harness runs agent commands in a terminal,
// and tool approvals there can be automatic (Allow all, Autopilot, auto-approve settings). So
// the terminal path also refuses:
//   - an agent `factory run` started (FACTORY_RUNNER=1);
//   - an environment that shows an agent's shell (AGENT_ENV: variables agent harnesses set
//     for the commands they run, e.g. VS Code's agent terminals; absence proves nothing);
// and asks for a confirmation code that is random per command, never derivable from the repo
// or the job (it used to be the job id, which every agent knows) and written only to the
// terminal device: not to stdout or stderr, not to any file or event. An agent that only runs
// a command and reads its output never sees it. The limit, honestly: an agent that drives an
// interactive terminal (VS Code can show an agent a terminal waiting for input and let it
// type into it) can read the code off that terminal's screen; the env markers are what stop
// those terminals, and a harness that sets none is not detected. There is no --yes.
//
// Tests run without a terminal through one seam: FACTORY_TEST_HUMAN set to an HMAC of a
// fixed label under the seal secret (which the guard keeps agents from reading), honoured
// only with NODE_ENV=test, when stdin or stdout is NOT a terminal and never in a factory
// agent. The guard refuses any shell command that sets it. The "typed" text then comes from
// FACTORY_TEST_HUMAN_INPUT, where {code} stands for the code the terminal would show.

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
// Sources: VS Code's agent terminal tool (src/vs/workbench/contrib/terminalContrib/chatAgentTools/
// browser/toolTerminalCreator.ts: COPILOT_AGENT=1 from 1.121, AI_AGENT=github_copilot_vscode_agent
// from 1.124, VSCODE_AGENT_ZSH_FIXUPS and VSCODE_PREVENT_SHELL_HISTORY only in agent terminals;
// microsoft/vscode#311734, #320127, PR #320129); Copilot CLI sets COPILOT_CLI=1 for the commands
// it runs (docs/research/hooks.md); AI_AGENT is the cross-vendor convention (Claude Code sets it
// too). VS Code before 1.121 marks its agent terminals with nothing an agent can't also have in
// your own terminal (GIT_PAGER=cat): those are not detected.
const AGENT_ENV = [
  ['FACTORY_RUNNER', '1'], // an agent `factory run` started
  ['AI_AGENT', null], // cross-vendor: VS Code agent terminals (≥ 1.124), Claude Code, others
  ['COPILOT_AGENT', null], // VS Code agent terminals (≥ 1.121)
  ['VSCODE_AGENT_ZSH_FIXUPS', null], // VS Code agent terminals running zsh
  ['VSCODE_PREVENT_SHELL_HISTORY', null], // VS Code agent terminals (chat.tools.terminal.preventShellHistory)
  ['COPILOT_CLI', '1'], // commands the Copilot CLI runs
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

// The test seam: only under NODE_ENV=test, never in a terminal, never in a factory agent,
// only with the right token.
function testSeam() {
  const t = process.env.FACTORY_TEST_HUMAN;
  if (!t || process.env.NODE_ENV !== 'test' || (process.stdin.isTTY && process.stdout.isTTY) || process.env.FACTORY_RUNNER === '1') return false;
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

// A short confirmation code: 4 characters from an alphabet without look-alikes (0/O, 1/I/L),
// random per command (crypto), so nothing in the repo, the job or an earlier run predicts it.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function confirmationCode(n = 4) {
  const crypto = require('crypto');
  let c = '';
  for (let i = 0; i < n; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return c;
}

// The terminal path's typed confirmation: a fresh code is shown on the terminal device only
// (never stdout/stderr, a file or an event) and the user types it back. `subject` (the job or
// lesson id) and `action` only label the prompt. Chat replies need none: the reply itself is
// the human's words.
function confirmTyped(channel, subject, action) {
  if (channel !== 'tty') return;
  const code = confirmationCode();
  const typed = testSeam()
    ? String(process.env.FACTORY_TEST_HUMAN_INPUT || '').replace(/\{code\}/gi, code)
    : readTty(`To ${action} (${subject}), type the code ${code}: `);
  if (typed.trim().replace(/\s+/g, '').toUpperCase() !== code) {
    fail(`Not confirmed: that was not the code shown on your terminal. Nothing was done; run the command again (each run shows a new code).`, 'not_confirmed');
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
  // Only a gate the router presented can be approved: an amendment is approvable once
  // `factory next` (or the drive) has shown gate A, never straight after `amend submit`.
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
  // An amendment submitted while the job was parked pre-empts the park: approving it is the
  // human's decision to move on, so it resumes the job too (no separate "resume").
  // It does exactly what `resume` does (one more round of the cap that parked it, the budget
  // raised, clarify's onResume …), so the job doesn't park again on the same cap at once.
  const resumed = pending.id === 'A' && state.status === 'parked';
  if (resumed) applyResume(root, state, { step: null, via: 'amendment' });
  job.save(root, state);
  log(root, state, 'approve', { channel, gate: pending.id, hash: now });
  if (resumed) log(root, state, 'resume', { channel, from: state.resumed.from, step: null, via: 'amendment' });
  return { job: state.id, gate: pending.id, hash: now, ...(resumed ? { resumed: true } : {}), message: `Approved ${pending.id} for ${state.id} (hash ${now.slice(0, 12)}).${resumed ? ' The job was parked: approving the amendment resumed it.' : ''}` };
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
  applyResume(root, state, { step });
  job.save(root, state);
  log(root, state, 'resume', { channel, from: state.resumed.from, step });
  return { job: state.id, message: `Resumed ${state.id}${state.resumed.from ? ` (one more ${state.resumed.from} round allowed)` : ''}. Copilot continues with factory next.` };
}

// What un-parking does, whoever decides it (resume, or approving an amendment on a parked job):
// one more round of whatever ran out, the repeat guard cleared, the job active again. Mutates
// state; the caller saves and logs.
function applyResume(root, state, { step = null, via = null } = {}) {
  const from = state.park && state.park.from;
  // One more round of whatever ran out.
  const L = state.policy.limits;
  const oneMore = (key, max) => {
    state.counters[key] = Math.min(state.counters[key], Math.max(0, max - 1));
  };
  if (from === 'review') oneMore('review_rounds', L.max_review_rounds);
  if (from === 'verify') oneMore('verify_fix_rounds', L.max_verify_fix_rounds);
  // Clarify v3: one more try of the stage that hit its cap (cli/core/clarify.js onResume).
  if (from === 'clarify') require('./clarify').onResume(root, state);
  if (from === 'decompose') oneMore('decompose_rounds', L.max_plan_validate_rounds);
  if (from === 'reverify') state.counters.reverify_bonus = (state.counters.reverify_bonus || 0) + 1;
  if (from === 'budget') state.policy.limits.max_agent_runs_per_job = Math.ceil(state.policy.limits.max_agent_runs_per_job * 1.5);
  state.repeat = { key: null, count: 0 };
  delete state.transient_aborts; // the human says Copilot works again: count transient runs afresh
  state.status = 'active';
  state.resumed = { at: nowIso(), from, step: step || null, ...(via ? { via } : {}) };
  state.park = null;
  state.pending_gate = null;
  return state;
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
  // H4 refuses while a serious review finding is still unverified (as ship and close do).
  const open = require('./floors').openUnverifiedFindings(steps.context(root, state, job.load));
  if (open.length) fail(`${state.id} still has serious review findings no verifier settled: ${open.map((f) => f.id).join(', ')}. Run factory next to re-verify them before recording the merge.`, 'floor', { missing: ['no_unverified_serious'] });
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
  if (require('./clarify').load(root, job.resolve(root, jobId).id)) fail(`Clarify v3 has no A-n assumptions: correct a fact in your own words instead (on the decision sheet, "fact 2: <correction>", or factory clarify reply "<your words>").`, 'no_assumption');
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

// "dismiss finding code-1 <reason>" / "accept finding code-1 <reason>": settle a serious
// review finding no verifier could settle (carried from round to round, blocking ship).
// Accepted: a known risk that ships, listed in the completion report; dismissed: not a
// problem. Only the human can, with a reason; recorded in the ledger.
function settleFinding(root, { jobId, id, decision, reason, channel }) {
  requireHumanChannel(channel);
  const state = job.resolve(root, jobId);
  if (!['accept', 'dismiss'].includes(decision)) fail('finding accept|dismiss <id> --reason "…"', 'bad_input');
  if (!String(id || '').trim()) fail(`Name the finding: "${decision} finding <id> <reason>" (factory next or the completion report lists the open ones).`, 'bad_input');
  if (!String(reason || '').trim()) fail(`Say why: reply "${decision} finding ${id} <reason>". Nothing was settled.`, 'needs_reason');
  const open = require('./floors').openUnverifiedFindings(steps.context(root, state, job.load));
  if (!open.some((f) => f.id.toLowerCase() === String(id).trim().toLowerCase())) fail(`${id} is not an open unverified finding of ${state.id}${open.length ? `; open: ${open.map((f) => f.id).join(', ')}` : ' (none is open)'}.`, 'bad_input');
  confirmTyped(channel, state.id, `${decision} finding ${id}`);
  const r = require('./review').settle(root, { jobId: state.id, id, decision, reason, channel });
  log(root, job.load(root, state.id), `${decision}_finding`, { channel, finding: r.finding, reason: String(reason).slice(0, 200) });
  return { ...r, message: `${r.finding} ${r.status} by you: ${String(reason).trim()}.${r.still_open.length ? ` Still unverified: ${r.still_open.join(', ')}.` : ''} Copilot continues with factory next.` };
}

// "confirm environment [hash]" / "confirm environment none": the build environment every
// worktree is set up with (its setup commands run on this machine), so only the human
// confirms it. The hash, when given, must be the proposal's as it was shown.
function setEnvironment(root, { file, none = false, expectHash = null, channel }) {
  requireHumanChannel(channel);
  const envMod = require('./environment');
  const p = none ? { name: 'none' } : file ? { name: file } : envMod.proposal(root);
  confirmTyped(channel, 'this repository', `use the build environment ${none ? 'none' : p.name || ''}`.trim());
  const r = envMod.confirm(root, { file, none, expectHash, channel });
  let state = null;
  try {
    state = job.resolve(root, null);
  } catch {
    state = null;
  }
  if (state) log(root, state, 'set_environment', { channel, environment: r.environment.name || null, hash: r.hash });
  require('./events').append(root, { event: 'environment_set', channel, name: r.environment.name || null, hash: r.hash, job: state ? state.id : null });
  return { ...r, message: `Build environment set: ${r.environment.name || '(unnamed)'} (${r.hash}). ${(r.environment.setup || []).length ? `Each worktree runs: ${r.environment.setup.join(' && ')}.` : 'Worktrees need no setup.'} Copilot continues with factory next.` };
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
  if ((m = t.match(new RegExp(`^proceed(?:\\s+${J})?$`, 'i')))) return { cmd: 'proceed', jobId: m[1] && m[1].toUpperCase() };
  if ((m = t.match(new RegExp(`^(cancel|abandon)\\s+job(?:\\s+${J})?(?:\\s+(.*))?$`, 'i')))) return { cmd: m[1].toLowerCase() === 'cancel' ? 'cancel' : 'abandon', jobId: m[2] && m[2].toUpperCase(), reason: (m[3] || '').trim() };
  if ((m = t.match(new RegExp(`^(accept|dismiss)\\s+finding(?:\\s+${J})?\\s+([a-z][\\w.@-]*-\\d+(?:@r\\d+)?)(?:\\s*[:\u2014\u2013-]?\\s+(.*))?$`, 'i')))) return { cmd: 'settle_finding', decision: m[1].toLowerCase(), jobId: m[2] && m[2].toUpperCase(), id: m[3], reason: (m[4] || '').trim() };
  if ((m = t.match(/^confirm\s+environment(?:\s+(none|[0-9a-f]{8}))?$/i))) return { cmd: 'set_environment', none: Boolean(m[1] && m[1].toLowerCase() === 'none'), hash: m[1] && m[1].toLowerCase() !== 'none' ? m[1].toLowerCase() : null };
  if ((m = t.match(/^(accept|reject)\s+lesson\s+(L\d+)(?:\s+(.*))?$/i))) return { cmd: `${m[1].toLowerCase()}_lesson`, lessonId: m[2].toUpperCase(), reason: (m[3] || '').trim() };
  if ((m = t.match(new RegExp(`^waive(?:\\s+${J})?\\s+([a-z_:]+)\\s+(.+)$`, 'i')))) return { cmd: 'waive', jobId: m[1] && m[1].toUpperCase(), floor: m[2], reason: m[3].trim() };
  if ((m = t.match(new RegExp(`^merged(?:\\s+${J})?\\s+([0-9a-f]{7,40})$`, 'i')))) return { cmd: 'merged', jobId: m[1] && m[1].toUpperCase(), commit: m[2] };
  if ((m = t.match(new RegExp(`^confirm\\s+((?:E-)?AC-\\d+)(?:\\s+${J})?$`, 'i')))) return { cmd: 'confirm', ac: m[1], jobId: m[2] && m[2].toUpperCase() };
  if ((m = t.match(new RegExp(`^change(?:\\s+${J})?\\s+(A-\\d+)(?:\\s*[:=\u2014\u2013-]\\s*|\\s+(?:to\\s+)?)(\\S.*)$`, 'i')))) return { cmd: 'change_assumption', jobId: m[1] && m[1].toUpperCase(), id: m[2].toUpperCase(), value: m[3].trim() };
  if ((m = t.match(new RegExp(`^drop(?:\\s+${J})?\\s+(A-\\d+)(?:\\s+${J})?$`, 'i')))) return { cmd: 'drop_assumption', jobId: (m[1] || m[3]) && (m[1] || m[3]).toUpperCase(), id: m[2].toUpperCase() };
  return null;
}

// The exact forms, for "that was not applied" hints.
const REPLY_FORMS = ['approve [J-0001] [H1]', 'deny [J-0001] <reason>', 'resume [J-0001] [step]', 'proceed [J-0001]', 'cancel job [J-0001] [reason]', 'abandon job [J-0001] [reason]', 'waive [J-0001] <floor> <reason>', 'merged [J-0001] <sha>', 'confirm AC-1 [J-0001]', 'change [J-0001] A-3 <new value>', 'drop [J-0001] A-3', 'accept lesson L4', 'reject lesson L4 [reason]', 'accept finding code-1 <reason>', 'dismiss finding code-1 <reason>', 'confirm environment [hash|none]'];
const VERBS = ['approve', 'approved', 'deny', 'denied', 'resume', 'proceed', 'cancel', 'abandon', 'waive', 'merged', 'merge', 'confirm', 'accept', 'reject', 'dismiss', 'lgtm'];
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
    case 'proceed':
      return require('./clarify').proceed(root, { jobId: parsed.jobId, channel });
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
    case 'set_environment':
      return setEnvironment(root, { none: parsed.none, expectHash: parsed.hash, channel });
    case 'settle_finding':
      return settleFinding(root, { jobId: parsed.jobId, id: parsed.id, decision: parsed.decision, reason: parsed.reason, channel });
    case 'drop_assumption':
      return changeAssumption(root, { jobId: parsed.jobId, id: parsed.id, drop: true, channel });
    default:
      fail(`Unknown reply command ${parsed.cmd}`);
  }
}

module.exports = { applyResume, snapshot, GATE_IDS, requireHumanChannel, confirmTyped, confirmationCode, CODE_ALPHABET, agentContext, testToken, AGENT_ENV, approve, deny, resume, stop, waive, merged, confirmAc, changeAssumption, settleFinding, setEnvironment, parseReply, nearMiss, REPLY_FORMS, applyReply, sha256 };
