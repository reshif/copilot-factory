'use strict';
// Tier 0 quality lints: static checks on every PR, no model cost. They guard the seams the
// quality benchmark found drifting (README "Quality and evals"):
//   - skill descriptions are triggers: a "Use when" clause, a length budget, no step
//     sequence, and a "Not for…" clause on every user-invocable skill;
//   - every `factory <cmd> [sub]` / `factory-inspect <cmd>` a skill names exists in that
//     CLI's help;
//   - skill bodies stay lean, and every link a skill makes to a references/ file resolves
//     (one level deep);
//   - no hard-coded counts that drift ("21 agents", "R10–R20") in skills and agents, and no
//     rule ranges in the READMEs.
// Not here, because other tests own them: required schema fields named in each agent's
// final-message section (tests/contracts.test.js), brief tool names vs `tools:`
// (tests/packaging.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN = path.resolve(__dirname, '..');
const REPO = path.resolve(PLUGIN, '..', '..');
const INSPECTOR = path.join(REPO, 'plugins', 'factory-inspector');

// Budgets. Descriptions are always in context, so they are short; the two catalogue-prone
// user skills get a tighter budget (the benchmark found 532/572-character feature lists).
const DESC_MAX = 400;
const DESC_TIGHT = { console: 260, inspect: 260 };
const WHAT_MAX = 200; // the capability clause before "Use when"
const BODY_MAX_LINES = 500;

function readSkill(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, `${file}: frontmatter`);
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    const k = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    fm[k] = raw.startsWith('"') ? JSON.parse(raw) : raw === 'false' ? false : raw === 'true' ? true : raw;
  }
  return { fm, body: m[2] };
}

function skills() {
  const out = [];
  for (const [plugin, dir] of [['factory', PLUGIN], ['factory-inspector', INSPECTOR]]) {
    const root = path.join(dir, 'skills');
    for (const d of fs.readdirSync(root)) {
      const file = path.join(root, d, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const { fm, body } = readSkill(file);
      const refs = path.join(root, d, 'references');
      const refFiles = fs.existsSync(refs) ? fs.readdirSync(refs).filter((f) => f.endsWith('.md')).map((f) => path.join(refs, f)) : [];
      out.push({ plugin, name: d, file, fm, body, dir: path.join(root, d), refFiles });
    }
  }
  return out;
}

// --- descriptions as triggers ----------------------------------------------------------------

// A description that narrates a procedure: several steps chained with "then", arrows, or a
// long comma list of verbs in the capability clause.
function stepSequence(what) {
  if (/\bthen\b|→|->|\bfirst\b.*\bnext\b/i.test(what)) return 'chains steps ("then", arrows)';
  if ((what.replace(/\([^)]*\)/g, '').match(/,/g) || []).length > 3) return 'more than three commas in the capability clause (a list of steps or features)';
  return null;
}

function lintDescription(name, desc, userInvocable) {
  const problems = [];
  const use = /\bUse (?:only )?when\b/.exec(desc);
  if (!use) problems.push('no trigger clause ("Use when …")');
  const max = DESC_TIGHT[name] || DESC_MAX;
  if (desc.length > max) problems.push(`${desc.length} characters (budget ${max})`);
  if (desc.length > 1024) problems.push('over the 1,024-character limit of the Agent Skills spec');
  const what = use ? desc.slice(0, use.index) : desc;
  if (what.length > WHAT_MAX) problems.push(`capability clause is ${what.length} characters (budget ${WHAT_MAX}): triggers first, details in the body`);
  const seq = stepSequence(what);
  if (seq) problems.push(`step sequence: ${seq}`);
  if (userInvocable && !/\bNot for\b/.test(desc)) problems.push('user-invocable skill with no "Not for …" clause for its near-misses');
  if (/\b(I|you|your)\b/.test(what)) problems.push('first or second person in the capability clause');
  return problems;
}

test('lint self-check: the description rules catch the patterns they target', () => {
  assert.ok(lintDescription('x', 'Factory clarify — draft the contract, run the fan-out, ask the user, then loop until God Eye approves. Used by start.', false).length >= 2);
  assert.ok(lintDescription('console', `${'Open the console with a board, a map, a feed, a canvas and a story. '.repeat(5)}Use when asked.`, true).some((p) => /budget 260/.test(p)));
  assert.deepEqual(lintDescription('why', 'Explains a factory job\'s path. Use when the user asks why the factory did something. Not for failing tests.', true), []);
  assert.ok(lintDescription('why', 'Explains a factory job\'s path. Use when the user asks why.', true).some((p) => /Not for/.test(p)));
});

test('skill descriptions are triggers: Use when, within budget, no step sequence, near-misses excluded', () => {
  const problems = [];
  for (const s of skills()) {
    for (const p of lintDescription(s.name, s.fm.description, s.fm['user-invocable'] !== false)) problems.push(`${s.plugin}/${s.name}: ${p}`);
  }
  assert.deepEqual(problems, []);
});

// --- commands named in skills exist ------------------------------------------------------------

function helpText(bin) {
  const r = spawnSync('node', [bin, 'help'], { encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } });
  let t = r.stdout;
  try {
    t = JSON.parse(t); // printed as a JSON string by some builds
  } catch {
    /* plain text */
  }
  return String(t);
}

