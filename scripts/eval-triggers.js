#!/usr/bin/env node
'use strict';
// Tier 2 eval harness for copilot-factory: does the right skill fire?
//
//   node scripts/eval-triggers.js [--suite triggers|dispatch|all] [--runs 3] [--skills start,why]
//        [--model <id>] [--max-runs 400] [--max-minutes 60] [--threshold 0.9] [--gate]
//        [--out evals/results] [--dry-run] [--json]
//
// triggers  evals/triggers/<skill>.json: should-trigger prompts and near-miss prompts for each
//           user-invocable skill. Each prompt runs N times through `copilot -p` with both
//           plugins loaded (--plugin-dir), so sibling skills compete for it.
// dispatch  evals/dispatch/cases.json: a `factory` stub on PATH prints a canned `factory next`;
//           the prompt continues the job, and the step skill fired after `start` must be the
//           expected one (or none, where start handles the action itself).
//
// What fired is read from the `--output-format json` events: `tool.execution_start` with
// toolName "skill" (arguments.skill) for skills, and toolName "task" for subagents (a factory
// agent started outside `factory run` is a must-not-fire violation). Each run happens in a
// throwaway git repo with writes, URLs and every shell command except the stub denied.
//
// Results: a confusion matrix (expected → first skill fired), per-skill trigger rate on
// should-trigger prompts, false-trigger rate on near-misses, precision and recall, written to
// <out>/<timestamp>.json and .md. Exit 0 when it ran (or was skipped), 1 with --gate when a
// metric is under --threshold or a must-not-fire case fired, 2 on bad usage.
//
// Runs only when the Copilot CLI can answer: signed in (COPILOT_GITHUB_TOKEN / GH_TOKEN or
// a /login), or a BYOK provider (COPILOT_PROVIDER_BASE_URL). Otherwise it prints
// {"skipped": true, …} and exits 0, so CI without a token stays green.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PLUGINS = [path.join(REPO, 'plugins', 'factory'), path.join(REPO, 'plugins', 'factory-inspector')];
const AUTH_TEXT = /No authentication information found|Authentication token found but could not be validated|To authenticate, you can use any of the following methods|not (?:logged|signed) in to (?:GitHub )?Copilot/i;

// ---------------------------------------------------------------- pure parts (tested)

function parseArgs(argv) {
  const o = { suite: 'all', runs: 3, skills: null, model: null, maxRuns: 400, maxMinutes: 60, threshold: 0.9, gate: false, out: path.join(REPO, 'evals', 'results'), dryRun: false, json: false, evals: path.join(REPO, 'evals') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--suite') o.suite = v();
    else if (a === '--runs') o.runs = Number(v());
    else if (a === '--skills') o.skills = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--model') o.model = v();
    else if (a === '--max-runs') o.maxRuns = Number(v());
    else if (a === '--max-minutes') o.maxMinutes = Number(v());
    else if (a === '--threshold') o.threshold = Number(v());
    else if (a === '--gate') o.gate = true;
    else if (a === '--out') o.out = path.resolve(v());
    else if (a === '--evals') o.evals = path.resolve(v());
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else throw Object.assign(new Error(`unknown option ${a}`), { usage: true });
  }
  if (!['triggers', 'dispatch', 'all'].includes(o.suite)) throw Object.assign(new Error(`--suite triggers|dispatch|all (got ${o.suite})`), { usage: true });
  if (!(o.runs >= 1)) throw Object.assign(new Error('--runs must be >= 1'), { usage: true });
  return o;
}

// The cases to run, as [{suite, id, skill, expect, prompt, next?}]. expect is the skill that
// must fire (should-trigger, dispatch) or null (near-miss: `skill` must not fire).
function loadCases(dir, { suite = 'all', skills = null } = {}) {
  const cases = [];
  if (suite !== 'dispatch') {
    const tdir = path.join(dir, 'triggers');
    for (const f of fs.readdirSync(tdir).filter((x) => x.endsWith('.json')).sort()) {
      const t = JSON.parse(fs.readFileSync(path.join(tdir, f), 'utf8'));
      if (skills && !skills.includes(t.skill)) continue;
      t.should_trigger.forEach((p, i) => cases.push({ suite: 'triggers', id: `${t.skill}+${i + 1}`, skill: t.skill, expect: t.skill, prompt: p }));
      t.should_not_trigger.forEach((p, i) => cases.push({ suite: 'triggers', id: `${t.skill}-${i + 1}`, skill: t.skill, expect: null, prompt: p }));
    }
  }
  if (suite !== 'triggers') {
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'dispatch', 'cases.json'), 'utf8'));
    for (const c of d.cases) {
      if (skills && c.expect && !skills.includes(c.expect)) continue;
      cases.push({ suite: 'dispatch', id: `dispatch:${c.id}`, skill: c.expect || 'start', expect: c.expect, prompt: c.prompt || d.prompt, next: c.next });
    }
  }
  return cases;
}

