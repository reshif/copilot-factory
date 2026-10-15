'use strict';
// factory console: reads .factory/ without changing it, records which agents ran per
// step, and writes a page whose data can't break out of its script tag.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');

const instructions = (prompt) => {
  const line = prompt.split('\n').find((l) => l.trim().startsWith('/'));
  return line ? fs.readFileSync(line.trim(), 'utf8') : prompt;
};

async function clarify(root) {
  const brief = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify'], { allowFail: false });
  const { result } = await H.run(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), JSON.stringify(brief), (prompt, opts) => {
    if (opts.agentType === 'factory:intent-mapper') return { unknowns: [] };
    if (opts.agentType === 'factory:intent-analyst') return { focus: 'x', questions: [] };
    if (opts.agentType === 'factory:judge') return { questions: [], dismissed: [] };
    if (opts.agentType === 'factory:god-eye') return { verdict: 'approve', items: [] };
    throw new Error(`unexpected ${opts.agentType}: ${instructions(prompt).slice(0, 80)}`);
  });
  assert.ok(Array.isArray(result.agents) && result.agents.length === 7, 'the envelope carries the roster (intent mapper, intent gate + 3 angles, judge, God Eye)');
  return F.record(root, result);
}

const snapshot = (root) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'worktrees') walk(p); } else out[path.relative(root, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(path.join(root, '.factory'));
  return out;
};

test('console: steps, timeline and the agents per step, read-only', async () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add </script><img src=x onerror=alert(1)>', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.cli(root, ['next']);
  assert.equal((await clarify(root)).status, 'ok');
  assert.equal(F.cli(root, ['next']).step, 'H1');
  F.reply(root, 'approve');
  F.cli(root, ['next']);
  assert.equal(F.cli(root, ['park', '--reason', 'Waiting on the API owners']).status, 'parked');

  // the roster is sealed into the ledger, tied to the routing decision
  const ledger = fs.readFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const ag = ledger.find((e) => e.kind === 'agents');
  assert.ok(ag && ag.seal, 'agents entry is sealed');
  assert.equal(ag.workflow, 'fanout-judge');
  assert.deepEqual([...new Set(ag.agents.map((a) => a.agent_type))].sort(), ['factory:god-eye', 'factory:intent-analyst', 'factory:intent-mapper', 'factory:judge']);
  assert.match(ag.decision_id, /^J-\d+-D\d+$/);

  const before = snapshot(root);
  const out = path.join(os.tmpdir(), `console-${process.pid}-${Date.now()}.html`);
  const dataFile = `${out}.json`;
  const r = F.cli(root, ['console', '--out', out, '--data', dataFile]);
  assert.equal(r.__code, 0, JSON.stringify(r));
  assert.equal(r.written, out);
  assert.deepEqual(snapshot(root), before, 'console changes nothing under .factory/');

  const html = fs.readFileSync(out, 'utf8');
  assert.ok(!html.includes('/*__FACTORY_DATA__*/null'), 'the data slot is filled');
  assert.ok(!html.includes('</script><img'), 'a job title cannot close the script tag');
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const job = data.jobs.find((j) => j.id === J);
  assert.equal(job.recipe, 'bug@low');
  assert.deepEqual(job.steps.map((s) => s.id).slice(0, 4), ['request', 'clarify', 'H1', 'ground']);
  assert.equal(job.steps.find((s) => s.id === 'H1').human, true);
  assert.equal(job.steps.find((s) => s.id === 'realize').stage, 'build');
  const types = job.timeline.map((t) => t.type);
  assert.equal(types[0], 'created');
  for (const t of ['route', 'human', 'agents', 'result']) assert.ok(types.includes(t), `timeline has ${t}`);
  const a = job.timeline.find((t) => t.type === 'agents');
  assert.equal(a.step, 'clarify', 'agents are placed on the step that ran them');
  assert.equal(a.agents.filter((x) => x.role === 'intent-analyst').length, 4);
  assert.equal(job.timeline.find((t) => t.type === 'human').step, 'H1');
  const park = job.timeline.find((t) => t.type === 'park');
  assert.ok(park && /API owners/.test(park.text), 'a park you asked for is on the timeline, even after a resume clears it from state');
  assert.equal(job.timeline.filter((t) => t.type === 'park').length, 1, 'state.park and the park command are one event');
  assert.equal(data.integrity.status, 'verified');
});

test('console: never creates a factory key on a machine without one', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  const key = path.join(os.tmpdir(), `no-key-${process.pid}-${Date.now()}`, 'secret');
  const out = path.join(os.tmpdir(), `console-nokey-${process.pid}.html`);
  const r = spawnSync('node', [F.BIN, 'console', '--out', out], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '', FACTORY_SECRET_FILE: key } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).integrity, 'not_checked');
  assert.ok(!fs.existsSync(key), 'no key file was created');
});

test('console --serve: streams fresh data when the factory writes, only to this machine', async () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Live one', '--type', 'bug', '--risk', 'low']).job;
  const http = require('http');
  const { url, close } = await new Promise((resolve) => require('../cli/core/console').serve(root, { port: 0, interval: 50, onReady: resolve }));
  try {
    const get = (p, headers = {}) => new Promise((res, rej) => http.get(url + p, { headers }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));
    const page = await get('');
    assert.equal(page.status, 200);
    assert.match(page.body, /"live":true/);
    assert.equal((await get('data.json', { host: 'attacker.example' })).status, 403, 'a rebound foreign host is refused');

    const events = [];
    let wake = () => {};
    const req = http.get(`${url}events`, (r) => {
      let buf = '';
      r.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (line) { events.push(JSON.parse(line.slice(6))); wake(); }
        }
      });
    });
    const nextEvent = (n) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('no event')), 5000); const check = () => { if (events.length >= n) { clearTimeout(t); res(events[n - 1]); } }; wake = check; check(); });
    assert.equal((await nextEvent(1)).jobs.find((j) => j.id === J).status, 'active', 'connecting sends the current data');
    F.cli(root, ['park', '--reason', 'Waiting on the API owners']);
    assert.equal((await nextEvent(2)).jobs.find((j) => j.id === J).status, 'parked', 'a CLI write reaches the open page');
    req.destroy();
  } finally {
    close();
  }
});

