'use strict';
// The project brief (.factory/project.md, P4.3): what every job should know about this repository
// before it starts: conventions, a module map, the test and lint commands, the build environment,
// what ground found, and an index of earlier jobs' ADRs and accepted lessons. Shared memory
// across jobs: every agent brief carries it (trimmed), and the user may edit it.
//
//   created   at the first job (factory job new), from detection: git ls-files, the manifests'
//             scripts, the policy's checks, the build environment;
//   ground    the first ground step's codebase claims fill "What ground found";
//   distill   the lesson-writer may propose edits (a diff: lines to add and remove per section)
//             and the CLI applies them (applyEdits), logged as project_brief_updated; distill
//             done refreshes the ADR and lesson indexes.
//
// Lines between <!-- factory:auto NAME --> and <!-- /factory:auto --> are the CLI's: refreshed
// from the repo and .factory/ each time. Everything else is the user's (and distill's, through
// the CLI): never rewritten. Delete a block's markers to keep the CLI out of it.

const fs = require('fs');
const path = require('path');
const { readJson, writeText, exists, nowIso } = require('../lib/util');
const { project, jobPaths } = require('../lib/paths');

const SECTIONS = ['Conventions', 'Module map', 'Test and lint commands', 'Environment', 'What ground found', 'Earlier decisions (ADRs)', 'Accepted lessons', 'Notes'];
// the sections distill may edit (outside the auto blocks)
const EDITABLE = ['Conventions', 'Module map', 'Test and lint commands', 'Environment', 'Notes'];
const BRIEF_CHARS = 3000;

const file = (root) => path.join(project(root).dir, 'project.md');
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

function read(root) {
  try {
    return fs.readFileSync(file(root), 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- detection

function modules(root) {
  let files = [];
  try {
    files = require('../lib/git').out(root, ['ls-files']).split('\n').filter(Boolean);
  } catch {
    files = [];
  }
  const top = {};
  for (const f of files) {
    const parts = f.split('/');
    const k = parts.length > 1 ? `${parts[0]}/` : '(root files)';
    const t = (top[k] = top[k] || { n: 0, sub: {} });
    t.n += 1;
    if (parts.length > 2) t.sub[`${parts[1]}/`] = (t.sub[`${parts[1]}/`] || 0) + 1;
  }
  const rows = Object.entries(top).sort((a, b) => b[1].n - a[1].n).slice(0, 15);
  if (!rows.length) return ['- (no tracked files yet)'];
  return rows.map(([k, t]) => {
    const subs = Object.entries(t.sub).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, n]) => `${s} ${n}`);
    return `- \`${k}\` ${t.n} file(s)${subs.length ? `: ${subs.join(', ')}` : ''}`;
  });
}

