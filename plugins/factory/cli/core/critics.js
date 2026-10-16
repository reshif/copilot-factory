'use strict';
// Critics with evidence (0.10.0): what the CLI decides around the design and plan critics, and
// what a gate shows of them.
//
//   - denyMode / denyTarget: a human "deny <reason>" at the design gate that names a defect is a
//     targeted revise (the architect fixes it, the critics re-check it: ~3 runs), not a new
//     decide from scratch (3 option generators again: ~7 runs). Only a reason that rejects the
//     approach ("rethink", "different approach", "start over") re-runs the option generators.
//     At the combined design + plan gate, a reason about the plan goes to decompose.
//   - gateView: the parts a combined gate approves, the critics' open objections (shown, never
//     hidden behind an approval), the API ledger and the plan probe.

const path = require('path');
const { readJson, exists } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const { valid } = require('../lib/seal');

const RETHINK = /\b(rethink|re-think|reconsider (the|this) (approach|design|option)|different (approach|design|option)|another (approach|option|design)|start over|from scratch|wrong approach|other options?|new options?)\b/i;
const PLANNY = /\b(plan|task|tasks|T\d+|verify command|verify commands|test command|split|bootstrap|environment|setup|venv|docker|compose|fixed port|sleep|depends_on|allowed paths?)\b/i;
const DESIGNY = /\b(design|adr|decision|api|architecture|diagram|option|library|call|semantic|behaviou?r)\b/i;

function denyMode(reason) {
  return RETHINK.test(String(reason || '')) ? 'rethink' : 'targeted';
}

// Which stage a deny at the combined gate goes back to.
function denyTarget(reason) {
  const r = String(reason || '');
  if (RETHINK.test(r)) return 'decide';
  if (PLANNY.test(r) && !DESIGNY.test(r)) return 'decompose';
  return 'decide';
}

function critique(root, jobId, name) {
  const c = readJson(path.join(jobPaths(root, jobId).critiquesDir, `${name}.json`), null);
  return c && valid(c) ? c : null;
}

const itemLine = (it) => ({
  id: it.id || null,
  critic: it.critic || 'god-eye',
  severity: it.severity,
  issue: String(it.issue || '').slice(0, 400),
  ...(it.evidence ? { evidence: typeof it.evidence === 'string' ? it.evidence.slice(0, 300) : it.evidence } : {}),
  ...(it.verified ? { verified: it.verified } : {}),
});

function ledgerSummary(root, jobId) {
  const deps = require('./deps');
  const l = deps.readLedger(root, jobId);
  const gaps = deps.gaps(root, jobId);
  const have = deps.fetched(root, jobId);
  if (!l && !gaps.length && !have.length) return null;
  return {
    file: deps.LEDGER(root, jobId),
    entries: l ? l.entries.length : 0,
    rejected: l ? (l.rejected || []).length : 0,
    symbols: l ? l.entries.slice(0, 12).map((e) => `${e.id} ${e.symbol} (${e.package} ${e.version}, ${e.file}:${e.line})`) : [],
    packages: have.map((p) => `${p.ecosystem}:${p.name} ${p.version}`),
    gaps: gaps.map((g) => `${g.ecosystem}:${g.name}${g.version ? ` ${g.version}` : ''}: ${g.reason}`),
  };
}

function probeSummary(root, jobId, planHash) {
  const p = readJson(path.join(jobPaths(root, jobId).dir, 'probe.json'), null);
  if (!p || !valid(p)) return null;
  return {
    file: path.join(jobPaths(root, jobId).dir, 'probe.json'),
    current: p.plan === planHash,
    ok: p.ok,
    setup: p.setup ? p.setup.status : null,
    commands: (p.commands || []).map((c) => `${c.task} \`${c.cmd}\` → ${c.class}${c.ok ? '' : ' (problem)'}`).slice(0, 20),
    problems: (p.problems || []).slice(0, 12),
  };
}

// What `factory next` shows at a gate besides the documents, or null.
function gateView(ctx, gate) {
  const { root, state } = ctx;
  if (!['H2', 'EH2', 'H3', 'HF'].includes(gate)) return null;
  const steps = require('./steps');
  const parts = gate === 'H3' ? steps.combinedParts(ctx, gate) : null;
  const showsDesign = gate !== 'H3' || Boolean(parts && 'design' in parts);
  const out = {};
  if (parts) out.approves = Object.keys(parts);
  if (showsDesign) {
    const d = critique(root, state.id, 'design');
    if (d && d.hash === ctx.b.design) {
      out.design_critique = { verdict: d.verdict, rounds: d.rounds, stop: d.stop || null, revised_after_last: Boolean(d.revised_after_last), ...(d.revised_after_last ? { not_rechecked: 'final revision not re-checked by the critics: the architect revised the design after the last critique round, and no critic has read that revision' } : {}), open: (d.open || d.items || []).filter((i) => i.severity !== 'minor').map(itemLine), ...(d.question ? { question: d.question } : {}), ...(d.loop ? { loop: d.loop } : {}) };
    }
    const l = ledgerSummary(root, state.id);
    if (l) out.api_ledger = l;
  }
  if (gate === 'H3') {
    const p = critique(root, state.id, 'plan');
    if (p && p.hash === ctx.b.plan) out.plan_critique = { verdict: p.verdict, open: (p.items || []).filter((i) => i.severity !== 'minor').map(itemLine) };
    const pr = probeSummary(root, state.id, ctx.b.plan);
    if (pr) out.probe = pr;
    if (parts && parts.environment) {
      const e = parts.environment;
      out.environment = { status: e.status, name: (e.env && e.env.name) || null, setup: (e.env && e.env.setup) || [], source: e.source || null, hash: e.short || null, ...(e.status === 'proposed' ? { note: 'Approving this gate also sets this build environment for this repository (.factory/environment.json): other jobs build in it too, and its setup commands run in every worktree on this machine.' } : {}) };
    }
  }
  const open = [...((out.design_critique || {}).open || []), ...((out.plan_critique || {}).open || [])];
  if (open.length) out.objections = `${open.length} objection(s) the critics left open: your call (approve with them, or deny naming what must change; a named defect is fixed by a targeted revise).`;
  return Object.keys(out).length ? out : null;
}

module.exports = { denyMode, denyTarget, gateView, ledgerSummary, probeSummary, critique, RETHINK };
