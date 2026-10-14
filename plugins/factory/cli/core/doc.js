'use strict';
// The factory's documents: one template per doc type in templates/docs/, each with YAML
// front matter, an H1, and "##" sections in a fixed order. A template's own
// "<!-- rule: … -->" comments say what `factory doc check` enforces per section:
//   optional        the section may be left out
//   table           the section holds a markdown table
//   acs             every acceptance criterion id of the contract appears in it
//   threats         every threat id (TH-n) of the job's threat model appears in it
//   mermaid a|b     it holds a well-formed ```mermaid block of one of these diagram types
//   subgraph        that block draws at least one subgraph (a boundary)
// Checks are cheap and syntactic. Mermaid is never rendered; blocks are checked for a
// known diagram type, balanced brackets and blocks, and at least one edge or message.

const fs = require('fs');
const path = require('path');
const { readText, readJson, writeText, exists, fail } = require('../lib/util');
const { pluginPath, jobPaths, project } = require('../lib/paths');

const TYPES = {
  adr: { file: 'adr.md', match: /^adr-\d+.*\.md$/, what: 'Architecture decision record (written by the architect)' },
  'no-adr': { file: 'no-adr.md', match: /^no-adr\.md$/, what: 'Why no decision was needed (architect)' },
  recommendation: { file: 'recommendation.md', match: /^recommendation\.md$/, what: 'Spike answer (architect)' },
  'threat-model': { file: 'threat-model.md', match: /^threat-model\.md$/, what: 'STRIDE threat model with a data-flow diagram (threat modeler)' },
  contracts: { file: 'contracts.md', match: /^contracts\.md$/, what: 'Epic interfaces to freeze (architect)' },
  findings: { file: 'findings.md', match: /^findings\.md$/, what: 'Cited grounding claims (rendered by the CLI)' },
  'ship-report': { file: 'ship-report.md', match: /^completion-report\.md$/, what: 'Completion report and PR body (rendered by the CLI)' },
  lessons: { file: 'lessons.md', match: /^lessons\.md$/, what: 'Lessons register (rendered by the CLI)' },
  index: { file: 'index.md', match: /^docs-index\.md$/, what: 'Per-job docs index and traceability (rendered by the CLI)' },
};
const DESIGN_TYPES = ['adr', 'no-adr', 'recommendation', 'threat-model', 'contracts'];
const FRONT_KEYS = ['doc', 'template', 'job', 'title', 'status', 'date'];