const bare = (name) => String(name || '').replace(/^[a-z-]+:/, '');

// What fired in one `copilot -p --output-format json` run: skills (in order), subagents,
// and whether a tool call was refused.
function firedFrom(jsonl) {
  const skills = [];
  const agents = [];
  let denied = 0;
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const d = e.data || {};
    if (e.type === 'tool.execution_start') {
      const args = typeof d.arguments === 'string' ? safeJson(d.arguments) : d.arguments || {};
      if (d.toolName === 'skill' && args.skill) skills.push(bare(args.skill));
      if (d.toolName === 'task' || d.toolName === 'agent') agents.push(String(args.agent_type || args.agent || args.name || 'unknown'));
    }
    if (e.type === 'subagent.started' && d.agentName) agents.push(String(d.agentName));
    if (e.type === 'tool.execution_complete' && d.success === false && /denied/i.test(JSON.stringify(d.error || ''))) denied += 1;
  }
  return { skills, agents: [...new Set(agents)], denied };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// The skill a case is judged on: for dispatch, the first skill after `start`; otherwise the
// first skill that fired. null when none did.
function judged(c, fired) {
  if (c.suite === 'dispatch') {
    const i = fired.skills.indexOf('start');
    const after = i === -1 ? fired.skills : fired.skills.slice(i + 1);
    return after.find((s) => s !== 'start') || null;
  }
  return fired.skills[0] || null;
}

// One case's verdict from its runs: rate = share of runs where the case's skill fired (for a
// dispatch case, where the expected step skill — or, expecting none, no step skill — fired).
function caseResult(c, runs) {
  const hits = runs.map((r) => {
    const got = judged(c, r);
    if (c.suite === 'dispatch') return c.expect ? got === c.expect : got === null;
    return c.expect ? got === c.skill : got !== c.skill;
  });
  const fireRate = runs.length ? runs.filter((r) => judged(c, r) === (c.expect || c.skill)).length / runs.length : 0;
  const passRate = runs.length ? hits.filter(Boolean).length / runs.length : 0;
  const violations = runs.flatMap((r) => r.agents.filter((a) => /^factory:/.test(a) || /^(builder|code-reviewer|god-eye|judge|tester)$/.test(a)));
  return {
    id: c.id,
    suite: c.suite,
    skill: c.skill,
    expect: c.expect,
    prompt: c.prompt,
    runs: runs.length,
    fired: runs.map((r) => judged(c, r)),
    fire_rate: Math.round(fireRate * 100) / 100,
    pass_rate: Math.round(passRate * 100) / 100,
    pass: runs.length > 0 && passRate >= 0.5 && violations.length === 0,
    pass_all: runs.length > 0 && passRate === 1 && violations.length === 0, // pass^k
    must_not_fire: [...new Set(violations)],
  };
}

