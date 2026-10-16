'use strict';
// Design depth (factory 0.11): what an ADR written under template adr@2 (or a no-adr@2 note) must
// show the human at the design gate, parsed and checked deterministically.
//
//   decisions   "## Decision records": one "### D-n: title" per significant decision, each with
//               Context, Drivers (cited by id), an Options trade-off table (two or more options,
//               two or more criteria columns, exactly one "chosen"), Choice, Consequences and
//               Revisit when
//   diagrams    the ```mermaid blocks: a component flowchart with a boundary, an end-to-end
//               sequenceDiagram with an alt/opt/break branch
//   mapping     "## Data model and mapping": source → target fields and the match key
//   failures    "## Failure and state flow": failures, how they are detected, what the run does,
//               the AC each serves
//   layout      "## Project layout": a ```text tree of every file after the job, each with its
//               status (new | changed | existing | deleted), responsibility and ACs
//   runs        "## How it runs": entry points, registration and commands, in `code`
//
// The same parse feeds `factory plan validate` (every new, changed or deleted layout file is
// owned by exactly one task; every task path covers a layout file), the gate view (decision
// table, diagrams, the tree with its task owners) and the console.

const fs = require('fs');
const path = require('path');
const { matchesAny } = require('../lib/glob');

const STATUS = { new: 'new', added: 'new', changed: 'changed', modified: 'changed', edited: 'changed', existing: 'existing', unchanged: 'existing', 'pre-existing': 'existing', deleted: 'deleted', removed: 'deleted' };
const OWNED = new Set(['new', 'changed', 'deleted']);
const AC_RE = /(?<![\w-])(?:E-)?AC-\d+\b/g;
const REF_RE = /(?<![\w-])(?:(?:E-)?AC|A|TH|L|C)-\d+\b|\bconstraints?\b|\bnon-goals?\b|\bfindings?\b/i;
const TREE_PREFIX = /^[\s│├└─┬┼┃┣┗━|`+\\-]*/;
const PARTS = [
  ['context', /^context$/i],
  ['drivers', /^(decision )?drivers$/i],
  ['options', /^(options|options considered|trade-?offs?)$/i],
  ['choice', /^(choice|decision|chosen)$/i],
  ['consequences', /^(consequences|risks|consequences and risks)$/i],
  ['revisit', /^(revisit|revisit when|revisit if|reopen when)$/i],
];
const PART_LABEL = { context: 'Context', drivers: 'Drivers', options: 'Options', choice: 'Choice', consequences: 'Consequences', revisit: 'Revisit when' };

function bare(text) {
  return String(text || '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

function words(text) {
  return bare(text).replace(/[|*_`#>-]/g, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}{}]/u.test(w)).length;
}

function acsIn(text) {
  return [...new Set(String(text || '').match(AC_RE) || [])];
}

// ---------------------------------------------------------------- tables
function cells(row) {
  return row.trim().replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
}

// Every markdown table in a text: { header, rows, line } (rows without the separator).
function tables(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\|.*\|\s*$/.test(lines[i]) && i + 1 < lines.length && /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[i + 1])) {
      const t = { header: cells(lines[i]), rows: [], line: i };
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) t.rows.push(cells(lines[i++]));
      out.push(t);
      continue;
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- the layout tree
// One ```text (or ```tree, or bare ```) block: one file or directory per line, its note after
// "#": status · responsibility · ACs. Paths come from the indentation of the tree drawing.
function parseTree(blockLines, startLine = 0) {
  const entries = [];
  const problems = [];
  const stack = [];
  blockLines.forEach((raw, k) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*(%%|\/\/)/.test(line)) return;
    const pre = TREE_PREFIX.exec(line)[0];
    const rest = line.slice(pre.length);
    if (!rest) return;
    const m = /^(\S+?)(?:\s+#\s*(.*))?$/.exec(rest);
    const at = `line ${startLine + k + 1}`;
    if (!m) {
      problems.push(`${at}: "${rest.slice(0, 60)}" is not "<name>  # status · responsibility · ACs"`);
      return;
    }
    let name = m[1];
    if ((name === '.' || name === './') && !entries.length && !stack.length) return; // the repository root
    const col = pre.length;
    while (stack.length && stack[stack.length - 1].col >= col) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].path : '';
    const dir = name.endsWith('/');
    name = name.replace(/\/+$/, '').replace(/^\.\//, '');
    const full = `${parent}${name}`;
    if (dir) stack.push({ col, path: `${full}/` });
    const note = (m[2] || '').trim();
    const first = /^[\s·|:—-]*([A-Za-z-]+)/.exec(note);
    const status = first ? STATUS[first[1].toLowerCase()] || null : null;
    let resp = note;
    if (status) resp = resp.replace(/^[\s·|:—-]*[A-Za-z-]+/, '');
    resp = resp.replace(AC_RE, ' ').replace(/\bACs?\s*:/gi, ' ').replace(/(\s*[·|,;:—–]\s*)+$/g, '').replace(/^(\s*[·|,;:—–]\s*)+/, '').replace(/(\s*[·|]\s*)+/g, ' · ').replace(/\s+/g, ' ').replace(/[\s·,;]+$/, '').trim();
    entries.push({ path: full, dir, status, responsibility: resp, acs: acsIn(note), line: startLine + k + 1, note });
  });
  return { entries, problems };
}

