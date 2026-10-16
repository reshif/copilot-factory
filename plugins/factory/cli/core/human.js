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
  // A gate that binds more than its document (the medium-risk H3: design + plan + the build
  // environment): its parts are recorded with the approval, and the environment it showed is
  // sealed by this approval, the human's, so there is no separate "confirm environment".
  const ctx0 = pending.id === 'A' ? null : steps.context(root, state, job.load);
  const parts = ctx0 ? steps.combinedParts(ctx0, pending.id) : null;
  if (parts && parts.environment && parts.environment.status === 'tampered') fail(`${parts.environment.message} Nothing was approved.`, 'environment_tampered');
  confirmTyped(channel, state.id, `approve ${pending.id}`);
  state.approvals[pending.id] = { hash: now, at: nowIso(), via: via || channel, snapshot: snapshot(root, state, pending.id, now), ...(parts ? { combined: Object.keys(parts), ...(parts.design !== undefined ? { design: parts.design } : {}), ...(parts.plan !== undefined ? { plan: parts.plan } : {}), ...(parts.environment ? { environment: parts.environment.hash } : {}) } : {}) };
  if (parts && parts.environment && parts.environment.status === 'proposed') {
    const r = require('./environment').confirm(root, { env: parts.environment.env, channel, via: `${state.id} ${pending.id}` });
    require('./events').append(root, { event: 'environment_set', channel, name: r.environment.name || null, hash: r.hash, job: state.id, gate: pending.id });
    log(root, state, 'set_environment', { channel, environment: r.environment.name || null, hash: r.hash, gate: pending.id });
  }
  state.pending_gate = null;
  if (pending.id === 'A') require('./amend').applyApproved(root, state);
  // An amendment submitted while the job was parked pre-empts the park: approving it is the
  // human's decision to move on, so it resumes the job too (no separate "resume").
  // It does exactly what `resume` does (one more round of the cap that parked it, the budget
  // raised, clarify's onResume …), so the job doesn't park again on the same cap at once.
  // (a budget park stays parked: the budget is absolute, only "resume +N%" grants more)
  const resumed = pending.id === 'A' && state.status === 'parked' && !needsGrant(state, null);
  if (resumed) applyResume(root, state, { step: null, via: 'amendment' });
  job.save(root, state);
  log(root, state, 'approve', { channel, gate: pending.id, hash: now });
  if (resumed) log(root, state, 'resume', { channel, from: state.resumed.from, step: null, via: 'amendment' });
  return { job: state.id, gate: pending.id, hash: now, ...(resumed ? { resumed: true } : {}), message: `Approved ${pending.id} for ${state.id} (hash ${now.slice(0, 12)}).${resumed ? ' The job was parked: approving the amendment resumed it.' : state.status === 'parked' ? ' The job stays parked on its spent budget: reply "resume +50%" (or another amount) to go on.' : ''}` };
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

// `resume [step | your words]`: a recipe step name restarts at that step; any other words are
// your answer to the park's question, and go to the next round (resume + content).
function splitResume(state, step) {
  const t = String(step || '').trim();
  if (!t) return { step: null, words: null };
  let steps = [];
  try {
    steps = require('./recipes').load(state.recipe.id).steps.map((s) => s.step.toLowerCase());
  } catch {
    steps = [];
  }
  return steps.includes(t.toLowerCase()) ? { step: t, words: null } : { step: null, words: t };
}

// The budget is absolute: resume grants more agent runs only when the human's words say how much.
// Returns the factor, or null.
// Only an explicit grant counts: "+N%" or "budget N" (N agent runs in all, more than now). Words
// that merely mention a number ("try 50% faster"? no "+") or "double" grant nothing; an option
// letter of the budget question is mapped to its text ("+100% …") by replyToPark first.
// The grant must be the whole reply ("+50%", "resume +50%", "budget +50%", "budget 40"), or the
// budget question's own option text, which ends in its reply form ("… (resume +50%)"): "+20%"
// inside other words ("make it +20% faster") grants nothing (review m6).
const GRANT_PCT = /^(?:(?:resume|budget)\s+)?\+\s*(\d{1,3})\s*%$/;
const GRANT_OPT = /\(resume\s+\+(\d{1,3})%\)$/;
const GRANT_ABS = /^budget\s+(\d{1,5})$/;
function budgetGrant(words, current = null) {
  const t = String(words || '').toLowerCase().trim().replace(/[.!]+$/, '');
  if (!t) return null;
  let m;
  if ((m = GRANT_PCT.exec(t) || GRANT_OPT.exec(t))) return Number(m[1]) > 0 ? 1 + Math.min(300, Number(m[1])) / 100 : null;
  if ((m = GRANT_ABS.exec(t)) && current) return Number(m[1]) > current ? Number(m[1]) / current : null;
  return null;
}