const DIAGRAMS = ['flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'classDiagram-v2', 'stateDiagram', 'stateDiagram-v2', 'erDiagram', 'journey', 'gantt', 'pie', 'mindmap', 'timeline', 'gitGraph', 'quadrantChart', 'requirementDiagram', 'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment', 'sankey-beta', 'xychart-beta', 'block-beta', 'architecture-beta', 'packet-beta', 'kanban'];

function templatePath(type) {
  if (!TYPES[type]) fail(`Unknown doc type "${type}". Types: ${Object.keys(TYPES).join(', ')}`, 'bad_input');
  return pluginPath('templates', 'docs', TYPES[type].file);
}

function template(type) {
  return readText(templatePath(type));
}

// ---------------------------------------------------------------- parsing
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return { front: null, comments: {}, bodyStart: 0 };
  const front = {};
  const comments = {};
  for (const raw of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(raw);
    if (!kv) continue;
    const c = kv[2].match(/\s+#\s(.*)$/);
    let v = c ? kv[2].slice(0, c.index).trim() : kv[2];
    if (c) comments[kv[1]] = c[1].trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else v = v.replace(/^["']|["']$/g, '');
    front[kv[1]] = v;
  }
  return { front, comments, bodyStart: m[0].split('\n').length - (m[2] ? 1 : 0) };
}

// Lines with their numbers, headings found outside code fences, and fenced blocks.
function structure(text) {
  const lines = String(text).split('\n');
  const fm = frontMatter(text);
  const heads = [];
  const fences = [];
  let open = null;
  for (let i = fm.bodyStart; i < lines.length; i++) {
    const l = lines[i];
    const f = /^\s*(```+|~~~+)\s*([\w-]*)/.exec(l);
    if (f && !open) {
      open = { lang: f[2].toLowerCase(), start: i, marker: f[1][0] };
      continue;
    }
    if (open && new RegExp(`^\\s*${open.marker === '`' ? '```' : '~~~'}\\s*$`).test(l)) {
      fences.push({ ...open, end: i, body: lines.slice(open.start + 1, i) });
      open = null;
      continue;
    }
    if (open) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) heads.push({ level: h[1].length, text: h[2], line: i });
  }
  if (open) fences.push({ ...open, end: null, body: lines.slice(open.start + 1) });
  return { lines, fm, heads, fences };
}

function norm(s) {
  return String(s).toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').replace(/[\s:.]+$/, '').trim();
}

function parseRules(text) {
  const r = { optional: false, table: false, acs: false, threats: false, subgraph: false, mermaid: null };
  for (const m of String(text).matchAll(/<!--\s*rule:\s*([\s\S]*?)-->/g)) {
    for (const part of m[1].split(';').map((x) => x.trim()).filter(Boolean)) {
      const [k, ...rest] = part.split(/\s+/);
      if (k === 'mermaid') r.mermaid = rest.join(' ').split('|').map((x) => x.trim()).filter(Boolean);
      else if (k in r) r[k] = true;
    }
  }
  return r;
}

// Sections of a parsed doc: each "##" heading with the text up to the next "##".
function sectionsOf(st) {
  const h2 = st.heads.filter((h) => h.level === 2);
  return h2.map((h, i) => {
    const end = i + 1 < h2.length ? h2[i + 1].line : st.lines.length;
    return { title: h.text, key: norm(h.text), line: h.line, start: h.line + 1, end, text: st.lines.slice(h.line + 1, end).join('\n') };
  });
}

const TEMPLATES = {};
function loadTemplate(type) {
  if (TEMPLATES[type]) return TEMPLATES[type];
  const text = template(type);
  const st = structure(text);
  const fm = st.fm;
  const h1 = st.heads.find((h) => h.level === 1);
  const h1Re = h1 ? new RegExp(`^${h1.text.split(/\{\{[^}]*\}\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`, 'i') : null;
  const statuses = (fm.comments.status || '').split('|').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
  const t = {
    type,
    version: fm.front.template,
    h1: h1 ? h1.text : null,
    h1Re,
    statuses: statuses.length ? statuses : null,
    sections: sectionsOf(st).map((s) => ({ title: s.title, key: s.key, rules: parseRules(s.text) })),
  };
  TEMPLATES[type] = t;
  return t;
}

function typeOf(file, front) {
  if (front && front.doc && TYPES[front.doc]) return front.doc;
  const base = path.basename(file || '');
  return Object.keys(TYPES).find((k) => TYPES[k].match.test(base)) || null;
}

// ---------------------------------------------------------------- mermaid
function stripText(line, kind) {
  let s = line.replace(/"[^"]*"/g, '""');
  if (kind === 'flow') s = s.replace(/\|[^|]*\|/g, '||');
  if (kind === 'seq') s = s.replace(/:.*$/, '');
  return s;
}

function balanced(lines, kind) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  for (const l of lines) {
    for (const ch of stripText(l, kind)) {
      if ('([{'.includes(ch)) stack.push(ch);
      else if (pairs[ch]) {
        if (stack.pop() !== pairs[ch]) return false;
      }
    }
  }
  return stack.length === 0;
}

// Checks one fenced mermaid block. Returns { type, problems, subgraphs }.
function mermaid(block) {
  const at = `mermaid block at line ${block.start + 1}`;
  const problems = [];
  if (block.end === null) return { type: null, problems: [`${at} is never closed (missing \`\`\`)`], subgraphs: 0 };
  let body = block.body.map((l) => l.trim());
  // An optional "---" config header at the top of the block.
  const firstReal = body.findIndex((l) => l);
  if (firstReal >= 0 && body[firstReal] === '---') {
    const close = body.indexOf('---', firstReal + 1);
    body = close > 0 ? body.slice(close + 1) : body;
  }
  const stmts = body.filter((l) => l && !l.startsWith('%%'));
  if (!stmts.length) return { type: null, problems: [`${at} is empty`], subgraphs: 0 };
  const head = stmts[0].split(/[\s;]+/)[0];
  const type = DIAGRAMS.find((d) => d === head) || null;
  if (!type) return { type: null, problems: [`${at} starts with "${stmts[0].slice(0, 40)}", not a Mermaid diagram type (flowchart LR, sequenceDiagram, C4Container, …)`], subgraphs: 0 };
  const rest = stmts.slice(1);
  if (!rest.length) problems.push(`${at} declares ${type} but draws nothing`);
  let subgraphs = 0;
  if (type === 'flowchart' || type === 'graph') {
    if (stmts[0].split(/\s+/)[1] && !/^(TB|TD|BT|RL|LR);?$/.test(stmts[0].split(/\s+/)[1])) problems.push(`${at}: "${stmts[0]}" has an unknown direction (use TB, TD, BT, RL or LR)`);
    subgraphs = rest.filter((l) => /^subgraph\b/.test(l)).length;
    const ends = rest.filter((l) => /^end\s*;?$/.test(l)).length;
    if (subgraphs !== ends) problems.push(`${at}: ${subgraphs} subgraph(s) but ${ends} "end" line(s)`);
    if (!rest.some((l) => /(-->|---|-\.->|-\.-|==>|===|--[ox]|<-->|~~~|--\s*[^-\s][^>]*-->)/.test(l))) problems.push(`${at}: the flowchart has no edges (A --> B); a diagram should show how things connect`);
    if (!balanced(rest, 'flow')) problems.push(`${at}: unbalanced brackets in a node shape — check every [ ], ( ) and { }`);
  } else if (type === 'sequenceDiagram') {
    const opens = rest.filter((l) => /^(loop|alt|opt|par|critical|break|rect|box)\b/.test(l)).length;
    const ends = rest.filter((l) => /^end\s*;?$/.test(l)).length;
    if (opens !== ends) problems.push(`${at}: ${opens} block(s) (loop/alt/opt/par/critical/break/rect/box) but ${ends} "end" line(s)`);
    if (!rest.some((l) => /^[^:]*?(->>|-->>|->|-->|-x|--x|-\)|--\))[^:]*:/.test(l))) problems.push(`${at}: the sequence diagram has no messages (A->>B: call)`);
    if (!balanced(rest, 'seq')) problems.push(`${at}: unbalanced brackets outside message text`);
  } else if (/^C4|^architecture-beta|^block-beta/.test(type)) {
    if (!balanced(rest, 'c4')) problems.push(`${at}: unbalanced brackets — check every ( ) and { }`);
    subgraphs = rest.filter((l) => /(Boundary|^group|^block)\b.*[{(]/.test(l) || /^System_Boundary|^Enterprise_Boundary|^Container_Boundary/.test(l)).length;
    if (!rest.some((l) => /^(Rel|BiRel|Rel_[A-Za-z]+)\s*\(|--|-->|<--|:[LRTB]\s*-/.test(l))) problems.push(`${at}: the ${type} diagram has no relationships (Rel(a, b, "…") or a --> b)`);
  }
  return { type, problems, subgraphs };
}

// ---------------------------------------------------------------- check
function hasTable(text) {
  const rows = String(text).split('\n').filter((l) => /^\s*\|.*\|\s*$/.test(l));
  return rows.length >= 3 && rows.some((l) => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l));
}

function bare(text) {
  return String(text).replace(/<!--[\s\S]*?-->/g, '').trim();
}

function idRe(id) {
  return new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/[-]/g, '\\-')}(?![0-9])`);
}

// opts: { type, job, acs: ['AC-1'], threats: ['TH-1'], dir }
function check(text, opts = {}) {
  const problems = [];
  const warnings = [];
  const st = structure(text);
  const front = st.fm.front;
  const type = opts.type || typeOf(opts.file, front);
  if (!type) return { type: null, ok: false, problems: [`Cannot tell the doc type: add front matter with "doc: <type>" (${Object.keys(TYPES).join(', ')})`], warnings };
  const t = loadTemplate(type);
  const tfile = `templates/docs/${TYPES[type].file}`;

  // Front matter
  if (!front) problems.push(`No front matter: start the file with the "---" block from ${tfile} (doc, template, job, title, status, date)`);
  else {
    for (const k of FRONT_KEYS) if (!front[k] || (Array.isArray(front[k]) && !front[k].length)) problems.push(`Front matter is missing "${k}"`);
    if (front.doc && front.doc !== type) problems.push(`Front matter says doc: ${front.doc}, but this is a ${type} document`);
    if (front.template && front.template !== t.version) problems.push(`Front matter says template: ${front.template}; the current template is ${t.version}`);
    if (front.status && t.statuses && !t.statuses.includes(front.status)) problems.push(`status "${front.status}" is not one of ${t.statuses.join(', ')}`);
    if (front.date && !/^\d{4}-\d{2}-\d{2}$/.test(front.date)) problems.push(`date "${front.date}" is not YYYY-MM-DD`);
    if (opts.job && front.job && front.job !== opts.job) problems.push(`Front matter says job: ${front.job}, but this is ${opts.job}`);
    if (opts.dir) {
      const rel = [].concat(front.related || [], front.contract && front.contract !== 'none' ? [front.contract] : []);
      for (const r of rel) if (typeof r === 'string' && !/\{\{/.test(r) && !/^https?:/.test(r) && !exists(path.resolve(opts.dir, r))) warnings.push(`Linked doc ${r} does not exist (yet)`);
    }
  }

  // Placeholders left from the template
  const ph = [];
  st.lines.forEach((l, i) => {
    const m = l.match(/\{\{[^}]*\}\}/);
    if (m && ph.length < 5) ph.push(`line ${i + 1}: ${m[0]}`);
  });
  if (ph.length) problems.push(`Unfilled template placeholders (${ph.join('; ')})`);

  // Title
  const h1 = st.heads.find((h) => h.level === 1);
  if (!h1) problems.push(`No title: the first heading should look like "${t.h1}"`);
  else if (t.h1Re && !t.h1Re.test(h1.text)) problems.push(`Title "${h1.text}" should look like "${t.h1}"`);

  // Sections in order, with their rules
  const secs = sectionsOf(st);
  const blocks = st.fences.filter((f) => f.lang === 'mermaid').map((b) => ({ ...b, res: mermaid(b) }));
  let at = -1;
  for (const ts of t.sections) {
    const idx = secs.findIndex((s, i) => i > at && s.key === ts.key);
    if (idx === -1) {
      const earlier = secs.findIndex((s) => s.key === ts.key);
      if (earlier !== -1) problems.push(`Section "## ${ts.title}" is out of order (sections follow ${tfile})`);
      else if (!ts.rules.optional) problems.push(`Missing section "## ${ts.title}"`);
      else if (ts.rules.threats && opts.threats && opts.threats.length) problems.push(`Missing section "## ${ts.title}": the threat model lists ${opts.threats.join(', ')}`);
      continue;
    }
    at = idx;
    const s = secs[idx];
    const body = bare(s.text);
    if (!ts.rules.optional && !body) {
      problems.push(`Section "## ${ts.title}" is empty`);
      continue;
    }
    if (ts.rules.table && !hasTable(s.text)) problems.push(`Section "## ${ts.title}" needs a markdown table (see ${tfile})`);
    if (ts.rules.acs && opts.acs) {
      const miss = opts.acs.filter((id) => !idRe(id).test(body));
      if (miss.length) problems.push(`Section "## ${ts.title}" does not cover ${miss.join(', ')} (every acceptance criterion needs a row)`);
    }
    if (ts.rules.threats && opts.threats) {
      const miss = opts.threats.filter((id) => !idRe(id).test(body));
      if (miss.length) problems.push(`Section "## ${ts.title}" does not map threat(s) ${miss.join(', ')} from threat-model.md`);
    }
    if (ts.rules.mermaid) {
      const mine = blocks.filter((b) => b.start > s.line && b.start < s.end);
      const good = mine.filter((b) => b.res.type && ts.rules.mermaid.includes(b.res.type) && !b.res.problems.length);
      if (!mine.length) problems.push(`Section "## ${ts.title}" needs a \`\`\`mermaid diagram (${ts.rules.mermaid.join(' | ')}); see ${tfile}`);
      else if (!good.length && mine.every((b) => !b.res.problems.length)) problems.push(`Section "## ${ts.title}" needs a ${ts.rules.mermaid.join(' | ')} diagram; found ${mine.map((b) => b.res.type).join(', ')}`);
      else if (ts.rules.subgraph && good.length && !good.some((b) => b.res.subgraphs > 0)) problems.push(`The diagram in "## ${ts.title}" draws no boundary: put each trust boundary in a subgraph`);
    }
  }
  for (const b of blocks) problems.push(...b.res.problems);
  return { type, template: t.version, ok: problems.length === 0, problems, warnings };
}

// ---------------------------------------------------------------- job context
function threatIds(text) {
  const st = structure(text || '');
  const s = sectionsOf(st).find((x) => /threats/.test(x.key));
  return [...new Set(((s ? s.text : '').match(/\bTH-\d+\b/g) || []))];
}

function jobOpts(root, state, file) {
  const contract = require('./contract');
  const jp = jobPaths(root, state.id);
  const acs = contract.parse(contract.read(root, state.id)).acs.map((a) => a.id);
  const tm = path.resolve(file) === path.resolve(jp.threatModel) ? null : readText(jp.threatModel, null);
  return { job: state.id, acs: acs.length ? acs : null, threats: tm ? threatIds(tm) : null, dir: path.dirname(file) };
}

function checkFile(file, opts = {}) {
  const text = readText(file, null);
  if (text === null) fail(`No such file: ${file}`, 'bad_input');
  return { file, ...check(text, { ...opts, file }) };
}

// The templated documents a job has right now, in pipeline order.
function jobDocs(root, jobId) {
  const jp = jobPaths(root, jobId);
  if (!exists(jp.dir)) return [];
  const names = fs.readdirSync(jp.dir);
  const order = ['findings', 'threat-model', 'adr', 'no-adr', 'recommendation', 'contracts', 'ship-report', 'index'];
  return order.flatMap((type) => names.filter((n) => TYPES[type].match.test(n)).sort().map((n) => ({ type, file: path.join(jp.dir, n) })));
}

function checkJob(root, jobId) {
  const job = require('./job');
  const state = job.resolve(root, jobId);
  const results = jobDocs(root, state.id).map((d) => checkFile(d.file, { type: d.type, ...jobOpts(root, state, d.file) }));
  return { job: state.id, ok: results.every((r) => r.ok), docs: results };
}

// Template problems in the design record (ADR, no-adr, recommendation, threat model,
// epic contracts). Used by `factory record` for decide and by the next decide brief.
function designProblems(root, state) {
  const invalidation = require('./invalidation');
  const out = [];
  for (const f of invalidation.designFiles(root, state.id)) {
    const type = typeOf(f, null);
    if (!DESIGN_TYPES.includes(type)) continue;
    const r = checkFile(f, { type, ...jobOpts(root, state, f) });
    for (const p of r.problems) out.push(`${path.basename(f)}: ${p}`);
  }
  return out;
}

// ---------------------------------------------------------------- rendering helpers
function frontBlock(fields) {
  const v = (x) => (Array.isArray(x) ? `[${x.join(', ')}]` : x);
  return ['---', ...Object.entries(fields).filter(([, x]) => x !== undefined && x !== null).map(([k, x]) => `${k}: ${v(x)}`), '---'].join('\n');
}

function cell(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

// First sentence of a section of a doc (e.g. an ADR's Decision), for summaries.
function sectionLead(text, title) {
  const s = sectionsOf(structure(text || '')).find((x) => x.key === norm(title));
  if (!s) return null;
  const b = bare(s.text).split('\n').find((l) => l.trim() && !/^[|#`]/.test(l.trim()));
  return b ? b.trim().replace(/^[-*]\s+/, '').split(/(?<=\.)\s/)[0].slice(0, 240) : null;
}

// ---------------------------------------------------------------- docs index
function index(root, { jobId }) {
  const job = require('./job');
  const ledger = require('./ledger');
  const contract = require('./contract');
  const steps = require('./steps');
  const state = job.resolve(root, jobId);
  const jp = jobPaths(root, state.id);
  const ctx = steps.context(root, state, job.load);
  const parsed = contract.parse(contract.read(root, state.id));
  const entries = ledger.all(root, state.id);
  const date = (entries.length ? entries[entries.length - 1].at : state.created_at || '').slice(0, 10) || '1970-01-01';
  const rows = [];
  const h1 = steps.approved(ctx, state.epic ? 'EH1' : 'H1', ctx.b.contract);
  const cp = contract.problems(parsed);
  if (exists(jp.contract)) rows.push(['contract.md', 'contract', 'contract.md (factory contract)', h1 ? `approved (${state.epic ? 'EH1' : 'H1'})` : 'draft', cp.length ? `${cp.length} problem(s)` : 'ok']);
  const docs = jobDocs(root, state.id).filter((d) => d.type !== 'index');
  const texts = {};
  for (const d of docs) {
    const text = readText(d.file, '');
    texts[path.basename(d.file)] = text;
    const r = check(text, { type: d.type, ...jobOpts(root, state, d.file) });
    const fm = frontMatter(text).front || {};
    rows.push([path.basename(d.file), d.type, fm.template || '—', fm.status || '—', r.ok ? 'ok' : `${r.problems.length} problem(s)`]);
    if (d.type === 'contracts' && exists(jp.contractsJson)) rows.push(['contracts.json', 'contracts (machine)', '—', '—', '—']);
  }
  const planFile = state.epic ? jp.slices : jp.plan;
  const plan = readJson(planFile, null);
  if (plan) rows.push([path.basename(planFile), state.epic ? 'slices' : 'plan', `schemas/${state.epic ? 'slices' : 'plan'}.json`, steps.approved(ctx, state.epic ? 'EH3' : 'H3', ctx.b.plan) ? 'approved' : 'proposed', ledger.freshStep(root, state.id, 'decompose', { plan: ctx.b.plan }) ? 'valid' : '—']);
  const lessonsMd = path.join(project(root).dir, 'lessons', 'lessons.md');
  if (exists(lessonsMd)) rows.push(['../../lessons/lessons.md', 'lessons', 'lessons@1', 'project', '—']);
  const units = plan ? plan.tasks || plan.slices || [] : [];
  const prove = ledger.lastStep(root, state.id, 'prove');
  const design = Object.entries(texts).filter(([n]) => !/^(findings|completion-report)\.md$/.test(n));
  const L = [
    frontBlock({ doc: 'index', template: loadTemplate('index').version, job: state.id, title: state.title, status: 'current', date, contract: 'contract.md', related: docs.map((d) => path.basename(d.file)) }),
    '',
    `# Docs index — ${state.id}: ${state.title}`,
    '',
    '## Documents',
    '',
    '| Document | Type | Template | Status | Check |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
    '',
    '## Traceability',
    '',
    '| AC | Design | Tasks | Proof |',
    '|---|---|---|---|',
    ...parsed.acs.map((ac) => {
      const where = design.filter(([, t]) => idRe(ac.id).test(t)).map(([n]) => n);
      const owners = units.filter((u) => (u.criteria_ids || []).includes(ac.id)).map((u) => u.id);
      const st = prove && prove.detail && prove.detail.acs ? prove.detail.acs[ac.id] : null;
      return `| ${cell(`${ac.id} ${ac.text}`)} | ${cell(where.join(', ') || '—')} | ${cell(owners.join(', ') || '—')} | ${cell(st || 'not proven yet')} |`;
    }),
    ...(parsed.acs.length ? [] : ['| — | — | — | — |']),
    '',
    '## Changelog',
    '',
    '| When | Step | Result |',
    '|---|---|---|',
    ...entries.filter((e) => e.kind === 'step').map((e) => `| ${cell(String(e.at).slice(0, 16))} | ${cell(e.step)} | ${e.ok ? 'ok' : 'not ok'} |`),
    ...(entries.some((e) => e.kind === 'step') ? [] : ['| — | — | — |']),
    '',
  ];
  const file = path.join(jp.dir, 'docs-index.md');
  writeText(file, L.join('\n'));
  return { job: state.id, index: file, docs: rows.length };
}

function list() {
  return Object.entries(TYPES).map(([type, t]) => ({ type, template: loadTemplate(type).version, path: templatePath(type), what: t.what, sections: loadTemplate(type).sections.map((s) => `${s.title}${s.rules.optional ? ' (optional)' : ''}`) }));
}

module.exports = { TYPES, DESIGN_TYPES, template, templatePath, loadTemplate, frontMatter, check, checkFile, checkJob, jobOpts, designProblems, mermaid, structure, typeOf, frontBlock, cell, sectionLead, index, list, threatIds };