// The layout of a design doc's text: the tree under "## Project layout" (all of its ```text
// blocks), or null when the doc has no such section.
function layoutOf(text, doc = require('./doc')) {
  const st = doc.structure(text);
  const sec = sectionOf(st, 'project layout');
  if (!sec) return null;
  const blocks = st.fences.filter((f) => f.start > sec.line && f.start < sec.end && f.lang !== 'mermaid');
  const all = { entries: [], problems: [], blocks: blocks.length, section: sec };
  for (const b of blocks) {
    const r = parseTree(b.body, b.start + 1);
    all.entries.push(...r.entries);
    all.problems.push(...r.problems);
  }
  return all;
}

function sectionOf(st, key) {
  const h2 = st.heads.filter((h) => h.level === 2);
  const i = h2.findIndex((h) => normKey(h.text) === key);
  if (i === -1) return null;
  const end = i + 1 < h2.length ? h2[i + 1].line : st.lines.length;
  return { title: h2[i].text, line: h2[i].line, end, text: st.lines.slice(h2[i].line + 1, end).join('\n') };
}

function normKey(s) {
  return String(s).toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').replace(/[\s:.]+$/, '').trim();
}

const files = (layout) => (layout ? layout.entries.filter((e) => !e.dir) : []);
const isTest = (p) => /(^|\/)(tests?|spec|__tests__)\//i.test(p) || /(^|\/)test_[^/]+$/i.test(p) || /[._-](test|spec)\.[^/]+$/i.test(p);

// What a path is at a commit: 'blob', 'tree' or null (absent). null when there is no repo to ask.
function kindAt(root, base, p) {
  if (!root || !base) return undefined;
  const r = require('../lib/git').run(root, ['cat-file', '-t', `${base}:${p}`], { allowFail: true });
  return r.code === 0 ? String(r.stdout).trim() : null;
}
const GLOB_CHARS = /[*?[\]{}]/;

