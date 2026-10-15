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
