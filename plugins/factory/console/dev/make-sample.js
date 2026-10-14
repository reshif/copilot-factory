'use strict';
// Builds a real .factory/ folder for the console's sample view: a few days in the life of
// one repository. The real CLI, the real workflow scripts and the real hooks do the work;
// only the agents (and you, through chat replies) are scripted. Agents do the file and
// git work a real agent would. A scratch HMAC key is used, never yours, and a simulated
// clock (clock.js, preloaded into every process) makes the history span about three days.
//
//   node console/dev/make-sample.js <scratch-dir>      → prints the repo root (last line)
//   FACTORY_SECRET_FILE=<scratch-dir>/secret factory console --root <root> --out c.html --data d.json
//
// Jobs it leaves behind:
//   J-0001 standard@medium  Rate-limit the public search API — full run: clarify questions and
//          answers, H1 denied once, a researcher retried, a design revision, a planner round
//          that failed validation, a builder retry on a stronger model, a guard denial, a
//          confirmed security finding and fix round, a review re-run for a missing lane,
//          local ship, merge, a lesson, close.                                  → closed
//   J-0002 bug@low          Fix CSV export dropping the last row              → waiting at H1
//   J-0003 feature@low      Add a /health endpoint — H1 approved this morning, proof failed,
//          verify-fix round, review running now                    → active
//   J-0004 standard@medium  Cache search results for 30 seconds — parked at H2 overnight,
//          resumed, amended                                                   → waiting at H3
//   J-0005 bug@low          Remove the legacy v1 search route — H1 denied     → cancelled
//   J-0006 feature@low      Bulk re-index command — review rounds used up     → abandoned
//   J-0007 spike            Redis or in-process cache?                        → closed
//   J-0008 hotfix@high      Hotfix: search returns 500 on an empty query — post-merge
//          review confirmed a problem                                         → closed
//   J-0009 hotfix@high      Follow-up to J-0008 (opened by the CLI)           → at its first step

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OUT = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'factory-console-sample'));
fs.mkdirSync(OUT, { recursive: true });
process.env.TMPDIR = OUT;
process.env.FACTORY_SECRET_FILE = path.join(OUT, 'secret');

// ---- simulated clock: starts three days ago, shared with every child process ----------
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const DAY = 24 * H;
const CLOCK_JS = path.join(__dirname, 'clock.js');
const CLOCK_FILE = path.join(OUT, 'clock-offset');
const REAL_START = Date.now();
const DAY0 = (() => {
  const d = new Date(REAL_START);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 3);
  return d.getTime();
})();
fs.writeFileSync(CLOCK_FILE, String(DAY0 + 8 * H + 52 * M - REAL_START));
process.env.FACTORY_SAMPLE_CLOCK = CLOCK_FILE;
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(CLOCK_JS)}`.trim();
const clock = require(CLOCK_JS);

const PLUGIN = path.resolve(__dirname, '..', '..');
const INSPECTOR = path.resolve(PLUGIN, '..', 'factory-inspector', 'bin', 'factory-inspect');
const F = require(path.join(PLUGIN, 'tests/helpers/fixture'));
const Hns = require(path.join(PLUGIN, 'tests/helpers/workflow-harness'));

// Deterministic "randomness" for durations.
let seed = 0x5eed2026;
function rnd() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a, b) => a + (b - a) * rnd();

// Commits made by agents and by you carry the simulated time too.
function gitDate() {
  const ms = clock.now();
  const off = -new clock.RealDate(ms).getTimezoneOffset();
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const tz = `${off >= 0 ? '+' : '-'}${pad(off / 60)}${pad(off % 60)}`;
  process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = `${Math.floor(ms / 1000)} ${tz}`;
}
function setClock(t) {
  clock.setTo(t);
  gitDate();
}
const wait = (ms) => setClock(clock.now() + ms);
const at = (day, hh, mm) => setClock(Math.max(clock.now(), DAY0 + day * DAY + hh * H + mm * M));
const human = (minMin, maxMin) => wait(between(minMin, maxMin) * M);

// ---- plumbing --------------------------------------------------------------------------
let root;
const ok = (r, what) => {
  if (r.error) throw new Error(`${what}: ${JSON.stringify(r)}`);
  return r;
};
function cli(args, { allowFail = true, quick = false } = {}) {
  wait(quick ? between(0.5, 2) * S : between(2, 9) * S);
  return F.cli(root, args, { allowFail });
}
// Front matter for a design doc an agent writes (templates/docs).
function fm(d, doc, title, status, related = ['findings.md']) {
  return `---\ndoc: ${doc}\ntemplate: ${doc}@1\njob: ${path.basename(d)}\ntitle: ${title}\nstatus: ${status}\ndate: ${new Date().toISOString().slice(0, 10)}\ncontract: contract.md\nrelated: [${related.join(', ')}]\n---\n\n`;
}
function reply(text) {
  gitDate();
  return F.reply(root, text);
}
function sh(cwd, cmd) {
  gitDate();
  return F.sh(cwd, cmd);
}
function hook(script, input) {
  return spawnSync('node', [path.join(PLUGIN, 'hooks', script)], { input: JSON.stringify(input), encoding: 'utf8', env: process.env });
}
function use(J) {
  ok(cli(['use', J], { quick: true }), `use ${J}`);
}
function writeContract(J, text) {
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), text);
}
function instructions(p) {
  const l = p.split('\n').find((x) => x.trim().startsWith('/'));
  return l && fs.existsSync(l.trim()) ? `${fs.readFileSync(l.trim(), 'utf8')}\n${p}` : p;
}

// ---- agents: parallel calls start together; each takes 1–7 minutes ---------------------
const DUR = {
  'intent-analyst': [1, 3.5], judge: [1, 3], 'god-eye': [2, 5], researcher: [1.5, 5], 'option-generator': [2, 5],
  'threat-modeler': [3, 6], architect: [4, 7], planner: [3, 7], builder: [3, 7], tester: [1, 3], integrator: [1, 2.5],
  'code-reviewer': [2, 6], 'test-reviewer': [2, 5], 'security-reviewer': [3, 7], 'finding-verifier': [2, 5],
};
let aid = 0;
let batch = null;
function enqueue(J, prompt, opts, impl) {
  return new Promise((resolve, reject) => {
    if (!batch) {
      batch = [];
      setImmediate(flush);
    }
    batch.push({ J, prompt, opts, impl, resolve, reject });
  });
}
function flush() {
  const items = batch;
  batch = null;
  const t0 = clock.now();
  items.forEach((it, i) => {
    if (i) wait(between(0.3, 1.5) * S);
    it.id = `agent-${String(++aid).padStart(4, '0')}`;
    const [a, b] = DUR[it.opts.agentType.replace('factory:', '')] || [1, 7];
    it.dur = between(a, b) * M;
    it.start = clock.now();
    hook('activity.js', { hook_event_name: 'SubagentStart', session_id: 'sample', cwd: root, agent_id: it.id, agent_type: it.opts.agentType });
  });
  for (const it of [...items].sort((a, b) => a.start + a.dur - (b.start + b.dur))) {
    const end = Math.max(it.start + it.dur, t0 + 20 * S);
    setClock(Math.max(clock.now(), end - between(10, 40) * S));
    try {
      it.out = it.impl(it.opts.agentType, instructions(it.prompt), it.opts, it.id);
    } catch (e) {
      it.err = e;
    }
    setClock(Math.max(clock.now() + 2 * S, end));
    hook('subagent-stop.js', { hook_event_name: 'SubagentStop', session_id: 'sample', cwd: root, agent_id: it.id, agent_type: it.opts.agentType });
  }
  for (const it of items) (it.err ? it.reject(it.err) : it.resolve(it.out));
}

async function runWorkflow(J, n, crew) {
  const a = ['wfargs', n.workflow, '--job', J];
  if (n.config) a.push('--config', n.config);
  if (n.mode) a.push('--mode', n.mode);
  if (n.scope) a.push('--scope', n.scope);
  const brief = cli(a, { allowFail: false });
  wait(between(5, 20) * S);
  const { result } = await Hns.run(path.join(PLUGIN, 'workflows', `${n.workflow}.js`), JSON.stringify(brief), (prompt, opts) => enqueue(J, prompt, opts, crew));
  wait(between(4, 15) * S);
  gitDate();
  return ok(F.record(root, result), `record ${n.workflow}`);
}

// ---- the repository: a tiny search API -------------------------------------------------
const BASE = {
  'package.json': '{\n  "name": "search-api",\n  "version": "1.4.0",\n  "private": true\n}\n',
  'README.md': '# search-api\n\nThe public product-search API.\n',
  'src/index-store.js': [
    "const DOCS = [",
    "  { id: 1, title: 'Trail running shoes' },",
    "  { id: 2, title: 'Leather hiking boots' },",
    "  { id: 3, title: 'Running socks, 3 pack' },",
    "  { id: 4, title: 'Waterproof shell jacket' },",
    "];",
    "let byLetter = {};",
    "function rebuild(docs = DOCS) {",
    "  byLetter = {};",
    "  for (const d of docs) for (const w of d.title.toLowerCase().split(/\\W+/).filter(Boolean)) (byLetter[w[0]] = byLetter[w[0]] || []).push({ word: w, id: d.id });",
    "}",
    "rebuild();",
    "// Ids of documents with a word starting with every term.",
    "function lookup(terms) {",
    "  return [...new Set(terms.flatMap((t) => byLetter[t[0]].filter((e) => e.word.startsWith(t)).map((e) => e.id)))];",
    "}",
    "module.exports = { lookup, rebuild, DOCS };",
    '',
  ].join('\n'),
  'src/search.js': [
    "const index = require('./index-store');",
    '',
    'module.exports = function search(req) {',
    '  const terms = req.query.q.trim().toLowerCase().split(/\\s+/);',
    '  return { status: 200, headers: {}, body: { results: index.lookup(terms) } };',
    '};',
    '',
  ].join('\n'),
  'src/export-csv.js': [
    '// Search results to CSV for the merchandising team.',
    'module.exports = function toCsv(rows) {',
    "  const lines = ['id,title'];",
    '  for (let i = 0; i < rows.length - 1; i++) lines.push(`${rows[i].id},${rows[i].title}`);',
    "  return lines.join('\\n');",
    '};',
    '',
  ].join('\n'),
  'src/routes/v1-search.js': "// Deprecated since 2025-03. Kept for the mobile app.\nconst search = require('../search');\nmodule.exports = (req) => ({ ...search(req), headers: { Deprecation: 'true' } });\n",
  'src/server.js': "const routes = {\n  '/search': require('./search'),\n  '/v1/search': require('./routes/v1-search'),\n};\nmodule.exports = (req) => (routes[req.path] ? routes[req.path](req) : { status: 404, headers: {}, body: { error: 'Not found' } });\n",
};

// ---- contracts ---------------------------------------------------------------------
function contract({ title, type, risk, goal, nonGoals, ac, constraints, allowed, verify, assumptions, intent = {} }) {
  const signal = String(ac[0] || goal).replace(/^E?-?AC-\d+:\s*/, '').replace(/\s*\(evidence:[^)]*\)\s*$/, '');
  return `# ${title}