test('console: each job carries a rev that changes only when that job does, and items name their stage', () => {
  const root = F.makeRepo();
  const A = F.cli(root, ['job', 'new', '--title', 'First', '--type', 'bug', '--risk', 'low']).job;
  F.cli(root, ['next']);
  const B = F.cli(root, ['job', 'new', '--title', 'Second', '--type', 'bug', '--risk', 'low']).job;
  const { build } = require('../cli/core/console');
  const rev = (d, id) => d.jobs.find((j) => j.id === id).rev;
  const d1 = build(root);
  const d2 = build(root);
  assert.match(rev(d1, A), /^[0-9a-f]{12}$/);
  assert.equal(rev(d1, A), rev(d2, A), 'same files, same rev');
  F.cli(root, ['park', '--reason', 'later', '--job', B]);
  const d3 = build(root);
  assert.notEqual(rev(d3, B), rev(d1, B), 'the parked job has a new rev');
  assert.equal(rev(d3, A), rev(d1, A), 'the other job keeps its rev');
  const route = d3.jobs.find((j) => j.id === A).timeline.find((t) => t.type === 'route' && t.step);
  assert.equal(route.stage, 'contract', 'a routed step carries its stage');
});

test('console: an agent with no stop event is running only while recent and the job is active', () => {
  const root = F.makeRepo();
  const A = F.cli(root, ['job', 'new', '--title', 'Active', '--type', 'bug', '--risk', 'low']).job;
  const B = F.cli(root, ['job', 'new', '--title', 'Parked', '--type', 'bug', '--risk', 'low']).job;
  F.cli(root, ['park', '--reason', 'later', '--job', B]);
  const { build, STALE_AGENT_MS } = require('../cli/core/console');
  const now = Date.parse('2030-01-01T12:00:00.000Z');
  const at = (ms) => new Date(now - ms).toISOString();
  const ev = (job, id, ts, type = 'factory:builder') => JSON.stringify({ ts, event: 'SubagentStart', job, agent_id: id, agent_type: type });
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), [
    ev(A, 'fresh', at(10 * 60000)),
    ev(A, 'crashed', at(STALE_AGENT_MS + 60000), 'factory:tester'),
    ev(B, 'parked-job', at(60000)),
  ].join('\n') + '\n');
  const data = build(root, { now: new Date(now).toISOString() });
  const a = data.jobs.find((j) => j.id === A);
  const b = data.jobs.find((j) => j.id === B);
  assert.deepEqual(a.running_agents.map((x) => x.agent_type), ['factory:builder'], 'only the recent one is running');
  assert.deepEqual(a.stale_agents.map((x) => [x.agent_type, x.stale]), [['factory:tester', true]], 'the old one is marked stale');
  assert.equal(b.running_agents.length, 0, 'a job that is not active has nothing running');
  assert.equal(b.stale_agents.length, 1);
});

test('console: a factory run agent is at work from agent_start until its agent_run, while the run lock is live', () => {
  const root = F.makeRepo();
  const A = F.cli(root, ['job', 'new', '--title', 'Clarify me', '--type', 'bug', '--risk', 'low']).job;
  const { build } = require('../cli/core/console');
  const { jobPaths } = require('../cli/lib/paths');
  const now = Date.parse('2030-01-01T12:00:00.000Z');
  const at = (ms) => new Date(now - ms).toISOString();
  const start = (id, type, ts) => JSON.stringify({ ts, event: 'agent_start', run_id: id, job: A, agent_type: type, label: type.replace('factory:', ''), workflow: 'fanout-judge' });
  const end = (id, type, ts) => JSON.stringify({ ts, event: 'agent_run', run_id: id, job: A, agent_type: type, ms: 1000, outcome: 'ok' });
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), [
    start('r1', 'factory:intent-mapper', at(5 * 60000)),
    end('r1', 'factory:intent-mapper', at(4 * 60000)),
    start('r2', 'factory:intent-analyst', at(3 * 60000)),
    start('r3', 'factory:intent-analyst', at(3 * 60000)),
  ].join('\n') + '\n');
  const lock = path.join(jobPaths(root, A).dir, 'run.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: require('os').hostname(), started_at: at(6 * 60000) }));
  const running = () => build(root, { now: new Date(now).toISOString() }).jobs.find((j) => j.id === A).running_agents.map((x) => x.agent_type);
  assert.deepEqual(running(), ['factory:intent-analyst', 'factory:intent-analyst'], 'both analysts are at work; the mapper finished');
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: require('os').hostname() }));
  assert.deepEqual(running(), [], 'once factory run is gone, its unfinished agents are not at work');
});

