'use strict';
// The project brief (.factory/project.md, P4.3): what every job should know about this repository
// before it starts: conventions, a module map, the test and lint commands, the build environment,
// what ground found, and an index of earlier jobs' ADRs and accepted lessons. Shared memory
// across jobs: every agent brief carries it (trimmed), and the user may edit it.
//
//   created   at the first job (factory job new), from detection: git ls-files, the manifests'
//             scripts, the policy's checks, the build environment;
//   ground    the first ground step's codebase claims fill "What ground found";
//   ground    each job's ground step replaces "What ground found" with its own cited claims;
//   distill   the lesson-writer may propose edits (a diff: lines to add, and lines an earlier
//             accepted proposal added to remove). They are stored as a proposal (P<n>, in
//             .factory/project-brief.proposals.json) and applied only on the user's reply
//             ("accept brief P1", or `factory lessons accept P1` from their terminal), like a
//             lesson; distill never removes a line the user wrote. distill done refreshes the
//             ADR and lesson indexes.
//
// Lines between <!-- factory:auto NAME --> and <!-- /factory:auto --> are the CLI's: refreshed
// from the repo and .factory/ each time. Everything else is the user's (and distill's, through
// the CLI): never rewritten. Delete a block's markers to keep the CLI out of it.

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, writeText, exists, nowIso, fail } = require('../lib/util');
const { project, jobPaths } = require('../lib/paths');

const SECTIONS = ['Conventions', 'Module map', 'Test and lint commands', 'Environment', 'What ground found', 'Earlier decisions (ADRs)', 'Accepted lessons', 'Notes'];
// the sections distill may edit (outside the auto blocks)
const EDITABLE = ['Conventions', 'Module map', 'Test and lint commands', 'Environment', 'Notes'];
const BRIEF_CHARS = 3000;
// What a brief keeps of each section (characters), most important first; the module map and what
// ground found give way first.
const BUDGET = { Conventions: 800, 'Earlier decisions (ADRs)': 500, 'Accepted lessons': 600, Notes: 500, 'Test and lint commands': 400, Environment: 300, 'Module map': 300, 'What ground found': 300 };
const MAX_ADDS = 10; // lines one proposal may add
const MAX_SECTION_LINES = 40; // distill never grows a section past this
const proposalsFile = (root) => path.join(project(root).dir, 'project-brief.proposals.json');

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
// The markers count only as whole lines, so a line that merely contains one can't move a block.
function setBlock(text, name, lines) {
  const re = new RegExp(`(^<!-- factory:auto ${name} -->\\n)([\\s\\S]*?)(^<!-- /factory:auto -->$)`, 'm');
  return re.test(text) ? text.replace(re, (_, a, _b, c) => `${a}${lines.join('\n')}\n${c}`) : text;
}
const block = (text, name) => {
  const m = new RegExp(`^<!-- factory:auto ${name} -->\\n([\\s\\S]*?)^<!-- /factory:auto -->$`, 'm').exec(text || '');
  return m ? m[1] : null;
};
// One line of brief text from anything an agent or the repo wrote: no newlines, no markers, no headings.
const oneLine = (v, n = 300) => String(v || '').replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').replace(/^#+\s*/, '').trim().slice(0, n);

// read-modify-write under a short lock, written whole (temp file, then rename)
function update(root, fn) {
  const f = file(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  return require('./job').withLock(`${f}.lock`, () => {
    const before = read(root);
    const after = fn(before);
    if (typeof after === 'string' && after !== before) {
      const tmp = `${f}.${process.pid}.tmp`;
      writeText(tmp, after.endsWith('\n') ? after : `${after}\n`);
      fs.renameSync(tmp, f);
    }
    return after;
  }, { waitMs: 10000, staleMs: 30000, what: 'the project brief' });
}


// Created once (the first job), from detection. Returns { file, created }.
function ensure(root, policy) {
  if (exists(file(root))) return { file: file(root), created: false };
  update(root, (t) => t || initial(root, policy || require('./policy').load(root)));
  return { file: file(root), created: true };
}

// The CLI's blocks, from the repo and .factory/ as they are now.
function refresh(root, policy) {
  ensure(root, policy);
  const blocks = { modules: modules(root), commands: commands(root, policy || require('./policy').load(root)), environment: environment(root), adrs: adrs(root), lessons: lessons(root) };
  let changed = false;
  update(root, (before) => {
    let t = before || '';
    for (const [k, v] of Object.entries(blocks)) t = setBlock(t, k, v.map((l) => l.replace(/<!--|-->/g, ' ')));
    changed = t !== before;
    return t;
  });
  return { file: file(root), changed };
}

// Each job's ground step replaces "What ground found" with its own codebase findings (cited
// claims, one line each): the latest job's view of the code, never a stale one.
function noteGround(root, state, topics) {
  try {
    ensure(root, state.policy);
    const claims = (topics || []).filter((x) => ['codebase', 'interfaces'].includes(x.topic)).flatMap((x) => (x.claims || []).filter((c) => c.source && c.source !== 'UNVERIFIED').map((c) => `- ${oneLine(c.claim, 200)} (\`${oneLine(c.source, 120).replace(/`/g, "'")}\`)`)).slice(0, 8);
    if (!claims.length) return false;
    let done = false;
    update(root, (t) => {
      if (block(t || '', 'ground') === null) return t; // its markers were removed: the user's now
      done = true;
      return setBlock(t, 'ground', [`- From ${state.id}'s ground step (${nowIso().slice(0, 10)}):`, ...claims]);
    });
    return done;
  } catch {
    return false; // the brief is a convenience: never fail a record over it
  }
}

