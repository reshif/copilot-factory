'use strict';
// Fixes after the Phase 4 review: model fallback and the models switch (B1), drive-stop
// surfacing on drive.js's real event order (M1), escalation on the global attempt (M7), the
// transcript disk budget and pruned links (M6), unknown tool counts (m3), stderr of every spawn
// (m4), the /files/ route and symlinks (m5), redaction (m6), transient defaults (m10).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');

const FAKE = path.join(__dirname, 'helpers', 'fake-copilot.js');
const CREW = path.join(__dirname, 'helpers', 'crew.js');
const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

function newJob(root, policy) {
  if (policy) fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify(policy));
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  return J;
}
function env(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-p4r-'));
  return { dir, log: path.join(dir, 'copilot.jsonl'), env: { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: FAKE, FAKE_COPILOT_SCRIPT: CREW, FAKE_COPILOT_LOG: path.join(dir, 'copilot.jsonl'), FACTORY_NOTIFY: 'off', ...extra } };
}
const run = (root, e, args) => {
  const r = spawnSync('node', [F.BIN, ...args], { cwd: root, encoding: 'utf8', env: e.env, timeout: 300000 });
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    j = { raw: r.stdout };
  }
  return Object.assign(j, { __stderr: r.stderr, __code: r.status });
};
const calls = (e) => (fs.existsSync(e.log) ? fs.readFileSync(e.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

test('B1: a model the account cannot use is retried once on the session default, logged, and skipped for the rest of the run and later runs', () => {
  const root = F.makeRepo();
  newJob(root);
  F.cli(root, ['next']);
  const e = env({ FAKE_COPILOT_REJECT_MODELS: 'claude-haiku-5.5' });
  const r = run(root, e, ['run', 'clarify', '--json']);
  assert.equal(r.__code, 0, r.__stderr);
  assert.equal(r.status, 'needs_user', JSON.stringify(r).slice(0, 400));
  const log = calls(e);
  const iv = log.filter((c) => c.agent === 'factory:interviewer');
  assert.deepEqual(iv.map((c) => [c.model, Boolean(c.rejected)]), [['claude-haiku-5.5', true], [null, false]], 'refused, then the same turn on the session default');
  const fb = events(root).filter((x) => x.event === 'agent_model_fallback');
  assert.equal(fb.length, 1);
  assert.equal(fb[0].model_id, 'claude-haiku-5.5');
  assert.match(fb[0].detail, /not available/);
  const ar = events(root).find((x) => x.event === 'agent_run' && x.role === 'interviewer');
  assert.equal(ar.outcome, 'ok');
  assert.equal(ar.model_fallback.model_id, 'claude-haiku-5.5');
  assert.equal(ar.model_id, null);
  const cache = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'cache', 'rejected-models.json'), 'utf8'));
  assert.ok(cache.models['claude-haiku-5.5']);
  // the next run skips the id without asking Copilot again
  F.cli(root, ['clarify', 'reply', 'ok']);
  F.cli(root, ['next']);
  const before = calls(e).length;
  run(root, e, ['run', 'clarify', '--json']);
  const later = calls(e).slice(before);
  assert.ok(later.length > 0);
  assert.ok(!later.some((c) => c.model === 'claude-haiku-5.5'), JSON.stringify(later.map((c) => [c.agent, c.model])));
  // (0.8.1: only the interviewer is on the fast tier; a later run's interviewer, if any, skips it)
  assert.ok(later.filter((c) => c.agent === 'factory:interviewer').every((c) => c.model === null));
  assert.ok(require('../cli/core/models').loadRejected(root).has('claude-haiku-5.5'));
  // doctor names it
  const d = spawnSync('node', [F.BIN, 'doctor'], { cwd: root, encoding: 'utf8', env: e.env });
  const chk = JSON.parse(d.stdout).checks.find((c) => c.name === 'copilot models');
  assert.equal(chk.ok, false);
  assert.match(chk.detail, /refused claude-haiku-5\.5 recently/);
});