function layoutProblems(title, layout, { acs, testAcs, root = null, base = null } = {}) {
  const out = [];
  const where = `Section "## ${title}"`;
  if (!layout.blocks) return [`${where} needs the file tree in a \`\`\`text block (one file per line, then "# status · responsibility · ACs")`];
  out.push(...layout.problems.map((p) => `${where}: ${p}`));
  const fs_ = files(layout);
  if (!fs_.length) return [...out, `${where}: the tree lists no files`];
  const seen = new Set();
  for (const e of fs_) {
    if (/^\//.test(e.path) || /(^|\/)\.\.(\/|$)/.test(e.path)) out.push(`${where}: ${e.path} must be a repository-relative path inside the repository`);
    if (seen.has(e.path)) out.push(`${where}: ${e.path} is listed twice`);
    seen.add(e.path);
    if (!e.status) out.push(`${where}: ${e.path} has no status: start its note with new, changed, existing or deleted ("# new · what it does · AC-1")`);
    // release review M5: a layout entry is one file, never a pattern
    if (GLOB_CHARS.test(e.path.replace(/\{\{[^}]*\}\}/g, 'x'))) out.push(`${where}: ${e.path} is a pattern, not a file: list each file the change touches`);
    // release review m3: the status is checked against the repository (the base commit)
    const k = e.status ? kindAt(root, base, e.path) : undefined;
    if (k !== undefined && !GLOB_CHARS.test(e.path)) {
      if (['existing', 'changed', 'deleted'].includes(e.status) && k !== 'blob') out.push(`${where}: ${e.path} is marked ${e.status}, but the base commit has no such file${k === 'tree' ? ' (it is a directory)' : ''}`);
      if (e.status === 'new' && k) out.push(`${where}: ${e.path} is marked new, but it already exists at the base commit: mark it changed (or existing)`);
    }
    if (words(e.responsibility) < 2) out.push(`${where}: ${e.path} needs its responsibility: what the file does, in a few words`);
  }
  if (!fs_.some((e) => OWNED.has(e.status))) out.push(`${where}: no file is new, changed or deleted: the layout must show what the job builds`);
  if (acs && acs.length) {
    const served = new Set(fs_.flatMap((e) => e.acs));
    const miss = acs.filter((a) => !served.has(a));
    if (miss.length) out.push(`${where}: no file serves ${miss.join(', ')}: name the AC on the files that implement or test it`);
    const known = new Set(acs);
    const ghost = [...new Set(fs_.flatMap((e) => e.acs).filter((a) => !known.has(a)))];
    if (ghost.length) out.push(`${where} cites ${ghost.join(', ')}, which the contract does not have`);
  }
  if (testAcs && testAcs.length && !fs_.some((e) => e.status !== 'deleted' && isTest(e.path))) out.push(`${where}: the tree lists no test file, but ${testAcs.join(', ')} need${testAcs.length === 1 ? 's' : ''} test evidence: name the tests that prove them (new, changed or existing)`);
  return out;
}

// ---------------------------------------------------------------- decision records
function decisionRecords(sectionText) {
  const lines = String(sectionText || '').split('\n');
  const recs = [];
  let cur = null;
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const h = !fence && /^###\s+(D-\d+)\b\s*[:.—–-]?\s*(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      cur = { id: h[1], title: h[2] || '', start: i, lines: [] };
      recs.push(cur);
      return;
    }
    if (!fence && /^###\s+/.test(l)) {
      cur = null;
      return;
    }
    if (cur) cur.lines.push(l);
  });
  return recs.map((r) => {
    const text = r.lines.join('\n');
    const marks = [];
    for (const m of text.matchAll(/\*\*\s*([A-Za-z -]+?)\s*[.:]?\s*\*\*\s*[.:]?/g)) {
      const p = PARTS.find(([, re]) => re.test(m[1].trim()));
      if (p) marks.push({ key: p[0], at: m.index, after: m.index + m[0].length });
    }
    const parts = {};
    marks.forEach((m, i) => {
      if (parts[m.key] !== undefined) return;
      parts[m.key] = text.slice(m.after, i + 1 < marks.length ? marks[i + 1].at : text.length).trim();
    });
    const t = tables(parts.options || '')[0] || tables(text)[0] || null;
    let chosen = null;
    let options = [];
    if (t) {
      const vi = verdictCol(t.header);
      options = t.rows.map((row) => ({ option: row[0] || '', verdict: vi >= 0 ? row[vi] || '' : '' }));
      const ch = options.filter((o) => /\bchosen\b/i.test(o.verdict) && !/\bnot chosen\b/i.test(o.verdict));
      chosen = ch.length === 1 ? ch[0].option : null;
    }
    return { id: r.id, title: r.title, parts, table: t, options, chosen, line: r.start };
  });
}

function verdictCol(header) {
  const i = header.findIndex((h) => /verdict|outcome|decision|chosen/i.test(h));
  return i >= 0 ? i : header.length - 1;
}

