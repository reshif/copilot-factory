'use strict';
// Tier 1 contract tests for the JSON-returning agents, at no model cost.
// tests/fixtures/golden/<role>[.<variant>].json holds one golden final message per role (and
// per mode where a role has two schemas); index.json maps each to its role and schema.
// Each golden must:
//   - validate against its schema made strict (additionalProperties: false on every object
//     with properties): the production schemas stay lenient so a real reply with an extra
//     field is not thrown away, but the goldens — and the examples in the agent bodies — use
//     only the fields the contract names;
//   - be the example in its agent's "## Your final message" section (one per agent);
//   - hold the semantic invariants code can check: unique ids, lane prefixes, cited files
//     and lines that exist in the fixture repo (tests/fixtures/repo), quotes that are really
//     at their line, an empty findings list that is valid;
//   - survive the runner: replayed by fake-copilot as a reply in prose (first turn, broken)
//     and then fenced (the correction turn), runAgent returns exactly the golden.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validate } = require('../cli/lib/schema');
const runner = require('../cli/core/runner');
const { limiter } = runner;

const PLUGIN = path.resolve(__dirname, '..');
const GOLDEN = path.join(__dirname, 'fixtures', 'golden');
const REPO = path.join(__dirname, 'fixtures', 'repo');
const FAKE = path.join(__dirname, 'helpers', 'fake-copilot.js');
const INDEX = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'index.json'), 'utf8'));

const golden = (name) => JSON.parse(fs.readFileSync(path.join(GOLDEN, `${name}.json`), 'utf8'));
const schemaOf = (name) => JSON.parse(fs.readFileSync(path.join(PLUGIN, 'schemas', 'agent-outputs', `${name}.json`), 'utf8'));
const agentBody = (role) => fs.readFileSync(path.join(PLUGIN, 'agents', `${role}.agent.md`), 'utf8').replace(/^---[\s\S]*?\n---\n/, '');
const finalSection = (role) => {
  const b = agentBody(role);
  return b.slice(b.indexOf('## Your final message'));
};

function strict(s) {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(strict);
  const out = {};
  for (const [k, v] of Object.entries(s)) out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([p, x]) => [p, strict(x)])) : strict(v);
  if (out.properties && !('additionalProperties' in out)) out.additionalProperties = false;
  return out;
}

// Every property name a schema defines, nested ones included.
function propNames(s, acc = new Set()) {
  if (!s || typeof s !== 'object') return acc;
  if (s.properties) for (const [k, v] of Object.entries(s.properties)) {
    acc.add(k);
    propNames(v, acc);
  }
  if (s.items) propNames(s.items, acc);
  return acc;
}

const repoLines = (file) => {
  const p = path.join(REPO, file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n') : null;
};
// "src/add.js:1" / "src/add.js:1-2" / "src/add.js" → the cited lines exist in the fixture repo.
function assertCite(cite, where) {
  const m = /^([\w./-]+\.(?:json|js|md))(?![\w])(?::(\d+)(?:-(\d+))?)?/.exec(cite);
  assert.ok(m, `${where}: "${cite}" cites a file`);
  const lines = repoLines(m[1]);
  assert.ok(lines, `${where}: ${m[1]} exists in the fixture repo`);
  if (m[2]) assert.ok(Number(m[3] || m[2]) <= lines.length && Number(m[2]) >= 1, `${where}: line ${m[2]} exists in ${m[1]}`);
  return m;
}
// Every "path:line" mentioned anywhere in a golden's strings.
function eachCite(v, fn) {
  if (typeof v === 'string') for (const m of v.matchAll(/(?<![\w/.])((?:src|tests)\/[\w./-]+\.js|package\.json|README\.md)(?::\d+)?/g)) fn(m[0]);
  else if (Array.isArray(v)) v.forEach((x) => eachCite(x, fn));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => eachCite(x, fn));
}

const agents = fs.readdirSync(path.join(PLUGIN, 'agents')).map((f) => f.replace(/\.agent\.md$/, ''));

test('every agent has a golden final message, and every golden names a real schema', () => {
  const roles = new Set(Object.values(INDEX).map((g) => g.role));
  for (const a of agents) assert.ok(roles.has(a), `tests/fixtures/golden has a golden for ${a}`);
  for (const [name, g] of Object.entries(INDEX)) {
    assert.ok(agents.includes(g.role), `${name}: role ${g.role} is an agent`);
    assert.ok(fs.existsSync(path.join(GOLDEN, `${name}.json`)), `${name}.json exists`);
    schemaOf(g.schema);
  }
  const files = fs.readdirSync(GOLDEN).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.replace(/\.json$/, ''));
  assert.deepEqual(files.sort(), Object.keys(INDEX).sort(), 'index.json lists every golden');
});