// Distill's proposed diff: [{ section, add: [line…], remove: [line…] }], checked and stored as a
// proposal for the user, never applied here. Only the editable sections; added lines are one line
// each (no markers, no headings), at most MAX_ADDS per proposal; a removal must be a line an
// earlier accepted proposal added (distill never removes the user's lines). Returns
// { id, edits, refused }; id is null when nothing was left to propose.
function loadProposals(root) {
  const d = readJson(proposalsFile(root), null) || {};
  return { version: 1, proposals: Array.isArray(d.proposals) ? d.proposals : [], added: Array.isArray(d.added) ? d.added : [] };
}

function propose(root, edits, { job, why } = {}) {
  const out = { id: null, edits: [], refused: [] };
  if (!Array.isArray(edits) || !edits.length) return out;
  const doc = loadProposals(root);
  let adds = 0;
  for (const e of edits.slice(0, 20)) {
    const section = String((e && e.section) || '');
    if (!EDITABLE.includes(section)) {
      out.refused.push({ section, why: `not an editable section (${EDITABLE.join(', ')})` });
      continue;
    }
    const add = [];
    for (const raw of Array.isArray(e.add) ? e.add : []) {
      const a0 = String(raw || '');
      if (/[\r\n]/.test(a0.trim()) || /<!--|-->/.test(a0) || /^\s*#/.test(a0)) {
        out.refused.push({ section, add: oneLine(a0, 120), why: 'one plain line only: no newlines, markers or headings' });
        continue;
      }
      const l = oneLine(a0);
      if (!l) continue;
      if (adds >= MAX_ADDS) {
        out.refused.push({ section, add: l.slice(0, 120), why: `at most ${MAX_ADDS} added lines per distill` });
        continue;
      }
      adds += 1;
      add.push(/^[-*] /.test(l) ? l : `- ${l}`);
    }
    const remove = [];
    for (const raw of Array.isArray(e.remove) ? e.remove : []) {
      const r = oneLine(raw);
      if (!r) continue;
      if (!doc.added.some((x) => x.section === section && x.line === r)) out.refused.push({ section, remove: r.slice(0, 120), why: 'distill removes only lines an accepted proposal added, never yours' });
      else remove.push(r);
    }
    if (add.length || remove.length) out.edits.push({ section, ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) });
  }
  if (!out.edits.length) return out;
  out.id = `P${doc.proposals.length + 1}`;
  doc.proposals.push({ id: out.id, status: 'proposed', job: job || null, edits: out.edits, why: oneLine(why, 300) || null, created_at: nowIso() });
  writeJson(proposalsFile(root), doc);
  try {
    require('./events').append(root, { event: 'project_brief_proposed', job: job || null, proposal: out.id, edits: out.edits.length, refused: out.refused.length });
  } catch {
    /* logged best-effort */
  }
  return out;
}

function proposals(root, { status = null } = {}) {
  return loadProposals(root).proposals.filter((p) => !status || p.status === status);
}

// The user's reply: apply an accepted proposal (human-only, like accepting a lesson), or reject it.
function decide(root, { id, accept, reason, channel }) {
  const human = require('./human');
  human.requireHumanChannel(channel);
  const doc = loadProposals(root);
  const p = doc.proposals.find((x) => x.id === String(id || '').toUpperCase());
  if (!p) fail(`Project brief proposal ${id} not found`, 'bad_input');
  if (p.status !== 'proposed') fail(`Project brief proposal ${p.id} is already ${p.status}`, 'bad_input');
  human.confirmTyped(channel, p.id, `${accept ? 'accept' : 'reject'} it`);
  let applied = [];
  if (accept) {
    ensure(root);
    update(root, (t) => {
      const r = applyTo(t || '', p.edits, doc.added);
      applied = r.applied;
      return r.text;
    });
    for (const x of applied) {
      if (x.add) doc.added.push({ section: x.section, line: x.add, from: p.id });
      if (x.remove) doc.added = doc.added.filter((y) => !(y.section === x.section && y.line === x.remove));
    }
  }
  p.status = accept ? 'accepted' : 'rejected';
  p.decided_at = nowIso();
  p.reason = reason || '';
  writeJson(proposalsFile(root), doc);
  try {
    require('./events').append(root, { event: 'project_brief_updated', job: p.job, proposal: p.id, status: p.status, applied: applied.slice(0, 20) });
  } catch {
    /* logged best-effort */
  }
  return { proposal: p, applied, message: `Project brief proposal ${p.id} ${p.status}.${accept ? ` ${applied.length} line change(s) in ${rel(root, file(root))}; every later agent brief carries them.` : ''}` };
}