// Confusion matrix (expected label → judged label, counted per run) and per-skill metrics.
function summarize(results, threshold = 0.9) {
  const matrix = {};
  const add = (row, col) => {
    matrix[row] = matrix[row] || {};
    matrix[row][col] = (matrix[row][col] || 0) + 1;
  };
  const per = {};
  for (const r of results) {
    const row = r.expect || `none (${r.suite === 'dispatch' ? 'dispatch' : `near-miss ${r.skill}`})`;
    for (const f of r.fired) add(row, f || 'none');
    if (r.suite !== 'triggers') continue;
    const p = (per[r.skill] = per[r.skill] || { tp: 0, fn: 0, fp: 0, tn: 0 });
    for (const f of r.fired) {
      if (r.expect) f === r.skill ? (p.tp += 1) : (p.fn += 1);
      else f === r.skill ? (p.fp += 1) : (p.tn += 1);
    }
  }
  // false positives also come from other suites' prompts firing this skill
  for (const r of results.filter((x) => x.suite === 'triggers')) {
    for (const f of r.fired) if (f && f !== r.skill && per[f] && r.expect !== f) per[f].fp_cross = (per[f].fp_cross || 0) + 1;
  }
  const round = (x) => (x === null ? null : Math.round(x * 100) / 100);
  const skills = {};
  for (const [s, p] of Object.entries(per)) {
    const fp = p.fp + (p.fp_cross || 0);
    skills[s] = {
      ...p,
      recall: round(p.tp + p.fn ? p.tp / (p.tp + p.fn) : null),
      precision: round(p.tp + fp ? p.tp / (p.tp + fp) : null),
      false_trigger_rate: round(p.fp + p.tn ? p.fp / (p.fp + p.tn) : null),
    };
  }
  const dispatch = results.filter((r) => r.suite === 'dispatch');
  const failures = [];
  for (const [s, m] of Object.entries(skills)) {
    if (m.recall !== null && m.recall < threshold) failures.push(`${s}: recall ${m.recall} < ${threshold}`);
    if (m.precision !== null && m.precision < threshold) failures.push(`${s}: precision ${m.precision} < ${threshold}`);
  }
  for (const r of results) if (r.must_not_fire.length) failures.push(`${r.id}: factory agent started outside factory run (${r.must_not_fire.join(', ')})`);
  const dispatchAccuracy = dispatch.length ? round(dispatch.filter((r) => r.pass).length / dispatch.length) : null;
  if (dispatchAccuracy !== null && dispatchAccuracy < threshold) failures.push(`dispatch accuracy ${dispatchAccuracy} < ${threshold}`);
  return { matrix, skills, dispatch_accuracy: dispatchAccuracy, cases: results.length, cases_passed: results.filter((r) => r.pass).length, failures, ok: failures.length === 0 };
}

function toMarkdown(report) {
  const s = report.summary;
  const L = [`# Trigger evals — ${report.started_at}`, '', `Model: ${report.model || 'default'} · runs per case: ${report.runs} · copilot runs: ${report.copilot_runs}${report.stopped ? ` · stopped early: ${report.stopped}` : ''}`, ''];
  L.push('| Skill | Recall | Precision | False-trigger rate | TP | FN | FP | TN |', '|---|---|---|---|---|---|---|---|');
  for (const [k, m] of Object.entries(s.skills)) L.push(`| ${k} | ${m.recall ?? '—'} | ${m.precision ?? '—'} | ${m.false_trigger_rate ?? '—'} | ${m.tp} | ${m.fn} | ${m.fp + (m.fp_cross || 0)} | ${m.tn} |`);
  if (s.dispatch_accuracy !== null) L.push('', `Dispatch accuracy: ${s.dispatch_accuracy}`);
  const cols = [...new Set(Object.values(s.matrix).flatMap((r) => Object.keys(r)))].sort();
  L.push('', '## Confusion matrix (expected → fired, per run)', '', `| expected \\ fired | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`);
  for (const [row, r] of Object.entries(s.matrix)) L.push(`| ${row} | ${cols.map((c) => r[c] || 0).join(' | ')} |`);
  const bad = report.results.filter((r) => !r.pass);
  if (bad.length) {
    L.push('', '## Failing cases', '');
    for (const r of bad) L.push(`- ${r.id} (${r.pass_rate}): "${r.prompt}" → ${r.fired.map((f) => f || 'none').join(', ')}${r.must_not_fire.length ? ` · agents: ${r.must_not_fire.join(', ')}` : ''}`);
  }
  L.push('', s.ok ? 'All thresholds met.' : `Below threshold:\n${s.failures.map((f) => `- ${f}`).join('\n')}`);
  return L.join('\n');
}

// ---------------------------------------------------------------- running copilot

function copilotBin() {
  return process.env.COPILOT_BIN || 'copilot';
}

function spawnArgs(bin, args) {
  return /\.[cm]?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

// Can Copilot answer at all? BYOK counts; otherwise one tiny prompt.
function available() {
  const bin = copilotBin();
  const [file, args] = spawnArgs(bin, ['-p', 'Reply with the word OK.', '-s', '--no-ask-user', '--output-format', 'json', '--deny-tool=shell,write,url']);
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: 120000, cwd: os.tmpdir() });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.error) return { ok: false, why: `copilot not runnable (${r.error.code || r.error.message})` };
  if (AUTH_TEXT.test(text)) return { ok: false, why: 'Copilot CLI not signed in (set COPILOT_GITHUB_TOKEN or run copilot /login)' };
  if (r.status !== 0) return { ok: false, why: `copilot exited ${r.status}: ${text.trim().split('\n').pop().slice(0, 200)}` };
  return { ok: true };
}

