'use strict';
// Grounded intent: research first, ask only what research can't answer.
//
// Clarify's scout phase (workflows/fanout-judge.js) maps the unknowns (U-n), researches the
// repo and world ones within the risk budget, verifies findings (E-n) and turns confirmed
// ones into evidence-backed assumptions (A-n). This module is the CLI side of it:
//
//   jobs/<J>/intent-evidence.json   the sealed record: unknowns, evidence, assumptions,
//                                   rounds (what docs, the console and the floor read)
//   jobs/<J>/intent-findings.md     rendered from it (templates/docs/intent-findings.md)
//   contract.md                     "## Assumptions (evidence-backed)", written from it
//
// The CLI never takes a scout's word for it: repo quotes are checked against the file,
// web evidence needs a URL and a quote, a high-risk scope-changing claim needs a second
// source, and the resolutions are re-sorted here with the same rules the workflow used.

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, writeText, readText, nowIso, fail, deepMerge, exists } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const { seal, valid } = require('../lib/seal');

const KINDS = ['repo', 'world', 'decision', 'user'];
const IMPACTS = ['high', 'medium', 'low'];
const TIERS = ['official', 'primary', 'standard', 'secondary', 'forum', 'repo'];
const VERDICTS = ['confirmed', 'contradicted', 'unverified', 'unchecked'];
const RESOLUTIONS = ['assumption', 'question', 'answered', 'dismissed', 'deferred', 'dropped', 'pending'];

function files(root, jobId) {
  const d = jobPaths(root, jobId).dir;
  return { json: path.join(d, 'intent-evidence.json'), md: path.join(d, 'intent-findings.md') };
}

// ---------------------------------------------------------------- policy
// policy.intent_research, with the job's snapshot winning (jobs created before the
// setting existed take the live defaults), and the budget for the job's risk.
function settings(root, state) {
  const live = require('./policy').load(root).intent_research || {};
  const snap = (state.policy && state.policy.intent_research) || {};
  const ir = deepMerge(live, snap);
  const b = ((ir.budgets || {})[state.risk]) || { repo_scouts: 3, web_scouts: 1, minutes: 2 };
  return {
    web: ir.web !== false,
    search_mcp: typeof ir.search_mcp === 'string' && ir.search_mcp.trim() ? ir.search_mcp.trim() : null,
    budget: {
      repo_scouts: Math.max(0, Number(b.repo_scouts) || 0),
      web_scouts: Math.max(0, Number(b.web_scouts) || 0),
      time_sec: Math.max(30, Math.round((Number(b.minutes) || 2) * 60)),
      strict_second_source: Boolean(b.strict_second_source),
      unknowns_per_scout: Math.max(1, Number(ir.unknowns_per_scout) || 3),
      max_unknowns: Math.max(1, Number(ir.max_unknowns) || 12),
      verifier_batch: Math.max(1, Number(ir.verifier_batch) || 4),
      max_verifiers: Math.max(1, Number(ir.max_verifiers) || 2),
      mapper_sec: Math.max(30, Number(ir.mapper_seconds) || 180),
    },
  };
}

// ---------------------------------------------------------------- the record
function empty(state) {
  return { version: 1, job: state.id, updated_at: null, rounds: [], web: null, versions: [], unknowns: [], evidence: [], assumptions: [] };
}

// The record, or null when the scout phase never ran. A record that fails its seal is
// reported as tampered (the floor fails on it) instead of being trusted.
function load(root, jobId) {
  const f = files(root, jobId).json;
  if (!exists(f)) return null;
  const d = readJson(f, null);
  if (!d) return null;
  if (!valid(d)) return { ...d, tampered: true };
  return d;
}

function save(root, jobId, data) {
  const { seal: _s, tampered: _t, ...rest } = data;
  writeJson(files(root, jobId).json, seal({ ...rest, updated_at: nowIso() }));
}