test('console: workflow runs step by step — steps in order, agents per step, pending and skipped template steps, replay at a time', () => {
  const root = F.makeRepo();
  const A = F.cli(root, ['job', 'new', '--title', 'Clarify me', '--type', 'bug', '--risk', 'low']).job;
  const { build } = require('../cli/core/console');
  const RS = require('../cli/core/run-steps');
  const { jobPaths } = require('../cli/lib/paths');
  const t0 = Date.parse('2030-01-01T12:00:00.000Z');
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const base = { job: A, decision_id: null, workflow: 'fanout-judge', config: 'clarify', wf_run: 'W1' };
  const lines = [];
  const ev = (s, rec) => lines.push(JSON.stringify({ ts: at(s), ...base, ...rec }));
  const phase = (s, index, text) => ev(s, { event: 'workflow_phase', text, index });
  const start = (s, id, role, label, step) => ev(s, { event: 'agent_start', run_id: id, role, agent_type: `factory:${role}`, label, step });
  const end = (s, id, role, label, step, outcome = 'ok') => ev(s, { event: 'agent_run', run_id: id, role, agent_type: `factory:${role}`, label, step, outcome, ms: 1000 });
  ev(0, { event: 'workflow_start', mode: null, round: 2, pid: process.pid });
  phase(1, 0, 'clarify: scout · map the unknowns');
  start(1, 'm', 'intent-mapper', 'intent map', 0); end(60, 'm', 'intent-mapper', 'intent map', 0);
  phase(61, 1, 'clarify: scout · research 5 unknown(s) with 3 scout(s)');
  for (const k of [1, 2, 3]) start(62, `s${k}`, 'researcher', `scout · repo #${k}`, 1);
  end(120, 's1', 'researcher', 'scout · repo #1', 1); end(121, 's2', 'researcher', 'scout · repo #2', 1, 'timeout'); end(122, 's3', 'researcher', 'scout · repo #3', 1);
  // no verify phase: the verifier had nothing to re-check; then the intent gate is skipped too (no gate angle)
  phase(130, 2, 'clarify: fan-out (4)');
  for (const k of [1, 2, 3, 4]) start(131, `a${k}`, 'intent-analyst', `analyst #${k}`, 2);
  end(200, 'a1', 'intent-analyst', 'analyst #1', 2); end(201, 'a2', 'intent-analyst', 'analyst #2', 2, 'invalid');
  start(202, 'a2r', 'intent-analyst', 'analyst #2 (retry)', 2);
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), lines.join('\n') + '\n');
  const lock = path.join(jobPaths(root, A).dir, 'run.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: require('os').hostname(), started_at: at(0), workflow: 'fanout-judge', config: 'clarify' }));
  const now = new Date(t0 + 300 * 1000).toISOString();
  const get = () => build(root, { now }).jobs.find((j) => j.id === A);

  let j = get();
  assert.equal(j.runs.length, 1);
  let r = j.runs[0];
  assert.equal(j.runs_live.running, 'W1', 'the run in progress');
  assert.equal(r.status, 'running');
  assert.equal(r.round, 2);
  assert.equal(r.stage, null, 'no routing decision in this log: no step, no stage');
  const row = (st) => [st.state, st.label, st.roles.map((x) => `${x.role} ${x.total}/${x.running}/${x.ok}/${x.failed}/${x.retries}`).join(', ')];
  assert.deepEqual(r.steps.map(row), [
    ['done', 'map the unknowns', 'intent-mapper 1/0/1/0/0'],
    ['done', 'research 5 unknowns', 'researcher 3/0/2/1/0'],
    ['skipped', 'verify findings', ''],
    ['skipped', 'intent gate', ''],
    ['running', 'fan-out (4)', 'intent-analyst 5/3/1/1/1'],
    ['pending', 'judge', ''],
    ['pending', 'God Eye (intent)', ''],
  ]);
  assert.deepEqual([r.at, r.of], [3, 5], 'step 3 of 5: skipped steps are not counted');
  assert.equal(r.next, 'your answers or H1');
  assert.deepEqual(r.steps[5].planned, ['judge'], 'a pending step names who will run it');
  assert.deepEqual(r.steps.slice(0, 2).map((x) => [x.started_at, x.ended_at]), [[at(1), at(61)], [at(61), at(130)]], 'a step runs from its phase to the next one');

  // replay: the same run as it stood during the research
  const v = RS.view(r, t0 + 90 * 1000);
  assert.deepEqual(v.steps.map(row), [
    ['done', 'map the unknowns', 'intent-mapper 1/0/1/0/0'],
    ['running', 'research 5 unknowns', 'researcher 3/3/0/0/0'],
    ['pending', 'verify findings', ''],
    ['pending', 'intent gate', ''],
    ['pending', 'fan-out', ''],
    ['pending', 'judge', ''],
    ['pending', 'God Eye (intent)', ''],
  ]);
  assert.equal(v.status, 'running');
  assert.equal(RS.view(r, t0 - 1000), null, 'before the run started there is nothing');

  // the run ends: the steps it never took are skipped, and the station remembers its last run
  lines.length = 0;
  end(240, 'a2r', 'intent-analyst', 'analyst #2 (retry)', 2); end(241, 'a3', 'intent-analyst', 'analyst #3', 2); end(242, 'a4', 'intent-analyst', 'analyst #4', 2);
  phase(250, 3, 'clarify: judge');
  start(251, 'j', 'judge', 'judge', 3); end(280, 'j', 'judge', 'judge', 3);
  ev(281, { event: 'workflow_end', outcome: 'ok', status: 'needs_user', ms: 281000 });
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), lines.join('\n') + '\n');
  j = get();
  r = j.runs[0];
  assert.equal(r.status, 'done');
  assert.equal(r.result, 'needs_user');
  assert.equal(j.runs_live.running, null);
  assert.deepEqual(r.steps.map((x) => x.state), ['done', 'done', 'skipped', 'skipped', 'done', 'done', 'skipped']);
  assert.deepEqual(r.steps[4].roles, [{ role: 'intent-analyst', total: 5, running: 0, ok: 4, failed: 1, retries: 1 }]);
  assert.equal(r.at, null);

  // a run with no end whose factory run is gone was cut off
  lines.length = 0;
  ev(400, { event: 'workflow_start', wf_run: 'W2', mode: null, round: 3, pid: process.pid });
  ev(401, { event: 'workflow_phase', wf_run: 'W2', text: 'clarify: intent gate (1)', index: 0 });
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), lines.join('\n') + '\n');
  assert.equal(get().runs[1].status, 'running');
  assert.equal(get().runs[1].visit, 2, 'the second clarify run of this job');
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, host: require('os').hostname() }));
  const cut = get().runs[1];
  assert.equal(cut.status, 'failed');
  assert.match(cut.error, /interrupted/);
  assert.deepEqual(cut.steps.filter((x) => x.text).map((x) => x.state), ['failed']);
});