for (const [name, g] of Object.entries(INDEX)) {
  test(`golden ${name} validates strictly against ${g.schema}.json`, () => {
    const out = golden(name);
    assert.deepEqual(validate(strict(schemaOf(g.schema)), out), []);
    assert.deepEqual(validate(schemaOf(g.schema), out), [], 'and against the production schema');
    eachCite(out, (c) => assertCite(c, name));
  });
}

test('each agent\'s final-message recipe names every schema field and shows one of its goldens', () => {
  for (const role of agents) {
    const sec = finalSection(role);
    const mine = Object.entries(INDEX).filter(([, g]) => g.role === role);
    for (const s of new Set(mine.map(([, g]) => g.schema))) {
      for (const p of propNames(schemaOf(s))) assert.match(sec, new RegExp(`\\b${p}\\b`), `${role}: its final-message section names "${p}" (${s}.json)`);
    }
    const m = /Example:\n```json\n(.*)\n```/.exec(sec);
    assert.ok(m, `${role}: has a compact JSON example`);
    const ex = JSON.parse(m[1]);
    assert.ok(mine.some(([n]) => JSON.stringify(golden(n)) === JSON.stringify(ex)), `${role}: its example is one of its goldens, field for field and in order`);
    assert.ok(!/no prose before or after it/.test(agentBody(role)), `${role}: the JSON-only rule is the runner's, not repeated in the body`);
  }
});

test('reviewer goldens: unique ids with the lane prefix, cited lines exist, an empty list is valid', () => {
  const ids = new Set();
  for (const [name, g] of Object.entries(INDEX).filter(([, x]) => x.schema === 'reviewer')) {
    const out = golden(name);
    for (const f of out.findings) {
      assert.ok(f.id.startsWith(`${out.lane}-`), `${name}: ${f.id} starts with ${out.lane}-`);
      assert.ok(!ids.has(f.id), `${name}: ${f.id} is unique`);
      ids.add(f.id);
      assert.ok(f.file && f.line, `${name}: ${f.id} cites file and line`);
      assertCite(`${f.file}:${f.line}`, `${name} ${f.id}`);
    }
    const sev = out.findings.map((f) => ['blocker', 'major', 'minor'].indexOf(f.severity));
    assert.deepEqual(sev, [...sev].sort((a, b) => a - b), `${name}: most severe first`);
  }
  const clean = golden('code-reviewer.clean');
  assert.deepEqual(clean.findings, [], 'the clean fixture has no findings');
  assert.deepEqual(validate(strict(schemaOf('reviewer')), clean), []);
  // Each finding verifier golden verifies a finding some reviewer golden raised.
  for (const n of ['finding-verifier', 'finding-verifier.unverifiable']) assert.ok(ids.has(golden(n).finding_id), `${n}: verifies a real finding`);
});