function commands(root, policy) {
  const out = [];
  const pkg = readJson(path.join(root, 'package.json'), null);
  if (pkg && pkg.scripts) {
    for (const [k, v] of Object.entries(pkg.scripts)) {
      if (/^(test|lint|build|typecheck|check|format)(:|$)/.test(k)) out.push(`- \`${k === 'test' ? 'npm test' : `npm run ${k}`}\` (package.json: \`${String(v).slice(0, 80)}\`)`);
    }
  }
  let py = null;
  try {
    py = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8');
  } catch {
    py = null;
  }
  if (py && /\[tool\.pytest/.test(py)) out.push('- `python -m pytest` (pyproject.toml: [tool.pytest])');
  if (py && /\[tool\.ruff/.test(py)) out.push('- `ruff check .` (pyproject.toml: [tool.ruff])');
  let mk = null;
  try {
    mk = fs.readFileSync(path.join(root, 'Makefile'), 'utf8');
  } catch {
    mk = null;
  }
  for (const t of ['test', 'lint', 'check']) if (mk && new RegExp(`^${t}:`, 'm').test(mk)) out.push(`- \`make ${t}\` (Makefile)`);
  for (const c of (policy && policy.checks) || []) if (c && c.cmd) out.push(`- \`${c.cmd}\` (policy check, run on every integrated build)`);
  return out.length ? out : ['- (none detected: add the commands that test and lint this project)'];
}

function environment(root) {
  const env = require('./environment');
  let e = null;
  try {
    e = env.loadSafe(root);
  } catch {
    e = null;
  }
  const conf = e && !e.error && e.env !== undefined ? e.env : null;
  if (conf && conf.name) return [`- \`${conf.name}\` (confirmed in .factory/environment.json)${conf.notes ? `: ${String(conf.notes).slice(0, 300)}` : ''}`];
  try {
    const d = env.detect(root);
    return [`- \`${d.name}\` (detected from ${(d.evidence || []).join(', ') || 'the repo files'}, not confirmed: \`factory env show\`)${d.notes ? `: ${String(d.notes).slice(0, 300)}` : ''}`];
  } catch {
    return ['- (unknown)'];
  }
}

// Earlier jobs' design records: .factory/jobs/<J>/adr-*.md, with the ADR's title line.
function adrs(root) {
  const out = [];
  let ids = [];
  try {
    ids = fs.readdirSync(project(root).jobsDir).filter((d) => /^J-\d+$/.test(d)).sort();
  } catch {
    ids = [];
  }
  for (const id of ids) {
    const dir = jobPaths(root, id).dir;
    let title = '';
    try {
      title = (readJson(path.join(dir, 'state.json'), {}) || {}).title || '';
    } catch {
      title = '';
    }
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^adr-\d+.*\.md$/.test(f)).sort();
    } catch {
      files = [];
    }
    for (const f of files) {
      let head = '';
      try {
        head = (fs.readFileSync(path.join(dir, f), 'utf8').split('\n').find((l) => /^#\s/.test(l)) || '').replace(/^#\s+/, '');
      } catch {
        head = '';
      }
      out.push(`- ${id}${title ? ` (${String(title).slice(0, 80)})` : ''}: \`.factory/jobs/${id}/${f}\`${head ? ` — ${head.slice(0, 120)}` : ''}`);
    }
  }
  return out.length ? out : ['- (none yet)'];
}

function lessons(root) {
  let ls = [];
  try {
    ls = require('./lessons').load(root).lessons.filter((l) => l.status === 'accepted' || l.status === 'promoted');
  } catch {
    ls = [];
  }
  return ls.length ? ls.map((l) => `- ${l.id} (${(l.scope || []).join(', ')}): ${String(l.text).slice(0, 240)}${l.check ? ` — check: \`${l.check}\`` : ''}`) : ['- (none accepted yet)'];
}

// ---------------------------------------------------------------- the file

const AUTO = (name, lines) => [`<!-- factory:auto ${name} -->`, ...lines, '<!-- /factory:auto -->'];
const GROUND_EMPTY = '- (filled by the first job\'s ground step)';

function initial(root, policy) {
  return [
    '# Project brief',
    '',
    '<!-- factory project brief: yours to edit. Every factory agent reads it (trimmed) in its brief. Lines between factory:auto markers are refreshed by the CLI from the repo and .factory/; the rest is yours, and distill may add or remove lines in Conventions, Module map, Test and lint commands, Environment and Notes (each change is logged). -->',
    '',
    '## Conventions',
    '- (none recorded yet: distill proposes them from what jobs teach; add your own)',
    '',
    '## Module map',
    ...AUTO('modules', modules(root)),
    '',
    '## Test and lint commands',
    ...AUTO('commands', commands(root, policy)),
    '',
    '## Environment',
    ...AUTO('environment', environment(root)),
    '',
    '## What ground found',
    ...AUTO('ground', [GROUND_EMPTY]),
    '',
    '## Earlier decisions (ADRs)',
    ...AUTO('adrs', adrs(root)),
    '',
    '## Accepted lessons',
    ...AUTO('lessons', lessons(root)),
    '',
    '## Notes',
    '',
  ].join('\n');
}

// Replace the lines of one auto block; a block whose markers are gone is left alone.
function setBlock(text, name, lines) {
  const re = new RegExp(`(<!-- factory:auto ${name} -->\\n)([\\s\\S]*?)(<!-- /factory:auto -->)`);
  return re.test(text) ? text.replace(re, (_, a, _b, c) => `${a}${lines.join('\n')}\n${c}`) : text;
}
const block = (text, name) => {
  const m = new RegExp(`<!-- factory:auto ${name} -->\\n([\\s\\S]*?)<!-- /factory:auto -->`).exec(text || '');
  return m ? m[1] : null;
};

// The CLI's own refreshes are not logged (they only restate the repo); distill's edits are.
function write(root, text) {
  writeText(file(root), text.endsWith('\n') ? text : `${text}\n`);
}

// Created once (the first job), from detection. Returns { file, created }.
function ensure(root, policy) {
  if (exists(file(root))) return { file: file(root), created: false };
  write(root, initial(root, policy || require('./policy').load(root)));
  return { file: file(root), created: true };
}

// The CLI's blocks, from the repo and .factory/ as they are now.
function refresh(root, policy) {
  ensure(root, policy);
  const before = read(root) || '';
  let t = before;
  t = setBlock(t, 'modules', modules(root));
  t = setBlock(t, 'commands', commands(root, policy || require('./policy').load(root)));
  t = setBlock(t, 'environment', environment(root));
  t = setBlock(t, 'adrs', adrs(root));
  t = setBlock(t, 'lessons', lessons(root));
  if (t !== before) write(root, t);
  return { file: file(root), changed: t !== before };
}

// The first ground step's codebase findings (cited claims) fill "What ground found" once.
function noteGround(root, state, topics) {
  try {
    ensure(root, state.policy);
    const t = read(root) || '';
    const cur = block(t, 'ground');
    if (cur === null || cur.trim() !== GROUND_EMPTY) return false;
    const claims = (topics || []).filter((x) => ['codebase', 'interfaces'].includes(x.topic)).flatMap((x) => (x.claims || []).filter((c) => c.source && c.source !== 'UNVERIFIED').map((c) => `- ${String(c.claim).slice(0, 200)} (\`${String(c.source).slice(0, 120)}\`)`)).slice(0, 12);
    if (!claims.length) return false;
    write(root, setBlock(t, 'ground', [`- From ${state.id}'s ground step (${nowIso().slice(0, 10)}):`, ...claims]));
    return true;
  } catch {
    return false; // the brief is a convenience: never fail a record over it
  }
}