test('console: workflow run templates follow the workflow sources; realize waves; older logs without steps keep today\'s view', () => {
  const RS = require('../cli/core/run-steps');
  // every phase(...) text in the workflow sources matches a template step of its workflow
  const src = (f) => fs.readFileSync(path.join(F.PLUGIN, 'workflows', f), 'utf8');
  const texts = (f) => [...src(f).matchAll(/phase\((['`])(.*?)\1\)/g)].map((m) => m[2].replace(/\$\{brief\.config\}/g, 'CFG').replace(/\$\{[^}]*\}/g, '1'));
  const fj = texts('fanout-judge.js');
  assert.ok(fj.length >= 10, fj.join(' | '));
  for (const t of fj) {
    const cfgs = t.startsWith('CFG') ? ['clarify', 'decide', 'challenge'] : [t.split(':')[0]];
    for (const c of cfgs) {
      const tpl = RS.TEMPLATES[`fanout-judge:${c}`];
      assert.ok(tpl && RS.matchStep(tpl, t.replace('CFG', c)) >= 0, `fanout-judge ${c}: "${t}" has a template step`);
    }
  }
  for (const w of ['ground', 'decompose', 'realize', 'reconcile']) for (const t of texts(`${w}.js`)) assert.ok(RS.matchStep(RS.TEMPLATES[w], t) >= 0, `${w}: "${t}"`);
  assert.ok(RS.matchStep(RS.TEMPLATES.decompose, 'decompose: God Eye (plan) round 1') === 1 && RS.matchStep(RS.TEMPLATES.decompose, 'decompose: plan round 2') === 0);
  // realize: the waves still ahead are pending, a wave the run jumped (all its tasks skipped) is skipped
  const T = (s) => new Date(Date.UTC(2030, 0, 1, 12, 0, s)).toISOString();
  const run = { id: 'R', workflow: 'realize', config: null, started_at: T(0), ended_at: null, status: 'running', phases: [{ i: 0, text: 'realize: wave 1/4 (T1, T2)', at: T(1), key: 'wave' }], agents: [{ role: 'builder', step: 0, at: T(2), end: null, outcome: null, retry: false }] };
  assert.deepEqual(RS.view(run).steps.map((s) => [s.state, s.label]), [['running', 'wave 1 of 4: T1, T2'], ['pending', 'wave 2 of 4'], ['pending', 'wave 3 of 4'], ['pending', 'wave 4 of 4']]);
  run.phases.push({ i: 1, text: 'realize: wave 3/4 (T4)', at: T(30), key: 'wave' });
  assert.deepEqual(RS.view(run).steps.map((s) => [s.state, s.label]), [['done', 'wave 1 of 4: T1, T2'], ['skipped', 'wave 2 of 4'], ['running', 'wave 3 of 4: T4'], ['pending', 'wave 4 of 4']]);
  // a log from before workflow_* lines: no runs, and the agents show as before
  const root = F.makeRepo();
  const A = F.cli(root, ['job', 'new', '--title', 'Old log', '--type', 'bug', '--risk', 'low']).job;
  const now = Date.parse('2030-01-01T12:00:00.000Z');
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), [
    JSON.stringify({ ts: new Date(now - 60000).toISOString(), event: 'agent_start', run_id: 'x', job: A, agent_type: 'factory:intent-analyst', label: 'analyst', workflow: 'fanout-judge' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(require('../cli/lib/paths').jobPaths(root, A).dir, 'run.lock'), JSON.stringify({ pid: process.pid, host: require('os').hostname() }));
  const j = require('../cli/core/console').build(root, { now: new Date(now).toISOString() }).jobs.find((x) => x.id === A);
  assert.deepEqual(j.runs, []);
  assert.deepEqual(j.runs_live, { running: null, last_by_stage: {} });
  assert.deepEqual(j.running_agents.map((x) => x.agent_type), ['factory:intent-analyst']);
});

test('console page: one data slot, self-contained, and a static file says it is a snapshot', () => {
  const tpl = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  assert.equal(tpl.split('/*__FACTORY_DATA__*/null').length, 2, 'exactly one data slot');
  assert.ok(!/<script[^>]+src=/i.test(tpl), 'no external scripts: one self-contained page');
  assert.ok(tpl.includes("'snapshot'"), 'the page has a snapshot state for a static file');
  const { render } = require('../cli/core/console');
  const html = render({ generated_at: '2030-01-01T00:00:00.000Z', project: 'p', integrity: { status: 'not_checked' }, jobs: [{ id: 'J-0001', title: '</script><script>alert(1)</script>', rev: 'x', timeline: [], steps: [] }] });
  assert.ok(html.includes('"live":false'), 'a written file is not live');
  assert.ok(!html.includes('</script><script>alert'), 'data cannot close the script tag');
  assert.ok(!html.includes('/*__FACTORY_DATA__*/'), 'the slot is filled');
});

test('console: clarify research (findings with source and verdict, assumptions, overrides) per round, from the ledger and intent-evidence.json', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.cli(root, ['next']);
  const scout = {
    ran: true, round: 1, web: { enabled: true, reason: null, available: true }, map: { ran: true, ok: true },
    unknowns: [
      { id: 'U-1', text: 'Where is add?', kind: 'repo', impact: 'high', draft: 'add is in src/add.js', research: 'repo', resolution: 'assumption', evidence: ['E-1'], researched: true },
      { id: 'U-2', text: 'Is + numeric addition per ECMAScript?', kind: 'world', impact: 'medium', draft: 'ECMAScript + adds numbers', research: 'web', resolution: 'question', evidence: ['E-2'], researched: true },
    ],
    evidence: [
      { id: 'E-1', unknown: 'U-1', claim: 'add is in src/add.js and subtracts', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports = (a, b) => a - b;', confidence: 'high', scout: 'repo', verdict: 'confirmed' },
      { id: 'E-2', unknown: 'U-2', claim: 'ECMAScript + adds two numbers', source: 'https://tc39.es/ecma262/', source_tier: 'standard', retrieved_at: '2026-10-14', quote: 'Return ? operation(lnum, rnum).', confidence: 'high', scout: 'web', verdict: 'unverified' },
    ],
    assumptions: [], scouts: [{ label: 'scout · repo #1', mode: 'repo', unknowns: ['U-1'], outcome: 'ok' }, { label: 'scout · web #1', mode: 'web', unknowns: ['U-2'], outcome: 'ok' }], verifiers: 1, degraded: [],
  };
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  const r = F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, items: [], researchable_questions: [] }, scout }));
  assert.equal(r.status, 'needs_user');
  F.reply(root, 'change A-1 add lives in lib/add.js');
  const dataFile = path.join(os.tmpdir(), `console-intent-${process.pid}-${Date.now()}.json`);
  F.cli(root, ['console', '--out', `${dataFile}.html`, '--data', dataFile]);
  const job = JSON.parse(fs.readFileSync(dataFile, 'utf8')).jobs.find((j) => j.id === J);
  const res = job.timeline.find((t) => t.type === 'result' && t.step === 'clarify');
  const x = res.research;
  assert.equal(x.unknowns, 2);
  assert.equal(x.scouts, 2);
  assert.equal(x.verifiers, 1);
  assert.deepEqual(x.findings.map((f) => [f.id, f.verdict]), [['E-1', 'confirmed'], ['E-2', 'unverified']], 'confirmed first');
  assert.equal(x.findings[1].claim, 'ECMAScript + adds two numbers');
  assert.equal(x.findings[1].source, 'https://tc39.es/ecma262/');
  assert.equal(x.findings[1].retrieved_at, '2026-10-14');
  assert.deepEqual(x.assumptions_list.map((a) => [a.id, a.overridden]), [['A-1', false]], 'as it stood that round');
  assert.equal(x.asked[0].researchable, true);
  assert.match(x.asked[0].reason, /E-2 unverified/);
  const h = job.timeline.find((t) => t.type === 'human' && t.action === 'change_assumption');
  assert.equal(h.assumption, 'A-1');
  assert.equal(h.value, 'add lives in lib/add.js');
  assert.equal(h.was, 'add is in src/add.js and subtracts');
  assert.deepEqual(job.intent.overridden, ['A-1']);
  // the page knows the two new roles, the scout phase on the recipe map and renders the research
  const html = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  for (const role of ['intent-mapper', 'verifier']) assert.match(html, new RegExp(`'${role}': \\['Clarify'`));
  assert.match(html, /P\('intent map', 'agent', 'intent-mapper'\)[\s\S]*P\('verify evidence', 'agent', 'verifier'\)/);
  assert.match(html, /function researchHtml/);
  const agents = fs.readdirSync(path.join(F.PLUGIN, 'agents')).map((f) => f.replace(/\.agent\.md$/, ''));
  const table = html.slice(html.indexOf('const AGENTS = {'), html.indexOf('const RECIPES'));
  for (const a of agents) assert.ok(table.includes(`'${a}':`), `Crew lists ${a}`);
});

test('console page: console.html is built from console/src (node console/build.js) and is current', () => {
  const { build } = require('../console/build');
  const built = build();
  const shipped = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  assert.ok(built === shipped, 'console.html is stale: run node console/build.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'console', 'src', 'manifest.json'), 'utf8'));
  const listed = new Set([...manifest.styles, ...manifest.scripts]);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const src = path.join(F.PLUGIN, 'console', 'src');
  for (const f of walk(src).map((x) => path.relative(src, x).split(path.sep).join('/'))) {
    if (/\.(css|js)$/.test(f)) assert.ok(listed.has(f), `${f} is in src/manifest.json`);
  }
});

test('console page: the one script parses, and the Blueprint view is in it', () => {
  const vm = require('vm');
  const html = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new vm.Script(js), 'console.html has a syntax error');
  assert.match(html, /id="nav-blueprint" data-view="blueprint"/);
  assert.match(html, /<section id="view-blueprint"/);
  assert.match(html, /APP\.displays\.register\(\{\s*id: "blueprint"/);
});

// the Blueprint reads a walk through states; toDisplay folds Copilot's timeline into one
const blueprintAdapter = () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(F.PLUGIN, 'console', 'src', 'js', 'blueprint', 'adapter.js'), 'utf8');
  const ctx = {};
  vm.runInNewContext(`${src}\nthis.toDisplay = toDisplay;`, ctx);
  return (data) => JSON.parse(JSON.stringify(ctx.toDisplay(data))); // plain objects of this realm, for deepEqual
};
const at = (m) => new Date(Date.UTC(2030, 0, 1, 9, m)).toISOString();
const route = (m, step) => ({ t: at(m), type: 'route', step, raw_step: step, rule: 'r' });
const job = (id, extra) => ({ id, title: `job ${id}`, work_type: 'feature', risk: 'low', status: 'active', created_at: at(0), updated_at: at(50), tasks: [], lessons: [], steps: [], timeline: [], ...extra });

test('console blueprint: each workflow run goes to its station\'s bank, folded by the same run-steps.js the page carries', () => {
  const toDisplay = blueprintAdapter();
  const run = (id, workflow, config, step, extra) => ({ id, workflow, config, step, started_at: at(10), ended_at: null, status: 'running', phases: [], agents: [], ...extra });
  const d = toDisplay({ generated_at: at(60), project: 'p', jobs: [job('J-0001', { runs: [
    run('a', 'fanout-judge', 'clarify', 'clarify'), run('b', 'ground', null, 'ground'), run('c', 'fanout-judge', 'decide', 'decide'), run('d', 'decompose', null, 'decompose'),
    run('e', 'realize', null, 'realize'), run('f', 'reconcile', null, 'reconcile'), run('g', 'fanout-judge', 'challenge', 'challenge'), run('h', 'fanout-judge', 'challenge', 'post_merge_challenge', { mode: 'post_merge' }),
    run('i', 'distill', null, 'distill'), run('k', 'fanout-judge', 'challenge', null), run('x', 'fanout-judge', 'clarify', 'clarify', { started_at: null }),
  ] }), job('J-0002', {})] });
  assert.deepEqual(d.jobs[0].runs.map((r) => [r.id, r.station]), [['a', 'intent'], ['b', 'design'], ['c', 'design'], ['d', 'plan'], ['e', 'build'], ['f', 'build'], ['g', 'review'], ['h', 'ship'], ['i', 'done'], ['k', 'review']], 'by the recipe step it ran for, else by workflow; a run with no start is dropped');
  assert.deepEqual(d.jobs[1].runs, [], 'older data: no runs, the bank keeps its lamps');
  // the page carries the CLI's run-steps.js verbatim, before the Blueprint that reads it
  const html = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  const rs = fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'run-steps.js'), 'utf8');
  assert.ok(html.includes(rs), 'run-steps.js is in the page');
  assert.ok(html.indexOf(rs) < html.indexOf('APP.displays.register({'), 'before the Blueprint');
  const vm = require('vm');
  const ctx = {};
  vm.runInNewContext(`${rs}\nthis.R = RUN_STEPS;`, ctx);
  assert.deepEqual(Object.keys(ctx.R.TEMPLATES), Object.keys(require('../cli/core/run-steps').TEMPLATES), 'as a classic script it defines RUN_STEPS');
});