// optionText: the budget question's option the reply chose (its letter maps to it); it grants
// what it names even with words added after it.
function needsGrant(state, words, optionText = null) {
  if (optionText && budgetGrant(optionText)) return false;
  return Boolean(state.park && (state.park.kind === 'budget' || state.park.from === 'budget') && !budgetGrant(words, state.policy && state.policy.limits && state.policy.limits.max_agent_runs_per_job));
}

const GRANT_MSG = (state) => `${state.id} parked because its agent-run budget is spent (${(state.park && state.park.reason) || ''}). The budget is absolute: say how much more to allow — reply "resume +50%" or "resume +100%" — or "cancel job". Nothing was resumed.`;

function resume(root, { jobId, step, words: given = null, channel }) {
  requireHumanChannel(channel);
  const state = job.resolve(root, jobId);
  if (state.status !== 'parked') fail(`${state.id} is not parked (status: ${state.status}).`, 'not_parked');
  const sp = splitResume(state, step);
  const words = [given, sp.words].filter(Boolean).join(' ').trim() || null;
  if (needsGrant(state, words)) fail(GRANT_MSG(state), 'needs_grant');
  confirmTyped(channel, state.id, 'resume it');
  applyResume(root, state, { step: sp.step, words });
  job.save(root, state);
  log(root, state, 'resume', { channel, from: state.resumed.from, step: sp.step, ...(words ? { words: words.slice(0, 500) } : {}), ...(state.resumed.grant ? { grant: state.resumed.grant } : {}) });
  return { job: state.id, resumed: true, message: `Resumed ${state.id}${state.resumed.grant ? ` with ${Math.round((state.resumed.grant - 1) * 100)}% more agent runs (${state.policy.limits.max_agent_runs_per_job})` : ''}${words ? '; your words go to the next round' : ''}. Copilot continues with factory next.` };
}

