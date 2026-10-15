'use strict';
// The task packet: what a builder needs to build its task to the approved design, assembled
// by the CLI from the job's documents (`task show` returns it as `packet`):
//   - the ADR's Decision and its architecture diagram (the design the human approved at H2);
//   - this task's rows of the ADR's "How each acceptance criterion is met" table;
//   - the ground findings (findings.md) whose source or claim falls inside the task's paths;
//   - the interfaces the task owns and the ones it consumes (plan.json interfaces/consumes);
//   - every other task's objective, paths and dependencies, one line each.

const path = require('path');
const { readText, readJson } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const { matchesAny } = require('../lib/glob');
const invalidation = require('./invalidation');
const docMod = require('./doc');

// The body of one "## Title" section (to the next "## "), without HTML comments.
function section(text, title) {
  const lines = String(text || '').split('\n');
  const want = title.toLowerCase();
  const head = (l) => (/^##\s+/.test(l) ? l.replace(/^##\s+/, '').trim().toLowerCase() : null);
  let i = lines.findIndex((l) => head(l) === want);
  if (i < 0) i = lines.findIndex((l) => head(l) !== null && head(l).startsWith(want));
  if (i < 0) return null;
  const end = lines.findIndex((l, j) => j > i && /^##\s+/.test(l));
  return lines.slice(i + 1, end < 0 ? lines.length : end).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim() || null;
}

function mermaidBlock(text) {
  const m = /```mermaid\n[\s\S]*?```/.exec(String(text || ''));
  return m ? m[0] : null;
}

// Rows of a markdown table as objects keyed by its header cells (lower-cased).
function tableRows(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  if (lines.length < 2) return [];
  const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(2).map((l) => Object.fromEntries(cells(l).map((c, i) => [head[i] || `c${i}`, c])));
}

// findings.md claims ("- <claim> — `source`") whose cited file, or a path in the claim, is
// inside the task's allowed paths.
function findingsFor(text, paths) {
  const out = [];
  let topic = null;
  for (const l of String(text || '').split('\n')) {
    const h = /^###\s+(.+)/.exec(l);
    if (h) topic = h[1].trim();
    const m = /^-\s+(.*?)\s+—\s+(`([^`]*)`|\*\*UNVERIFIED\*\*)\s*$/.exec(l);
    if (!m) continue;
    const source = m[3] || 'UNVERIFIED';
    const files = [source.replace(/:\d+(-\d+)?$/, ''), ...(m[1].match(/[\w./-]+\.[A-Za-z]{1,5}\b/g) || [])].filter((f) => /[./]/.test(f) && !/^https?:/.test(f));
    if (files.some((f) => matchesAny(f.replace(/^\.\//, ''), paths))) out.push({ topic, claim: m[1], source });
  }
  return out.slice(0, 30);
}

const oneLine = (s, n = 160) => {
  const t = String(s || '').split('\n')[0].trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function build(root, state, plan, task) {
  const jp = jobPaths(root, state.id);
  const design = invalidation.designFiles(root, state.id).filter((f) => f.endsWith('.md'));
  const adr = design.find((f) => docMod.typeOf(f) === 'adr') || design.find((f) => docMod.typeOf(f) === 'no-adr') || null;
  const text = adr ? readText(adr, '') : '';
  const isAdr = adr && docMod.typeOf(adr) === 'adr';
  const how = isAdr ? section(text, 'How each acceptance criterion is met') : null;
  const rows = tableRows(how).filter((r) => (task.criteria_ids || []).some((id) => new RegExp(`(^|[^\\w-])${id.replace(/[-]/g, '\\-')}([^\\w-]|$)`).test(r.ac || Object.values(r)[0] || '')));
  const interfaces = (plan.interfaces || []);
  const owns = interfaces.filter((i) => i.owner === task.id);
  const consumes = (task.consumes || []).map((name) => interfaces.find((i) => i.name === name) || { name, owner: null });
  const consumers = (name) => (plan.tasks || []).filter((t) => (t.consumes || []).includes(name)).map((t) => t.id);
  return {
    adr: adr ? path.relative(root, adr) : null,
    plan: path.relative(root, jp.plan),
    findings_file: path.relative(root, jp.findings),
    decision: adr ? section(text, isAdr ? 'Decision' : 'Approach') : null,
    diagram: adr ? mermaidBlock(section(text, 'Architecture diagram') || text) : null,
    criteria_rows: rows,
    findings: findingsFor(readText(jp.findings, ''), task.allowed_paths || []),
    interfaces: {
      owns: owns.map((i) => ({ ...i, consumers: consumers(i.name) })),
      consumes: consumes.map((i) => ({ ...i })),
    },
    siblings: (plan.tasks || []).filter((t) => t.id !== task.id).map((t) => ({ id: t.id, objective: oneLine(t.objective), allowed_paths: t.allowed_paths || [], depends_on: t.depends_on || [], ...(t.consumes && t.consumes.length ? { consumes: t.consumes } : {}) })),
  };
}

function forTask(root, state, taskId) {
  const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
  const task = (plan.tasks || []).find((t) => t.id === taskId);
  return task ? build(root, state, plan, task) : null;
}

module.exports = { build, forTask, section, mermaidBlock, tableRows, findingsFor };