test('console blueprint: gates wait on you with the reply the CLI parses', () => {
  const toDisplay = blueprintAdapter();
  const d = toDisplay({ generated_at: at(60), project: 'p', jobs: [
    job('J-0001', { pending_gate: { id: 'H1', at: at(5) }, timeline: [route(1, 'clarify'), route(5, 'H1')] }),
    job('J-0002', { pending_gate: { id: 'HS', at: at(9) }, timeline: [route(1, 'clarify'), route(3, 'realize'), route(5, 'prove'), route(7, 'challenge'), route(8, 'ship'), route(9, 'HS')] }),
  ] });
  const [a, b] = d.jobs;
  assert.equal(a.state, 'awaiting_intent_approval');
  assert.deepEqual(a.history.map((h) => h.to), ['intent', 'awaiting_intent_approval']);
  assert.equal(a.waiting_on.who, 'you');
  assert.equal(a.waiting_on.reply.split(' · ')[0], 'approve J-0001 H1');
  assert.equal(b.state, 'awaiting_ship_approval');
  assert.equal(b.waiting_on.gate, 'HS');
  for (const s of d.stages.concat(d.side_lanes)) for (const x of s.states) assert.ok(d.meaning[x], `${x} has a meaning`);
});

// clarify asked questions (a result with outcome 'ask'): the job waits on your answers, as the Board's "Your turn · Clarify"
const ask = (m, ids) => ({ t: at(m), type: 'result', step: 'clarify', raw_step: 'clarify', ok: false, outcome: 'ask', questions: ids.length, question_ids: ids, text: `${ids.length} question(s) for you (scope)` });
test('console blueprint: clarify waiting on your answers is your turn (Q), and your answers move it back to clarify', () => {
  const toDisplay = blueprintAdapter();
  const d = toDisplay({ generated_at: at(60), project: 'p', jobs: [
    job('J-0001', { timeline: [route(1, 'clarify'), ask(4, ['Q-1', 'Q-2', 'Q-3'])] }),
    job('J-0002', { timeline: [route(1, 'clarify'), ask(4, ['Q-1', 'Q-2', 'Q-3']), route(9, 'clarify'), ask(12, ['Q-4']), route(20, 'clarify')] }),
    job('J-0003', { timeline: [route(1, 'clarify'), { t: at(4), type: 'result', step: 'clarify', raw_step: 'clarify', ok: false, outcome: 'ask', text: '2 question(s) for you (intent)' }] }),
  ] });
  const [a, b, c] = d.jobs;
  assert.equal(a.state, 'awaiting_answers');
  assert.ok(d.stages.find((s) => s.key === 'intent').states.includes('awaiting_answers'), 'at the Contract station');
  assert.deepEqual(a.history.map((h) => [h.to, h.by, h.reason]), [['intent', 'router', 'rule r'], ['awaiting_answers', 'router', 'clarify asked 3 question(s)']]);
  assert.equal(a.waiting_on.who, 'you');
  assert.equal(a.waiting_on.gate, 'Q');
  assert.equal(a.waiting_on.reply, 'answer Q-1, Q-2, Q-3 in chat · change A-n <value> · drop A-n');
  assert.ok(a.waiting_on.plain, 'the answers are your own words, not a command to copy');
  assert.equal(b.state, 'intent', 'the next clarify route takes it back to clarify');
  assert.deepEqual(b.history.slice(1).map((h) => [h.from, h.to, h.by, h.reason]), [
    ['intent', 'awaiting_answers', 'router', 'clarify asked 3 question(s)'], ['awaiting_answers', 'intent', 'you', 'you answered'],
    ['intent', 'awaiting_answers', 'router', 'clarify asked 1 question(s)'], ['awaiting_answers', 'intent', 'you', 'you answered']]);
  assert.equal(b.waiting_on.who, 'agent');
  assert.equal(c.history[1].reason, 'clarify asked 2 question(s)', 'the count from the result text when the ids are missing');
  assert.equal(c.waiting_on.reply.split(' · ')[0], 'answer the questions in chat');
});