<!-- factory contract · work_type: ${type} · risk: ${risk} -->

## Intent
- Problem: ${intent.problem || `Not true today: ${goal}`}
- Who: ${intent.who || 'Callers of the search API; asked by the search team lead'}
- Outcome: ${intent.outcome || goal}
- Why now: ${intent.why_now || 'Raised in this week\'s search review'}
- Success signal: ${intent.success || signal}

## Goal
${goal}

## Non-goals
${nonGoals.map((x) => `- ${x}`).join('\n')}

## Acceptance criteria
${ac.map((x) => `- ${x}`).join('\n')}

## Constraints
${constraints.map((x) => `- ${x}`).join('\n')}

## Allowed paths
${allowed.map((x) => `- ${x}`).join('\n')}

## Verify commands
${verify.length ? verify.map((x) => `- ${x}`).join('\n') : '- (none: the outcome is a document)'}

## Assumptions
${assumptions.map((x) => `- ${x}`).join('\n')}
`;
}

// ---- a scripted crew. `sc` holds what this job's agents say and write ------------------
function crew(J, sc, st) {
  const dir = () => F.jobDir(root, J);
  return (type, text, opts, agentId) => {
    const label = opts.label || '';
    const retry = /\(retry\)$/.test(label);
    const role = type.replace('factory:', '');
    switch (role) {
      case 'intent-analyst': {
        const focus = label.replace('analyst · ', '');
        const qs = ((sc.questions && sc.questions(st.round)) || []).filter((q) => q.focus === focus);
        return { focus, questions: qs.map(({ question, why }) => ({ question, why, blocking: true })), assumptions: sc.assumptions ? sc.assumptions[focus] || [] : [] };
      }
      case 'judge': {
        const qs = (sc.questions && sc.questions(st.round)) || [];
        return { questions: qs.map(({ question, why }) => ({ question, why })), dismissed: sc.dismissed && st.round === 1 ? sc.dismissed : [] };
      }
      case 'god-eye': {
        const m = label.match(/design #(\d+)/);
        if (m && sc.designCritique) return sc.designCritique(Number(m[1]));
        return { verdict: 'approve', items: [] };
      }
      case 'researcher': {
        const topic = label.replace('ground · ', '').replace(' (retry)', '');
        if (sc.researcherFailsOnce === topic && !retry) return null;
        const r = (sc.research || {})[topic] || DEFAULT_RESEARCH[topic] || [];
        return { topic, claims: r.map(([claim, source]) => ({ claim, source })), unknowns: [] };
      }
      case 'option-generator': {
        const i = /smallest/.test(text) ? 0 : /robust/.test(text) ? 1 : 2;
        const o = sc.options[i];
        return { title: o[0], summary: o[1], approach: o[1], pros: o[2], cons: o[3], risks: o[4] || [] };
      }
      case 'threat-modeler': {
        const p = path.join(dir(), 'threat-model.md');
        fs.writeFileSync(p, typeof sc.threat.doc === "function" ? sc.threat.doc(dir()) : sc.threat.doc);
        return { path: p, threats: sc.threat.threats };
      }
      case 'architect':
        return sc.architect(dir(), /revise/.test(label));
      case 'planner': {
        const k = Number((label.match(/#(\d+)/) || [])[1] || 1);
        const plan = sc.plans[Math.min(k, sc.plans.length) - 1];
        fs.writeFileSync(path.join(dir(), 'plan.json'), JSON.stringify(plan, null, 2));
        const v = F.cli(root, ['plan', 'validate', '--job', J]);
        return { valid: Boolean(v.valid), errors: v.errors || [], path: path.join(dir(), 'plan.json'), summary: v.valid ? `${plan.tasks.length} task(s) in ${(v.waves || []).length} wave(s)` : `${(v.errors || []).length} validation error(s)` };
      }
      case 'builder': {
        const [, id, attempt] = label.match(/^build (T\d+) #(\d+)/);
        const s = ok(F.cli(root, ['task', 'start', id, '--job', J]), `task start ${id}`);
        F.cli(root, ['task', 'show', id, '--job', J]);
        if (sc.beforeBuild) sc.beforeBuild(id, Number(attempt), s, agentId);
        const b = sc.build(id, Number(attempt), st);
        for (const [rel, body] of Object.entries(b.files)) F.write(s.worktree, rel, body);
        sh(s.worktree, `git add -A && (git diff --cached --quiet || git commit -qm ${JSON.stringify(b.msg)})`);
        return { status: 'done', summary: b.msg, swept: b.swept || [], commits: [] };
      }
      case 'tester': {
        const id = label.split(' ')[1];
        const v = F.cli(root, ['task', 'verify', id, '--job', J]);
        return { pass: Boolean(v.pass), evidence_id: v.evidence_id, failures: (v.failures || []).map((f) => `${f.cmd} exited ${f.code}`), swept_checked: [] };
      }
      case 'integrator': {
        const r = F.cli(root, ['reconcile', 'run', '--job', J]);
        return { status: r.status === 'merged' ? 'merged' : 'failed', summary: r.status === 'merged' ? 'Task branches merged in dependency order; no conflicts' : String(r.status || r.error), files: [] };
      }
      case 'code-reviewer':
      case 'test-reviewer':
      case 'security-reviewer': {
        const lane = label.replace('review · ', '').replace(' (retry)', '');
        const f = sc.review ? sc.review(lane, st, retry) : [];
        return f === null ? null : { lane, findings: f };
      }
      case 'finding-verifier': {
        const raw = text.split('The finding to verify:')[1];
        const f = raw ? JSON.parse(raw.trim()) : {};
        const v = sc.verify ? sc.verify(f, st) : null;
        return { finding_id: f.id, status: v ? v[0] : 'confirmed', reason: v ? v[1] : 'Reproduced from the diff.' };
      }
      default:
        throw new Error(`no scripted agent for ${type} (${label})`);
    }
  };
}

const DEFAULT_RESEARCH = {
  codebase: [['GET /search is handled by a single function with no middleware', 'src/search.js:3'], ['Routes are a plain path → handler map', 'src/server.js:1']],
  interfaces: [['Handlers take { path, query, headers, ip, apiKey } and return { status, headers, body }', 'src/server.js:5']],
  history: [['No ADRs in the repo yet', 'git log --oneline -- docs/ (no output)']],
  external: [],
};

// ---- the main session: next → act, until a stop condition ------------------------------
async function drive(J, sc, st, { stopAt } = {}) {
  const cr = crew(J, sc, st);
  for (let g = 0; g < 150; g++) {
    wait(between(8, 40) * S); // the main session reads the last result and asks what's next
    const n = ok(cli(['next', '--job', J]), 'next');
    if (stopAt && stopAt(n)) return n;
    if (n.action === 'skill' && n.skill === 'clarify') {
      st.round = (st.round || 0) + 1;
      const r = await runWorkflow(J, { workflow: 'fanout-judge', config: 'clarify' }, cr);
      if (r.status === 'needs_user') {
        if (!sc.onQuestions) throw new Error(`${J}: unexpected questions ${JSON.stringify(r)}`);
        if ((await sc.onQuestions(r.questions || [])) === 'stop') return n;
      } else if (r.status !== 'ok') throw new Error(`${J}: clarify ${JSON.stringify(r)}`);
    } else if (n.action === 'gate') {
      const g2 = sc.gate ? await sc.gate(n) : null;
      if (g2 === 'stop') return n;
      if (!g2) {
        human(...(sc.humanGate || GATE_WAIT)[n.step] || [10, 60]);
        ok(reply('approve'), `approve ${n.step}`);
      }
    } else if (n.action === 'workflow') {
      st.mode = n.mode || null;
      if (n.config === 'challenge') st.ch = (st.ch || 0) + 1;
      if (n.workflow === 'realize' && n.scope !== 'all') st.fixRound = (st.fixRound || 0) + 1;
      if (n.workflow === 'realize' && n.scope === 'fix') st.fix = true;
      if (n.workflow === 'realize' && n.scope === 'verifyFix') st.verifyFix = true;
      await runWorkflow(J, n, cr);
    } else if (n.action === 'cli') {
      const r = cli(n.command.replace(/^factory /, '').split(' ').filter(Boolean));
      if (r.error && !/verify run/.test(n.command)) throw new Error(`${n.command}: ${JSON.stringify(r)}`);
    } else if (n.action === 'skill' && n.skill === 'ship') {
      ok(cli(['report', '--job', J]), 'report');
      ok(cli(['ship', '--local', '--job', J]), 'ship');
    } else if (n.action === 'wait' && n.step === 'H4') {
      human(...(sc.mergeWait || [20, 70]));
      sh(root, `git merge -q --no-ff -m ${JSON.stringify(`Merge ${J}: ${n.title}`)} factory/${J}`);
      wait(between(1, 4) * M);
      ok(reply(`merged ${sh(root, 'git rev-parse --short HEAD')}`), 'merged');
    } else if (n.action === 'skill' && n.skill === 'distill') {
      cli(['distill', 'context', '--job', J]);
      wait(between(2, 5) * M);
      if (sc.lesson) ok(cli(['lessons', 'add', '--job', J, '--text', sc.lesson[0], '--scope', sc.lesson[1]]), 'lesson');
      ok(cli(['distill', 'done', '--job', J]), 'distill done');
      ok(cli(['ci', 'verify', '--job', J]), 'ci verify');
    } else if (n.action === 'parked' || n.action === 'done') {
      return n;
    } else throw new Error(`${J}: unexpected ${JSON.stringify(n)}`);
  }
  throw new Error(`${J} did not finish`);
}
const GATE_WAIT = { H1: [15, 80], H2: [20, 100], H3: [10, 60], HF: [20, 70], HS: [10, 35], A: [15, 50] };

// ======================================================================================
// J-0001 — Rate-limit the public search API
// ======================================================================================
const C1 = {
  title: 'Rate-limit the public search API', type: 'feature', risk: 'medium',
  goal: 'GET /search refuses callers who go past 60 requests a minute with 429 Too Many Requests and a Retry-After header, so one noisy client cannot slow search down for everyone.',
  nonGoals: ['Changing the search response format', 'Per-plan or per-customer limits (one limit for every caller)'],
  ac: ['AC-1: a caller gets 60 requests per rolling minute; the 61st within that minute is refused (evidence: test)', 'AC-2: a refused call answers 429 with a Retry-After header in whole seconds, never 0 (evidence: test)'],
  constraints: ['No new dependencies', 'Adds no more than 1 ms to a search call'],
  allowed: ['src/**', 'tests/**'],
  verify: ['`node tests/limiter.test.js` (AC-1)', '`node tests/retry-after.test.js` (AC-2)', '`node tests/search.test.js` (AC-2)'],
  assumptions: ['Node 18 or later'],
};
const C1v2 = {
  ...C1,
  constraints: [...C1.constraints, 'A caller is identified by its API key (X-Api-Key)', 'The limit is per instance: with two instances the effective ceiling is 120 a minute, accepted for now'],
};
const C1v3 = {
  ...C1v2,
  ac: [...C1.ac, 'AC-3: a call without an API key is limited by its client IP address (evidence: test)'],
  verify: ['`node tests/limiter.test.js` (AC-1)', '`node tests/retry-after.test.js` (AC-2)', '`node tests/search.test.js` (AC-2, AC-3)'],
};

const J1FILES = {
  limiter: [
    '// Sliding-window limiter: at most `max` hits per key in any `windowMs`.',
    'module.exports = function limiter(max, windowMs) {',
    '  const hits = new Map();',
    '  return (key, now = Date.now()) => {',
    '    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);',
    '    if (list.length >= max) {',
    '      hits.set(key, list);',
    '      return { ok: false, retryAfter: (windowMs - (now - list[0])) / 1000 };',
    '    }',
    '    list.push(now);',
    '    hits.set(key, list);',
    '    return { ok: true };',
    '  };',
    '};',
    '',
  ].join('\n'),
  limiterTest: "const limiter = require('../src/limiter');\nconst l = limiter(60, 60000);\nfor (let i = 0; i < 60; i++) if (!l('k', 1000 + i).ok) { console.error('refused early at', i); process.exit(1); }\nif (l('k', 2000).ok) { console.error('61st allowed'); process.exit(1); }\nif (!l('other', 2000).ok) { console.error('keys share a window'); process.exit(1); }\nif (!l('k', 61001).ok) { console.error('window never slides'); process.exit(1); }\nconsole.log('ok');\n",
  retryAfterBad: "module.exports = (seconds) => ({ 'Retry-After': seconds });\n",
  retryAfter: "// Retry-After is whole seconds, at least 1 (RFC 9110 §10.2.3).\nmodule.exports = (seconds) => ({ 'Retry-After': String(Math.max(1, Math.ceil(seconds))) });\n",
  retryAfterTest: "const h = require('../src/retry-after');\nfor (const [inp, want] of [[0.2, '1'], [0, '1'], [29.1, '30'], [30, '30']]) {\n  if (h(inp)['Retry-After'] !== want) { console.error(`retryAfter(${inp}) =`, h(inp)['Retry-After'], 'want', want); process.exit(1); }\n}\nconsole.log('ok');\n",
  search: (fixed) => [
    "const index = require('./index-store');",
    "const limiter = require('./limiter');",
    "const retryAfter = require('./retry-after');",
    '',
    'const allow = limiter(60, 60 * 1000);',
    '',
    fixed
      ? '// Keyed by API key; anonymous calls by the socket address. Never by X-Forwarded-For:\n// the client sets that header, so it would hand out a fresh bucket per request.'
      : '// Keyed by API key; anonymous calls by client address.',
    'function callerKey(req) {',
    '  if (req.apiKey) return `key:${req.apiKey}`;',
    fixed ? '  return `ip:${req.ip}`;' : "  return `ip:${(req.headers || {})['x-forwarded-for'] || req.ip}`;",
    '}',
    '',
    'module.exports = function search(req) {',
    '  const r = allow(callerKey(req));',
    "  if (!r.ok) return { status: 429, headers: retryAfter(r.retryAfter), body: { error: 'Too many requests' } };",
    '  const terms = req.query.q.trim().toLowerCase().split(/\\s+/);',
    '  return { status: 200, headers: {}, body: { results: index.lookup(terms) } };',
    '};',
    '',
  ].join('\n'),
  searchTest: (fixed) => [
    "const search = require('../src/search');",
    "const call = (r) => search({ query: { q: 'running' }, headers: {}, ...r });",
    'let last;',
    "for (let i = 0; i < 61; i++) last = call({ apiKey: 'k1', ip: '10.0.0.1' });",
    "if (last.status !== 429 || !/^[1-9]\\d*$/.test(last.headers['Retry-After'])) { console.error('keyed caller not limited', last); process.exit(1); }",
    "if (call({ apiKey: 'k2', ip: '10.0.0.1' }).status !== 200) { console.error('a second key on the same IP was limited'); process.exit(1); }",
    "for (let i = 0; i < 61; i++) last = call({ ip: '10.0.0.9' });",
    "if (last.status !== 429) { console.error('anonymous caller not limited by IP'); process.exit(1); }",
    ...(fixed
      ? ["for (let i = 0; i < 61; i++) last = call({ ip: '10.0.0.7', headers: { 'x-forwarded-for': `203.0.113.${i}` } });", "if (last.status !== 429) { console.error('X-Forwarded-For rotation escapes the limit'); process.exit(1); }"]
      : []),
    "console.log('ok');",
    '',
  ].join('\n'),
};
const J1PLAN_BAD = {
  tasks: [
    { id: 'T1', objective: 'Sliding-window limiter, 60 requests a minute per key', allowed_paths: ['src/limiter.js', 'tests/limiter.test.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/limiter.test.js', covers: ['AC-1'] }], retry_limit: 3 },
    { id: 'T2', objective: 'Retry-After header in whole seconds', allowed_paths: ['src/retry-after.js', 'tests/retry-after.test.js'], depends_on: [], criteria_ids: ['AC-2'], verify_commands: [{ cmd: 'node tests/retry-after.test.js', covers: ['AC-2'] }], retry_limit: 3 },
    { id: 'T3', objective: 'Answer 429 from GET /search once the limit is hit', allowed_paths: ['src/search.js', 'tests/search.test.js'], depends_on: ['T1', 'T2'], criteria_ids: ['AC-2', 'AC-4'], verify_commands: [{ cmd: 'node tests/search.test.js', covers: ['AC-2'] }], retry_limit: 3 },
  ],
};
const J1PLAN = {
  tasks: [
    J1PLAN_BAD.tasks[0],
    J1PLAN_BAD.tasks[1],
    { id: 'T3', objective: 'Answer 429 from GET /search once the limit is hit; key by API key, anonymous calls by IP', allowed_paths: ['src/search.js', 'tests/search.test.js'], depends_on: ['T1', 'T2'], criteria_ids: ['AC-2', 'AC-3'], verify_commands: [{ cmd: 'node tests/search.test.js', covers: ['AC-2', 'AC-3'] }], retry_limit: 3, rollback: 'Revert src/search.js; the limiter and header modules are unused without it' },
  ],
};

function sc1(J) {
  let denied = false;
  return {
    questions: (round) => (round === 1
      ? [
          { focus: 'ambiguity', question: 'Limit per API key or per IP address?', why: 'Partners call through shared NAT gateways: one IP can carry many API keys' },
          { focus: 'constraints', question: 'Must the limit hold across both API instances, or is per-instance acceptable?', why: 'Two instances sit behind the load balancer; per-instance doubles the effective limit' },
        ]
      : []),
    dismissed: [{ question: 'Should limits differ per pricing plan?', reason: 'Non-goal in the contract' }],
    assumptions: { testability: ['Tests can drive the limiter with an injected clock'] },
    onQuestions: async (qs) => {
      human(25, 45);
      ok(cli(['answer', '--job', J, '--question', qs[0].question, '--answer', 'Per API key. Most traffic carries one.']), 'answer');
      wait(between(2, 4) * M);
      ok(cli(['answer', '--job', J, '--question', qs[1].question, '--answer', 'Per instance is fine for now; we only run two.']), 'answer');
      wait(between(3, 6) * M); // the main session writes the answers into the contract
      writeContract(J, contract(C1v2));
    },
    gate: async (n) => {
      if (n.step === 'H1' && !denied) {
        denied = true;
        human(55, 80);
        ok(reply('deny Also cover anonymous callers — no API key means limit by IP'), 'deny');
        wait(between(4, 8) * M);
        writeContract(J, contract(C1v3));
        return 'handled';
      }
      return null;
    },
    researcherFailsOnce: 'history',
    research: {
      codebase: [['GET /search is one handler with no middleware', 'src/search.js:3'], ['Callers reach handlers with { query, headers, ip, apiKey }', 'src/server.js:5']],
      interfaces: [['Retry-After takes delay-seconds as a non-negative integer', 'https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3'], ['429 Too Many Requests is defined in RFC 6585', 'https://www.rfc-editor.org/rfc/rfc6585#section-4']],
      history: [['No earlier rate limiting in this repo', 'git log --oneline -S limiter (no output)']],
      external: [['The load balancer sets X-Forwarded-For but passes through any value the client sent', 'UNVERIFIED']],
    },
    options: [
      ['In-process sliding window', 'A Map of timestamps per caller key inside the search handler', ['No dependency', '~0.1 ms per call'], ['Per instance', 'Memory grows with distinct callers']],
      ['Token bucket in Redis', 'Shared bucket per caller in the Redis cluster with a Lua script', ['Exact across instances'], ['New dependency and network hop', 'Redis outage blocks search'], ['Redis is not provisioned for this service']],
      ['Middleware in server.js', 'Generic limiter middleware wrapping every route', ['Reusable'], ['Touches every route; larger blast radius']],
    ],
    architect: (d, revise) => {
      const p = path.join(d, 'adr-001-rate-limit-search.md');
      fs.writeFileSync(p, fm(d, 'adr', 'Rate-limit search in process', 'proposed') + [
        '# ADR 001: Rate-limit search in process',
        '',
        '## Context',
        'Search has no rate limit; one partner script took p95 from 80 ms to 1.4 s last month (findings · codebase · src/search.js:3). AC-1 and AC-2 need a per-caller limit with a correct Retry-After.',
        '',
        '## Decision drivers',
        '- AC-1/AC-2: exact 60-a-minute behaviour per caller, with a whole-second Retry-After.',
        '- Constraint: no new dependency; Redis is not provisioned for this service (findings · history).',
        '- Small blast radius: only GET /search changes.',
        '',
        '## Considered options',
        '| # | Option | Pros | Cons | Verdict |',
        '|---|---|---|---|---|',
        '| 1 | In-process sliding window | No dependency; ~0.1 ms per call | Per instance; memory grows with callers | chosen |',
        '| 2 | Token bucket in Redis | Exact across instances | New dependency and network hop | rejected: not provisioned |',
        '| 3 | Middleware in server.js | Reusable | Touches every route | rejected: larger blast radius |',
        '',
        '## Decision',
        'We will add a sliding window of 60 requests a minute per caller, kept in process in src/limiter.js and called first in the search handler. A caller is its API key; calls without a key are limited by client IP.',
        ...(revise ? ['', 'Memory: entries older than the window are dropped on each hit; a key with no hits for a minute is pruned on the next sweep (every 10 000 calls).'] : []),
        '',
        '## Architecture diagram',
        '```mermaid',
        'flowchart LR',
        '  client([API caller]) -->|GET /search, x-api-key| server',
        '  subgraph api["search-api — this repository"]',
        '    server[src/server.js router] -->|req: query, apiKey, ip| search[src/search.js handler]',
        '    search -->|hit key| limiter[src/limiter.js sliding window]',
        '    limiter -->|allowed / retryAfter| search',
        '    search -->|terms| index[(index-store)]',
        '  end',
        '  search -->|200 results or 429 + Retry-After| client',
        '  classDef changed fill:#fff3bf,stroke:#f08c00,stroke-width:2px',
        '  class limiter,search changed',
        '```',
        '',
        '### Key flow',
        '```mermaid',
        'sequenceDiagram',
        '  participant C as Caller',
        '  participant S as search handler',
        '  participant L as limiter',
        '  C->>S: GET /search?q=…',
        '  S->>L: hit(apiKey or ip)',
        '  alt under 60 in the last minute',
        '    L-->>S: allowed',
        '    S-->>C: 200 results',
        '  else limit reached',
        '    L-->>S: retryAfter seconds',
        '    S-->>C: 429 with Retry-After',
        '  end',
        '```',
        '',
        '## Consequences',
        '- Positive: one partner can no longer slow search for everyone.',
        '- Negative: the limit is per instance, so two instances allow up to 120 a minute.',
        '- Follow-up: revisit with option 2 if Redis is provisioned.',
        '',
        '## How each acceptance criterion is met',
        '| AC | How the design meets it | Proof |',
        '|---|---|---|',
        '| AC-1 | limiter refuses the 61st hit in a rolling minute | test: `node tests/limiter.test.js` |',
        '| AC-2 | 429 carries Retry-After = ceil(oldest hit + 60 s − now), at least 1 | test: `node tests/search.test.js` |',
        '| AC-3 | key falls back to the client IP when there is no API key | test: `node tests/search.test.js` |',
        '',
        '## Threat mitigations',
        'No threat model at this risk. Spoofed X-Forwarded-For is not trusted: the key uses the socket IP.',
        '',
        '## Rollback and migration',
        'Revert the merge commit; no data changes.',
        '',
        '## Open questions',
        '- Should partners get a higher limit? Product — would add a per-key override.',
        '',
      ].join('\n'));
      return { kind: 'adr', paths: [p], summary: 'Sliding window per API key (IP for anonymous calls), in process', rejected: [{ option: 'Token bucket in Redis', reason: 'New dependency; not provisioned' }, { option: 'Middleware in server.js', reason: 'Touches every route' }] };
    },
    designCritique: (k) => (k === 1
      ? { verdict: 'revise', items: [{ issue: 'The ADR does not say how memory stays bounded as distinct callers grow', severity: 'major', suggestion: 'State when idle keys are dropped' }] }
      : { verdict: 'approve', items: [] }),
    plans: [J1PLAN_BAD, J1PLAN],
    beforeBuild: (id, attempt, s, agentId) => {
      if (id !== 'T1' || attempt !== 1) return;
      // The T1 builder tries to wire the limiter into search.js too: outside its scope.
      const r = hook('guard.js', {
        hook_event_name: 'PreToolUse', session_id: 'sample', cwd: s.worktree, agent_id: agentId, agent_type: 'factory:builder',
        tool_name: 'Write', tool_input: { file_path: path.join(s.worktree, 'src', 'search.js'), content: "const limiter = require('./limiter');\n" },
      });
      if (!/permissionDecision":"deny/.test(r.stdout)) throw new Error(`guard did not deny: ${r.stdout}${r.stderr}`);
    },
    build: (id, attempt, st) => {
      if (id === 'T1') return { files: { 'src/limiter.js': J1FILES.limiter, 'tests/limiter.test.js': J1FILES.limiterTest }, msg: 'T1: sliding-window limiter' };
      if (id === 'T2') return { files: { 'src/retry-after.js': attempt === 1 ? J1FILES.retryAfterBad : J1FILES.retryAfter, 'tests/retry-after.test.js': J1FILES.retryAfterTest }, msg: attempt === 1 ? 'T2: Retry-After header' : 'T2: Retry-After in whole seconds, minimum 1' };
      return { files: { 'src/search.js': J1FILES.search(st.fix), 'tests/search.test.js': J1FILES.searchTest(st.fix) }, msg: st.fix ? 'T3: key anonymous callers by socket address, not X-Forwarded-For' : 'T3: 429 from /search past the limit', swept: st.fix ? ['src/search.js', 'src/server.js', 'src/routes/v1-search.js'] : [] };
    },
    review: (lane, st, retry) => {
      if (lane === 'security') return st.fix ? [] : [{ id: 'security-1', severity: 'major', file: 'src/search.js', line: 10, summary: 'Anonymous callers are keyed on X-Forwarded-For, which the client controls: rotating the header gives a fresh 60-request bucket on every call' }];
      if (lane === 'tests') {
        if (st.ch === 2) return null; // the tests reviewer comes back with nothing, twice
        return [{ id: 'tests-1', severity: 'minor', file: 'tests/search.test.js', line: 5, summary: 'Asserts Retry-After is numeric but not its value' }];
      }
      return st.ch === 1 ? [{ id: 'code-1', severity: 'minor', file: 'src/limiter.js', line: 3, summary: 'Keys with no recent hits are never evicted from the Map' }] : [];
    },
    verify: (f) => ['confirmed', 'Sent 200 anonymous requests from one socket with X-Forwarded-For 203.0.113.<n>: all answered 200, none limited.'],
    lesson: ['Never derive a rate-limit or auth key from a client-supplied header (X-Forwarded-For, X-Real-IP); use the API key or the socket address.', 'src/**'],
    mergeWait: [25, 50],
  };
}