function decisionProblems(title, sectionText) {
  const where = `Section "## ${title}"`;
  const recs = decisionRecords(sectionText);
  if (!recs.length) return [`${where} needs at least one decision record ("### D-1: <title>" with Context, Drivers, Options, Choice, Consequences and Revisit when)`];
  const out = [];
  const ids = recs.map((r) => r.id);
  for (const d of ids.filter((x, i) => ids.indexOf(x) !== i)) out.push(`${where}: ${d} is used twice`);
  for (const r of recs) {
    const at = `${where}, ${r.id}`;
    if (words(r.title) < 2) out.push(`${at} needs a title that names the decision`);
    const missing = Object.keys(PART_LABEL).filter((k) => r.parts[k] === undefined || !bare(r.parts[k]));
    if (missing.length) out.push(`${at} is missing ${missing.map((k) => `**${PART_LABEL[k]}.**`).join(', ')}`);
    if (r.parts.drivers && bare(r.parts.drivers) && !REF_RE.test(r.parts.drivers)) out.push(`${at}: its Drivers cite nothing: tie each to an acceptance criterion (AC-n), a constraint, a grounded assumption (A-n) or a finding`);
    for (const k of ['context', 'choice', 'consequences', 'revisit']) if (r.parts[k] && bare(r.parts[k]) && words(r.parts[k]) < 4) out.push(`${at}: **${PART_LABEL[k]}.** says too little (${words(r.parts[k])} word(s)): explain it`);
    if (!r.table) {
      out.push(`${at} needs an options trade-off table under **Options.** (Option | criteria… | Verdict)`);
      continue;
    }
    if (r.options.length < 2) out.push(`${at} weighs ${r.options.length} option(s): a decision needs at least two (the rejected ones included)`);
    if (r.table.header.length < 4) out.push(`${at}: the options table has ${r.table.header.length} column(s): a trade-off table needs the option, at least two criteria or costs, and the verdict`);
    const chosen = r.options.filter((o) => /\bchosen\b/i.test(o.verdict) && !/\bnot chosen\b/i.test(o.verdict));
    if (chosen.length !== 1) out.push(`${at}: exactly one option's verdict must say "chosen" (found ${chosen.length})`);
    for (const o of r.options) if (!bare(o.verdict)) out.push(`${at}: option "${o.option.slice(0, 40)}" has no verdict (chosen, or rejected and why)`);
  }
  return out;
}

// ---------------------------------------------------------------- other sections
function mappingProblems(title, sectionText, blocks) {
  const where = `Section "## ${title}"`;
  const body = bare(sectionText);
  if (/^none\s*[:—–-]/i.test(body)) return words(body) >= 5 ? [] : [`${where}: "None:" needs the reason the change moves no data`];
  const t = tables(sectionText).find((x) => x.header.some((h) => /source|from|input/i.test(h)) && x.header.some((h) => /target|to\b|model|output/i.test(h)));
  const diagram = blocks.find((b) => ['erDiagram', 'classDiagram', 'classDiagram-v2'].includes(b.res.type));
  if (!t && !diagram) return [`${where} needs a mapping table (Source | Target | Transform | Match key), an erDiagram or classDiagram, or "None: <why>"`];
  const out = [];
  if (t && !t.rows.length) out.push(`${where}: the mapping table has no rows`);
  const keyCol = t ? t.header.findIndex((h) => /key|match/i.test(h)) : -1;
  if (!(keyCol >= 0 && t.rows.some((r) => /\b(yes|key|match|unique|primary|natural)\b/i.test(r[keyCol] || ''))) && !/\b(match(ed|ing)? (on|by)|key)\b/i.test(body.replace(/\|[^\n]*\|/g, ''))) out.push(`${where} must say which fields match a source record to a target record (a "Match key" column marked yes, or a sentence naming the key)`);
  return out;
}

function failureProblems(title, sectionText) {
  const where = `Section "## ${title}"`;
  const t = tables(sectionText).find((x) => x.rows.length);
  if (!t) return [`${where} needs a table of failures (Failure | Detected by | Behaviour | AC), one row each`];
  const out = [];
  if (t.rows.length < 2) out.push(`${where} lists ${t.rows.length} failure: name every way a run can fail or partly fail (an unreachable system, bad credentials, conflicting or invalid data, a partial write…)`);
  if (t.header.length < 3) out.push(`${where}: each failure needs how it is detected and what the run then does`);
  if (!t.rows.some((r) => acsIn(r.join(' ')).length)) out.push(`${where}: map each failure to the acceptance criterion it serves (an AC column)`);
  return out;
}

function runsProblems(title, sectionText) {
  const body = bare(sectionText);
  if (!body) return [];
  return /`[^`\n]+`/.test(body) || /^\s*(```|~~~)/m.test(body) ? [] : [`Section "## ${title}" must name the entry points and commands in \`code\` (how it is started, where it is registered, how it is tested)`];
}