test('console blueprint: "Your turn" counts the same jobs as the Board, clarify questions included', () => {
  const vm = require('vm');
  const src = (f) => fs.readFileSync(path.join(F.PLUGIN, 'console', 'src', 'js', ...f.split('/')), 'utf8');
  const ctx = { localStorage: { getItem: () => null }, stepName: (id) => id };
  const shell = src('shell/state.js');
  const bucketOf = shell.slice(shell.indexOf('function bucketOf('), shell.indexOf('\n}\n', shell.indexOf('function bucketOf(')) + 3);
  vm.runInNewContext(`${src('job-line/fold.js')}\n${src('job-line/state.js')}\n${bucketOf}\nthis.turn = (j) => { const S = finalState(j); return bucketOf(j, jobSummary(j, S)) === 'turn'; };`, ctx);
  const steps = [{ id: 'request', stage: 'request' }, { id: 'clarify', stage: 'intent' }, { id: 'H1', stage: 'intent', human: true }, { id: 'decide', stage: 'design' }];
  const jobs = [
    job('J-0001', { steps, timeline: [route(1, 'clarify'), ask(4, ['Q-1'])] }),
    job('J-0002', { steps, timeline: [route(1, 'clarify'), ask(4, ['Q-1']), route(9, 'clarify')] }),
    job('J-0003', { steps, pending_gate: { id: 'H1', at: at(5) }, timeline: [route(1, 'clarify'), route(5, 'H1')] }),
    job('J-0004', { steps, timeline: [route(1, 'clarify'), route(5, 'H1'), { t: at(6), type: 'human', action: 'approve', gate: 'H1', step: 'H1' }, route(7, 'decide')] }),
  ];
  const board = jobs.filter((j) => ctx.turn(j)).map((j) => j.id);
  const bp = blueprintAdapter()({ generated_at: at(60), project: 'p', jobs }).jobs.filter((j) => j.waiting_on.who === 'you').map((j) => j.id);
  assert.deepEqual(board, ['J-0001', 'J-0003']);
  assert.deepEqual(bp, board);
});