// `factory <cmd> [sub]` spans in a text, from inline code and code blocks.
function commandsIn(text, exe) {
  const out = [];
  const re = new RegExp(`(?:^|[\`\\s(])${exe.replace('-', '\\-')} ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?`, 'gm');
  for (const span of text.match(/`[^`\n]+`/g) || []) {
    for (const m of span.matchAll(re)) out.push({ cmd: m[1], sub: m[2] || null, span });
  }
  return out;
}

function checkCommands(text, exe, help, where) {
  const problems = [];
  const words = new Set(help.split(/[^a-z-]+/));
  const lines = help.split('\n');
  for (const { cmd, sub, span } of commandsIn(text, exe)) {
    if (!words.has(cmd)) {
      problems.push(`${where}: ${span} — "${cmd}" is not a command in \`${exe} help\``);
      continue;
    }
    if (!sub) continue;
    // A subcommand must appear next to its command, or on a help line that names the command.
    const ok = help.includes(`${cmd} ${sub}`) || lines.some((l) => new RegExp(`\\b${cmd}\\b`).test(l) && new RegExp(`(^|[^a-z-])${sub}([^a-z-]|$)`).test(l));
    if (!ok) problems.push(`${where}: ${span} — "${cmd} ${sub}" is not in \`${exe} help\``);
  }
  return problems;
}

test('every factory / factory-inspect command a skill names exists in that CLI\'s help', () => {
  const fhelp = helpText(path.join(PLUGIN, 'bin', 'factory'));
  const ihelp = helpText(path.join(INSPECTOR, 'bin', 'factory-inspect'));
  assert.match(fhelp, /next/);
  assert.match(ihelp, /report/);
  const problems = [];
  let seen = 0;
  for (const s of skills()) {
    for (const f of [s.file, ...s.refFiles]) {
      const text = fs.readFileSync(f, 'utf8');
      seen += commandsIn(text, 'factory').length;
      problems.push(...checkCommands(text, 'factory', fhelp, path.relative(REPO, f)));
      problems.push(...checkCommands(text, 'factory-inspect', ihelp, path.relative(REPO, f)));
    }
  }
  assert.ok(seen > 20, `found the commands the skills name (${seen})`);
  assert.deepEqual(problems, []);
  // the checker itself catches a made-up command
  assert.equal(checkCommands('Run `factory frobnicate` and `factory job explode`.', 'factory', fhelp, 'x').length, 2);
});

// --- lean bodies, references one level deep ----------------------------------------------------

test('skill bodies stay lean and every references/ link resolves, one level deep', () => {
  const problems = [];
  for (const s of skills()) {
    const lines = s.body.split('\n').length;
    if (lines > BODY_MAX_LINES) problems.push(`${s.name}: body has ${lines} lines (budget ${BODY_MAX_LINES})`);
    for (const f of [s.file, ...s.refFiles]) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\]\(([^)#\s]+\.md)\)/g)) {
        const target = path.resolve(path.dirname(f), m[1]);
        if (!fs.existsSync(target)) problems.push(`${path.relative(REPO, f)}: link ${m[1]} does not resolve`);
        else if (f !== s.file && path.dirname(target) === path.join(s.dir, 'references') && target !== f && /references\//.test(m[1])) problems.push(`${path.relative(REPO, f)}: references nest (${m[1]}); keep them one level deep`);
      }
    }
    for (const r of s.refFiles) {
      const linked = [s.file, ...skills().map((x) => x.file)].some((f) => fs.readFileSync(f, 'utf8').includes(`references/${path.basename(r)}`));
      if (!linked) problems.push(`${path.relative(REPO, r)}: no SKILL.md links it, so it is never loaded`);
      if (!/^Read this (only )?when/m.test(fs.readFileSync(r, 'utf8'))) problems.push(`${path.relative(REPO, r)}: starts without a load condition ("Read this when …")`);
    }
  }
  assert.deepEqual(problems, []);
});

// --- hard-coded counts --------------------------------------------------------------------------

const COUNT = [
  [/\b\d+ (?:custom |factory )?agents\b/i, 'agent count'],
  [/\b\d+ skills\b/i, 'skill count'],
  [/\bR\d+\s*[–-]\s*R\d+\b/, 'rule-id range'],
];

function counts(text) {
  return COUNT.flatMap(([re, what]) => (re.test(text) ? [`${what} "${text.match(re)[0]}"`] : []));
}

test('no hard-coded counts that drift in skills and agents; no rule-id ranges in the READMEs', () => {
  const problems = [];
  const files = [];
  for (const s of skills()) files.push(s.file, ...s.refFiles);
  for (const f of fs.readdirSync(path.join(PLUGIN, 'agents'))) files.push(path.join(PLUGIN, 'agents', f));
  for (const f of files) for (const p of counts(fs.readFileSync(f, 'utf8'))) problems.push(`${path.relative(REPO, f)}: ${p}`);
  for (const f of [path.join(REPO, 'README.md'), path.join(INSPECTOR, 'README.md')]) {
    const m = fs.readFileSync(f, 'utf8').match(/\bR\d+\s*[–-]\s*R\d+\b/g);
    if (m) problems.push(`${path.relative(REPO, f)}: rule-id range ${m.join(', ')} (the rule table is the source)`);
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(counts('the 21 agents and R10–R20'), ['agent count "21 agents"', 'rule-id range "R10–R20"']);
});