// A throwaway workspace; for a dispatch case also a `factory` stub that prints its `next`.
function workspace(c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-eval-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# eval workspace\n');
  let bin = null;
  if (c.next) {
    bin = path.join(dir, '.eval-bin');
    fs.mkdirSync(bin);
    const stub = `#!/usr/bin/env node
const a = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const next = ${JSON.stringify(c.next)};
const out = a[0] === 'next' ? next : a[0] === 'doctor' ? { ready: true, checks: [{ name: 'initialized', ok: true, level: 'ok' }] } : a[0] === 'why' ? '| decision | rule |\\n|---|---|\\n| D1 | order.next_step |' : { job: next.job, ok: true };
process.stdout.write((typeof out === 'string' ? out : JSON.stringify(out, null, 2)) + '\\n');
`;
    fs.writeFileSync(path.join(bin, 'factory'), stub, { mode: 0o755 });
  }
  return { dir, bin };
}

function runOnce(c, o) {
  const ws = workspace(c);
  const args = ['-p', c.prompt, '--output-format', 'json', '-s', '--no-ask-user', ...PLUGINS.flatMap((p) => ['--plugin-dir', p]), '--add-dir', ws.dir, '--deny-tool=write,url,memory', ...(c.next ? ['--allow-tool=shell(factory:*)', '--allow-tool=shell(factory)'] : ['--deny-tool=shell']), ...(o.model ? ['--model', o.model] : [])];
  const env = { ...process.env, ...(ws.bin ? { PATH: `${ws.bin}${path.delimiter}${process.env.PATH}` } : {}) };
  const [file, argv] = spawnArgs(copilotBin(), args);
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(file, argv, { cwd: ws.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
    child.stdout.on('data', (d) => (out += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(ws.dir, { recursive: true, force: true });
      resolve({ code, ...firedFrom(out) });
    });
    child.on('error', () => resolve({ code: -1, skills: [], agents: [], denied: 0 }));
  });
}

async function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
  const cases = loadCases(o.evals, o);
  if (o.dryRun) {
    process.stdout.write(JSON.stringify({ dry_run: true, cases: cases.length, copilot_runs: Math.min(cases.length * o.runs, o.maxRuns), by_suite: cases.reduce((m, c) => ({ ...m, [c.suite]: (m[c.suite] || 0) + 1 }), {}) }, null, 2) + '\n');
    return 0;
  }
  const av = available();
  if (!av.ok) {
    process.stdout.write(JSON.stringify({ skipped: true, reason: av.why }) + '\n');
    return 0;
  }
  const started = Date.now();
  const report = { started_at: new Date().toISOString(), model: o.model, runs: o.runs, copilot_runs: 0, stopped: null, results: [] };
  for (const c of cases) {
    const runs = [];
    for (let i = 0; i < o.runs; i++) {
      if (report.copilot_runs >= o.maxRuns) report.stopped = report.stopped || `--max-runs ${o.maxRuns}`;
      if ((Date.now() - started) / 60000 >= o.maxMinutes) report.stopped = report.stopped || `--max-minutes ${o.maxMinutes}`;
      if (report.stopped) break;
      report.copilot_runs += 1;
      runs.push(await runOnce(c, o));
    }
    if (runs.length) report.results.push(caseResult(c, runs));
    if (!o.json) process.stderr.write(`[eval] ${c.id}: ${runs.map((r) => judged(c, r) || 'none').join(', ')}\n`);
    if (report.stopped) break;
  }
  report.summary = summarize(report.results, o.threshold);
  fs.mkdirSync(o.out, { recursive: true });
  const base = path.join(o.out, `triggers-${report.started_at.replace(/[:.]/g, '-')}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  fs.writeFileSync(`${base}.md`, toMarkdown(report));
  process.stdout.write(o.json ? JSON.stringify(report, null, 2) + '\n' : `${toMarkdown(report)}\n\nWritten: ${base}.json, ${base}.md\n`);
  return o.gate && !report.summary.ok ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));

module.exports = { parseArgs, loadCases, firedFrom, judged, caseResult, summarize, toMarkdown, available, main };