test('console blueprint: park and resume, a failed proof sent back to Build, stops and closes', () => {
  const toDisplay = blueprintAdapter();
  const d = toDisplay({ generated_at: at(60), project: 'p', jobs: [
    job('J-0001', { timeline: [route(1, 'decide'), { t: at(2), type: 'park', text: 'waiting on infra', from: 'manual' }, { t: at(9), type: 'human', action: 'resume' }, route(10, 'H2')], pending_gate: { id: 'H2', at: at(10) } }),
    job('J-0002', { timeline: [route(1, 'realize'), route(2, 'prove'), { t: at(3), type: 'result', raw_step: 'prove', ok: false, acs: { 'AC-1': 'failed' } }, route(4, 'realize'), route(5, 'prove')] }),
    job('J-0003', { status: 'cancelled', timeline: [route(1, 'clarify'), { t: at(4), type: 'stopped', text: 'not needed' }] }),
    job('J-0004', { status: 'closed', closed_at: at(30), timeline: [route(1, 'clarify'), route(20, 'distill')], tasks: [{ id: 'T1', objective: 'o', depends_on: [], attempts: 1, outcome: 'done', pass: true }] }),
    job('J-0005', { epic: true, timeline: [route(1, 'clarify')] }),
  ] });
  const by = Object.fromEntries(d.jobs.map((j) => [j.id, j]));
  assert.deepEqual(by['J-0001'].history.map((h) => h.to), ['designing', 'parked', 'designing', 'awaiting_design_approval'], 'resume goes back where it parked');
  assert.equal(by['J-0002'].rework_loops, 1, 'verifying → building is one trip back');
  assert.deepEqual(by['J-0002'].criteria, [{ id: 'AC-1', text: '', status: 'failed', tasks: [] }]);
  assert.equal(by['J-0003'].state, 'cancelled');
  assert.equal(by['J-0003'].waiting_on.who, 'nobody');
  assert.equal(by['J-0004'].state, 'closed');
  assert.equal(by['J-0004'].tasks[0].status, 'passing');
  assert.ok(!by['J-0005'], 'an epic is not a job on the line');
});

test('console: a review round carries the CLI lane verdicts and each finding\'s verifier verdict; unverified findings read as blocking', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Bulk', '--type', 'feature', '--risk', 'low']).job;
  const at = (m) => new Date(Date.UTC(2030, 0, 1, 9, m)).toISOString();
  const ledger = path.join(F.jobDir(root, J), 'ledger.jsonl');
  fs.appendFileSync(ledger, [
    { job: J, at: at(1), kind: 'agents', workflow: 'fanout-judge', config: 'challenge', decision_id: `${J}-D0009`, status: 'ok', agents: [{ label: 'review code', agent_type: 'factory:code-reviewer', model: 'sonnet', outcome: 'ok' }, { label: 'verify code-1', agent_type: 'factory:finding-verifier', model: 'sonnet', outcome: 'unverifiable' }] },
    { job: J, at: at(2), kind: 'step', step: 'challenge', ok: false, detail: { round: 1, required: ['code', 'tests'], lanes: { code: 'changes', tests: 'pass' }, missing: [], findings: [
      { id: 'code-1', lane: 'code', severity: 'major', status: 'unverified', verifier_status: 'unverifiable', verification: 'Could not build the fixture.', verification_evidence: 'ran the tests: ok', file: 'src/a.js', line: 3, summary: 'Loads every id into memory' },
      { id: 'tests-1', lane: 'tests', severity: 'minor', status: 'minor', summary: 'Small fixture' },
    ] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), [
    { ts: at(1), event: 'agent_run', job: J, decision_id: `${J}-D0009`, agent_type: 'factory:god-eye', label: 'review code', ms: 1200, outcome: 'ok', verdict: 'revise' },
    { ts: at(5), event: 'autopilot_seen', session: 's1' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const now = Date.parse(at(30));
  fs.writeFileSync(path.join(root, '.factory', 'autopilot.json'), JSON.stringify({ first_at: at(5), last_at: at(20), session: 's1', count: 3 }));
  const { build } = require('../cli/core/console');
  const data = build(root, { now: new Date(now).toISOString() });
  const job = data.jobs.find((j) => j.id === J);
  const r = job.timeline.find((t) => t.type === 'result' && t.raw_step === 'challenge');
  assert.match(r.text, /1 unverified, blocking/, 'the round text counts unverified serious findings');
  assert.deepEqual(r.lanes, { code: 'changes', tests: 'pass' }, 'the CLI lane verdicts are carried, not re-parsed from text');
  assert.deepEqual(r.required, ['code', 'tests']);
  assert.equal(r.round, 1);
  const f = r.findings.find((x) => x.id === 'code-1');
  assert.equal(f.verifier_status, 'unverifiable');
  assert.equal(f.verification_evidence, 'ran the tests: ok');
  assert.equal(f.verification, 'Could not build the fixture.');
  assert.deepEqual(job.review_lanes, ['code', 'tests'], 'the lanes the last review required');
  const state = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'state.json'), 'utf8'));
  assert.equal(job.limits.max_review_rounds, state.policy.limits.max_review_rounds, 'the job\'s policy limits are in the data');
  const ag = job.timeline.find((t) => t.type === 'agents').agents.find((a) => a.label === 'review code');
  assert.equal(ag.verdict, 'revise', 'agent_run verdict is carried to the agent');
  assert.equal(ag.ms, 1200);
  assert.deepEqual({ ...data.autopilot, window_hours: undefined }, { first_at: at(5), last_at: at(20), count: 3, recent: true, window_hours: undefined });
  assert.ok(data.factory_events.some((e) => e.type === 'autopilot' && /could answer a gate/.test(e.text)), 'an Autopilot sighting is on the wire');
  assert.equal(build(root, { now: new Date(now + 7 * 3600e3).toISOString() }).autopilot.recent, false, 'a sighting past the warning window is no longer recent');
});

test('console page: the Crew\'s tools are each agent file\'s own tools: line', () => {
  const html = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  const m = /const AGENT_TOOLS = (\{.*?\});/.exec(html);
  assert.ok(m, 'console.html carries AGENT_TOOLS');
  const shown = JSON.parse(m[1]);
  const dir = path.join(F.PLUGIN, 'agents');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.agent.md'));
  assert.deepEqual(Object.keys(shown).sort(), files.map((f) => f.replace(/\.agent\.md$/, '')).sort(), 'one entry per agent file');
  for (const f of files) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(dir, f), 'utf8'))[1];
    const tools = JSON.parse(/^tools:\s*(.+)$/m.exec(fm)[1]);
    assert.deepEqual(shown[f.replace(/\.agent\.md$/, '')], tools, `${f}: the console shows the file's tools`);
  }
  const src = fs.readFileSync(path.join(F.PLUGIN, 'console', 'src', 'js', 'definitions.js'), 'utf8');
  assert.ok(!/'(Read|Grep|Glob|Bash|Write|Edit|WebFetch)'/.test(src.slice(src.indexOf('const AGENTS'), src.indexOf('const RECIPES'))), 'no hand-written tool list left in definitions.js');
  assert.match(src, /'finding-verifier': \[[^\]]*unverifiable/, 'the finding-verifier says what unverifiable does');
  assert.ok(!/at most (three|3)[^.]*lessons|At most 3 general/i.test(src), 'no stale lesson cap');
});