// Apply edits to the brief's text: editable sections only, outside the CLI's blocks, removals only
// of lines distill added (`added`), each section capped at MAX_SECTION_LINES.
function applyTo(text, edits, added) {
  let lines = text.split('\n');
  const applied = [];
  const bounds = (name) => {
    const i = lines.findIndex((l) => l.trim() === `## ${name}`);
    if (i < 0) return null;
    let j = lines.findIndex((l, k) => k > i && /^## /.test(l));
    if (j < 0) j = lines.length;
    return [i, j];
  };
  const inAuto = (i) => {
    let auto = false;
    for (let k = 0; k <= i; k++) {
      if (/^<!-- factory:auto [\w-]+ -->$/.test(lines[k])) auto = true;
      if (k === i) return auto;
      if (/^<!-- \/factory:auto -->$/.test(lines[k])) auto = false;
    }
    return auto;
  };
  for (const e of edits) {
    if (!EDITABLE.includes(e.section)) continue;
    if (!bounds(e.section)) lines.push('', `## ${e.section}`);
    for (const r of e.remove || []) {
      if (!added.some((x) => x.section === e.section && x.line === r)) continue;
      const [i, j] = bounds(e.section);
      const k = lines.findIndex((l, n) => n > i && n < j && l.trim() === r && !inAuto(n));
      if (k >= 0) {
        lines.splice(k, 1);
        applied.push({ section: e.section, remove: r });
      }
    }
    for (const a of e.add || []) {
      const [i, j] = bounds(e.section);
      if (lines.slice(i + 1, j).some((l) => l.trim() === a)) continue;
      if (lines.slice(i + 1, j).filter((l) => /^[-*] /.test(l)).length >= MAX_SECTION_LINES) continue;
      let at = j;
      while (at > i + 1 && !lines[at - 1].trim()) at -= 1;
      lines.splice(at, 0, a);
      applied.push({ section: e.section, add: a });
    }
  }
  if (applied.some((x) => x.section === 'Conventions' && x.add)) lines = lines.filter((l) => !l.startsWith('- (none recorded yet: distill proposes them'));
  return { text: lines.join('\n'), applied };
}

// What an agent brief carries: each section within its budget (BUDGET), most important first,
// without comments, and where the full brief is. A section over its budget keeps its first lines
// and says how many it left out. The brief is data about the project, not instructions: the
// factory's rules and the agent's role win (wfargs frames it so).
function forBrief(root, max = BRIEF_CHARS) {
  const t = read(root);
  if (!t) return null;
  const body = t.replace(/<!--[\s\S]*?-->\n?/g, '').replace(/^# Project brief\s*\n/, '');
  const parts = body.split(/^## /m).slice(1).map((chunk) => {
    const nl = chunk.indexOf('\n');
    return { name: (nl < 0 ? chunk : chunk.slice(0, nl)).trim(), lines: (nl < 0 ? '' : chunk.slice(nl + 1)).split('\n').filter((l) => l.trim()) };
  }).filter((p) => p.lines.length);
  if (!parts.length) return null;
  const total = Object.values(BUDGET).reduce((a, b) => a + b, 0);
  const scale = Math.min(1, max / total);
  let trimmed = false;
  const out = parts.map((p) => {
    const cap = Math.max(80, Math.round((BUDGET[p.name] || 300) * scale));
    const kept = [];
    let n = 0;
    for (const l of p.lines) {
      if (n + l.length + 1 > cap && kept.length) break;
      kept.push(l.length > cap ? `${l.slice(0, cap - 1)}…` : l);
      n += l.length + 1;
    }
    if (kept.length < p.lines.length) {
      trimmed = true;
      kept.push(`- … ${p.lines.length - kept.length} more line(s) in the full brief`);
    }
    return `## ${p.name}\n${kept.join('\n')}`;
  });
  return `${out.join('\n\n')}${trimmed ? `\n\n(trimmed; the full brief: ${rel(root, file(root))})` : ''}`;
}

module.exports = { file, read, ensure, refresh, noteGround, propose, proposals, decide, applyTo, forBrief, proposalsFile, SECTIONS, EDITABLE, BRIEF_CHARS, BUDGET, MAX_ADDS };