// ======================================================================================
// J-0002 — Fix CSV export dropping the last row
// ======================================================================================
const C2 = {
  title: 'Fix CSV export dropping the last row', type: 'bug', risk: 'low',
  goal: 'Exporting search results to CSV includes every row; today the last row is silently dropped.',
  nonGoals: ['Changing the column set or order'],
  ac: ['AC-1: exporting N result rows produces a header line plus N data lines (evidence: test)', 'AC-2: exporting zero rows produces only the header line (evidence: test)'],
  constraints: ['Keep the export function signature: toCsv(rows) → string'],
  allowed: ['src/export-csv.js', 'tests/export-csv.test.js'],
  verify: ['`node tests/export-csv.test.js` (AC-1, AC-2)'],
  assumptions: ['Titles never contain commas today'],
};
const C2v2 = { ...C2, constraints: [...C2.constraints, 'Lines end with \\r\\n and the file ends with one, like the spreadsheet export merchandising compares it with'] };
function sc2() {
  return {
    questions: (round) => (round === 1 ? [{ focus: 'ambiguity', question: 'Should the file end with a line break after the last row?', why: 'Merchandising diffs it against the spreadsheet export, which ends with \\r\\n' }] : []),
    onQuestions: async () => 'stop',
    options: [],
  };
}