test('B1: one switch (agents.models_enabled: false, or models: "default") runs every role on the session default, for running jobs too', () => {
  const root = F.makeRepo();
  newJob(root);
  F.cli(root, ['next']);
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ agents: { models_enabled: false } })); // after the job snapshotted its policy
  const e = env();
  const r = run(root, e, ['run', 'clarify', '--json']);
  assert.equal(r.status, 'needs_user', r.__stderr);
  assert.ok(calls(e).length && calls(e).every((c) => c.model === null), JSON.stringify(calls(e).map((c) => c.model)));
  const M = require('../cli/core/models');
  assert.equal(M.modelsOff({ agents: { models: 'default' } }), true);
  assert.equal(require('../cli/core/wfargs').roleModel({ agents: { models: 'default' } }, 'builder'), null);
  assert.equal(require('../cli/core/wfargs').roleModel({ agents: { models_enabled: false, models: { builder: 'opus' } } }, 'builder'), null);
});

test('B1: the model-rejection matcher is conservative; doctor warns on a CLI older than the default ids', () => {
  const M = require('../cli/core/models');
  const id = 'claude-opus-5.5';
  assert.ok(M.rejection({ code: 1, stderr: 'Error: Model "claude-opus-5.5" is not available.', stdout: '' }, id));
  assert.ok(M.rejection({ code: 1, stderr: 'error: model claude-opus-5.5 is not enabled for your organization', stdout: '' }, id));
  assert.equal(M.rejection({ code: 0, stderr: 'model not available', stdout: '' }, id), null, 'exit 0 is never a refusal');
  assert.equal(M.rejection({ code: 1, stderr: 'TypeError: x is not a function', stdout: '' }, id), null);
  assert.equal(M.rejection({ code: 1, stderr: 'model not available', stdout: '{"type":"assistant.message","data":{"content":"done"}}' }, id), null, 'an agent that answered was not refused at startup');
  assert.equal(M.rejection({ code: 1, timedOut: true, stderr: 'model unavailable' }, id), null);
  assert.deepEqual(M.versionWarnings('GitHub Copilot CLI 1.0.90', ['claude-haiku-5.5', 'claude-opus-5.5', 'claude-sonnet-5.5']), [{ id: 'claude-haiku-5.5', min: '1.0.94' }]);
  assert.deepEqual(M.versionWarnings('1.0.97', ['claude-haiku-5.5', 'claude-opus-5.5']), []);
  // doctor with a CLI that says 1.0.90
  const root = F.makeRepo();
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oldcli-')), 'copilot.js');
  fs.writeFileSync(bin, "process.stdout.write('GitHub Copilot CLI 1.0.90\\n');\n");
  const d = spawnSync('node', [F.BIN, 'doctor'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '', COPILOT_BIN: bin } });
  const chk = JSON.parse(d.stdout).checks.find((c) => c.name === 'copilot models');
  assert.equal(chk.ok, false);
  assert.match(chk.detail, /predates claude-haiku-5\.5 \(added in 1\.0\.94\)/);
  assert.match(chk.detail, /claude-haiku-5\.5: interviewer, sweep-check[\s\S]*every other role: your Copilot session default model[\s\S]*attempt 3\+: claude-opus-5\.5/);
});

test('M7: builder escalation uses the global attempt number, across factory runs', async () => {
  const H = require('./helpers/workflow-harness');
  const { builderSpec } = require('../cli/core/wfargs');
  const spec = builderSpec({ policy: require('../cli/core/policy').defaults() });
  // attempts 1 and 2 were spent by an earlier run: this run's first attempt is #3
  const brief = { workflow: 'realize', job: 'J-0001', input_hash: 'h', budgets: {}, waves: [['T1']], tasks: { T1: { id: 'T1', depends_on: [], retry_limit: 3, attempt_base: 2, builder: spec, builder_prompt: 'B T1 {{attempt}} {{failures}}' } }, max_parallel_tasks: 1, builder_schema: {} };
  const r = await H.run(path.join(F.PLUGIN, 'workflows', 'realize.js'), brief, () => ({ status: 'done', summary: 'ok', swept: [] }), { verify: async (id) => ({ task: id, pass: true, failures: [] }) });
  const b = r.calls.filter((c) => c.prompt.startsWith('B T1'));
  assert.equal(b[0].opts.label, 'build T1 #3');
  assert.equal(b[0].opts.model, 'opus', 'attempt #3 escalates even as the first attempt of this run');
});