const num = (id) => Number(String(id || '').replace(/^[A-Z]-/, '')) || 0;
function nextIds(data) {
  const max = (list) => list.reduce((m, x) => Math.max(m, num(x.id)), 0);
  return { U: max(data.unknowns || []), E: max(data.evidence || []), A: max(data.assumptions || []) };
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const clip = (s, n) => String(s === undefined || s === null ? '' : s).slice(0, n);

function cleanUnknown(u) {
  return {
    id: String(u.id),
    text: clip(u.text, 400),
    kind: KINDS.includes(u.kind) ? u.kind : 'user',
    impact: IMPACTS.includes(u.impact) ? u.impact : 'medium',
    draft: clip(u.draft || u.text, 400),
    ...(Array.isArray(u.options) && u.options.length ? { options: u.options.slice(0, 5).map((o) => clip(o, 160)) } : {}),
    research: ['repo', 'web', 'none'].includes(u.research) ? u.research : u.kind === 'repo' ? 'repo' : u.kind === 'world' ? 'web' : 'none',
    ...(u.search ? { search: clip(u.search, 300) } : {}),
    ...(u.why ? { why: clip(u.why, 300) } : {}),
    resolution: RESOLUTIONS.includes(u.resolution) ? u.resolution : 'pending',
    evidence: Array.isArray(u.evidence) ? u.evidence.map(String) : [],
    assumption: u.assumption || null,
    question_id: u.question_id || null,
    answer: u.answer || null,
    note: u.note ? clip(u.note, 300) : null,
    researched: Boolean(u.researched),
    source: u.source || 'mapper',
    round: u.round || null,
  };
}

function cleanEvidence(e) {
  return {
    id: String(e.id),
    unknown: String(e.unknown || ''),
    claim: clip(e.claim, 500),
    source: clip(e.source, 500),
    source_tier: TIERS.includes(e.source_tier) ? e.source_tier : 'secondary',
    retrieved_at: e.retrieved_at ? clip(e.retrieved_at, 40) : null,
    quote: clip(e.quote, 1000),
    applies_to_version: e.applies_to_version ? clip(e.applies_to_version, 80) : null,
    confidence: IMPACTS.includes(e.confidence) ? e.confidence : 'low',
    scout: e.scout === 'web' ? 'web' : 'repo',
    verdict: VERDICTS.includes(e.verdict) ? e.verdict : 'unchecked',
    verdict_confidence: e.verdict_confidence || null,
    verdict_reason: e.verdict_reason ? clip(e.verdict_reason, 300) : null,
    second_source: e.second_source && e.second_source.source ? { source: clip(e.second_source.source, 500), quote: clip(e.second_source.quote, 500) } : null,
    counter_source: e.counter_source && e.counter_source.source ? { source: clip(e.counter_source.source, 500), quote: clip(e.counter_source.quote, 500) } : null,
    checks: Array.isArray(e.checks) ? e.checks.slice(0, 5) : [],
    round: e.round || null,
  };
}

// Fold one clarify run's scout data (envelope data.scout) into the record. Ids come from
// the workflow, which continued from the brief's next_ids, so new items are new; what the
// human did (answers, overrides, drops) is kept.
function merge(data, sc, round) {
  const out = { ...data, unknowns: data.unknowns.slice(), evidence: data.evidence.slice(), assumptions: data.assumptions.slice(), versions: (data.versions || []).slice(), rounds: (data.rounds || []).slice() };
  if (!sc || typeof sc !== 'object') return out;
  const at = (list, id) => list.findIndex((x) => x.id === id);
  for (const raw of sc.unknowns || []) {
    if (!raw || !/^U-\d+$/.test(raw.id || '')) continue;
    const u = cleanUnknown({ round, ...raw });
    const i = at(out.unknowns, u.id);
    if (i === -1) out.unknowns.push(u);
    else {
      const old = out.unknowns[i];
      const human = ['answered', 'dropped'].includes(old.resolution);
      out.unknowns[i] = { ...old, ...u, ...(human ? { resolution: old.resolution, answer: old.answer } : {}), question_id: old.question_id || u.question_id };
    }
  }
  for (const raw of sc.evidence || []) {
    if (!raw || !/^E-\d+$/.test(raw.id || '')) continue;
    const e = cleanEvidence({ round, ...raw });
    const i = at(out.evidence, e.id);
    if (i === -1) out.evidence.push(e);
    else out.evidence[i] = { ...out.evidence[i], ...e };
  }
  for (const raw of sc.assumptions || []) {
    if (!raw || !/^A-\d+$/.test(raw.id || '')) continue;
    const i = at(out.assumptions, raw.id);
    const a = { id: raw.id, unknown: String(raw.unknown || ''), statement: clip(raw.statement, 500), evidence: (raw.evidence || []).map(String), overridden: false, override: null, dropped: false, withdrawn: false };
    if (i === -1) out.assumptions.push(a);
    else if (!out.assumptions[i].overridden && !out.assumptions[i].dropped) out.assumptions[i] = { ...out.assumptions[i], statement: a.statement, evidence: a.evidence, withdrawn: false };
  }
  for (const v of sc.versions || []) {
    if (v && v.name && !out.versions.some((x) => x.name === v.name)) out.versions.push({ name: clip(v.name, 120), version: clip(v.version, 60), source: clip(v.source, 300) });
  }
  if (sc.web) out.web = { enabled: Boolean(sc.web.enabled), reason: sc.web.reason || null, available: sc.web.available === undefined ? null : sc.web.available, search_mcp: sc.web.search_mcp || null };
  out.rounds.push({
    round,
    at: nowIso(),
    scouted: Boolean(sc.ran),
    mapped: Boolean(sc.map && sc.map.ran),
    map_ok: sc.map ? sc.map.ok : null,
    scouts: (sc.scouts || []).map((s) => ({ label: clip(s.label, 80), mode: s.mode, unknowns: (s.unknowns || []).slice(0, 20), outcome: s.outcome || null })),
    verifiers: Number(sc.verifiers) || 0,
    degraded: (sc.degraded || []).map(String).slice(0, 20),
    budget: sc.budget || null,
  });
  return out;
}

// ---------------------------------------------------------------- CLI checks on evidence
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// "src/a.js:12", "src/a.js:12-20", "src/a.js#L12" → { file, from, to } (lines 1-based) or null.
function repoSource(src) {
  const m = String(src || '').trim().replace(/^`|`$/g, '').match(/^(.+?)(?::|#L)(\d+)(?:[-–](?:L)?(\d+))?$/);
  if (!m || /^https?:/.test(m[1])) return null;
  return { file: m[1], from: Number(m[2]), to: Number(m[3] || m[2]) };
}

// The quote must be at the cited place in the repo (a few lines of slack either side).
function repoQuoteOk(root, e) {
  const s = repoSource(e.source);
  if (!s) return { ok: false, why: `source "${clip(e.source, 80)}" is not path:line` };
  const abs = path.resolve(root, s.file);
  if (!abs.startsWith(path.resolve(root) + path.sep) || abs.includes(`${path.sep}.factory${path.sep}`)) return { ok: false, why: 'source is outside the repository' };
  const text = readText(abs, null);
  if (text === null) return { ok: false, why: `${s.file} does not exist` };
  if (!squash(e.quote)) return { ok: false, why: 'no quote' };
  const lines = text.split('\n');
  const near = lines.slice(Math.max(0, s.from - 4), Math.min(lines.length, s.to + 3)).join('\n');
  if (squash(near).includes(squash(e.quote))) return { ok: true };
  return { ok: false, why: squash(text).includes(squash(e.quote)) ? `quote is in ${s.file} but not at line ${s.from}` : `quote not found in ${s.file}` };
}

// Re-check what the CLI can check itself. Returns the evidence list with verdicts adjusted.
function checkEvidence(root, data, { strict = false } = {}) {
  const uById = Object.fromEntries(data.unknowns.map((u) => [u.id, u]));
  return data.evidence.map((e0) => {
    const e = { ...e0, checks: (e0.checks || []).slice() };
    if (e.cli_checked) return e;
    const down = (why) => {
      if (e.verdict === 'confirmed' || e.verdict === 'unchecked') e.verdict = 'unverified';
      e.verdict_reason = `${why} (CLI check)`;
      e.checks.push(why);
    };
    if (e.scout === 'repo') {
      const q = repoQuoteOk(root, e);
      if (!q.ok) down(q.why);
    } else {
      if (!/^https?:\/\//.test(e.source)) down('web evidence without a URL source');
      else if (!squash(e.quote)) down('web evidence without an exact quote');
      else if (!['official', 'primary', 'standard'].includes(e.source_tier) && e.verdict === 'confirmed' && !e.second_source) down(`a ${e.source_tier} source alone does not confirm a claim`);
    }
    const u = uById[e.unknown];
    if (strict && u && u.impact === 'high' && e.verdict === 'confirmed' && !e.second_source) down('high risk: a scope-changing claim needs a second independent source');
    e.cli_checked = true;
    return e;
  });
}

// ---------------------------------------------------------------- sorting
// Same rules as the workflow's scout phase (workflows can't import, so they're written twice):
//   confirmed evidence → an evidence-backed assumption, stated not asked
//   (a repo finding nobody re-checked counts below high impact, unless the scout had low confidence)
//   contradicted / unverified / nothing found / not researched → a question, saying why
//   user and decision unknowns → questions (decisions carry their evidence per option)
//   low impact, not researched → deferred (assumed and listed)
function usable(e, u) {
  if (!e || e.verdict === 'contradicted' || e.verdict === 'unverified') return false;
  if (e.verdict === 'confirmed') return true;
  return e.scout === 'repo' && u.impact !== 'high' && e.confidence !== 'low';
}

function sort(data) {
  const out = { ...data, unknowns: data.unknowns.map((u) => ({ ...u })), assumptions: data.assumptions.map((a) => ({ ...a })) };
  const evBy = {};
  for (const e of out.evidence) (evBy[e.unknown] = evBy[e.unknown] || []).push(e);
  let nextA = nextIds(out).A;
  for (const u of out.unknowns) {
    const evs = evBy[u.id] || [];
    u.evidence = evs.map((e) => e.id);
    const a = out.assumptions.find((x) => x.unknown === u.id && !x.withdrawn);
    if (a && (a.overridden || a.dropped)) {
      u.resolution = a.dropped ? 'dropped' : 'assumption';
      u.assumption = a.id;
      continue;
    }
    if (['answered', 'dismissed', 'dropped'].includes(u.resolution)) continue;
    const good = evs.filter((e) => usable(e, u));
    let res;
    if (u.kind === 'user') res = 'question';
    else if (u.kind === 'decision') res = u.impact === 'low' && !evs.length ? 'deferred' : 'question';
    else if (good.length) res = 'assumption';
    else if (u.impact === 'low' && !evs.length) res = 'deferred';
    else if (u.resolution === 'pending' && !u.researched) res = 'pending';
    else res = 'question';
    if (res === 'question' && !u.note && evs.length) {
      const bad = evs.filter((e) => !usable(e, u));
      u.note = bad.some((e) => e.verdict === 'contradicted') ? `sources disagree: ${bad.map((e) => `${e.id} ${e.verdict}`).join(', ')}` : `research did not confirm it: ${bad.map((e) => `${e.id} ${e.verdict}${e.verdict_reason ? ` (${e.verdict_reason})` : ''}`).join(', ')}`;
    }
    if (res === 'deferred' && !u.note) u.note = 'low impact: assumed, not researched';
    u.resolution = res;
    if (res === 'assumption') {
      const statement = good.map((e) => e.claim).join('; ');
      const ids = good.map((e) => e.id);
      if (a) Object.assign(a, { statement, evidence: ids, withdrawn: false });
      else {
        nextA += 1;
        out.assumptions.push({ id: `A-${nextA}`, unknown: u.id, statement, evidence: ids, overridden: false, override: null, dropped: false, withdrawn: false });
      }
      u.assumption = a ? a.id : `A-${nextA}`;
    } else if (a) {
      a.withdrawn = true; // its evidence no longer holds: the unknown is asked instead
      u.assumption = null;
    }
  }
  return out;
}

// Answers recorded with `factory answer --id Q-n` settle the unknown that question was for.
function applyAnswers(data, state, answers) {
  const log = state.question_log || [];
  const out = { ...data, unknowns: data.unknowns.map((u) => ({ ...u })) };
  for (const a of answers || []) {
    const q = a.id ? log.find((x) => x.id === a.id) : log.find((x) => norm(x.question) === norm(a.question));
    const uid = q && q.unknown;
    const u = uid && out.unknowns.find((x) => x.id === uid);
    if (u && u.resolution !== 'dropped') {
      u.resolution = 'answered';
      u.answer = clip(a.answer, 400);
      u.question_id = u.question_id || q.id;
    }
  }
  return out;
}

// ---------------------------------------------------------------- the contract section
function liveAssumptions(data) {
  return (data.assumptions || []).filter((a) => !a.withdrawn && !a.dropped);
}

function contractLines(data) {
  return liveAssumptions(data)
    .sort((a, b) => num(a.id) - num(b.id))
    .map((a) => (a.overridden ? `- ${a.id}: ${String(a.override.value).replace(/\s+/g, ' ').trim()} (overridden by user)` : `- ${a.id}: ${String(a.statement).replace(/\s+/g, ' ').trim()} (evidence: ${a.evidence.join(', ')})`));
}

// Write the evidence-backed section into contract.md. Returns true when the text changed.
function writeContract(root, state, data) {
  const contract = require('./contract');
  const f = jobPaths(root, state.id).contract;
  const text = readText(f, null);
  if (text === null) return false;
  const next = contract.setGrounded(text, contractLines(data));
  if (next === text) return false;
  writeText(f, next);
  return true;
}

// ---------------------------------------------------------------- the floor: intent_grounded
// Every world claim cited in Intent and Constraints is confirmed evidence or an open
// (asked or answered) question:
//   - an E-n cited there must exist; world (web) evidence must be confirmed, repo evidence
//     must not be contradicted or unverified
//   - a URL cited there must be the source of confirmed evidence (cite E-n instead)
//   - the evidence-backed assumptions must match the record (ids, evidence, overrides)
//   - every world unknown of medium or high impact is confirmed, asked, answered or dismissed
function groundedProblems(root, state, { data, parsed } = {}) {
  const contract = require('./contract');
  const p = parsed || contract.parse(contract.read(root, state.id));
  const d = data === undefined ? load(root, state.id) : data;
  const out = [];
  if (d && d.tampered) return ['intent-evidence.json fails its seal (edited by hand?): run clarify again'];
  const evById = Object.fromEntries(((d && d.evidence) || []).map((e) => [e.id, e]));
  const confirmedUrls = new Set(((d && d.evidence) || []).filter((e) => e.verdict === 'confirmed').flatMap((e) => [e.source, e.second_source && e.second_source.source].filter(Boolean)));
  for (const c of p.citations || []) {
    for (const id of c.evidence) {
      const e = evById[id];
      if (!e) out.push(`${c.section} cites ${id}, which is not in the intent evidence`);
      else if (e.scout === 'web' && e.verdict !== 'confirmed') out.push(`${c.section} cites ${id} (${clip(e.claim, 60)}), which is ${e.verdict}, not confirmed: ask the user instead`);
      else if (['contradicted', 'unverified'].includes(e.verdict)) out.push(`${c.section} cites ${id}, which is ${e.verdict}`);
    }
    for (const url of c.urls) {
      if (!confirmedUrls.has(url) && !c.evidence.some((id) => evById[id] && (evById[id].source === url))) out.push(`${c.section} cites ${url} without confirmed evidence: cite its E-n or make it a question`);
    }
  }
  const asA = Object.fromEntries(((d && d.assumptions) || []).map((a) => [a.id, a]));
  for (const g of p.groundedAssumptions || []) {
    if (!g.id) continue;
    const a = asA[g.id];
    if (!a || a.withdrawn || a.dropped) {
      out.push(`${g.id} in the contract is not a live evidence-backed assumption (it was withdrawn, dropped or never recorded)`);
      continue;
    }
    if (g.overridden !== Boolean(a.overridden)) out.push(`${g.id}: the contract and the record disagree on whether the user overrode it`);
    if (!g.overridden) {
      for (const id of g.evidence) {
        const e = evById[id];
        if (!e) out.push(`${g.id} cites ${id}, which is not in the intent evidence`);
        else if (!usable(e, (d.unknowns || []).find((u) => u.id === e.unknown) || { impact: 'high' })) out.push(`${g.id} rests on ${id}, which is ${e.verdict}`);
      }
    }
  }
  for (const u of (d && d.unknowns) || []) {
    if (u.kind !== 'world' || u.impact === 'low') continue;
    if (['answered', 'dismissed', 'dropped'].includes(u.resolution)) continue;
    if (u.resolution === 'question' && u.question_id) continue;
    if (u.resolution === 'assumption') {
      const a = asA[u.assumption];
      if (a && (a.overridden || a.evidence.every((id) => evById[id] && evById[id].verdict === 'confirmed'))) continue;
      out.push(`World unknown ${u.id} ("${clip(u.text, 70)}") is assumed on evidence that is not confirmed`);
      continue;
    }
    out.push(`World unknown ${u.id} ("${clip(u.text, 70)}") is neither confirmed by evidence nor asked`);
  }
  return out;
}

// Floor check for floors.js. Jobs whose rulebook (recipe.lock.json) predates the floor pass.
function floorOk(ctx) {
  const { root, state } = ctx;
  const lock = readJson(jobPaths(root, state.id).recipeLock, null);
  if (lock && lock.floors && lock.floors.floors) {
    const all = JSON.stringify(lock.floors.floors);
    if (!all.includes('intent_grounded')) return true;
  }
  return groundedProblems(root, state).length === 0;
}

// ---------------------------------------------------------------- views
const VERDICT_RANK = { confirmed: 0, unchecked: 1, unverified: 2, contradicted: 3 };
const IMPACT_RANK = { high: 0, medium: 1, low: 2 };

// "What I found": the 3–8 findings worth showing, confirmed and high-impact first.
function topFindings(data, max = 8) {
  const uBy = Object.fromEntries(data.unknowns.map((u) => [u.id, u]));
  return data.evidence
    .map((e, i) => ({ e, i, u: uBy[e.unknown] || {} }))
    .sort((a, b) => (IMPACT_RANK[a.u.impact] ?? 3) - (IMPACT_RANK[b.u.impact] ?? 3) || VERDICT_RANK[a.e.verdict] - VERDICT_RANK[b.e.verdict] || a.i - b.i)
    .slice(0, max)
    .map(({ e, u }) => ({ id: e.id, unknown: e.unknown, kind: u.kind || null, impact: u.impact || null, claim: e.claim, source: e.source, source_tier: e.source_tier, retrieved_at: e.retrieved_at, applies_to_version: e.applies_to_version, confidence: e.confidence, verdict: e.verdict }));
}

function assumptionsView(data) {
  return liveAssumptions(data).map((a) => ({ id: a.id, unknown: a.unknown, statement: a.overridden ? a.override.value : a.statement, evidence: a.evidence, overridden: Boolean(a.overridden), ...(a.overridden ? { was: a.statement } : {}) }));
}

function counts(data) {
  const c = { unknowns: data.unknowns.length, by_kind: {}, by_resolution: {}, evidence: data.evidence.length, confirmed: 0, assumptions: liveAssumptions(data).length, overridden: data.assumptions.filter((a) => a.overridden).length, dropped: data.assumptions.filter((a) => a.dropped).length };
  for (const u of data.unknowns) {
    c.by_kind[u.kind] = (c.by_kind[u.kind] || 0) + 1;
    c.by_resolution[u.resolution] = (c.by_resolution[u.resolution] || 0) + 1;
  }
  c.confirmed = data.evidence.filter((e) => e.verdict === 'confirmed').length;
  return c;
}

// Short text for later briefs (later clarify rounds, ground): what research already settled.
function briefText(data, { forGround = false } = {}) {
  if (!data || !data.unknowns.length) return '';
  const evBy = Object.fromEntries(data.evidence.map((e) => [e.id, e]));
  const L = [];
  const settled = data.unknowns.filter((u) => ['assumption', 'answered', 'dismissed'].includes(u.resolution));
  if (settled.length) {
    L.push(`- Settled during clarify (${forGround ? 'do not research these again; cite them' : 'never ask these again'}):`);
    for (const u of settled) {
      const how = u.resolution === 'assumption'
        ? `assumed (${u.assumption}): ${(data.assumptions.find((a) => a.id === u.assumption) || {}).overridden ? `overridden by the user: ${data.assumptions.find((a) => a.id === u.assumption).override.value}` : u.evidence.filter((id) => evBy[id] && usable(evBy[id], u)).map((id) => `${id} ${clip(evBy[id].claim, 120)} [${evBy[id].source}]`).join('; ')}`
        : u.resolution === 'answered' ? `answered by the user: ${clip(u.answer, 160)}` : 'dismissed (does not change the outcome)';
      L.push(`  - ${u.id} [${u.kind}] ${clip(u.text, 140)} → ${how}`);
    }
  }
  const open = data.unknowns.filter((u) => ['question', 'pending', 'deferred'].includes(u.resolution));
  if (open.length) {
    L.push('- Still open or assumed without research:');
    for (const u of open) L.push(`  - ${u.id} [${u.kind}, ${u.impact}] ${clip(u.text, 140)} → ${u.resolution}${u.question_id ? ` (asked as ${u.question_id})` : ''}${u.note ? ` — ${clip(u.note, 120)}` : ''}`);
  }
  if ((data.versions || []).length) L.push(`- Versions in use: ${data.versions.map((v) => `${v.name} ${v.version} (${v.source})`).join(', ')}`);
  const f = data.evidence.filter((e) => e.verdict === 'confirmed' || (e.scout === 'repo' && e.verdict === 'unchecked'));
  if (forGround && f.length) {
    L.push('- Evidence already gathered (reuse it; cite the E-n in your claims instead of re-fetching):');
    for (const e of f.slice(0, 25)) L.push(`  - ${e.id} (${e.unknown}, ${e.verdict}) ${clip(e.claim, 160)} — ${e.source}`);
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- intent-findings.md
function findingsMarkdown(state, data) {
  const doc = require('./doc');
  const { frontBlock, cell, loadTemplate } = doc;
  const c = counts(data);
  const open = data.unknowns.filter((u) => u.resolution === 'question' && !u.answer);
  const last = (data.rounds || [])[data.rounds.length - 1] || {};
  const degraded = (last.degraded || []).length > 0;
  const status = degraded ? 'degraded' : open.length ? 'open' : 'grounded';
  const w = data.web || {};
  const webText = w.enabled === false ? `off (${w.reason || 'policy'})` : w.available === false ? 'unavailable (no network or no web tool)' : w.enabled ? `on${w.search_mcp ? ` (search: ${w.search_mcp})` : ' (no search tool: URLs from package registries and vendor doc roots)'}` : '—';
  const researched = data.unknowns.filter((u) => u.researched).length;
  const L = [
    frontBlock({ doc: 'intent-findings', template: loadTemplate('intent-findings').version, job: state.id, title: state.title, status, date: nowIso().slice(0, 10), contract: 'contract.md', related: ['intent-evidence.json'] }),
    '',
    `# Intent findings — ${state.id}: ${state.title}`,
    '',
    '## Summary',
    '',
    'Research came first: repo and world unknowns were researched within the risk budget, high-impact and web findings re-checked, and only what research could not settle is asked.',
    '',
    '| Unknowns | Researched | Evidence | Confirmed | Assumptions | Questions open | Web research |',
    '|---|---|---|---|---|---|---|',
    `| ${c.unknowns} | ${researched} | ${c.evidence} | ${c.confirmed} | ${c.assumptions} | ${open.length} | ${cell(webText)} |`,
    '',
    '## What we found',
    '',
    '| Evidence | Unknown | Claim | Source | Tier | Retrieved | Version | Confidence | Verdict |',
    '|---|---|---|---|---|---|---|---|---|',
    ...data.evidence.map((e) => `| ${e.id} | ${e.unknown} | ${cell(e.claim)} | ${cell(e.source)} | ${e.source_tier} | ${cell(e.retrieved_at || '—')} | ${cell(e.applies_to_version || '—')} | ${e.confidence} | ${e.verdict}${e.verdict_reason ? `: ${cell(e.verdict_reason)}` : ''} |`),
    ...(data.evidence.length ? [] : ['| — | — | No evidence gathered | — | — | — | — | — | — |']),
    '',
    '## What we are assuming',
    '',
  ];
  const live = liveAssumptions(data);
  for (const a of live) L.push(a.overridden ? `- ${a.id}: ${a.override.value} — **overridden by you** (research said: ${a.statement}; ${a.evidence.join(', ')})` : `- ${a.id}: ${a.statement} (evidence: ${a.evidence.join(', ')}) — reply \`change ${a.id} <value>\` or \`drop ${a.id}\` to override`);
  for (const a of data.assumptions.filter((x) => x.dropped)) L.push(`- ~~${a.id}: ${a.statement}~~ — dropped by you`);
  const deferred = data.unknowns.filter((u) => u.resolution === 'deferred');
  for (const u of deferred) L.push(`- ${u.id} (low impact, not researched): ${u.draft}`);
  if (!live.length && !deferred.length && !data.assumptions.some((x) => x.dropped)) L.push('None.');
  L.push('', '## What only you can answer', '');
  const asks = data.unknowns.filter((u) => ['question', 'answered'].includes(u.resolution));
  for (const u of asks) {
    const tag = u.resolution === 'answered' ? `answered${u.question_id ? ` (${u.question_id})` : ''}: ${u.answer}` : u.question_id ? `asked as ${u.question_id}` : 'not asked yet';
    const why = ['repo', 'world'].includes(u.kind) ? ` — researchable, asked because ${u.note || 'research did not settle it'}` : u.evidence.length ? ` — evidence: ${u.evidence.join(', ')}` : ' — your call';
    L.push(`- ${u.id} [${u.kind}, ${u.impact}] ${u.draft} — ${tag}${why}`);
  }
  if (!asks.length) L.push('None.');
  L.push('', '## Unknowns', '', '| Unknown | Kind | Impact | Resolution | Evidence | Note |', '|---|---|---|---|---|---|');
  for (const u of data.unknowns) L.push(`| ${u.id} ${cell(u.text)} | ${u.kind} | ${u.impact} | ${u.resolution}${u.assumption ? ` (${u.assumption})` : ''}${u.question_id ? ` (${u.question_id})` : ''} | ${cell(u.evidence.join(', ') || '—')} | ${cell(u.note || '—')} |`);
  if (!data.unknowns.length) L.push('| — | — | — | — | — | No unknowns mapped |');
  L.push('', '## Research log', '');
  for (const r of data.rounds || []) {
    L.push(`- Round ${r.round} (${String(r.at).slice(0, 16)}): ${r.scouted ? `${r.mapped ? 'mapped the unknowns; ' : ''}${(r.scouts || []).length} scout(s)${(r.scouts || []).length ? ` (${r.scouts.map((s) => `${s.label}: ${s.outcome}`).join(', ')})` : ''}, ${r.verifiers || 0} verifier(s)` : 'no scout phase'}${(r.degraded || []).length ? `; degraded: ${r.degraded.join(', ')}` : ''}`);
  }
  if ((data.versions || []).length) L.push(`- Versions researched: ${data.versions.map((v) => `${v.name} ${v.version} (${v.source})`).join(', ')}`);
  if (!(data.rounds || []).length) L.push('None.');
  L.push('');
  return L.join('\n');
}

function render(root, state, data) {
  const f = files(root, state.id).md;
  writeText(f, findingsMarkdown(state, data));
  return f;
}

// ---------------------------------------------------------------- human overrides
// "change A-3 <value>" / "drop A-3": the record marks the assumption, the contract section
// is rewritten from it, so the contract hash changes like any contract edit (an H1 shown
// with the old text can no longer be approved; after H1 it is drift → amend).
function override(root, { jobId, id, value, drop = false, via = 'chat' }) {
  const job = require('./job');
  const state = job.resolve(root, jobId);
  if (['closed', 'cancelled', 'abandoned'].includes(state.status)) fail(`${state.id} is ${state.status}; its assumptions can no longer change.`, 'not_active');
  const data = load(root, state.id);
  if (!data || data.tampered) fail(`${state.id} has no intent research yet${data && data.tampered ? ' (its record fails its seal)' : ''}: nothing to ${drop ? 'drop' : 'change'}.`, 'no_assumption');
  const A = String(id || '').toUpperCase();
  const a = data.assumptions.find((x) => x.id === A);
  const live = liveAssumptions(data).map((x) => x.id);
  if (!a || a.withdrawn) fail(`${state.id} has no assumption ${A}.${live.length ? ` Its assumptions: ${live.join(', ')}.` : ''}`, 'no_assumption');
  if (a.dropped) fail(`${A} was already dropped.`, 'no_assumption');
  const v = String(value || '').replace(/\s+/g, ' ').trim();
  if (!drop && !v) fail(`Say the new value: reply "change ${A} <new value>".`, 'needs_value');
  const at = nowIso();
  const before = require('./contract').hash(root, state);
  if (drop) Object.assign(a, { dropped: true, dropped_at: at, dropped_via: via });
  else Object.assign(a, { overridden: true, override: { value: v.slice(0, 500), at, via, was: a.override ? a.override.value : a.statement } });
  const u = data.unknowns.find((x) => x.id === a.unknown);
  if (u) {
    u.resolution = drop ? 'dropped' : 'assumption';
    u.note = drop ? `the user dropped ${A}` : `the user changed ${A}`;
  }
  save(root, state.id, data);
  writeContract(root, state, data);
  render(root, state, data);
  const after = require('./contract').hash(root, state);
  state.counters.assumptions_overridden = (state.counters.assumptions_overridden || 0) + 1;
  job.save(root, state);
  const h1 = state.epic ? 'EH1' : 'H1';
  const approved = state.approvals && state.approvals[h1];
  const next = approved ? `The approved contract changed, so ${h1} no longer covers it: factory next opens an amendment for your approval.` : state.pending_gate && state.pending_gate.id === h1 ? `The contract changed, so ${h1} must be presented again (clarify re-checks it first).` : 'Clarify takes it into account next round.';
  return { job: state.id, assumption: A, action: drop ? 'dropped' : 'changed', value: drop ? null : v, was: a.override ? a.override.was : a.statement, contract_changed: before !== after, message: `${drop ? `Dropped ${A}` : `Changed ${A} to "${v}"`} for ${state.id}. ${next}` };
}

function show(root, jobId) {
  const job = require('./job');
  const state = job.resolve(root, jobId);
  const data = load(root, state.id);
  if (!data) return { job: state.id, researched: false, message: 'No intent research yet: it runs at the start of the clarify fan-out.' };
  return {
    job: state.id,
    researched: true,
    tampered: Boolean(data.tampered),
    file: files(root, state.id).json,
    findings_doc: files(root, state.id).md,
    counts: counts(data),
    web: data.web,
    findings: topFindings(data, 50),
    assumptions: assumptionsView(data),
    unknowns: data.unknowns.map((u) => ({ id: u.id, text: u.text, kind: u.kind, impact: u.impact, resolution: u.resolution, evidence: u.evidence, assumption: u.assumption, question_id: u.question_id, note: u.note })),
    grounded_problems: groundedProblems(root, state, { data }),
  };
}

module.exports = {
  KINDS, IMPACTS, TIERS, files, settings, empty, load, save, nextIds, merge, checkEvidence, repoQuoteOk, repoSource, usable, sort, applyAnswers,
  liveAssumptions, contractLines, writeContract, groundedProblems, floorOk, topFindings, assumptionsView, counts, briefText, findingsMarkdown, render, override, show,
};