// ======================================================================================
// J-0003 — Add a /health endpoint
// ======================================================================================
const C3 = {
  title: 'Add a /health endpoint', type: 'feature', risk: 'low',
  goal: 'GET /health answers 200 with the service status and build version, so the load balancer can take a broken instance out of rotation.',
  nonGoals: ['Deep checks of downstream services'],
  ac: ['AC-1: GET /health answers 200 with {"status":"ok"} (evidence: test)', 'AC-2: the body carries the version from package.json (evidence: test)'],
  constraints: ['Answers in under 5 ms; no I/O per request'],
  allowed: ['src/**', 'tests/**'],
  verify: ['`node tests/health.test.js` (AC-1)', '`node tests/health-version.test.js` (AC-2)'],
  assumptions: ['The load balancer probes every 10 s'],
};
const J3PLAN = { tasks: [{ id: 'T1', objective: 'GET /health handler answering 200 with status and version', allowed_paths: ['src/health.js', 'tests/health.test.js', 'tests/health-version.test.js'], depends_on: [], criteria_ids: ['AC-1', 'AC-2'], verify_commands: [{ cmd: 'node tests/health.test.js', covers: ['AC-1'] }], retry_limit: 3 }] };
function sc3() {
  return {
    plans: [J3PLAN],
    build: (id, attempt, st) => ({
      files: {
        'src/health.js': st.verifyFix
          ? "// Read once at start-up: no I/O per probe.\nconst { version } = require('../package.json');\n\nmodule.exports = function health() {\n  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { status: 'ok', version } };\n};\n"
          : "module.exports = function health() {\n  return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { status: 'ok', version: process.env.npm_package_version } };\n};\n",
        'tests/health.test.js': "const health = require('../src/health');\nconst r = health();\nif (r.status !== 200 || r.body.status !== 'ok') { console.error(r); process.exit(1); }\nconsole.log('ok');\n",
        'tests/health-version.test.js': "const health = require('../src/health');\nconst pkg = require('../package.json');\nconst v = health().body.version;\nif (v !== pkg.version) { console.error('version', v, 'want', pkg.version); process.exit(1); }\nconsole.log('ok');\n",
      },
      msg: st.verifyFix ? 'T1: read the version from package.json, not npm_package_version' : 'T1: GET /health',
      swept: st.verifyFix ? ['src/health.js'] : [],
    }),
    review: () => [],
  };
}

