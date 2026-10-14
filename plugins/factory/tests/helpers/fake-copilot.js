#!/usr/bin/env node
'use strict';
// A stand-in for the GitHub Copilot CLI, for `factory run` tests (COPILOT_BIN points here).
// It reads the flags `factory run` passes (-p, --agent, --model, --output-format,
// --session-id, --add-dir …) and answers as the agent it was started as, from a script:
//
//   FAKE_COPILOT_SCRIPT  a .json table {"factory:<role>": reply | [reply, reply, …]}
//                        (an array is indexed by how many times that role ran before),
//                        or a .js module exporting (call) => reply (may be async).
//   FAKE_COPILOT_LOG     JSONL file: one line per invocation (argv, cwd, agent, model,
//                        session, turn, start/end ms, exit, FACTORY_* env).
//
// A reply is a plain object (sent back as the JSON answer), a string (sent as is), or a
// control object with any of: json, text, exit, stderr, sleep_ms.
// `call` holds: agent, role, model, prompt, instructions (the file the prompt points at),
// cwd, argv, add_dirs, session, turn (1 for a new session id, 2 for its resume …), n
// (earlier runs of this role), env (the FACTORY_* variables).

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('GitHub Copilot CLI 1.0.97 (fake)\n');
  process.exit(0);
}

function flag(name) {
  const i = argv.indexOf(name);
  if (i !== -1) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}
const all = (name) => argv.map((a, i) => (a === name ? argv[i + 1] : null)).filter((x) => x !== null);

const prompt = flag('-p') !== undefined ? flag('-p') : flag('--prompt');
const agent = flag('--agent') || null;
const model = flag('--model') || null;
const json = flag('--output-format') === 'json';
const session = flag('--session-id') || flag('--resume') || null;
const logFile = process.env.FAKE_COPILOT_LOG || null;

if (prompt === undefined) {
  process.stderr.write('fake copilot: no -p prompt\n');
  process.exit(2);
}

function readLog() {
  if (!logFile || !fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function instructions(p) {
  for (const line of String(p).split('\n')) {
    const t = line.trim();
    if (t.startsWith('/') && fs.existsSync(t)) return fs.readFileSync(t, 'utf8');
  }
  return p;
}

// Turn within a session: count earlier calls with the same id (state files next to the log).
function turnOf(id) {
  if (!id) return 1;
  const dir = `${logFile || path.join(require('os').tmpdir(), 'fake-copilot')}.sessions`;
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, id.replace(/[^\w-]/g, '_'));
  const n = fs.existsSync(f) ? parseInt(fs.readFileSync(f, 'utf8'), 10) + 1 : 1;
  fs.writeFileSync(f, String(n));
  return n;
}

async function answer(call) {
  const script = process.env.FAKE_COPILOT_SCRIPT;
  if (!script) return { text: 'No FAKE_COPILOT_SCRIPT set.' };
  if (/\.c?js$/.test(script)) return require(path.resolve(script))(call);
  const table = JSON.parse(fs.readFileSync(script, 'utf8'));
  const e = table[call.agent];
  if (e === undefined) return { exit: 1, stderr: `fake copilot: no scripted reply for ${call.agent}` };
  return Array.isArray(e) ? e[Math.min(call.n, e.length - 1)] : e;
}

(async () => {
  const start = Date.now();
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('FACTORY_')) env[k] = v;
  const n = readLog().filter((l) => l.agent === agent).length;
  const call = { agent, role: String(agent || '').replace(/^factory:/, ''), model, prompt, instructions: instructions(prompt), cwd: process.cwd(), argv, add_dirs: all('--add-dir'), session, turn: turnOf(session), n, env };
  let r;
  try {
    r = await answer(call);
  } catch (e) {
    r = { exit: 1, stderr: `fake copilot: script failed: ${e.stack}` };
  }
  const ctl = r && typeof r === 'object' && ['json', 'text', 'exit', 'stderr', 'sleep_ms'].some((k) => k in r) ? r : typeof r === 'string' ? { text: r } : { json: r };
  if (ctl.sleep_ms) await new Promise((res) => setTimeout(res, ctl.sleep_ms));
  const exit = ctl.exit || 0;
  const text = 'json' in ctl ? JSON.stringify(ctl.json) : ctl.text || '';
  if (exit === 0) {
    if (json) {
      // JSONL in the SDK's session event shape: a tool-calling turn, a sub-agent's message
      // (which must be ignored), then the final answer.
      const lines = [
        { type: 'session.start', data: { sessionId: session, model } },
        { type: 'assistant.message', data: { messageId: 'm1', content: '', toolRequests: [{ toolCallId: 't1', name: 'view' }] } },
        { type: 'assistant.message', agentId: 'sub-1', data: { messageId: 'm2', content: '{"not":"this one"}' } },
        { type: 'assistant.message', data: { messageId: 'm3', content: text } },
        { type: 'session.idle', data: {} },
      ];
      process.stdout.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    } else process.stdout.write(text + '\n');
  }
  if (ctl.stderr) process.stderr.write(ctl.stderr + '\n');
  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ start, end: Date.now(), agent, model, cwd: process.cwd(), argv, session, turn: call.turn, exit, env }) + '\n');
  process.exit(exit);
})();