function optionsProblems(title, sectionText, options) {
  const where = `Section "## ${title}"`;
  const out = [];
  const t = tables(sectionText)[0];
  if (t && t.rows.length < 2) out.push(`${where} lists ${t.rows.length} option: an ADR weighs at least two (otherwise write a no-adr note)`);
  if (options && options.length) {
    const body = bare(sectionText);
    const miss = options.filter((o) => !new RegExp(`(?<![\\w-])${o.id}(?![0-9])`).test(body));
    if (miss.length) out.push(`${where} leaves out the option generators' ${miss.map((o) => `${o.id} ("${String(o.title || '').slice(0, 50)}")`).join(', ')}: one row per generated option, by its id`);
  }
  return out;
}

function branchProblems(title, blocks) {
  const seq = blocks.filter((b) => b.res.type === 'sequenceDiagram' && !b.res.problems.length);
  if (!seq.length) return [];
  const out = [];
  if (!seq.some((b) => b.body.some((l) => /^\s*(alt|opt|break|critical)\b/.test(l)))) out.push(`The sequence diagram in "## ${title}" shows only the happy path: draw the dry-run and failure paths as alt / else / opt blocks`);
  const msgs = Math.max(...seq.map((b) => b.body.filter((l) => /^[^:]*?(->>|-->>|->|-->|-x|--x|-\)|--\))[^:]*:/.test(l.trim())).length));
  if (msgs < 4) out.push(`The sequence diagram in "## ${title}" has ${msgs} message(s): draw the whole run, start to finish`);
  return out;
}

// The component diagram names real modules: at least one name from the layout.
function layoutNameProblems(title, blocks, layout) {
  const fl = files(layout).filter((e) => e.status && e.status !== 'deleted');
  if (!fl.length) return [];
  const stems = new Set();
  for (const e of fl) {
    const base = path.basename(e.path).replace(/\.[^.]+$/, '');
    if (base.length >= 3 && !/^(__init__|index|main|mod|lib|utils?|test_.*|.*[._-]test|readme)$/i.test(base)) stems.add(base.toLowerCase());
    const dir = path.dirname(e.path);
    if (dir !== '.') for (const seg of dir.split('/')) if (seg.length >= 3 && !/^(src|lib|tests?|app|pkg|docs?)$/i.test(seg)) stems.add(seg.toLowerCase());
  }
  if (!stems.size) return [];
  const text = blocks.map((b) => b.body.join('\n')).join('\n').toLowerCase();
  return [...stems].some((s) => text.includes(s)) ? [] : [`The diagram in "## ${title}" names none of the modules in "## Project layout" (${[...stems].slice(0, 5).join(', ')}…): draw the real modules and classes, by name`];
}

// ---------------------------------------------------------------- the design of a job
function designDocs(root, jobId) {
  const inv = require('./invalidation');
  const doc = require('./doc');
  return inv.designFiles(root, jobId).filter((f) => ['adr', 'no-adr'].includes(doc.typeOf(f, null)));
}

// The layout every design doc of the job declares (adr@2 / no-adr@2), merged; null when none
// declares one (an older design, a bug@low job without a design).
function jobLayout(root, jobId) {
  let out = null;
  for (const f of designDocs(root, jobId)) {
    const text = fs.readFileSync(f, 'utf8');
    const tpl = (require('./doc').frontMatter(text).front || {}).template;
    if (tpl && require('./doc').isLegacy(tpl)) continue; // an older design: no layout contract
    const l = layoutOf(text);
    if (!l) continue;
    out = out || { entries: [], files: [] };
    out.files.push(path.basename(f));
    for (const e of l.entries) if (!out.entries.some((x) => x.path === e.path)) out.entries.push({ ...e, doc: path.basename(f) });
  }
  return out;
}

// Every layout file with the tasks whose allowed paths cover it.
function ownership(layout, tasks) {
  return (layout ? layout.entries : []).map((e) => ({ ...e, owners: e.dir ? [] : (tasks || []).filter((t) => matchesAny(e.path, t.allowed_paths || [])).map((t) => t.id) }));
}

