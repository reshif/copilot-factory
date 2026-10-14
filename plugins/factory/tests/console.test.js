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
    if (opts.agentType === 'factory:intent-analyst') return { focus: 'x', questions: [] };
    if (opts.agentType === 'factory:judge') return { questions: [], dismissed: [] };
    if (opts.agentType === 'factory:god-eye') return { verdict: 'approve', items: [] };
    throw new Error(`unexpected ${opts.agentType}: ${instructions(prompt).slice(0, 80)}`);
  });
  assert.ok(Array.isArray(result.agents) && result.agents.length === 6, 'the envelope carries the roster (intent gate + 3 angles, judge, God Eye)');
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
  assert.deepEqual([...new Set(ag.agents.map((a) => a.agent_type))].sort(), ['factory:god-eye', 'factory:intent-analyst', 'factory:judge']);
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