// Distill's proposed diff: [{ section, add: [line…], remove: [line…] }]. Applied by the CLI to
// the editable sections, outside the auto blocks; an unknown section or a line that is not there
// is refused, never guessed. Returns { applied, refused }.
function applyEdits(root, edits, { job } = {}) {
  const out = { applied: [], refused: [] };
  if (!Array.isArray(edits) || !edits.length) return out;
  ensure(root);
  let lines = (read(root) || '').split('\n');
  const bounds = (name) => {
    const i = lines.findIndex((l) => l.trim() === `## ${name}`);
    if (i < 0) return null;
    let j = lines.findIndex((l, k) => k > i && /^## /.test(l));
    if (j < 0) j = lines.length;
    return [i, j];
  };
  // the CLI's lines (an auto block, its markers included)
  const inAuto = (i) => {
    let auto = false;
    for (let k = 0; k <= i; k++) {
      if (/^<!-- factory:auto /.test(lines[k])) auto = true;
      if (k === i) return auto;
      if (/^<!-- \/factory:auto -->/.test(lines[k])) auto = false;
    }
    return auto;
  };
  const clean = (s) => String(s || '').replace(/\r?\n/g, ' ').trim().slice(0, 400);
  for (const e of edits.slice(0, 20)) {
    const section = String((e && e.section) || '');
    if (!EDITABLE.includes(section)) {
      out.refused.push({ section, why: `not an editable section (${EDITABLE.join(', ')})` });
      continue;
    }
    if (!bounds(section)) lines.push('', `## ${section}`);
    for (const r of (Array.isArray(e.remove) ? e.remove : []).map(clean).filter(Boolean)) {
      const [i, j] = bounds(section);
      const k = lines.findIndex((l, n) => n > i && n < j && l.trim() === r && !inAuto(n));
      if (k < 0) out.refused.push({ section, remove: r, why: 'no such line outside the CLI\'s blocks' });
      else {
        lines.splice(k, 1);
        out.applied.push({ section, remove: r });
      }
    }
    for (const a0 of (Array.isArray(e.add) ? e.add : []).map(clean).filter(Boolean)) {
      const a = /^[-*] /.test(a0) ? a0 : `- ${a0}`;
      const [i, j] = bounds(section);
      if (lines.slice(i + 1, j).some((l) => l.trim() === a)) continue;
      let at = j;
      while (at > i + 1 && !lines[at - 1].trim()) at -= 1; // before the blank lines that end the section
      lines.splice(at, 0, a);
      out.applied.push({ section, add: a });
    }
  }
  if (out.applied.length) {
    // the Conventions placeholder goes once a convention is added
    if (out.applied.some((x) => x.section === 'Conventions' && x.add)) lines = lines.filter((l) => !l.startsWith('- (none recorded yet: distill proposes them'));
    writeText(file(root), lines.join('\n'));
    try {
      require('./events').append(root, { event: 'project_brief_updated', job: job || null, applied: out.applied.slice(0, 20), refused: out.refused.slice(0, 20) });
    } catch {
      /* logged best-effort */
    }
  }
  return out;
}

// What an agent brief carries: the brief without comments, trimmed, with where the rest is.
function forBrief(root, max = BRIEF_CHARS) {
  const t = read(root);
  if (!t) return null;
  const body = t.replace(/<!--[\s\S]*?-->\n?/g, '').replace(/\n{3,}/g, '\n\n').replace(/^# Project brief\s*\n/, '').trim();
  if (!body) return null;
  return body.length > max ? `${body.slice(0, max).replace(/\n[^\n]*$/, '')}\n… (trimmed; the full brief: ${rel(root, file(root))})` : body;
}

module.exports = { file, read, ensure, refresh, noteGround, applyEdits, forBrief, SECTIONS, EDITABLE, BRIEF_CHARS };