test('other goldens: ids, unknowns, quotes and paths hold up', () => {
  const research = golden('researcher.research');
  for (const e of research.evidence) {
    assert.match(e.plan, /^P-\d+$/);
    const m = assertCite(e.source, 'research');
    assert.equal(repoLines(m[1])[Number(m[2]) - 1].trim(), e.quote.trim(), 'a repo quote is the cited line, word for word');
  }
  for (const v of research.versions) assertCite(v.source, 'research versions');
  const rb = golden('interviewer');
  for (const p of rb.pins.filter((x) => x.source === 'repo')) {
    const m = assertCite(p.file, 'read-back pin');
    assert.equal(repoLines(m[1])[Number(m[2]) - 1].trim(), p.quote.trim(), 'a repo pin quotes its line, word for word');
  }
  const brief = golden('brief-writer');
  for (const r of brief.records) assert.ok(r.options.some((o) => o.key === r.recommendation), 'a recommendation names one of its options');
  const ready = golden('god-eye.readiness');
  assert.equal(ready.verdict === 'ready', !ready.objections.some((o) => o.severity === 'blocker'), 'ready exactly when nothing blocks');
  for (const c of golden('researcher').claims) if (!/^(UNVERIFIED|https?:)/.test(c.source)) assertCite(c.source, 'researcher');
  const th = golden('threat-modeler').threats.map((t) => /^TH-\d+/.exec(t.threat)[0]);
  assert.equal(new Set(th).size, th.length, 'threat ids are unique');
  for (const n of ['architect', 'planner', 'slicer', 'threat-modeler']) {
    const out = golden(n);
    for (const p of out.paths || [out.path]) assert.match(p, /^\.factory\/jobs\/J-\d+\//, `${n}: writes inside the job folder`);
  }
  for (const n of ['builder', 'tester']) for (const s of golden(n).swept || golden(n).swept_checked) assertCite(s.split(/[: ]/)[0], n);
  for (const t of golden('option-generator').touches) if (!/\s/.test(t)) assertCite(t, 'option touches');
  const opt = golden('option-generator');
  assert.ok(opt.criteria.every((c) => /^(E-)?AC-\d+$/.test(c.id)));
});

// ---------------------------------------------------------------- the runner reads each golden

test('runAgent turns every golden reply into exactly the golden, through the correction turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-contracts-'));
  const root = path.join(dir, 'root');
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true });
  const script = path.join(dir, 'script.js');
  // The label names the golden. Turn 1: prose around an object missing the first required
  // field. Turn 2 (same session, the runner's correction): prose plus the golden in a fence.
  fs.writeFileSync(script, `
const fs = require('fs');
const path = require('path');
const idx = ${JSON.stringify(INDEX)};
module.exports = (c) => {
  const name = c.env.FACTORY_AGENT_LABEL;
  const out = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(GOLDEN)}, name + '.json'), 'utf8'));
  if (c.role !== idx[name].role) return { exit: 3, stderr: 'wrong agent ' + c.agent };
  if (process.env.CONTRACT_MODE === 'plain') return out;
  if (c.turn === 1) {
    const schema = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(path.join(PLUGIN, 'schemas', 'agent-outputs'))}, idx[name].schema + '.json'), 'utf8'));
    const broken = { ...out };
    delete broken[schema.required[0]];
    return { text: 'I checked everything. Result:\\n' + JSON.stringify(broken) + '\\nLet me know if you need more.' };
  }
  if (!/Do not redo the work/.test(c.instructions)) return { exit: 4, stderr: 'not the correction turn' };
  return { text: 'Corrected:\\n\`\`\`json\\n' + JSON.stringify(out, null, 2) + '\\n\`\`\`' };
};
`);
  const saved = { ...process.env };
  Object.assign(process.env, { FAKE_COPILOT_SCRIPT: script, FAKE_COPILOT_LOG: path.join(dir, 'log.jsonl') });
  const ctx = (mode) => ({
    root,
    brief: { job: 'J-0001', workflow: 'fanout-judge', config: 'contracts' },
    settings: { bin: FAKE, maxParallel: 6, modelIds: {}, timeoutSec: 60, resumeForRetry: true, flags: [] },
    runs: [],
    files: 0,
    scratch: path.join(root, '.factory', 'scratch', 'runner', 'J-0001', mode),
    decisionId: null,
    unavailable: null,
    limit: limiter(6),
    say: () => {},
    note: () => {},
  });
  try {
    for (const mode of ['correction', 'plain']) {
      process.env.CONTRACT_MODE = mode;
      const c = ctx(mode);
      const names = Object.keys(INDEX);
      const results = await Promise.all(names.map((name) => runner.runAgent(c, `# ${name}\nReply with the golden.`, { agentType: `factory:${INDEX[name].role}`, label: name, schema: schemaOf(INDEX[name].schema) })));
      names.forEach((name, i) => {
        assert.deepEqual(results[i], golden(name), `${mode}: ${name} comes back as the golden`);
        const rec = c.runs.find((r) => r.label === name);
        assert.equal(rec.outcome, 'ok', `${mode}: ${name} outcome`);
        assert.equal(rec.retry, mode === 'correction', `${mode}: ${name} ${mode === 'correction' ? 'needed' : 'needed no'} correction turn`);
        assert.equal(rec.spawns, mode === 'correction' ? 2 : 1);
      });
    }
  } finally {
    for (const k of ['FAKE_COPILOT_SCRIPT', 'FAKE_COPILOT_LOG', 'CONTRACT_MODE']) if (k in saved) process.env[k] = saved[k];
    else delete process.env[k];
  }
});

test('finding verifier: unverifiable keeps a serious finding blocking and is recorded with its evidence', () => {
  const F = require('./helpers/fixture');
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  const review = require('../cli/core/review');
  const job = require('../cli/core/job');
  const state = job.load(root, J);
  const v = golden('finding-verifier.unverifiable');
  const f = golden('security-reviewer').findings[0];
  const res = review.record(root, { jobId: J, step: 'post_merge_challenge', payload: { lanes: [{ lane: 'security', findings: [f] }], verifications: [v] } });
  assert.equal(state.id, J);
  assert.deepEqual(res.unverified, [f.id], 'an unverifiable finding stays unverified');
  assert.equal(res.lanes.security, 'changes', 'and blocks its lane');
  const rec = require('../cli/core/ledger').lastStep(root, J, 'post_merge_challenge').detail.findings[0];
  assert.equal(rec.verifier_status, 'unverifiable');
  assert.equal(rec.verification, v.reason);
  assert.equal(rec.verification_evidence, v.evidence);
});