test('console page: agent outcomes get bad, warn, good or neutral, never good by default', () => {
  const vm = require('vm');
  const ctx = { window: {} };
  vm.runInNewContext(`${fs.readFileSync(path.join(F.PLUGIN, 'console', 'src', 'js', 'job-line', 'data.js'), 'utf8')}\nthis.outcomeClass = outcomeClass;`, ctx);
  for (const o of ['timeout', 'invalid', 'failed', 'copilot_unavailable', 'error', 'no_result', 'fail', 'blocked', 'exhausted']) assert.equal(ctx.outcomeClass(o), 'bad', o);
  for (const o of ['unverifiable', 'revise']) assert.equal(ctx.outcomeClass(o), 'warn', o);
  for (const o of ['approve', 'pass', 'done', 'merged']) assert.equal(ctx.outcomeClass(o), 'good', o);
  for (const o of ['ok', 'confirmed', 'refuted', 'something-new', null]) assert.equal(ctx.outcomeClass(o), '', String(o));
});

test('console blueprint: lane verdicts from the data, unverified findings block, rounds from policy, learn is not merged', () => {
  const toDisplay = blueprintAdapter();
  const ch = (m, round, lanes, findings, text) => ({ t: at(m), type: 'result', step: 'challenge', raw_step: 'challenge', ok: false, round, lanes, required: Object.keys(lanes), missing: [], findings, text });
  const d = toDisplay({ generated_at: at(60), project: 'p', autopilot: { last_at: at(55), recent: true, count: 1 }, jobs: [
    job('J-0001', { review_lanes: ['code', 'tests'], limits: { max_review_rounds: 5 }, timeline: [route(1, 'challenge'),
      { t: at(2), type: 'agents', agents: [{ role: 'code-reviewer', model: 'sonnet' }, { role: 'finding-verifier', model: 'sonnet', outcome: 'unverifiable' }] },
      // the text says nothing parseable: the verdicts come from `lanes`
      ch(3, 2, { code: 'changes', tests: 'pass' }, [{ id: 'code-1', lane: 'code', severity: 'major', status: 'unverified', verifier_status: 'unverifiable', verification_evidence: 'ran it', summary: 's' }], 'Round two')] }),
    job('J-0002', { status: 'closed', closed_at: at(30), timeline: [route(1, 'clarify'), route(5, 'H1'), { t: at(6), type: 'human', action: 'approve', gate: 'H1', step: 'H1', via: 'chat' }, route(7, 'ground'), route(20, 'distill'), route(25, 'close')] }),
    job('J-0003', { work_type: 'spike', status: 'active', timeline: [route(1, 'decide'), route(5, 'close')] }),
    job('J-0004', { epic: true, title: 'Big epic', children: ['J-0005'] }),
  ] });
  const [a, b, c] = d.jobs;
  const code = a.reviews.find((r) => r.lane === 'code');
  assert.equal(code.verdict, 'changes');
  assert.equal(code.unverified, 1, 'an unverified serious finding blocks its lane');
  assert.equal(code.findings[0].status, 'unverified');
  assert.equal(code.findings[0].verifier, 'unverifiable');
  assert.equal(code.findings[0].evidence, 'ran it');
  assert.equal(code.model, 'sonnet', 'the reviewer\'s model comes from the roster');
  assert.equal(a.reviews.find((r) => r.lane === 'tests').verdict, 'pass');
  assert.deepEqual(a.required_lanes, ['code', 'tests']);
  assert.equal(a.review_round, 2);
  assert.equal(a.max_review_rounds, 5, 'rounds are capped by the job\'s policy, not a fixed number');
  assert.ok(!b.history.some((h) => h.to === 'merged'), 'a job that distils without a merge never passes through Merged');
  assert.ok(b.history.some((h) => h.to === 'learning'), 'distill is the Learn station');
  const appr = b.history.find((h) => h.from === 'awaiting_intent_approval');
  assert.equal(appr.by, 'you', 'your approval moves the job off H1, not the router');
  assert.match(appr.reason, /you approved H1/);
  assert.equal(c.state, 'learning', 'a spike closing sits at Learn, not Merged');
  assert.ok(!d.jobs.some((j) => j.id === 'J-0004'), 'an epic is not a job on the line');
  assert.deepEqual(d.epic_jobs.map((e) => e.id), ['J-0004'], 'but it is listed, so the drawing can say so');
  assert.equal(d.autopilot.recent, true, 'the Autopilot sighting reaches the Blueprint');
  assert.ok(d.stages.find((s) => s.key === 'done').states.includes('learning'));
  assert.ok(d.meaning.learning);
});