// Any reply of the human's to a park is resume + content: their words are stored with the job
// (and with clarify's record before H1) and every agent that works on it next gets them.
// Is this message an answer to the park? An option of its question (its letter or number, "option
// b", "b: …", or starting with the option's words), "yes" to a stored answer the factory asked
// about, or words about the question itself (they share its significant words). Returns the
// words the agents get (an option's text, with anything added after it) or null.
// The forms a park answer takes, shared with readReply (the one reader every prompt is classified
// by): an option ("b", "2", "b)", "(b)", "option b", "b: …"), or a confirmation of a stored answer.
const PARK_OPTION = /^(?:option\s+([a-z]|\d{1,2})|\(([a-z]|\d{1,2})\)|([a-z]|\d{1,2})\))(?:\s*[:.,\u2014\u2013-]?\s*(.*))?$/is;
const PARK_LETTER = /^([a-z]|\d{1,2})(?:\s*[:.,\u2014\u2013-]\s*(.*))?$/is;
const PARK_CONFIRM = /^(y|yes|yep|yes please|ok|okay|sure|confirm|use it|do it)[.!]?$/i;
const PARK_STOP = new Set('this that with from your have will them they what when where which would could should about into only also just then than were been their there here more some such very much does make like want need please okay sure think maybe test tests build builds job jobs factory file files code thing things good fine looks look check work works done'.split(' '));
function sigWords(text) {
  return new Set((String(text || '').toLowerCase().match(/[a-z0-9_][a-z0-9_.-]{3,}/g) || []).map((w) => w.replace(/[.-]+$/, '')).filter((w) => w.length >= 4 && !PARK_STOP.has(w)));
}
function parkAnswer(state, text) {
  const park = state.park || {};
  const t = String(text || '').trim();
  const opts = (park.options || []).map((o, i) => ({ key: String(o.key || String.fromCharCode(97 + i)).toLowerCase(), text: String(o.text || '') }));
  if (park.pending_answer && PARK_CONFIRM.test(t)) return { words: park.pending_answer.words, via: 'confirmed' };
  // a repaired environment waits for its seal: only "approve environment <its short hash>" or the
  // option letter seal it, never a bare ok / yes (release review B2)
  if (park.kind === 'environment_repair') {
    const m = /^approve(?:\s+J-\d+)?\s+environment(?:\s+([0-9a-f]{8}))?$/i.exec(t);
    if (m) {
      const want = (state.env_repair || {}).short;
      if (!m[1]) fail(`Name the environment you seal: reply "approve environment ${want || '<hash>'}" (or "a"). Nothing was sealed.`, 'explicit_seal_needed');
      if (m[1].toLowerCase() !== want) fail(`The repaired environment waiting for your seal is ${want}, not ${m[1]}: it changed after it was shown. Nothing was sealed.`, 'stale_environment');
      const a = (park.options || [])[0];
      return { words: a ? a.text : 'seal', option: 'a', optionText: a ? a.text : 'seal', extra: null, via: 'option' };
    }
  }
  const m = PARK_OPTION.exec(t) || PARK_LETTER.exec(t);
  if (m && opts.length) {
    const key = String(m[1] || m[2] || m[3] || '').toLowerCase();
    const rest = String((m.length > 4 ? m[4] : m[2]) || '').trim();
    const i = /^\d+$/.test(key) ? Number(key) - 1 : opts.findIndex((o) => o.key === key);
    if (opts[i]) return { words: rest ? `${opts[i].text} — ${rest}` : opts[i].text, option: opts[i].key, optionText: opts[i].text, extra: rest || null, via: 'option' };
  }
  const low = t.toLowerCase();
  const byText = opts.find((o) => {
    const head = o.text.toLowerCase().split(/[\s:,(]+/).filter(Boolean).slice(0, 2).join(' ');
    return head.length >= 4 && low.startsWith(head);
  });
  if (byText) return { words: t, option: byText.key, optionText: byText.text, extra: t, via: 'option' };
  const about = sigWords([park.question, ...opts.map((o) => o.text), park.question ? '' : park.reason].join(' '));
  const mine = sigWords(t);
  if ([...mine].some((w) => about.has(w))) return { words: t, via: 'reply' };
  return null;
}

// A chat message while the job is parked: resumes it only when it answers the park (parkAnswer).
// Anything else is stored and the user is asked once whether it is their answer ("yes" resumes
// with it); it never resumes silently.
function replyToPark(root, { jobId, text, channel }) {
  requireHumanChannel(channel);
  const state = job.resolve(root, jobId);
  if (state.status !== 'parked') fail(`${state.id} is not parked (status: ${state.status}).`, 'not_parked');
  const raw = String(text || '').trim();
  if (!raw) fail('Say your answer.', 'bad_input');
  const ans = parkAnswer(state, raw);
  const words = ans ? ans.words : raw;
  if (needsGrant(state, words, ans && ans.option ? ans.optionText : null)) fail(GRANT_MSG(state), 'needs_grant');
  const question = (state.park && state.park.question) || String((state.park && state.park.reason) || 'why the job parked').split('\n')[0].slice(0, 300);
  if (!ans && state.park && state.park.kind === 'environment_repair' && PARK_CONFIRM.test(raw)) {
    fail(`"${raw}" does not seal the repaired build environment: reply "approve environment ${(state.env_repair || {}).short || '<hash>'}" (or "a") to seal it, "b" (or your words) to repair it again, or "c" to re-check after a fix on your machine. Nothing was sealed.`, 'explicit_seal_needed');
  }
  if (!ans) {
    state.park = { ...state.park, pending_answer: { words: raw.slice(0, 2000), at: nowIso() } };
    job.save(root, state);
    log(root, state, 'park_answer_pending', { channel, words: raw.slice(0, 500) });
    // on the seal question, "yes" to stored words sends them to a new repair round; it never seals (m6)
    const envPark = state.park && state.park.kind === 'environment_repair';
    return { job: state.id, resumed: false, pending: true, question, message: envPark ? `Nothing was sealed or resumed. Reply "yes" to DISCARD the repaired environment ${(state.env_repair || {}).short || ''} and send your words to a new repair round, or "approve environment ${(state.env_repair || {}).short || '<hash>'}" to seal it.` : `Nothing was resumed. Use this as your answer to "${question}"? Reply "yes" to resume ${state.id} with it (or answer the question).` };
  }
  confirmTyped(channel, state.id, 'resume it with your words');
  applyResume(root, state, { words, via: ans.via === 'option' ? `option ${ans.option}` : 'reply', option: ans.option ? { key: ans.option, text: ans.optionText, extra: ans.extra } : null, channel });
  job.save(root, state);
  log(root, state, 'resume', { channel, from: state.resumed.from, via: ans.via, ...(ans.option ? { option: ans.option } : {}), words: words.slice(0, 500), ...(state.resumed.grant ? { grant: state.resumed.grant } : {}) });
  return { job: state.id, resumed: true, ...(ans.option ? { option: ans.option } : {}), message: `Resumed ${state.id} with ${ans.option ? `option ${ans.option} (${words.slice(0, 160)})` : 'your words'}${state.resumed.grant ? ` and ${Math.round((state.resumed.grant - 1) * 100)}% more agent runs` : ''}: they go to the next round. Copilot continues with factory next.` };
}

// What un-parking does, whoever decides it (resume, a reply, or approving an amendment on a parked
// job): the loop that stopped starts a new segment with the human's words (it never just buys one
// more identical round), the repeat guard is cleared, the job is active again. The budget grows
// only by the grant the human's words name. Mutates state; the caller saves and logs.
function applyResume(root, state, { step = null, via = null, words = null, option = null, channel = null } = {}) {
  const park = state.park || {};
  const from = park.from;
  const L = state.policy.limits;
  const oneMore = (key, max) => {
    state.counters[key] = Math.min(state.counters[key], Math.max(0, max - 1));
  };
  // the loops the engine runs (cli/core/loop.js): a new segment, with the human's answer
  const LOOP_OF = { review: 'review', verify: 'verify', reverify: 'reverify', reconcile: 'integrator' };
  const loopName = LOOP_OF[from] || (park.loop || null);
  if (loopName) {
    state.loops = state.loops || {};
    const old = state.loops[loopName] || {};
    state.loops[loopName] = { ...require('./loop').fresh(), segments: (old.segments || 0) + 1, last_question: old.diagnosis ? old.diagnosis.question : null };
  }
  // a loop left waiting for a diagnosis that never came (the repeat guard parked it, m4): the
  // resume starts it afresh too, with the human's words
  for (const [n, l] of Object.entries(state.loops || {})) {
    if (n !== loopName && l && l.pending && l.pending.kind === 'diagnosis' && !l.diagnosis) state.loops[n] = { ...require('./loop').fresh(), segments: (l.segments || 0) + 1, last_question: null };
  }
  if (from === 'review') oneMore('review_rounds', L.max_review_rounds);
  if (from === 'verify') oneMore('verify_fix_rounds', L.max_verify_fix_rounds);
  // Clarify v3: clarify's own park (an agent that failed twice), and words given while parked
  if (from === 'clarify' || require('./clarify').inClarify(state)) require('./clarify').onResume(root, state, words);
  if (from === 'decompose') oneMore('decompose_rounds', L.max_plan_validate_rounds);
  if (from === 'reverify') state.counters.reverify_bonus = (state.counters.reverify_bonus || 0) + 1;
  // fix 0.10.1: a repaired build environment that passed its check: option a seals it (this is
  // the human's channel; agents never seal); b repairs again with the human's words; c leaves it
  // to the human (factory env set). A park the repair loop stopped in starts a fresh loop.
  // Release review M4: "I fixed it on my machine" (c on the seal question, a on the stopped loop's
  // question, or a plain resume) re-checks the sealed environment, with a fresh machine inventory
  // and its real execution context, before any agent repair; b repairs again with the words.
  const ER = require('./env-repair');
  if (park.kind === 'environment_repair') {
    if (option && option.key === 'a') ER.sealRepair(root, state, channel || 'chat');
    else if (option && option.key === 'c') ER.recheck(root, state);
    else {
      state.env_repair = null;
      if (state.loops) delete state.loops.environment;
    }
  } else if (park.from === 'environment') {
    if (option && option.key === 'b') {
      if (state.loops) delete state.loops.environment;
    } else ER.recheck(root, state);
  }
  // the plan probe was interrupted twice (review MAJ-2): the answer sets how this job is probed,
  // and the interrupted runs are forgotten (a run the human started in their terminal counts)
  if (park.kind === 'plan_probe') {
    if (option && option.key === 'a') state.probe_override = 'lint';
    else if (option && option.key === 'c') state.probe_override = false;
    try {
      require('fs').rmSync(require('./probe').STARTED(root, state.id), { force: true });
    } catch {
      /* nothing started */
    }
  }
  let grant = null;
  if (from === 'budget' || park.kind === 'budget') {
    grant = (option && budgetGrant(option.text)) || budgetGrant(words, L.max_agent_runs_per_job);
    if (grant) state.policy.limits.max_agent_runs_per_job = Math.ceil(state.policy.limits.max_agent_runs_per_job * grant);
  }
  if (words) state.human_notes = [...(state.human_notes || []), { at: nowIso(), text: String(words).slice(0, 2000), from: park.kind || from || null, ...(park.question ? { question: park.question } : {}), ...(option ? { option: option.key, option_text: String(option.text || '').slice(0, 600), ...(option.extra ? { added: String(option.extra).slice(0, 1400) } : {}) } : {}) }].slice(-10);
  state.repeat = { key: null, count: 0 };
  delete state.transient_aborts; // the human says Copilot works again: count transient runs afresh
  state.status = 'active';
  state.resumed = { at: nowIso(), from, step: step || null, ...(via ? { via } : {}), ...(words ? { words: String(words).slice(0, 500) } : {}), ...(grant ? { grant } : {}) };
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
  // the fetched dependency source is a cache: an ended job does not keep it
  try {
    require('./deps').cleanup(root, state.id);
  } catch {
    /* a convenience */
  }
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
  // a bare "merged": the merge the router saw on the base branch
  if (!commit) commit = require('./decision-table').detectLocalMerge(root, state);
  if (!commit) fail(`${state.base_branch || 'The base branch'} does not contain ${state.id}'s shipped head yet: merge it first, or name the commit ("merged <commit>").`, 'bad_input');
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
  // the files the check rests on (what the tasks that cover the criterion changed): a later fix
  // round that leaves them as they are does not ask for the check again (verify.js)
  const scope = require('./verify').humanScope(root, state, ac.toUpperCase());
  ledger.append(root, state.id, { kind: 'evidence', ac: ac.toUpperCase(), type: 'human', fingerprint: ctx.b.fingerprint, pass: true, source: `human:${channel}`, ...(scope ? { scope: scope.paths, files: scope.files } : {}) });
  log(root, state, 'confirm_ac', { channel, ac });
  return { job: state.id, message: `Confirmed ${ac.toUpperCase()} for ${state.id} on the current build. Run factory verify run to include it.` };
}

// "approve ship": the human's go to push the job branch and open the pull request (part of the
// ship review at low or medium risk, when the repository has not opted in to automatic draft PRs).
// Bound to the build it was given for: a new build asks again.
function approveShip(root, { jobId, channel }) {
  requireHumanChannel(channel);
  const state = job.resolve(root, jobId);
  const ctx = steps.context(root, state, job.load);
  if (!ctx.b.fingerprint) fail('Nothing built yet to ship.', 'bad_input');
  if (state.pr && state.pr.fingerprint === ctx.b.fingerprint) fail(`${state.id} is already shipped for this build.`, 'bad_input');
  confirmTyped(channel, state.id, 'approve pushing it and opening the pull request');
  state.ship_approval = { fingerprint: ctx.b.fingerprint, at: nowIso(), via: channel };
  job.save(root, state);
  log(root, state, 'approve_ship', { channel, fingerprint: ctx.b.fingerprint });
  return { job: state.id, message: `Push and pull request approved for ${state.id} on build ${ctx.b.fingerprint.slice(0, 12)}. Copilot continues with factory next (it runs factory ship).` };
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
// A reason copied from a reply form ("<why>", "<reason>") or too short to say anything is no reason.
const PLACEHOLDER = (r) => /^<[^>]*>$|^\[[^\]]*\]$/.test(String(r || '').trim()) || /<(why|reason|what[^>]*)>/i.test(String(r || ''));
function parseReply(text) {
  const p = parseReplyRaw(text);
  if (p && ['settle_finding', 'waive', 'deny', 'cancel', 'abandon', 'reject_lesson', 'reject_brief'].includes(p.cmd) && p.reason && PLACEHOLDER(p.reason)) return null;
  if (p && ['settle_finding', 'waive'].includes(p.cmd) && p.reason && String(p.reason).trim().length < 3) return null;
  return p;
}

function parseReplyRaw(text) {
  const t = String(text || '').trim().replace(TRAILING, '');
  if (!t || t.includes('\n')) return null;
  let m;
  const J = '(J-\\d+)';
  if ((m = t.match(new RegExp(`^approve(?:\\s+${J})?\\s+environment(?:\\s+([0-9a-f]{8}))?$`, 'i')))) return { cmd: 'approve_environment', jobId: m[1] && m[1].toUpperCase(), hash: m[2] ? m[2].toLowerCase() : null };
  if ((m = t.match(new RegExp(`^approve(?:\\s+${J})?\\s+ship$`, 'i')))) return { cmd: 'approve_ship', jobId: m[1] && m[1].toUpperCase() };
  if ((m = t.match(new RegExp(`^approve(?:\\s+${J})?(?:\\s+(${GATE_IDS.join('|')}))?$`, 'i')))) return { cmd: 'approve', jobId: m[1] && m[1].toUpperCase(), gate: m[2] && m[2].toUpperCase() };
  if ((m = t.match(new RegExp(`^deny(?:\\s+${J})?(?:(?:\\s*[:\u2014\u2013-]\\s*|\\s+)(.*))?$`, 'i')))) return { cmd: 'deny', jobId: m[1] && m[1].toUpperCase(), reason: (m[2] || '').trim() };
  if ((m = t.match(new RegExp(`^resume(?:\\s+${J})?(?:\\s+(.*))?$`, 'i')))) return { cmd: 'resume', jobId: m[1] && m[1].toUpperCase(), step: (m[2] || '').trim() || null };
  if ((m = t.match(new RegExp(`^proceed(?:\\s+${J})?$`, 'i')))) return { cmd: 'proceed', jobId: m[1] && m[1].toUpperCase() };
  if ((m = t.match(new RegExp(`^(cancel|abandon)\\s+job(?:\\s+${J})?(?:\\s+(.*))?$`, 'i')))) return { cmd: m[1].toLowerCase() === 'cancel' ? 'cancel' : 'abandon', jobId: m[2] && m[2].toUpperCase(), reason: (m[3] || '').trim() };
  if ((m = t.match(new RegExp(`^(accept|dismiss)\\s+finding(?:\\s+${J})?\\s+([a-z][\\w.@-]*-\\d+(?:@r\\d+)?)(?:\\s*[:\u2014\u2013-]?\\s+(.*))?$`, 'i')))) return { cmd: 'settle_finding', decision: m[1].toLowerCase(), jobId: m[2] && m[2].toUpperCase(), id: m[3], reason: (m[4] || '').trim() };
  if ((m = t.match(/^confirm\s+environment(?:\s+(none|[0-9a-f]{8}))?$/i))) return { cmd: 'set_environment', none: Boolean(m[1] && m[1].toLowerCase() === 'none'), hash: m[1] && m[1].toLowerCase() !== 'none' ? m[1].toLowerCase() : null };
  if ((m = t.match(/^(accept|reject)\s+lesson\s+(L\d+)(?:\s+(.*))?$/i))) return { cmd: `${m[1].toLowerCase()}_lesson`, lessonId: m[2].toUpperCase(), reason: (m[3] || '').trim() };
  if ((m = t.match(/^(accept|reject)\s+brief\s+(P\d+)(?:\s+(.*))?$/i))) return { cmd: `${m[1].toLowerCase()}_brief`, proposalId: m[2].toUpperCase(), reason: (m[3] || '').trim() };
  if ((m = t.match(new RegExp(`^waive(?:\\s+${J})?\\s+([a-z_:]+)\\s+(.+)$`, 'i')))) return { cmd: 'waive', jobId: m[1] && m[1].toUpperCase(), floor: m[2], reason: m[3].trim() };
  if ((m = t.match(new RegExp(`^merged(?:\\s+${J})?\\s+([0-9a-f]{7,40})$`, 'i')))) return { cmd: 'merged', jobId: m[1] && m[1].toUpperCase(), commit: m[2] };
  if ((m = t.match(new RegExp(`^merged(?:\\s+${J})?$`, 'i')))) return { cmd: 'merged', jobId: m[1] && m[1].toUpperCase(), commit: null };
  if ((m = t.match(new RegExp(`^confirm\\s+((?:E-)?AC-\\d+)(?:\\s+${J})?$`, 'i')))) return { cmd: 'confirm', ac: m[1], jobId: m[2] && m[2].toUpperCase() };
  if ((m = t.match(new RegExp(`^change(?:\\s+${J})?\\s+(A-\\d+)(?:\\s*[:=\u2014\u2013-]\\s*|\\s+(?:to\\s+)?)(\\S.*)$`, 'i')))) return { cmd: 'change_assumption', jobId: m[1] && m[1].toUpperCase(), id: m[2].toUpperCase(), value: m[3].trim() };
  if ((m = t.match(new RegExp(`^drop(?:\\s+${J})?\\s+(A-\\d+)(?:\\s+${J})?$`, 'i')))) return { cmd: 'drop_assumption', jobId: (m[1] || m[3]) && (m[1] || m[3]).toUpperCase(), id: m[2].toUpperCase() };
  return null;
}

// One message that is several exact replies, separated by ";" or new lines ("confirm AC-2;
// dismiss finding code-1 not reachable; approve"): the ship review and the end-of-job digest in
// one reply. Every part must be an exact reply, or nothing is taken as one.
function parseBatch(text) {
  const t = String(text || '').trim();
  if (!t || (!t.includes(';') && !t.includes('\n'))) return null;
  const parts = t.split(/\s*;\s*|\s*\n+\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const parsed = parts.map((x) => parseReply(x));
  if (parsed.some((x) => !x)) return null;
  return { cmd: 'batch', parts: parsed.map((x, i) => ({ ...x, text: parts[i] })) };
}

// Every way a message can be taken as the user's reply, without the job's state: the one reader
// the prompt hook classifies every prompt by, a scheduled one (/every, /after, /loop: never
// applied) included (review B1 analogue: the scheduled path had its own, narrower list). Forms:
//   exact      one exact reply (parseReply)          batch      several, separated by ";" or lines
//   near_miss  looks like one, is not (a hint)        clarify    ok, "ok, but …", a sheet answer
//   park       an option letter or number, "option b", yes / do it / use it, a budget grant
//   inspector  the inspector plugin's replies (marking findings, modes)
// Any line or ";"-part counts: a batch with one exact part reads as a reply.
const SHEET = /^\s*(\d{1,2}\s*[:.)]?\s*(?:[a-e]\b|defer\b|other\b|:)|fact\s+\d+\s*:)/i;
const INSPECTOR = /^\s*((ack|fixed|wontfix|reopen)\s+finding\s+F\d+|inspect\s+mode\s+\S+\s+(on|off|sample))\b/i;
const ACCEPT_HEAD = /^(ok|okay|yes|yep|fine|sure|agreed|looks good|lgtm|sounds good|accept(?: all)?|go ahead)\s*[,.;:!]\s*(?:but|except|and|although|though)?\b/i;
function readReply(text) {
  const t = String(text || '').trim();
  const out = { text: t, parsed: null, miss: null, forms: [], reply: false };
  if (!t) return out;
  out.parsed = parseReply(t) || parseBatch(t);
  out.miss = out.parsed ? null : nearMiss(t);
  const forms = new Set();
  if (out.parsed) forms.add(out.parsed.cmd === 'batch' ? 'batch' : 'exact');
  if (out.miss) forms.add('near_miss');
  const C = require('./clarify');
  const parts = [...new Set([t, ...t.split(/\n|;/).map((x) => x.trim()).filter(Boolean)])];
  for (const x of parts) {
    const y = x.replace(TRAILING, '') || x;
    if (parseReply(x)) forms.add('exact');
    else if (nearMiss(x)) forms.add('near_miss');
    if (C.ACCEPT.test(y) || ACCEPT_HEAD.test(x) || SHEET.test(x)) forms.add('clarify');
    if (PARK_OPTION.test(y) || PARK_LETTER.test(y) || PARK_CONFIRM.test(y) || budgetGrant(y)) forms.add('park');
    if (INSPECTOR.test(x)) forms.add('inspector');
  }
  out.forms = [...forms];
  out.reply = forms.size > 0;
  return out;
}

// The exact forms, for "that was not applied" hints.
const REPLY_FORMS = ['approve [J-0001] [H1]', 'approve ship', 'approve environment <hash> (a repaired build environment)', 'several replies in one message, separated by ";"', 'deny [J-0001] <reason>', 'resume [J-0001] [step]', 'proceed [J-0001]', 'cancel job [J-0001] [reason]', 'abandon job [J-0001] [reason]', 'waive [J-0001] <floor> <reason>', 'merged [J-0001] [sha]', 'confirm AC-1 [J-0001]', 'change [J-0001] A-3 <new value>', 'drop [J-0001] A-3', 'accept lesson L4', 'reject lesson L4 [reason]', 'accept brief P1', 'reject brief P1 [reason]', 'accept finding code-1 <reason>', 'dismiss finding code-1 <reason>', 'confirm environment [hash|none]'];
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
    case 'batch': {
      // in order; a part that fails stops the rest (what was applied stays applied, and says so)
      const done = [];
      for (const p of parsed.parts) {
        try {
          const r = applyReply(root, p, channel);
          done.push(`${p.text}: ${r.message || 'applied'}`);
        } catch (e) {
          const msg = `${done.length ? `Applied ${done.length} of ${parsed.parts.length}: ${done.join(' | ')}. ` : ''}NOT applied: "${p.text}" (${e.message})${parsed.parts.length - done.length > 1 ? ` and the ${parsed.parts.length - done.length - 1} part(s) after it` : ''}.`;
          if (!done.length) fail(msg, e.code || 'bad_input');
          return { message: msg, applied: done.length, of: parsed.parts.length, partial: true };
        }
      }
      return { message: `Applied all ${done.length}: ${done.join(' | ')}`, applied: done.length, of: parsed.parts.length };
    }
    case 'approve_ship':
      return approveShip(root, { jobId: parsed.jobId, channel });
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
    case 'accept_brief':
    case 'reject_brief':
      return require('./project-brief').decide(root, { id: parsed.proposalId, accept: parsed.cmd === 'accept_brief', reason: parsed.reason, channel });
    case 'waive':
      return waive(root, { jobId: parsed.jobId, floor: parsed.floor, reason: parsed.reason, channel });
    case 'merged':
      return merged(root, { jobId: parsed.jobId, commit: parsed.commit, channel });
    case 'confirm':
      return confirmAc(root, { jobId: parsed.jobId, ac: parsed.ac, channel });
    case 'change_assumption':
      return changeAssumption(root, { jobId: parsed.jobId, id: parsed.id, value: parsed.value, channel });
    case 'approve_environment': {
      const st = job.resolve(root, parsed.jobId);
      if (!(st.status === 'parked' && st.park && st.park.kind === 'environment_repair')) fail(`${st.id} has no repaired build environment waiting for your seal.`, 'no_repair');
      return replyToPark(root, { jobId: st.id, text: parsed.hash ? `approve environment ${parsed.hash}` : 'approve environment', channel });
    }
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

module.exports = { readReply, applyResume, replyToPark, parkAnswer, approveShip, parseBatch, budgetGrant, splitResume, snapshot, GATE_IDS, requireHumanChannel, confirmTyped, confirmationCode, CODE_ALPHABET, agentContext, testToken, AGENT_ENV, approve, deny, resume, stop, waive, merged, confirmAc, changeAssumption, settleFinding, setEnvironment, parseReply, nearMiss, REPLY_FORMS, applyReply, sha256 };