// ======================================================================================
// J-0004 — Cache search results for 30 seconds
// ======================================================================================
const C4 = {
  title: 'Cache search results for 30 seconds', type: 'feature', risk: 'medium',
  goal: 'Repeated identical searches within 30 seconds are answered from a cache instead of the index, to bring peak p95 back under 150 ms.',
  nonGoals: ['Caching personalised results', 'Changing ranking'],
  ac: ['AC-1: a repeated identical search within 30 s is served from the cache (evidence: test)', 'AC-2: an entry older than 30 s is never served (evidence: test)'],
  constraints: ['Cache memory at most 50 MB per instance', 'No new dependency unless infra provides a shared cache'],
  allowed: ['src/**', 'tests/**'],
  verify: ['`node tests/cache.test.js` (AC-1, AC-2)'],
  assumptions: ['Identical means same normalised query string'],
};
const C4v2 = {
  ...C4,
  ac: [...C4.ac, 'AC-3: rebuilding the index clears the cache (evidence: test)'],
  constraints: ['Cache memory at most 50 MB per instance', 'In-process cache (infra confirmed: no shared Redis for search this quarter)'],
  verify: ['`node tests/cache.test.js` (AC-1, AC-2, AC-3)'],
};
const J4PLAN = (amended) => ({
  tasks: [
    { id: 'T1', objective: amended ? 'TTL cache (30 s, 5 000 entries) cleared on index rebuild' : 'TTL cache module (30 s, 5 000 entries, LRU eviction)', allowed_paths: ['src/cache.js', 'tests/cache.test.js'], depends_on: [], criteria_ids: amended ? ['AC-1', 'AC-2', 'AC-3'] : ['AC-1', 'AC-2'], verify_commands: [{ cmd: 'node tests/cache.test.js', covers: amended ? ['AC-1', 'AC-2', 'AC-3'] : ['AC-1', 'AC-2'] }], retry_limit: 3 },
    { id: 'T2', objective: 'Serve GET /search from the cache, keyed by the normalised query', allowed_paths: ['src/search.js', 'tests/search-cache.test.js'], depends_on: ['T1'], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/search-cache.test.js', covers: ['AC-1'] }], retry_limit: 3 },
  ],
});
function sc4() {
  return {
    options: [
      ['In-process TTL map', 'A Map from normalised query to { at, results }, swept every 30 s', ['No dependency', 'Sub-millisecond hits'], ['Each instance warms its own cache']],
      ['Shared Redis cache', 'SETEX per query in the shared Redis cluster', ['One warm cache for both instances'], ['Needs infra to provision Redis for search', 'A network hop per hit']],
      ['LRU like the session store', 'Reuse the bounded LRU pattern from the session store, with a 30 s TTL', ['Bounded memory', 'A pattern the team knows'], ['Per instance']],
    ],
    architect: (d) => {
      const p = path.join(d, 'adr-001-search-result-cache.md');
      fs.writeFileSync(p, fm(d, 'adr', 'Cache search results in process', 'proposed') + [
        '# ADR 001: Cache search results in process',
        '',
        '## Context',
        'Identical searches recompute the same results; the index lookup is the p95 cost (findings · codebase).',
        '',
        '## Decision drivers',
        '- AC-1/AC-2: serve repeats within 30 s, never anything older.',
        '- Bounded memory under a query flood.',
        '',
        '## Considered options',
        '| # | Option | Pros | Cons | Verdict |',
        '|---|---|---|---|---|',
        '| 1 | In-process TTL map | No dependency | Unbounded memory | rejected: unbounded memory |',
        '| 2 | Shared Redis cache | One warm cache | Needs infra to provision Redis | rejected for now: see open question |',
        '| 3 | LRU like the session store | Bounded; known pattern | Per instance | chosen |',
        '',
        '## Decision',
        'We will add a bounded LRU (5 000 entries, 30 s TTL) per instance in src/cache.js, keyed by the normalised query, cleared when the index is rebuilt.',
        '',
        '## Architecture diagram',
        '```mermaid',
        'flowchart LR',
        '  client([API caller]) -->|GET /search| search',
        '  subgraph api["search-api — this repository"]',
        '    search[src/search.js] -->|normalised query| cache[src/cache.js LRU 5000 / 30 s]',
        '    cache -->|miss| index[(index-store)]',
        '    reindex[bin/reindex.js] -->|clear| cache',
        '  end',
        '  classDef changed fill:#fff3bf,stroke:#f08c00,stroke-width:2px',
        '  class cache changed',
        '```',
        '',
        '## Consequences',
        '- Positive: repeated searches skip the index.',
        '- Negative: each instance warms its own cache.',
        '',
        '## How each acceptance criterion is met',
        '| AC | How the design meets it | Proof |',
        '|---|---|---|',
        '| AC-1 | a hit within 30 s returns the cached entry | test |',
        '| AC-2 | entries older than 30 s are evicted on read | test |',
        '| AC-3 | reindex clears the cache | test |',
        '',
        '## Threat mitigations',
        'No threat model at this risk.',
        '',
        '## Rollback and migration',
        'Revert the merge commit; the cache is in memory only.',
        '',
        '## Open questions',
        '- If a shared cache is provisioned for search this quarter, option 2 (Redis) wins: one warm cache instead of two. Infra.',
        '',
      ].join('\n'));
      return { kind: 'adr', paths: [p], summary: 'In-process LRU with a 30 s TTL, unless infra provides a shared cache', rejected: [{ option: 'In-process TTL map', reason: 'Unbounded memory' }] };
    },
    plans: [J4PLAN(false)],
  };
}

// ======================================================================================
// J-0005 — Remove the legacy v1 search route
// ======================================================================================
const C5 = {
  title: 'Remove the legacy v1 search route', type: 'bug', risk: 'low',
  goal: 'The deprecated GET /v1/search route is gone: calls to it answer 404 and its code is deleted.',
  nonGoals: ['Changing GET /search'],
  ac: ['AC-1: GET /v1/search answers 404 (evidence: test)'],
  constraints: ['No change to any other route'],
  allowed: ['src/routes/**', 'src/server.js', 'tests/routes.test.js'],
  verify: ['`node tests/routes.test.js` (AC-1)'],
  assumptions: ['Nobody calls /v1/search any more (deprecated since 2025-03)'],
};

// ======================================================================================
// J-0006 — Bulk re-index command
// ======================================================================================
const C6 = {
  title: 'Bulk re-index command', type: 'feature', risk: 'low',
  goal: 'An operator can rebuild the whole search index with one command, in batches, without taking search offline.',
  nonGoals: ['Scheduling re-index runs'],
  ac: ['AC-1: `node bin/reindex.js --all` rebuilds every document in batches of 500 (evidence: test)', 'AC-2: a failed batch is retried once and then reported, without stopping the run (evidence: test)'],
  constraints: ['Search keeps answering during a run'],
  allowed: ['src/reindex.js', 'bin/reindex.js', 'tests/reindex.test.js', 'tests/reindex-cli.test.js'],
  verify: ['`node tests/reindex.test.js` (AC-1, AC-2)'],
  assumptions: ['The catalogue has about 2 million documents'],
};
const J6PLAN = {
  tasks: [
    { id: 'T1', objective: 'Batch re-index core: batches of 500, one retry per failed batch, a report at the end', allowed_paths: ['src/reindex.js', 'tests/reindex.test.js'], depends_on: [], criteria_ids: ['AC-1', 'AC-2'], verify_commands: [{ cmd: 'node tests/reindex.test.js', covers: ['AC-1', 'AC-2'] }], retry_limit: 3 },
    { id: 'T2', objective: 'bin/reindex.js --all wrapper that prints the report', allowed_paths: ['bin/reindex.js', 'tests/reindex-cli.test.js'], depends_on: ['T1'], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/reindex-cli.test.js', covers: ['AC-1'] }], retry_limit: 3 },
  ],
};
const J6REINDEX = [
  '// v1: batches of 500',
  '// v2: stream ids instead of loading them all',
  '// v3: retry only the failed batch',
  '// v4: refuse to start while another run holds the lock',
];
function reindexSource(v) {
  return [
    ...J6REINDEX.slice(0, v + 1),
    "const index = require('./index-store');",
    'module.exports = async function reindex(docs, { batch = 500, write = async () => {} } = {}) {',
    '  const report = { batches: 0, failed: [] };',
    '  for (let i = 0; i < docs.length; i += batch) {',
    '    const part = docs.slice(i, i + batch);',
    '    report.batches += 1;',
    '    try { await write(part); } catch { try { await write(part); } catch (e) { report.failed.push({ from: i, error: String(e.message) }); } }',
    '  }',
    '  index.rebuild(docs);',
    '  return report;',
    '};',
    '',
  ].join('\n');
}
const J6FINDINGS = [
  'Loads every document id into memory before batching: Promise.all over the full id list',
  'After a partial failure the retry re-runs batches that already succeeded, writing duplicates',
  'Two re-index runs can interleave: nothing stops a second run from starting',
  'The lock is never released when a batch throws, so every later run refuses to start',
];
function sc6() {
  return {
    plans: [J6PLAN],
    build: (id, attempt, st) => {
      if (id === 'T2') return { files: { 'bin/reindex.js': "#!/usr/bin/env node\nconst reindex = require('../src/reindex');\nconst { DOCS } = require('../src/index-store');\nif (process.argv.includes('--all')) reindex(DOCS).then((r) => console.log(JSON.stringify(r)));\n", 'tests/reindex-cli.test.js': "const { execFileSync } = require('child_process');\nconst out = JSON.parse(execFileSync('node', ['bin/reindex.js', '--all'], { encoding: 'utf8' }));\nif (out.batches !== 1) { console.error(out); process.exit(1); }\nconsole.log('ok');\n" }, msg: 'T2: bin/reindex.js --all' };
      const v = st.fixRound || 0;
      return {
        files: { 'src/reindex.js': reindexSource(v), 'tests/reindex.test.js': "const reindex = require('../src/reindex');\nconst docs = Array.from({ length: 1200 }, (_, i) => ({ id: i, title: `doc ${i}` }));\nlet calls = 0;\nreindex(docs, { write: async () => { calls += 1; if (calls === 2) throw new Error('flaky'); } }).then((r) => {\n  if (r.batches !== 3 || r.failed.length) { console.error(r); process.exit(1); }\n  console.log('ok');\n});\n" },
        msg: v ? `T1: fix round ${v} — ${J6REINDEX[v].replace('// ', '')}` : 'T1: batch re-index core',
        swept: v ? ['src/reindex.js'] : [],
      };
    },
    review: (lane, st) => (lane === 'code' ? [{ id: 'code-1', severity: 'major', file: 'src/reindex.js', line: 3 + (st.ch - 1), summary: J6FINDINGS[Math.min(st.ch, 4) - 1] }] : [{ id: 'tests-1', severity: 'minor', file: 'tests/reindex.test.js', line: 2, summary: 'Only 1 200 documents: never exercises more than three batches' }]),
    verify: (f) => ['confirmed', `Reproduced against a 50 000-document fixture: ${f.summary.toLowerCase()}.`],
  };
}

// ======================================================================================
// J-0007 — Redis or in-process cache? (spike)
// ======================================================================================
const C7 = {
  title: 'Redis or in-process cache?', type: 'spike', risk: 'low',
  goal: 'Decide whether search result caching (J-0004) should use a shared Redis cache or an in-process cache, with measured numbers for both.',
  nonGoals: ['Building the cache'],
  ac: ['AC-1: a recommendation that compares hit rate, p95 latency and memory for both options on last week\'s query log (evidence: doc)'],
  constraints: ['Use the replayed query log, not synthetic queries'],
  allowed: ['docs/**'],
  verify: [],
  assumptions: ['Last week\'s traffic is representative'],
};
function sc7() {
  return {
    research: {
      codebase: [['Search answers from an in-memory index rebuilt on deploy', 'src/index-store.js:8']],
      interfaces: [['The shared Redis cluster is sized for sessions only (4 GB, 70% used)', 'UNVERIFIED']],
      history: [['J-0004 parked at H2 on exactly this question', '.factory/jobs/J-0004/state.json']],
      external: [['Redis SETEX gives per-key TTLs with O(1) cost', 'https://redis.io/docs/latest/commands/setex/']],
    },
    options: [
      ['In-process LRU', 'Replay: 61% hit rate per instance, p95 41 ms on hits, 38 MB per instance', ['No dependency', 'Fastest hits'], ['Two cold caches after each deploy']],
      ['Shared Redis', 'Replay: 74% hit rate, p95 3.1 ms added per hit, 120 MB in the cluster', ['Higher hit rate'], ['Cluster is near its memory limit', 'New failure mode for search']],
      ['In-process now, Redis later', 'Ship the LRU behind an interface; swap in Redis if the cluster grows', ['Unblocks J-0004 today'], ['Two implementations to keep']],
    ],
    architect: (d) => {
      const p = path.join(d, 'recommendation.md');
      fs.writeFileSync(p, fm(d, 'recommendation', 'In-process cache for search', 'proposed') + '# Recommendation: in-process cache for search\n\n## Question\nShared Redis or in-process cache for J-0004?\n\n## Options weighed\n| # | Option | Hit rate | p95 on hit | Memory | Verdict |\n|---|---|---|---|---|---|\n| 1 | In-process LRU | 61% per instance | 41 ms | 38 MB per instance | recommended |\n| 2 | Shared Redis | 74% | +3.1 ms per hit | 120 MB in the cluster | not recommended: cluster near its memory limit |\n\n## Recommendation\nIn-process LRU behind a small cache interface.\n\n## Confidence\nmedium-high — a replay of last week\'s query log.\n\n## What would change it\n- A third instance, or infra growing the Redis cluster → Redis.\n\n## Evidence\n- Replay numbers above — `node bench/replay.js` (both options)\n\n## Diagram\n```mermaid\nflowchart LR\n  search[search handler] -->|get / set| iface[cache interface]\n  iface --> lru[in-process LRU]\n  iface -.->|later| redis[(Redis)]\n```\n');
      return { kind: 'recommendation', paths: [p], summary: 'In-process LRU now; revisit Redis if a third instance is added', rejected: [{ option: 'Shared Redis', reason: 'Cluster near its memory limit; adds a failure mode' }] };
    },
  };
}

// ======================================================================================
// J-0008 — Hotfix: search returns 500 on an empty query
// ======================================================================================
const C8 = {
  title: 'Hotfix: search returns 500 on an empty query', type: 'hotfix', risk: 'high',
  goal: 'GET /search with an empty or missing q answers 400 with a clear error instead of crashing with 500.',
  nonGoals: ['Changing results for non-empty queries'],
  ac: ['AC-1: GET /search?q= answers 400 {"error":"Empty query"} (evidence: test)', 'AC-2: GET /search without q answers 400 (evidence: test)', 'AC-3: non-empty queries answer as before (evidence: test)'],
  constraints: ['Smallest possible change; ship today'],
  allowed: ['src/search.js', 'tests/search-empty.test.js'],
  verify: ['`node tests/search-empty.test.js` (AC-1, AC-2)', '`node tests/search.test.js` (AC-3)'],
  assumptions: ['The 500s in the error log all come from empty q (412 of 412 sampled)'],
};
const J8PLAN = { tasks: [{ id: 'T1', objective: 'Answer 400 for an empty or missing q before touching the index', allowed_paths: ['src/search.js', 'tests/search-empty.test.js'], depends_on: [], criteria_ids: ['AC-1', 'AC-2', 'AC-3'], verify_commands: [{ cmd: 'node tests/search-empty.test.js', covers: ['AC-1', 'AC-2'] }, { cmd: 'node tests/search.test.js', covers: ['AC-3'] }], retry_limit: 2, rollback: 'Revert the merge commit' }] };
function sc8() {
  return {
    research: {
      'failing path': [['req.query.q.trim() throws when q is missing; an empty q reaches index.lookup with [""] and byLetter[undefined].filter throws', 'src/search.js:18'], ['412 of 412 sampled 500s since Tuesday have an empty q', 'logs/api-errors (sampled)']],
      'blast radius': [['Only GET /search and /v1/search call search()', 'src/server.js:2'], ['tests/search.test.js covers the limiter path only', 'tests/search.test.js:1']],
    },
    options: [
      ['Guard in the handler', 'Return 400 before the limiter result is used when q is empty', ['Three lines'], ['Validation stays ad hoc']],
      ['Validate in server.js', 'A per-route query schema checked before every handler', ['Covers future routes'], ['Too large for a hotfix']],
      ['Guard in index-store', 'Make lookup tolerate empty terms', ['Fixes the crash'], ['Empty queries would return every document']],
    ],
    threat: {
      doc: (d) => fm(d, 'threat-model', 'Empty-query hotfix', 'draft') + '# Threat model: empty-query hotfix\n\n## Scope and assets\n| Asset | Why it matters | Where it lives |\n|---|---|---|\n| Search availability | availability | src/search.js |\n\n## Data-flow diagram\n```mermaid\nflowchart LR\n  subgraph internet["Trust boundary: internet"]\n    client([Anonymous caller])\n  end\n  subgraph api["Trust boundary: search-api"]\n    search[search handler] -->|terms| index[(index-store)]\n  end\n  client -->|untrusted q| search\n  search -->|400 fixed error or results| client\n```\n\n## Entry points and trust boundaries\n| Entry point | Crosses | Who can reach it | Authn / authz |\n|---|---|---|---|\n| GET /search?q= | internet → api | anyone | API key optional |\n\n## Threats (STRIDE)\n| ID | STRIDE | Threat | Entry point / asset | Likelihood | Impact | Mitigation the design must include |\n|---|---|---|---|---|---|---|\n| TH-1 | Denial of service | Crafted q values still crash the handler | GET /search | medium | high | Validate q before the index; tests for empty and missing |\n| TH-2 | Information disclosure | Error body echoes the query (reflected content) | GET /search | low | low | Fixed error text only |\n\n## Out of scope\n- Rate limiting (J-0001).\n',
      threats: [{ threat: 'Crafted q values still crash the handler (DoS)', mitigation: 'Validate q before the index', severity: 'medium' }, { threat: 'Error body echoes the query', mitigation: 'Fixed error text', severity: 'low' }],
    },
    architect: (d) => {
      const p = path.join(d, 'no-adr.md');
      fs.writeFileSync(p, fm(d, 'no-adr', 'Guard q in the search handler', 'accepted', ['findings.md', 'threat-model.md']) + '# No ADR: Guard q in the search handler\n\n## Why no decision is needed\nOne viable fix: guard q in the handler (option 1). Option 2 is a design change for its own job; option 3 changes results.\n\n## Approach\nIn src/search.js, trim q and answer 400 {"error":"Empty query"} before the index is touched.\n\n## How each acceptance criterion is met\n| AC | How the approach meets it | Proof |\n|---|---|---|\n| AC-1 | empty q answers 400 | test |\n| AC-2 | missing q answers 400 | test |\n| AC-3 | non-empty q takes the old path | test |\n\n## Threat mitigations\n| Threat | Mitigation | Where |\n|---|---|---|\n| TH-1 | q validated before the index | src/search.js |\n| TH-2 | fixed error text, q never echoed | src/search.js |\n\n## Rollback\nRevert the merge commit.\n');
      return { kind: 'no-adr', paths: [p], summary: 'Guard q in the handler; no real decision to record', rejected: [{ option: 'Validate in server.js', reason: 'Too large for a hotfix' }, { option: 'Guard in index-store', reason: 'Empty query would match everything' }] };
    },
    plans: [J8PLAN],
    build: () => ({
      files: {
        'src/search.js': J1FILES.search(true).replace(
          '  const terms = req.query.q.trim().toLowerCase().split(/\\s+/);',
          "  const q = String((req.query && req.query.q) || '').trim();\n  if (!q) return { status: 400, headers: {}, body: { error: 'Empty query' } };\n  const terms = q.toLowerCase().split(/\\s+/);",
        ),
        'tests/search-empty.test.js': "const search = require('../src/search');\nfor (const [i, query] of [{ q: '' }, { q: '   ' }, {}].entries()) {\n  const r = search({ query, headers: {}, ip: `10.1.0.${i}` });\n  if (r.status !== 400 || r.body.error !== 'Empty query') { console.error(query, r); process.exit(1); }\n}\nconsole.log('ok');\n",
      },
      msg: 'T1: 400 for an empty or missing q',
      swept: ['src/routes/v1-search.js'],
    }),
    review: (lane, st) => {
      if (st.mode === 'post_merge' && lane === 'security') return [{ id: 'security-1', severity: 'major', file: 'src/search.js', line: 18, summary: 'q has no length limit: a 1 MB query is split and looked up term by term, pinning a core per request' }];
      if (lane === 'code') return [{ id: 'code-1', severity: 'minor', file: 'src/search.js', line: 17, summary: 'String(...) around q hides an array q from ?q=a&q=b' }];
      return [];
    },
    verify: () => ['confirmed', 'A 1 MB q of single letters took 2.3 s of CPU on one request; 20 in parallel took the instance out of rotation.'],
    lesson: ['Validate and bound every query parameter in the handler before it reaches the index.', 'src/search.js,src/routes/**'],
    humanGate: { H1: [6, 12], H2: [8, 20], H3: [5, 12], HS: [10, 20] },
    mergeWait: [8, 15],
  };
}

// ======================================================================================
(async () => {
  // The repository is older than the history: its first commits are backdated.
  process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = `${Math.floor((DAY0 - 41 * DAY + 15 * H) / 1000)} +0000`;
  root = F.makeRepo();
  for (const [rel, body] of Object.entries(BASE)) F.write(root, rel, body);
  process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = `${Math.floor((DAY0 - 9 * DAY + 11 * H) / 1000)} +0000`;
  F.sh(root, 'git rm -q src/add.js tests/add.test.js && git add -A && git commit -qm "search-api: search, CSV export, legacy v1 route"');
  gitDate();
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({
    agents: {
      models: { architect: 'opus', 'god-eye': 'opus', planner: 'opus', 'threat-modeler': 'opus', 'security-reviewer': 'opus', builder: 'sonnet', 'code-reviewer': 'sonnet', 'test-reviewer': 'sonnet', 'finding-verifier': 'sonnet', tester: 'haiku', researcher: 'haiku', 'intent-analyst': 'haiku', integrator: 'haiku' },
      builder_escalation: ['opus'],
    },
  }, null, 2));
  const newJob = (c) => ok(cli(['job', 'new', '--title', c.title, '--type', c.type, '--risk', c.risk === 'high' && c.type === 'hotfix' ? 'medium' : c.risk]), 'job new').job;
  const draft = (J, c) => {
    wait(between(3, 7) * M); // the main session drafts the contract with you
    writeContract(J, contract(c));
  };

  // ---------------- day 1 ----------------
  at(0, 9, 4);
  const J1 = newJob(C1);
  draft(J1, C1);
  const s1 = sc1(J1);
  await drive(J1, s1, {});
  human(10, 25);
  ok(reply('accept lesson L1'), 'accept lesson');

  at(0, 17, 26);
  const J2 = newJob(C2);
  draft(J2, C2);
  const st2 = {};
  await drive(J2, sc2(), st2); // stops on the clarify question; you answer on day 3

  // ---------------- day 2 ----------------
  at(1, 9, 7);
  const J3 = newJob(C3);
  draft(J3, C3);
  const st3 = {};
  await drive(J3, sc3(), st3, { stopAt: (n) => n.action === 'gate' && n.step === 'H1' }); // H1 waits for you

  at(1, 10, 31);
  const J4 = newJob(C4);
  draft(J4, C4);
  const st4 = {};
  await drive(J4, sc4(), st4, { stopAt: (n) => n.action === 'gate' && n.step === 'H2' });
  human(35, 50);
  ok(cli(['park', '--job', J4, '--reason', 'Waiting on infra: shared cache or in-process?']), 'park');

  at(1, 13, 42);
  const J5 = newJob(C5);
  draft(J5, C5);
  await drive(J5, {}, {}, { stopAt: (n) => n.action === 'gate' && n.step === 'H1' });
  human(30, 45);
  ok(reply('deny J-0005 Not yet: mobile 4.1 still calls /v1/search. Check the access logs first'), 'deny');
  human(35, 55);
  ok(reply('cancel job J-0005 Mobile 4.1 still depends on v1; revisit after the 4.2 rollout'), 'cancel');

  at(1, 15, 18);
  const J6 = newJob(C6);
  draft(J6, C6);
  const n6 = await drive(J6, sc6(), {});
  if (n6.action !== 'parked') throw new Error(`J-0006 should park: ${JSON.stringify(n6)}`);

  // ---------------- day 3 ----------------
  at(2, 8, 54);
  ok(reply('abandon job J-0006 Needs a design first: batching, idempotent retries and locking. Reopen as a spike.'), 'abandon');

  at(2, 9, 6);
  const J7 = newJob(C7);
  draft(J7, C7);
  await drive(J7, sc7(), {});

  at(2, 11, 2);
  ok(reply('resume J-0004'), 'resume');
  use(J4);
  await drive(J4, sc4(), st4, { stopAt: (n) => n.action === 'gate' && n.step === 'H3' });
  human(70, 100); // infra answers: in-process, but it must not outlive an index rebuild
  ok(cli(['amend', 'start', '--job', J4, '--reason', 'Infra confirmed in-process (no shared Redis this quarter), and the cache must be cleared whenever the index is rebuilt']), 'amend start');
  wait(between(4, 8) * M);
  writeContract(J4, contract(C4v2));
  fs.writeFileSync(path.join(F.jobDir(root, J4), 'plan.json'), JSON.stringify(J4PLAN(true), null, 2));
  ok(cli(['plan', 'validate', '--job', J4]), 'plan validate');
  ok(cli(['amend', 'submit', '--job', J4]), 'amend submit');
  await drive(J4, sc4(), st4, { stopAt: (n) => n.action === 'gate' && n.step === 'H3' }); // gate A, approved, then H3 again

  at(2, 13, 48);
  const J8 = newJob(C8);
  draft(J8, C8);
  await drive(J8, sc8(), {});

  at(2, 18, 21);
  use(J2);
  ok(cli(['answer', '--job', J2, '--question', 'Should the file end with a line break after the last row?', '--answer', 'Yes: \\r\\n line endings and one at the end, like the spreadsheet export.']), 'answer');
  wait(between(3, 6) * M);
  writeContract(J2, contract(C2v2));
  await drive(J2, sc2(), st2, { stopAt: (n) => n.action === 'gate' && n.step === 'H1' }); // waits for you at H1

  // ---------------- this morning: you, then the factory, working on J-0003 ----------------
  setClock(Math.max(clock.now() + 10 * M, clock.realNow() - 48 * M));
  const refused = hook('prompt.js', { hook_event_name: 'UserPromptSubmit', session_id: 'sample', cwd: root, prompt: 'approve H3' });
  if (!/NOT applied/.test(refused.stdout)) throw new Error(`reply was not refused: ${refused.stdout}`);
  wait(between(1, 2) * M);
  ok(reply('approve J-0003 H1'), 'approve J-0003 H1');
  use(J3);
  const n3 = await drive(J3, sc3(), st3, { stopAt: (n) => n.action === 'workflow' && n.config === 'challenge' });
  // The review is running now: brief issued, reviewers started, nothing recorded yet.
  const brief = ok(cli(['wfargs', 'fanout-judge', '--config', 'challenge', '--job', J3]), 'wfargs challenge');
  wait(between(10, 30) * S);
  for (const f of brief.fanout) {
    hook('activity.js', { hook_event_name: 'SubagentStart', session_id: 'sample', cwd: root, agent_id: `agent-${String(++aid).padStart(4, '0')}`, agent_type: f.agent_type });
    wait(between(0.5, 1.5) * S);
  }
  void n3;
  wait(between(1, 3) * M);
  use(J2); // the job waiting for you

  // ---------------- the inspector audits everything ----------------
  const ins = spawnSync('node', [INSPECTOR, 'run', '--all', '--root', root], { encoding: 'utf8', env: process.env });
  if (ins.status !== 0) throw new Error(`inspector failed: ${ins.stdout}${ins.stderr}`);
  const reg = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'inspect', 'register.json'), 'utf8'));
  const findings = Array.isArray(reg) ? reg : reg.findings || [];
  const open = findings.filter((f) => !f.status || f.status === 'open');
  const start = new Date(DAY0 + 8 * H + 52 * M);
  console.log(`history: ${start.toISOString()} → ${new Date(clock.now()).toISOString()} (real now ${new clock.RealDate().toISOString()})`);
  console.log(`inspector: ${findings.length} finding(s), ${open.length} open`);
  for (const f of open) console.log(`  ${f.id} [${f.severity || f.level || '?'}] ${f.job || (f.jobs || []).join(',')} ${f.rule || f.check || ''}: ${String(f.summary || f.title || f.message || '').slice(0, 140)}`);
  console.log(root);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