// plan ↔ layout: every new, changed or deleted file is owned by exactly one task, and each task's
// write scope is the files the layout gives it (release review M5): an allowed path is an exact
// layout file of that task (new, changed or deleted), or a glob whose every match — among the
// layout's files and the repository's files at the base commit — is such a file. Never "**", a
// bare directory, or a glob that also covers an existing file the human was told stays untouched.
function planLayoutProblems(layout, tasks, { root = null, base = null } = {}) {
  if (!layout || !files(layout).length) return [];
  const out = [];
  const own = ownership(layout, tasks).filter((e) => !e.dir);
  for (const e of own.filter((x) => OWNED.has(x.status))) {
    if (!e.owners.length) out.push(`${e.path} (${e.status} in the design's Project layout) is owned by no task: put it in exactly one task's allowed_paths`);
    else if (e.owners.length > 1) out.push(`${e.path} (${e.status} in the design's Project layout) is owned by ${e.owners.join(' and ')}: exactly one task owns each file (narrow the allowed paths)`);
  }
  const built = own.filter((x) => OWNED.has(x.status));
  const builtSet = new Set(built.map((e) => e.path));
  let tree = [];
  if (root && base) {
    try {
      tree = require('../lib/git').out(root, ['ls-tree', '-r', '--name-only', base]).split('\n').filter(Boolean);
    } catch {
      tree = [];
    }
  }
  const layoutDirs = new Set(layout.entries.filter((e) => e.dir).map((e) => e.path.replace(/\/+$/, '')));
  const universe = [...new Set([...own.map((e) => e.path), ...tree])];
  for (const t of tasks || []) {
    for (const raw of t.allowed_paths || []) {
      const p = String(raw).replace(/^=/, '').replace(/^\.\//, '');
      const where = `${t.id}'s allowed path ${raw}`;
      if (/(^|\/)\*\*(\/|$)/.test(p) && p.replace(/\*\*\/?/g, '').replace(/\/$/, '') === '') {
        out.push(`${where} is "**" (everything): name the task's files from the design's Project layout`);
        continue;
      }
      if (!GLOB_CHARS.test(p)) {
        if (builtSet.has(p)) continue;
        const isDir = p.endsWith('/') || layoutDirs.has(p.replace(/\/$/, '')) || tree.some((f) => f.startsWith(`${p.replace(/\/$/, '')}/`)) || own.some((e) => e.path.startsWith(`${p.replace(/\/$/, '')}/`));
        out.push(isDir ? `${where} is a directory: a task's allowed paths name the layout's files (a directory covers files the design keeps or gives to other tasks)` : `${where} covers no new, changed or deleted file in the design's Project layout (${layout.files.join(', ')}): derive tasks from the layout, or narrow the path to its files`);
        continue;
      }
      const hits = universe.filter((f) => matchesAny(f, [p]));
      const mine = hits.filter((f) => builtSet.has(f) && (own.find((e) => e.path === f) || {}).owners.includes(t.id));
      const extra = hits.filter((f) => !mine.includes(f));
      if (!mine.length) out.push(`${where} covers no new, changed or deleted file in the design's Project layout (${layout.files.join(', ')}): derive tasks from the layout, or narrow the path to its files`);
      else if (extra.length) out.push(`${where} also covers ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ` and ${extra.length - 5} more` : ''}, which the design's Project layout does not give ${t.id} to change (existing, another task's, or not in the layout): name the files instead`);
    }
  }
  return out;
}

// The tree as text, with each file's status, task owner(s) and ACs: what the gate shows.
function treeText(entries) {
  const L = [];
  const depth = (p) => p.split('/').length - 1;
  const sorted = [...entries];
  for (const e of sorted) {
    const name = `${'  '.repeat(depth(e.path))}${path.basename(e.path)}${e.dir ? '/' : ''}`;
    const meta = e.dir ? '' : [e.status || '?', e.owners && e.owners.length ? e.owners.join('+') : OWNED.has(e.status) ? 'no task' : '—', e.acs.join(',') || '—', e.responsibility].join(' · ');
    L.push(meta ? `${name.padEnd(34)} # ${meta}` : name);
  }
  return L.join('\n');
}

// What the design gate shows besides the documents: the decisions as a table, every diagram (its
// mermaid source and type), the layout tree with each file's owner task (once there is a plan),
// and how it runs. null when the job has no adr / no-adr.
function view(root, state, { tasks = null } = {}) {
  const doc = require('./doc');
  const docsOf = designDocs(root, state.id);
  if (!docsOf.length) return null;
  const out = { docs: [], decisions: [], diagrams: [], layout: null, runs: null, legacy: [] };
  for (const f of docsOf) {
    const text = fs.readFileSync(f, 'utf8');
    const st = doc.structure(text);
    const fm = st.fm.front || {};
    const name = path.basename(f);
    out.docs.push({ file: name, template: fm.template || null });
    if (fm.template && doc.isLegacy(fm.template)) out.legacy.push(`${name} (${fm.template})`);
    const dr = sectionOf(st, 'decision records');
    if (dr) for (const r of decisionRecords(dr.text)) out.decisions.push({ doc: name, id: r.id, title: r.title, chosen: r.chosen, options: r.options.map((o) => ({ option: o.option, verdict: o.verdict })), drivers: oneLine(r.parts.drivers), why: oneLine(r.parts.choice), revisit: oneLine(r.parts.revisit) });
    const secs = st.heads.filter((h) => h.level === 2);
    for (const b of st.fences.filter((x) => x.lang === 'mermaid' && x.end !== null)) {
      const sec = secs.filter((h) => h.line < b.start).pop();
      const r = doc.mermaid(b);
      out.diagrams.push({ doc: name, section: sec ? sec.text : null, type: r.type, ok: !r.problems.length, source: b.body.join('\n') });
    }
    const runs = sectionOf(st, 'how it runs');
    if (runs && bare(runs.text)) out.runs = (out.runs ? `${out.runs}\n` : '') + bare(runs.text).slice(0, 1500);
  }
  const lay = jobLayout(root, state.id);
  if (lay) {
    const t = tasks || require('./job').tasksOf(root, state);
    const own = ownership(lay, t);
    out.layout = {
      files: own.filter((e) => !e.dir).map((e) => ({ path: e.path, status: e.status, responsibility: e.responsibility, acs: e.acs, owners: e.owners })),
      tree: treeText(own),
      planned: t.length > 0,
      ...(t.length ? { problems: planLayoutProblems(lay, t, { root, base: state.base_commit || null }) } : {}),
    };
  }
  out.summary = summary(out);
  return out;
}

function oneLine(s) {
  return bare(s || '').replace(/\s+/g, ' ').slice(0, 300) || null;
}

function summary(v) {
  const seq = v.diagrams.filter((d) => d.type === 'sequenceDiagram').length;
  const comp = v.diagrams.filter((d) => /^(flowchart|graph|C4|architecture|block)/.test(d.type || '')).length;
  const f = v.layout ? v.layout.files : [];
  return [
    v.decisions.length ? `${v.decisions.length} decision record(s)` : 'no decision records',
    `${comp} component, ${seq} sequence and ${v.diagrams.length - comp - seq} data / state diagram(s)`,
    v.layout ? `a layout of ${f.length} file(s) (${f.filter((x) => x.status === 'new').length} new, ${f.filter((x) => x.status === 'changed').length} changed)${v.layout.planned ? `, ${f.filter((x) => OWNED.has(x.status) && x.owners.length === 1).length} owned by one task` : ''}` : 'no project layout',
    ...(v.legacy.length ? [`older template: ${v.legacy.join(', ')} (no design-depth checks)`] : []),
  ].join('; ');
}

// Markdown for the gate (skill, inbox, `factory doc design`): decisions, diagrams, tree.
function markdown(v) {
  if (!v) return '';
  const c = (s) => String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const L = [`**Design:** ${v.summary}.`, ''];
  if (v.decisions.length) {
    L.push('| Decision | Chosen | Rejected | Why | Revisit when |', '|---|---|---|---|---|');
    for (const d of v.decisions) L.push(`| ${c(`${d.id} ${d.title}`)} | ${c(d.chosen || '—')} | ${c(d.options.filter((o) => o.option !== d.chosen).map((o) => o.option).join('; ') || '—')} | ${c(d.why || '—')} | ${c(d.revisit || '—')} |`);
    L.push('');
  }
  for (const d of v.diagrams) L.push(`*${d.section || 'Diagram'}* (${d.type || 'mermaid'})`, '', '```mermaid', d.source, '```', '');
  if (v.layout) L.push(`*Project layout* (status · task · ACs · responsibility)${v.layout.planned ? '' : ' — tasks are assigned at decompose'}`, '', '```text', v.layout.tree, '```', '');
  if (v.layout && (v.layout.problems || []).length) L.push(...v.layout.problems.map((p) => `- ✗ ${p}`), '');
  if (v.runs) L.push('*How it runs*', '', v.runs, '');
  return L.join('\n');
}

module.exports = { parseTree, layoutOf, tables, decisionRecords, decisionProblems, layoutProblems, mappingProblems, failureProblems, runsProblems, optionsProblems, branchProblems, layoutNameProblems, jobLayout, ownership, planLayoutProblems, treeText, view, markdown, acsIn, isTest, OWNED };