test('M1: R25 on drive.js\'s real event order: a sent notification surfaces the stop, notifications off do not', () => {
  const R = require('../../factory-inspector/inspector/rules');
  const { LIMITS } = require('../../factory-inspector/inspector/config');
  const O = require('../../factory-inspector/inspector/observe');
  const crewDrive = (extraEnv) => {
    const root = F.makeRepo();
    const J = newJob(root);
    const e = env(extraEnv);
    const s = run(root, e, ['drive']);
    assert.ok(s.kind, JSON.stringify(s).slice(0, 300));
    const ev = events(root);
    const iStop = ev.findIndex((x) => x.event === 'drive_stop');
    const iNote = ev.findIndex((x) => x.event === 'notify');
    assert.ok(iNote >= 0 && iNote < iStop, 'drive.js logs the notification just before its stop');
    const job = O.observe(root).jobs[J];
    const later = new Date(Date.now() + 3 * 36e5).toISOString();
    return { root, J, stop: ev[iStop], fired: R.jobHealth(job, LIMITS, later).some((x) => x.rule === 'R25.drive_stop_unsurfaced') };
  };
  // a notifier that works: notify-send on PATH
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-'));
  fs.writeFileSync(path.join(bin, 'notify-send'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const sent = crewDrive({ FACTORY_NOTIFY: '', PATH: `${bin}${path.delimiter}${process.env.PATH}`, WSL_DISTRO_NAME: '' });
  assert.equal(sent.stop.sent, true, JSON.stringify(sent.stop));
  assert.equal(sent.fired, false, 'notified: surfaced');
  const off = crewDrive({ FACTORY_NOTIFY: 'off' });
  assert.equal(off.stop.sent, false);
  assert.equal(off.fired, true, 'notifications off, nobody looked, no reply: not surfaced');
});

test('M6: the transcript disk budget prunes across jobs, oldest first, never a live run; the console marks a pruned transcript', () => {
  const T = require('../cli/core/transcripts');
  const root = F.makeRepo();
  const J1 = newJob(root);
  const J2 = newJob(root);
  const mk = (job, name, bytes, ageMin) => {
    const d = path.join(T.runsDir(root, job), name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'a.jsonl'), 'x'.repeat(bytes));
    const t = new Date(Date.now() - ageMin * 60000);
    fs.utimesSync(d, t, t);
    return d;
  };
  mk(J1, '20260101T000000-clarify-1', 4000, 50);
  mk(J1, '20260102T000000-clarify-2', 4000, 40);
  mk(J2, '20260103T000000-realize-3', 4000, 30);
  mk(J2, '20260104T000000-realize-4', 4000, 20);
  // a live run lock on J2: its runs are never touched by another job's prune
  fs.writeFileSync(path.join(F.jobDir(root, J2), 'run.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), heartbeat_sec: 15 }));
  let removed = T.pruneAll(root, { totalBytes: 12000, keepRuns: 30 }, { ownJob: J1 });
  assert.deepEqual(removed.map((x) => [x.job, x.run, x.why]), [[J1, '20260101T000000-clarify-1', 'total_bytes']], 'oldest first, and J2 is live');
  fs.rmSync(path.join(F.jobDir(root, J2), 'run.lock'));
  removed = T.pruneAll(root, { totalBytes: 9000, keepRuns: 1 }, { ownJob: J1 });
  assert.deepEqual(removed.map((x) => [x.job, x.run, x.why]), [[J2, '20260103T000000-realize-3', 'keep_runs']]);
  // an ended job: after closed_days
  const st = require('../cli/core/job').load(root, J1);
  st.status = 'closed';
  st.closed_at = new Date(Date.now() - 30 * 864e5).toISOString();
  require('../cli/core/job').save(root, st);
  removed = T.pruneAll(root, { totalBytes: 1e9, closedDays: 14 });
  assert.deepEqual(removed.map((x) => [x.job, x.why]), [[J1, 'closed_days']]);
  // the console: a link to a pruned transcript says pruned, a live one links
  const { runnerExtras } = require('../cli/core/console');
  const gone = runnerExtras({ transcript: `.factory/scratch/runs/${J1}/20260101T000000-clarify-1/read-back.jsonl` }, root);
  assert.deepEqual([gone.transcript, gone.transcript_pruned], [undefined, true]);
  const kept = runnerExtras({ transcript: `.factory/scratch/runs/${J2}/20260104T000000-realize-4/a.jsonl` }, root);
  assert.equal(kept.transcript, `.factory/scratch/runs/${J2}/20260104T000000-realize-4/a.jsonl`);
});

test('m3/m4/m6: tool calls unknown when the CLI sent no events; every spawn\'s stderr is kept; secrets are redacted on disk', () => {
  const T = require('../cli/core/transcripts');
  const t = T.open(null);
  t.write('plain text, no JSONL\n');
  t.write('{"type":"session.shutdown","data":{"shutdownType":"routine"}}\n');
  t.flush();
  const r = t.result();
  assert.equal(r.tool_calls, null, 'no message or tool event: unknown, not 0');
  assert.deepEqual(r.usage, { reported: false }, 'a shutdown with no numbers reports nothing');
  assert.equal(T.totals([{ ms: 1, tool_calls: null, usage: { reported: false } }]).tool_calls, null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-red-'));
  const f = path.join(dir, 'x.jsonl');
  const w = T.open(f);
  w.write('{"type":"tool.execution_complete","data":{"result":{"content":"GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 and sk-ant-abcdefghijklmnopqrstuvwx"}}}\n');
  w.flush();
  const disk = fs.readFileSync(f, 'utf8');
  assert.ok(!/ghp_abcdef|sk-ant-abcdef/.test(disk), disk);
  assert.match(disk, /«redacted»/);
  T.writeStderr(path.join(dir, 'x.stderr.log'), 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\n');
  assert.match(fs.readFileSync(path.join(dir, 'x.stderr.log'), 'utf8'), /Bearer «redacted»/);
  // a failing agent: every spawn's stderr (format turn included) lands in its .stderr.log
  const root = F.makeRepo();
  newJob(root);
  F.cli(root, ['next']);
  const script = path.join(dir, 's.js');
  fs.writeFileSync(script, `module.exports = (c) => (c.agent === 'factory:interviewer' ? { exit: 1, stderr: 'first spawn: boom token=supersecretvalue' } : {});\n`);
  const e = env({ FAKE_COPILOT_SCRIPT: script });
  run(root, e, ['run', 'clarify', '--json']);
  const ar = events(root).find((x) => x.event === 'agent_run' && x.role === 'interviewer');
  assert.ok(ar.stderr_file, JSON.stringify(ar));
  const log = fs.readFileSync(path.join(root, ar.stderr_file), 'utf8');
  assert.match(log, /first spawn: boom/);
  assert.ok(!/supersecretvalue/.test(log) && !/supersecretvalue/.test(ar.stderr_tail), 'redacted in the log and the tail');
});

test('m5: /files/ serves only .jsonl and .log, and never through a symlink out of the transcripts folder', async () => {
  const root = F.makeRepo();
  newJob(root);
  const runs = path.join(root, '.factory', 'scratch', 'runs', 'J-0001', 'r');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'ok.jsonl'), '{"type":"x"}\n');
  fs.symlinkSync(path.join(root, '.factory', 'policy.json'), path.join(runs, 'leak.jsonl'));
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), '{"secret":1}');
  fs.writeFileSync(path.join(runs, 'page.html'), '<b>x</b>');
  const http = require('http');
  const get = (url) => new Promise((res) => http.get(url, (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res({ code: r.statusCode, body: b })); }));
  await new Promise((resolve) => {
    require('../cli/core/console').serve(root, { port: 0, onReady: async ({ url, close }) => {
      assert.equal((await get(`${url}files/.factory/scratch/runs/J-0001/r/ok.jsonl`)).code, 200);
      assert.equal((await get(`${url}files/.factory/scratch/runs/J-0001/r/leak.jsonl`)).code, 404, 'a symlink out of the folder');
      assert.equal((await get(`${url}files/.factory/scratch/runs/J-0001/r/page.html`)).code, 404, 'only transcripts and logs');
      close();
      resolve();
    } });
  });
});

test('m10: runAgent defaults the transient settings itself (a missing transientRetries is not unlimited)', () => {
  const src = fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'runner.js'), 'utf8');
  assert.match(src, /Number\.isInteger\(S\.transientRetries\) \? S\.transientRetries : 4/);
  assert.match(src, /typeof S\.transientBackoffSec === 'number' \? S\.transientBackoffSec : 10/);
});

test('M3: drive\'s done stop names the brief proposals waiting for the user', () => {
  const d = require('../cli/core/drive').stopDetail('done', { job: 'J-0001', reason: 'closed' }, { job: 'J-0001', lessons: [], briefs: [{ id: 'P1', job: 'J-0001', edits: 1 }] });
  assert.match(d.summary, /Project brief changes proposed: P1 \(reply "accept brief Pn"/);
  assert.deepEqual(d.briefs.map((b) => b.id), ['P1']);
});
