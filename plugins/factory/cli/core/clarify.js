'use strict';
// Clarify v3 (docs/DESIGN-CLARIFY-v3.md): every clarify rule lives in this module.
//
//   read-back ─ok─▶ research (pinned, time-boxed) ─▶ decision sheet ─reply─▶ contract
//   ─▶ readiness (deterministic checks, then God Eye's fixed checklist) ─▶ H1
//   a denial or a redirect ─▶ read back ─ok─▶ restart at the earliest affected stage
//
// The record is jobs/<J>/clarify.json (sealed, version 3). Its items carry a strength (user >
// evidence > accepted > assumption) and a source; routing is recomputed from their current
// state at every stage; identity comes from the ids this module assigns (I-n, P-n, E-n, the
// sheet's numbers, redirect clauses), never from word overlap. workflows/clarify.js only
// dispatches the agents a stage needs and returns their raw replies; `factory record` hands
// them to record() here.

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, readText, writeText, nowIso, fail, deepMerge, exists, sha256 } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const { seal, valid } = require('../lib/seal');

const STAGES = ['readback', 'readback_wait', 'research', 'sheet_wait', 'interpret', 'redirect', 'redirect_wait', 'assemble', 'check', 'ready'];
const WAITS = new Set(['readback_wait', 'sheet_wait', 'redirect_wait']);
const RUNS = new Set(['readback', 'research', 'interpret', 'redirect', 'assemble', 'check']);
const KINDS = ['intent', 'scope', 'fact', 'pin', 'decision', 'question', 'instruction', 'design'];
const STATUSES = ['open', 'to_decide', 'decided', 'assumed', 'deferred', 'done', 'dropped'];
const FINAL = new Set(['decided', 'assumed', 'deferred', 'done', 'dropped']);
const STRENGTH = { user: 4, evidence: 3, accepted: 2, assumption: 1 };
// Where a blocker sends work back, earliest first.
const ORDER = { readback: 0, research: 1, sheet: 2, assemble: 3, check: 4 };
const CHECKLIST = ['intent_clear', 'scope_bounded', 'acs_testable', 'self_consistent', 'facts_honoured', 'instructions_handled', 'decisions_closed'];
const IMPACT = { high: 0, medium: 1, low: 2 };
const SECTIONS = { decisions: '## Decisions', facts: '## Facts relied on', design: '## Design may choose', gaps: '## Research gaps' };
const SECTION_COMMENT = '<!-- Written by the factory from the clarify record (factory clarify status); edit the rest of the contract, not this section. -->';

const clip = (s, n = 400) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const num = (id) => Number(String(id || '').replace(/^[A-Z]+-/, '')) || 0;
const norm = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- the record
function file(root, jobId) {
  return path.join(jobPaths(root, jobId).dir, 'clarify.json');
}

function load(root, jobId) {
  const f = file(root, jobId);
  if (!exists(f)) return null;
  const d = readJson(f, null);
  if (!d) return null;
  if (!valid(d)) return { ...d, tampered: true };
  return d;
}

function save(root, jobId, data) {
  const { seal: _s, tampered: _t, ...rest } = data;
  rest.rev = (rest.rev || 0) + 1;
  rest.updated_at = nowIso();
  writeJson(file(root, jobId), seal(rest));
  data.rev = rest.rev;
  return data;
}

function empty(state) {
  return {
    version: 3, job: state.id, created_at: nowIso(), updated_at: null, rev: 0, stage: 'readback',
    words: [], items: [], plan: [], evidence: [], readback: null, sheets: [], research: { passes: [], failures: [] },
    redirects: [], checks: [], contract: { written_hash: null, checked_hash: null, edited_by_hand: false }, counters: { research_passes: 0, writer_attempts: 0, readback_failures: 0 },
    failures: [], parked: null, denials_seen: null, migration: null, history: [],
  };
}

function nextId(list, prefix) {
  return `${prefix}-${list.reduce((m, x) => Math.max(m, num(x.id)), 0) + 1}`;
}

function log(data, event, text, stage = data.stage) {
  data.history.push({ at: nowIso(), stage, event, ...(text ? { text: clip(text, 300) } : {}) });
  if (data.history.length > 200) data.history = data.history.slice(-200);
}

function itemEvent(it, event, actor, text) {
  it.history = it.history || [];
  it.history.push({ at: nowIso(), event, actor, ...(text ? { text: clip(text, 300) } : {}) });
  if (it.history.length > 40) it.history = it.history.slice(-40);
}

// The job's record: loaded, or migrated from a v1/v2 intent record, or new (with the request).
function get(root, state) {
  const d = load(root, state.id);
  if (d) return d;
  const approved = state.approvals && (state.approvals.H1 || state.approvals.EH1);
  const legacy = require('./intent').load(root, state.id);
  if (legacy && !approved) {
    const m = require('./clarify-migrate').migrate(root, state, legacy);
    return m;
  }
  const data = empty(state);
  if (state.request) addWord(data, state.request, 'request');
  return data;
}

// The record when one exists (read-only callers): null for a job clarify v3 never touched and
// that has nothing to migrate.
function peek(root, state) {
  const d = load(root, state.id);
  if (d) return d;
  const approved = state.approvals && (state.approvals.H1 || state.approvals.EH1);
  if (approved) return null;
  return get(root, state);
}

// ---------------------------------------------------------------- policy
function settings(root, state) {
  const policy = require('./policy');
  const live = policy.load(root);
  const pol = deepMerge(live, state.policy || {});
  const c = deepMerge(live.clarify || {}, (state.policy && state.policy.clarify) || {});
  const ir = pol.intent_research || {};
  const pos = (v, d) => (typeof v === 'number' && v > 0 ? v : d);
  const minutes = (c.research_minutes || {})[state.risk];
  const sec = c.agent_seconds || {};
  const caps = readJson(require('../lib/paths').pluginPath('config', 'workflows', 'clarify.json')).caps || {};
  return {
    research_passes: Math.max(1, pos(c.max_research_passes, caps.max_research_passes || 2)),
    sheet_decisions: Math.max(1, pos(c.max_sheet_decisions, caps.max_sheet_decisions || 5)),
    writer_attempts: Math.max(1, pos(c.max_writer_attempts, caps.max_writer_attempts || 2)),
    research_sec: Math.max(1, Math.round(pos(minutes, { low: 6, medium: 10, high: 15 }[state.risk] || 10) * 60)),
    agent_sec: { interviewer: pos(sec.interviewer, 600), 'brief-writer': pos(sec['brief-writer'], 900), 'contract-writer': pos(sec['contract-writer'], 900), 'god-eye': pos(sec['god-eye'], 900) },
    web: ir.web !== false,
    search_mcp: typeof ir.search_mcp === 'string' && ir.search_mcp.trim() ? ir.search_mcp.trim() : null,
  };
}

// ---------------------------------------------------------------- words (the user's, verbatim)
function addWord(data, text, via, stage = data.stage) {
  const t = String(text || '').trim();
  if (!t) return null;
  const last = data.words[data.words.length - 1];
  // the same reply relayed twice, once by the prompt hook (chat) and once by the main session
  // (the CLI), within a few minutes: recorded once
  const chat = (v) => /chat/.test(String(v || ''));
  if (last && last.text === t && via !== 'request' && chat(last.via) !== chat(via) && Date.now() - Date.parse(last.at) < 10 * 60 * 1000) return { ...last, duplicate: true };
  const w = { id: nextId(data.words, 'W'), at: nowIso(), via, stage, text: t.slice(0, 4000) };
  data.words.push(w);
  return w;
}

function quoted(data, quote) {
  const q = norm(quote);
  if (q.length < 3) return null;
  return data.words.find((w) => norm(w.text).includes(q)) || null;
}

// ---------------------------------------------------------------- items and authority
function newItem(data, fields, actor) {
  const it = {
    id: nextId(data.items, 'I'),
    kind: KINDS.includes(fields.kind) ? fields.kind : 'fact',
    text: clip(fields.text, 300),
    value: fields.value === undefined || fields.value === null ? null : clip(fields.value, 600),
    status: STATUSES.includes(fields.status) ? fields.status : 'open',
    strength: STRENGTH[fields.strength] ? fields.strength : null,
    source: fields.source || null,
    origin: fields.origin || 'readback',
    tag: ['repo', 'docs', 'decision'].includes(fields.tag) ? fields.tag : null,
    impact: IMPACT[fields.impact] !== undefined ? fields.impact : 'medium',
    pins: Array.isArray(fields.pins) ? fields.pins.map((p) => String(p).toLowerCase()) : [],
    needs_research: Boolean(fields.needs_research),
    owner: fields.owner || null,
    evidence: [],
    rejected: [],
    covered: null,
    links: [],
    history: [],
    ...(fields.extra || {}),
  };
  itemEvent(it, 'created', actor || it.origin, fields.why || null);
  data.items.push(it);
  return it;
}

function item(data, id) {
  const R = String(id || '').trim().toUpperCase();
  return data.items.find((x) => x.id === R) || null;
}

// Authority: the user always wins; anyone else needs more strength than the value has.
// Returns true when the value was set; a weaker or equal non-user claim is refused.
function setValue(it, { value, strength, source, actor, status = 'decided', text }) {
  const cur = STRENGTH[it.strength] || 0;
  const neu = STRENGTH[strength] || 0;
  const byUser = strength === 'user' || (strength === 'accepted' && /^user/.test(actor || ''));
  if (!byUser && it.value !== null && cur >= neu) return false;
  if (it.value !== null && it.value !== undefined) itemEvent(it, 'replaced', actor, `was: ${clip(it.value, 160)} (${it.strength || 'none'})`);
  it.value = value === null || value === undefined ? it.value : clip(value, 600);
  it.strength = strength;
  if (source) it.source = source;
  it.status = status;
  itemEvent(it, status, actor, text || value);
  return true;
}

function reopen(it, actor, why) {
  itemEvent(it, 'reopened', actor, why);
  it.status = 'open';
  it.needs_research = Boolean(it.tag && it.tag !== null) || it.kind === 'decision';
  it.covered = null;
  it.shown = null;
  if (it.kind === 'decision') {
    it.strength = null; // the user reopened it: the next answer decides it again
    it.value_before = it.value;
    it.value = null;
  }
}

// ---------------------------------------------------------------- versions and pins
// "==2.4.3", "v2.4.x", "4.2" are pins; ">=2.0,<4.0", "^4.3", "~=3.1" are ranges.
function pinOf(v) {
  const t = String(v || '').trim().replace(/^==\s*/, '').replace(/^v(?=\d)/i, '');
  if (!/^\d+(\.\d+)*(\.x|\.\*)?$/i.test(t)) return null;
  return t.replace(/\.\*$/, '.x').toLowerCase();
}
const parts = (v) => String(v).replace(/\.x$/i, '').split('.').filter(Boolean);
// Does a page for version `doc` document the pinned version `pin`? 2.4.x ↔ 2.4.3, 3.2.25 ↔ 3.2.
function compatible(pin, doc) {
  const a = parts(pin);
  const b = parts(pinOf(doc) || '');
  if (!a.length || !b.length) return false;
  const k = Math.min(a.length, b.length);
  if (k < Math.min(2, a.length)) return false;
  for (let i = 0; i < k; i++) if (a[i] !== b[i]) return false;
  return true;
}
// The version a documentation URL names: { moving: true } for stable/latest/main, a version, or null.
function urlVersion(url) {
  const u = String(url || '').toLowerCase().replace(/[?#].*$/, '');
  if (!/^https?:\/\//.test(u)) return null;
  const segs = u.replace(/^https?:\/\/[^/]+/, '').split('/').filter(Boolean);
  if (segs.some((s) => ['stable', 'latest', 'main', 'master', 'dev', 'devel', 'nightly', 'current'].includes(s))) return { moving: true };
  for (const s of segs) {
    const v = pinOf(s.replace(/^v/, ''));
    if (v && /\./.test(v)) return { version: v };
  }
  return null;
}

// A simple range test, for a user's version against the repo's constraint.
function inRange(version, range) {
  const v = parts(pinOf(version) || '').map(Number);
  if (!v.length) return true;
  const cmp = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  for (const c of String(range).split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(>=|<=|>|<|==|~=|\^|~)?\s*v?([\d.]+)/.exec(c);
    if (!m) continue;
    const r = m[2].split('.').map(Number);
    const d = cmp(v, r);
    const op = m[1] || '==';
    if (op === '>=' && d < 0) return false;
    if (op === '>' && d <= 0) return false;
    if (op === '<' && d >= 0) return false;
    if (op === '<=' && d > 0) return false;
    if ((op === '^' || op === '~=' || op === '~') && (d < 0 || v[0] !== r[0])) return false;
  }
  return true;
}

function pinsBySystem(data) {
  const out = {};
  for (const it of data.items) if (it.kind === 'pin' && it.status === 'decided' && it.value) out[it.system] = it.value;
  return out;
}

// Re-judge every finding against the pins as they stand now (a changed pin invalidates the
// findings that rested on the old one).
function judge(root, data) {
  const pins = pinsBySystem(data);
  for (const e of data.evidence) {
    const prev = e.verdict;
    e.verdict = verdictOf(root, e, pins, data);
    if (prev && prev !== e.verdict) e.rejudged = prev;
  }
  // an item rests only on usable findings; the others stay visible as rejected
  for (const it of data.items) {
    const all = [...new Set([...(it.evidence || []), ...(it.rejected || [])])];
    it.evidence = all.filter((id) => usable(data.evidence.find((e) => e.id === id)));
    it.rejected = all.filter((id) => !it.evidence.includes(id));
    // settled by findings that no longer hold (another version than the one now confirmed)
    if (it.strength === 'evidence' && it.kind !== 'pin' && !it.evidence.length && it.rejected.length) {
      it.strength = 'assumption';
      it.status = 'assumed';
      it.unconfirmed = `its sources document another version (${[...new Set(it.rejected.map((id) => (data.evidence.find((e) => e.id === id) || {}).verdict))].join(', ')})`;
      it.needs_research = Boolean(it.tag);
      itemEvent(it, 'demoted', 'cli', it.unconfirmed);
    }
  }
}

function repoQuoteOk(root, e) {
  const m = /^([^:\s]+):(\d+)(?:-(\d+))?$/.exec(String(e.source || '').trim());
  if (!m) return false;
  const f = path.resolve(root, m[1]);
  if (!f.startsWith(path.resolve(root) + path.sep) || !exists(f)) return false;
  const lines = readText(f, '').split('\n');
  const a = Number(m[2]);
  const b = Number(m[3] || m[2]);
  if (a < 1 || b > lines.length || b < a) return false;
  const span = lines.slice(a - 1, b).join('\n');
  return norm(span).includes(norm(e.quote)) && norm(e.quote).length > 0;
}

function verdictOf(root, e, pins, data) {
  if (e.tier === 'repo' || (!/^https?:/i.test(e.source) && /:\d+/.test(e.source))) return repoQuoteOk(root, e) ? 'repo' : 'bad_quote';
  if (!/^https?:/i.test(e.source) || !String(e.quote || '').trim()) return 'unsourced';
  const it = item(data, e.item);
  const sys = String(e.system || '').toLowerCase() || (it && it.pins.length === 1 ? it.pins[0] : '');
  const pin = sys ? pins[sys] : null;
  if (!pin) return 'docs';
  const u = urlVersion(e.source);
  if (u && u.moving) return 'unpinned';
  if (u && u.version) return compatible(pin, u.version) && (!e.version || compatible(pin, e.version)) ? 'pinned' : 'other_version';
  if (!e.version) return 'unpinned';
  return compatible(pin, e.version) ? 'pinned' : 'other_version';
}

const USABLE = new Set(['repo', 'pinned', 'docs']);
const usable = (e) => Boolean(e && USABLE.has(e.verdict));

// ---------------------------------------------------------------- failures
// What research could not do and still matters: a failure about a plan item that later got a
// usable source (a pinned page after a 3.x one was skipped) is history, not a gap.
function openFailures(data) {
  return data.failures.filter((f) => {
    if (!f.plan) return true;
    const pe = data.plan.find((p) => p.id === f.plan);
    const it = pe && data.items.find((x) => x.id === pe.item);
    return !(it && FINAL.has(it.status) && (it.evidence || []).some((id) => usable(data.evidence.find((e) => e.id === id))));
  });
}

// Sources research found but could not use (another version, a moving page, a quote not at its line).
function skippedSources(data) {
  return data.evidence.filter((e) => !usable(e)).map((e) => ({ source: e.source, why: e.verdict === 'other_version' ? `documents ${e.version || 'another version'}` : e.verdict === 'unpinned' ? 'a moving page (stable/latest), not the confirmed version' : e.verdict === 'bad_quote' ? 'the quote is not at the cited line' : e.verdict }));
}

function addFailure(data, f) {
  const key = `${f.what}|${f.reason}`;
  if (data.failures.some((x) => `${x.what}|${x.reason}` === key)) return;
  data.failures.push({ at: nowIso(), stage: data.stage, ...f, what: clip(f.what, 200), reason: clip(f.reason, 240) });
}

// ---------------------------------------------------------------- routing (by current state)
// Where an item goes now: research, the sheet, the contract, or nowhere (closed).
function route(it, data, S) {
  if (FINAL.has(it.status)) return null;
  if (it.kind === 'pin') return it.status === 'to_decide' ? 'readback' : null;
  if (it.kind === 'question') return 'sheet';
  if (it.kind === 'instruction') return 'assemble';
  if (it.kind === 'intent' || it.kind === 'scope' || it.kind === 'design') return null;
  if (it.needs_research && (S ? data.counters.research_passes < S.research_passes : true)) return 'research';
  if (it.kind === 'decision') return 'sheet';
  return 'settle';
}

// After research (or when research is out of passes): settle facts by their evidence.
function settleFact(data, it) {
  const ev = [...it.evidence, ...(it.rejected || [])].map((id) => data.evidence.find((e) => e.id === id)).filter(Boolean);
  const good = ev.filter(usable);
  if (good.length && it.statement) {
    if (!setValue(it, { value: it.statement, strength: 'evidence', source: { kind: 'evidence', ids: good.map((e) => e.id) }, actor: 'research' })) it.status = it.status === 'open' ? 'decided' : it.status;
    return;
  }
  const why = ev.length ? `only ${[...new Set(ev.map((e) => e.verdict))].join('/')} sources` : (it.gap || 'research found nothing');
  if (it.statement) {
    if (STRENGTH[it.strength] > STRENGTH.assumption) return;
    it.value = clip(it.statement, 600);
    it.strength = 'assumption';
    it.status = 'assumed';
    it.unconfirmed = why;
    itemEvent(it, 'assumed', 'research', `not confirmed: ${why}`);
    return;
  }
  if (it.impact === 'high') {
    it.kind = 'question';
    it.status = 'to_decide';
    it.unconfirmed = why;
    itemEvent(it, 'asked', 'research', `research could not find it out (${why}): the user is asked`);
    return;
  }
  it.status = 'deferred';
  it.owner = 'design';
  it.unconfirmed = why;
  itemEvent(it, 'deferred', 'research', `not researched (${why}): design finds it out`);
}

// The next stage once nothing is running: research, a sheet, the contract, or the read-back.
function advance(data, S) {
  const routes = data.items.map((it) => route(it, data, S));
  if (routes.includes('readback')) return 'readback_wait';
  if (routes.includes('research')) return 'research';
  for (const it of data.items) if (route(it, data, S) === 'settle') settleFact(data, it);
  if (data.items.some((it) => route(it, data, S) === 'sheet')) {
    buildSheet(data, S);
    return 'sheet_wait';
  }
  // facts not shown to the user yet go on a sheet of their own (one turn, they may correct them)
  if (unshownFacts(data).length) {
    buildSheet(data, S);
    return 'sheet_wait';
  }
  return 'assemble';
}

function unshownFacts(data) {
  return data.items.filter((it) => it.kind === 'fact' && ['decided', 'assumed'].includes(it.status) && ['evidence', 'assumption'].includes(it.strength) && !it.shown);
}

// ---------------------------------------------------------------- the read-back
function applyReadback(root, state, data, out) {
  const rb = { n: ((data.readback && data.readback.n) || 0) + 1, at: nowIso(), intent: {}, scope: { in: [], out: [] }, took: [], pins: [], plan: [], questions: [], design: [], dropped: [], confirmed: null };
  const o = out || {};
  for (const k of ['problem', 'who', 'outcome', 'success']) rb.intent[k] = clip((o.intent || {})[k], 300);
  rb.scope.in = (o.scope && Array.isArray(o.scope.in) ? o.scope.in : []).map((x) => clip(x, 200)).slice(0, 10);
  rb.scope.out = (o.scope && Array.isArray(o.scope.out) ? o.scope.out : []).map((x) => clip(x, 200)).slice(0, 10);
  const referenced = new Set();
  const reuse = (ref, kinds) => {
    const it = ref && ref !== 'new' ? item(data, ref) : null;
    if (it && (!kinds || kinds.includes(it.kind) || it.kind === 'question')) {
      referenced.add(it.id);
      return it;
    }
    return null;
  };
  // the intent and scope: the interviewer's restatement, confirmed by the user's ok
  let intentItem = data.items.find((x) => x.kind === 'intent' && x.status !== 'dropped');
  const intentText = `${rb.intent.problem} → ${rb.intent.outcome}`;
  if (!intentItem) intentItem = newItem(data, { kind: 'intent', text: 'The intent', value: intentText, status: 'open', strength: 'assumption', origin: 'readback' }, 'interviewer');
  else if (intentItem.strength !== 'user') {
    intentItem.value = intentText;
    intentItem.status = 'open';
  }
  referenced.add(intentItem.id);
  rb.intent_item = intentItem.id;
  // what the user said: kept only with a quote that is really in their words
  for (const t of (Array.isArray(o.took) ? o.took : []).slice(0, 20)) {
    const w = quoted(data, t.quote);
    if (!w) {
      rb.dropped.push({ what: clip(t.text, 160), why: 'its quote is not in your words' });
      continue;
    }
    let it = reuse(t.item, ['fact', 'decision', 'instruction']);
    if (it) {
      if (it.kind === 'question') it.kind = 'fact';
      setValue(it, { value: clip(t.text, 300), strength: 'user', source: { kind: 'word', ref: w.id, quote: clip(t.quote, 300) }, actor: 'user', text: t.quote });
      if (!it.text || it.kind === 'fact') it.text = clip(t.text, 300);
    } else it = newItem(data, { kind: 'fact', text: t.text, value: t.text, status: 'decided', strength: 'user', source: { kind: 'word', ref: w.id, quote: clip(t.quote, 300) }, origin: 'readback' }, 'user');
    referenced.add(it.id);
    rb.took.push(it.id);
  }
  // user-stated items an earlier read-back had and this one forgot: carried, never dropped
  for (const it of data.items) {
    if (it.strength === 'user' && it.kind === 'fact' && it.status !== 'dropped' && !referenced.has(it.id) && it.source && it.source.kind === 'word') {
      referenced.add(it.id);
      rb.took.push(it.id);
    }
  }
  // version pins: a repo line or the user's own words, never a guess
  const cands = {};
  for (const p of (Array.isArray(o.pins) ? o.pins : []).slice(0, 20)) {
    const system = String(p.system || '').trim().toLowerCase();
    if (!system) continue;
    let src = null;
    if (p.source === 'user') {
      const w = quoted(data, p.quote);
      if (w && norm(p.quote).includes(norm(String(p.version).replace(/\.x$/i, '')))) src = { kind: 'word', ref: w.id, quote: clip(p.quote, 200) };
    } else if (p.source === 'repo' && p.file) {
      if (repoQuoteOk(root, { source: p.file, quote: p.quote })) src = { kind: 'repo', ref: clip(p.file, 200), quote: clip(p.quote, 200) };
    }
    if (!src) {
      rb.dropped.push({ what: `${system} ${clip(p.version, 40)}`, why: p.source === 'user' ? 'not in your words' : 'not at the cited line' });
      continue;
    }
    const exact = pinOf(p.version);
    (cands[system] = cands[system] || []).push({ version: exact || clip(p.version, 60), range: !exact, source: src });
  }
  for (const [system, list] of Object.entries(cands)) {
    let it = data.items.find((x) => x.kind === 'pin' && x.system === system && x.status !== 'dropped');
    const exact = list.filter((c) => !c.range);
    const ranges = list.filter((c) => c.range);
    const user = exact.filter((c) => c.source.kind === 'word');
    const repo = exact.filter((c) => c.source.kind === 'repo');
    const distinct = [];
    for (const c of exact) if (!distinct.some((d) => compatible(d.version, c.version) || compatible(c.version, d.version))) distinct.push(c);
    const outside = user.filter((u) => ranges.some((r) => !inRange(u.version, r.version)));
    const conflict = distinct.length > 1 || outside.length > 0;
    if (!it) it = newItem(data, { kind: 'pin', text: `The ${system} version to research against`, status: 'open', origin: 'readback', extra: { system } }, 'interviewer');
    referenced.add(it.id);
    it.candidates = list;
    if (it.strength === 'user' && it.status === 'decided' && !conflict) {
      // kept: the user settled it before
    } else if (conflict) {
      const rec = repo[0] || exact[0];
      it.status = 'to_decide';
      it.options = distinct.length > 1 ? distinct.map((c, i) => ({ key: String.fromCharCode(97 + i), text: `${c.version} (${c.source.kind === 'word' ? `you said "${c.source.quote}"` : `${c.source.ref}`})`, version: c.version })) : [{ key: 'a', text: `${user[0].version} (you said "${user[0].source.quote}")`, version: user[0].version }];
      it.recommendation = it.options.find((x) => x.version === rec.version) ? it.options.find((x) => x.version === rec.version).key : 'a';
      it.why = distinct.length > 1 ? `the versions disagree; ${rec.source.kind === 'repo' ? `the repository installs ${rec.version}` : 'take the one you stated'}` : `${user[0].version} is outside what the repository allows (${ranges.map((r) => r.version).join(', ')})`;
      itemEvent(it, 'conflict', 'cli', it.why);
    } else if (exact.length) {
      const c = user[0] || exact[0];
      setValue(it, { value: c.version, strength: c.source.kind === 'word' ? 'user' : 'evidence', source: c.source, actor: c.source.kind === 'word' ? 'user' : 'repo' });
    } else {
      it.status = 'open';
      it.why = `the repository only gives a range (${ranges.map((r) => r.version).join(', ')})`;
    }
    it.allows = ranges.map((r) => ({ range: r.version, source: r.source }));
    rb.pins.push(it.id);
  }
  // the plan: what to find out, each tagged repo, docs or decision
  for (const p of (Array.isArray(o.plan) ? o.plan : []).slice(0, 15)) {
    const tag = ['repo', 'docs', 'decision'].includes(p.tag) ? p.tag : 'docs';
    let it = reuse(p.item, ['fact', 'decision']);
    const kind = tag === 'decision' ? 'decision' : 'fact';
    if (it) {
      if (!it.value || STRENGTH[it.strength] < STRENGTH.user) {
        it.kind = it.kind === 'question' ? kind : it.kind;
        it.text = clip(p.what, 300);
        it.tag = tag;
        it.impact = IMPACT[p.impact] !== undefined ? p.impact : it.impact;
        it.pins = Array.isArray(p.pins) ? p.pins.map((x) => String(x).toLowerCase()) : it.pins;
        if (!FINAL.has(it.status) || it.status === 'assumed') it.needs_research = true;
      }
    } else it = newItem(data, { kind, text: p.what, tag, impact: p.impact, pins: p.pins, needs_research: true, origin: 'readback', why: p.why }, 'interviewer');
    if (Array.isArray(p.options) && p.options.length && !it.options) it.options = p.options.slice(0, 5).map((x, i) => ({ key: String.fromCharCode(97 + i), text: clip(typeof x === 'string' ? x : x.text, 200) }));
    referenced.add(it.id);
    let pe = data.plan.find((x) => x.item === it.id);
    if (!pe) {
      pe = { id: nextId(data.plan, 'P'), item: it.id, what: it.text, tag, pins: it.pins };
      data.plan.push(pe);
    } else Object.assign(pe, { what: it.text, tag, pins: it.pins });
    rb.plan.push(it.id);
  }
  for (const q of (Array.isArray(o.questions) ? o.questions : []).slice(0, 5)) {
    let it = reuse(q.item, ['question']);
    if (!it) it = newItem(data, { kind: 'question', text: q.question, status: 'open', impact: 'high', origin: 'readback', why: q.why }, 'interviewer');
    else if (it.status !== 'decided') it.text = clip(q.question, 300);
    it.why_asked = clip(q.why, 200);
    referenced.add(it.id);
    rb.questions.push(it.id);
  }
  for (const d of (Array.isArray(o.design_may_choose) ? o.design_may_choose : []).slice(0, 10)) {
    let it = data.items.find((x) => x.kind === 'design' && norm(x.text) === norm(d));
    if (!it) it = newItem(data, { kind: 'design', text: d, status: 'deferred', owner: 'design', origin: 'readback' }, 'interviewer');
    referenced.add(it.id);
    rb.design.push(it.id);
  }
  // what an earlier read-back proposed and this one no longer does (the user corrected it)
  for (const it of data.items) {
    if (referenced.has(it.id) || it.origin !== 'readback' || it.status === 'dropped' || it.strength === 'user' || !data.readback) continue;
    if (['fact', 'decision', 'question', 'scope', 'design'].includes(it.kind) && !(it.links || []).length) {
      it.status = 'dropped';
      itemEvent(it, 'dropped', 'interviewer', 'not in the new read-back (your edit replaced it)');
    }
  }
  data.readback = rb;
  data.stage = 'readback_wait';
  log(data, 'readback', `read-back ${rb.n}: ${rb.took.length} stated, ${rb.pins.length} pin(s), ${rb.plan.length} to find out, ${rb.questions.length} question(s)`);
}

function readbackScreen(state, data) {
  const rb = data.readback;
  if (!rb) return '';
  const L = [`**Read-back · ${state.id} ${state.title}**`, ''];
  const i = rb.intent;
  L.push('**What you want** (my words; correct me)');
  if (i.problem) L.push(`- Problem: ${i.problem}`);
  if (i.who) L.push(`- Who: ${i.who}`);
  if (i.outcome) L.push(`- Outcome: ${i.outcome}`);
  if (i.success) L.push(`- Success signal: ${i.success}`);
  if (rb.scope.in.length) L.push(`- In scope: ${rb.scope.in.join('; ')}`);
  if (rb.scope.out.length) L.push(`- Out of scope: ${rb.scope.out.join('; ')}`);
  const took = rb.took.map((id) => item(data, id)).filter(Boolean);
  if (took.length) {
    L.push('', '**What I took from your words**');
    took.forEach((it, k) => L.push(`${k + 1}. ${it.value || it.text} — "${(it.source && it.source.quote) || ''}"`));
  }
  const pins = rb.pins.map((id) => item(data, id)).filter(Boolean);
  if (pins.length) {
    L.push('', '**Versions I will research against**');
    for (const p of pins) {
      const allows = (p.allows || []).map((a) => `the repo allows "${a.range}", ${a.source.ref}`).join('; ');
      if (p.status === 'to_decide') {
        L.push(`- **${p.system}: the versions disagree** (a conflict to settle before research): ${p.options.map((o) => `${o.key}) ${o.text}${o.key === p.recommendation ? ' **(recommended)**' : ''}`).join(' · ')}. Why: ${p.why}.`);
      } else if (p.value) {
        const s = p.source || {};
        L.push(`- ${p.system} ${p.value} — ${s.kind === 'word' ? `you said "${s.quote}"` : `${s.ref}: "${s.quote}"`}${allows ? ` (${allows})` : ''}`);
      } else L.push(`- ${p.system}: no exact version (${p.why || allows}); research says which version each source documents`);
    }
  }
  const plan = rb.plan.map((id) => item(data, id)).filter((x) => x && x.status !== 'dropped');
  if (plan.length) {
    L.push('', '**What I will find out**');
    plan.forEach((it, k) => L.push(`${k + 1}. [${it.tag}] ${it.text}`));
  }
  const qs = rb.questions.map((id) => item(data, id)).filter((x) => x && !FINAL.has(x.status));
  if (qs.length) {
    L.push('', '**Only you can tell me**');
    qs.forEach((it, k) => L.push(`${k + 1}. ${it.text}${it.why_asked ? ` (${it.why_asked})` : ''}`));
  }
  const design = rb.design.map((id) => item(data, id)).filter(Boolean);
  if (design.length) L.push('', `**Design may choose:** ${design.map((d) => d.text).join('; ')}.`);
  if (rb.dropped.length) L.push('', `Not taken (no source): ${rb.dropped.map((d) => `${d.what} (${d.why})`).join('; ')}.`);
  if (data.migration && rb.n === 1) L.push('', `Carried over from before v3: ${data.migration.summary}.`);
  L.push('', `Reply **ok** to ${plan.some((x) => x.needs_research) ? 'start research' : 'go on'}${pins.some((p) => p.status === 'to_decide') ? ' (with the recommended version)' : ''}, or tell me in your own words what to change.`);
  return L.join('\n');
}

function confirmReadback(data, word, S) {
  const rb = data.readback;
  rb.confirmed = { at: nowIso(), word: word.id };
  for (const it of data.items) {
    if (it.status === 'dropped') continue;
    if (it.kind === 'intent' && it.strength !== 'user') setValue(it, { value: it.value, strength: 'accepted', actor: 'user (read-back ok)', text: word.text });
    if (it.kind === 'pin' && it.status === 'to_decide') {
      const o = it.options.find((x) => x.key === it.recommendation) || it.options[0];
      setValue(it, { value: o.version, strength: 'accepted', source: { kind: 'word', ref: word.id, quote: word.text }, actor: 'user (read-back ok)', text: `${o.text}` });
      it.resolved = { chose: o.version, by: 'recommended, you accepted' };
    }
    if (it.kind === 'question' && it.status === 'open') it.status = 'to_decide';
  }
  log(data, 'readback_confirmed', word.text);
}

// ---------------------------------------------------------------- research
function researchItems(data, S) {
  return data.items.filter((it) => route(it, data, S) === 'research');
}

function planFor(data, it) {
  let pe = data.plan.find((x) => x.item === it.id);
  if (!pe) {
    pe = { id: nextId(data.plan, 'P'), item: it.id, what: it.text, tag: it.tag || (it.kind === 'decision' ? 'decision' : 'docs'), pins: it.pins };
    data.plan.push(pe);
  }
  return pe;
}

function applyResearch(root, state, data, outputs, runs, S, pass) {
  const rec = { n: data.research.passes.length + 1, at: nowIso(), items: pass.items, scouts: [], brief_ok: false, failures: [] };
  const byPlan = Object.fromEntries(data.plan.map((p) => [p.id, p]));
  const runOf = (label) => (runs || []).filter((r) => r.label === label || r.label === `${label} (retry)`).pop() || null;
  const fail1 = (what, reason, extra = {}) => {
    rec.failures.push({ what, reason });
    addFailure(data, { what, reason, pass: rec.n, ...extra });
  };
  let transient = false;
  for (const s of pass.scouts) {
    const out = outputs[s.label];
    const r = runOf(s.label);
    if (!out) {
      const why = r && r.outcome === 'timeout' ? `timed out after ${r.time_cap_sec || Math.round(S.research_sec)}s` : r && r.outcome ? `${r.outcome}${r.errors && r.errors.length ? `: ${clip(r.errors[0], 120)}` : ''}` : 'returned nothing';
      fail1(`the ${s.mode} researcher`, why);
      rec.scouts.push({ label: s.label, mode: s.mode, ok: false, why });
      transient = true;
      continue;
    }
    rec.scouts.push({ label: s.label, mode: s.mode, ok: true });
    if (s.mode === 'docs' && out.web_available === false) fail1('the web', `web unavailable: ${clip(((out.unresolved || [])[0] || {}).reason || 'no network', 160)}`);
    for (const f of out.failed_sources || []) fail1(clip(f.source, 200), clip(f.reason, 160), { plan: f.plan || null });
    for (const u of out.unresolved || []) {
      const pe = byPlan[u.plan];
      if (!pe) continue;
      const it = item(data, pe.item);
      if (it) it.gap = clip(`${s.mode}: ${u.reason}`, 200);
      if (!/preference|no documentation needed/i.test(u.reason || '')) fail1(pe.what, `${s.mode} research: ${clip(u.reason, 160)}`, { plan: pe.id });
    }
    for (const e of (out.evidence || []).slice(0, 40)) {
      const pe = byPlan[e.plan];
      if (!pe || !pass.items.includes(pe.item)) continue;
      const dup = data.evidence.find((x) => x.source === clip(e.source, 400) && x.item === pe.item && norm(x.quote) === norm(e.quote));
      if (dup) {
        // found again: it counts for this pass too
        dup.passes = [...new Set([...(dup.passes || [dup.pass]), rec.n])];
        continue;
      }
      const ev = { id: nextId(data.evidence, 'E'), item: pe.item, plan: pe.id, claim: clip(e.claim, 300), source: clip(e.source, 400), quote: clip(e.quote, 400), version: e.version ? clip(e.version, 40) : null, system: e.system ? clip(e.system, 60).toLowerCase() : null, tier: e.source_tier || (s.mode === 'repo' ? 'repo' : 'official'), retrieved_at: e.retrieved_at || null, by: s.mode, pass: rec.n, passes: [rec.n], ...(e.contradicts ? { contradicts: String(e.contradicts).toUpperCase() } : {}) };
      data.evidence.push(ev);
      const it = item(data, pe.item);
      if (it && !it.evidence.includes(ev.id)) it.evidence.push(ev.id);
    }
  }
  judge(root, data);
  for (const e of data.evidence.filter((x) => x.pass === rec.n && !usable(x))) {
    const pin = pinsBySystem(data)[e.system || (item(data, e.item) || { pins: [] }).pins[0]];
    const why = e.verdict === 'other_version' ? `documents ${e.version || (urlVersion(e.source) || {}).version || 'another version'}, not the confirmed ${pin}` : e.verdict === 'unpinned' ? `documents the latest release (${(urlVersion(e.source) || {}).moving ? 'a moving page' : 'no version'}), not the confirmed ${pin}` : e.verdict === 'bad_quote' ? 'the quote is not at the cited line' : 'no source quote';
    fail1(e.source, `skipped: ${why}`, { plan: e.plan });
  }
  // the brief: decision records and facts
  const brief = outputs[pass.brief];
  if (brief) {
    rec.brief_ok = true;
    data.research.summary = clip(brief.summary, 600);
    const evFor = (it, sources) => {
      const out = [];
      for (const s of sources || []) {
        const e = data.evidence.find((x) => x.item === it.id && x.source === clip(s, 400)) || data.evidence.find((x) => x.source === clip(s, 400));
        if (e && !out.includes(e.id)) out.push(e.id);
      }
      return out;
    };
    for (const r of brief.records || []) {
      const pe = byPlan[r.plan];
      const it = pe && item(data, pe.item);
      if (!it || !pass.items.includes(it.id)) continue;
      const ids = evFor(it, r.evidence);
      const good = ids.filter((id) => usable(data.evidence.find((e) => e.id === id)));
      const better = !it.record || good.length >= (it.record.usable || 0);
      if (!better) continue;
      it.kind = 'decision';
      it.options = (r.options || []).slice(0, 5).map((x, i) => ({ key: String(x.key || String.fromCharCode(97 + i)).toLowerCase(), text: clip(x.text, 200), consequences: clip(x.consequences, 200) }));
      it.recommendation = it.options.some((x) => x.key === String(r.recommendation || '').toLowerCase()) ? String(r.recommendation).toLowerCase() : null;
      it.why = clip(r.why, 300);
      it.record = { pass: rec.n, evidence: ids, usable: good.length };
      it.evidence = [...new Set([...it.evidence, ...ids])];
      it.researched = good.length > 0;
    }
    for (const f of brief.facts || []) {
      const pe = byPlan[f.plan];
      const it = pe && item(data, pe.item);
      if (!it || !pass.items.includes(it.id)) continue;
      const ids = evFor(it, f.evidence);
      it.statement = clip(f.statement, 400);
      it.evidence = [...new Set([...it.evidence, ...ids])];
      if (f.contradicts) contradiction(data, it, String(f.contradicts).toUpperCase(), ids);
    }
    for (const g of brief.gaps || []) {
      const pe = byPlan[g.plan];
      const it = pe && item(data, pe.item);
      if (it) it.gap = clip(g.why, 200);
    }
  } else {
    const r = runOf(pass.brief);
    fail1('the brief writer', r && r.outcome === 'timeout' ? `timed out after ${r.time_cap_sec}s` : r && r.outcome ? r.outcome : 'returned nothing');
  }
  // contradictions the researchers flagged themselves
  for (const e of data.evidence.filter((x) => x.pass === rec.n && x.contradicts && usable(x))) contradiction(data, item(data, e.item), e.contradicts, [e.id]);
  judge(root, data);
  data.research.passes.push(rec);
  data.counters.research_passes += 1;
  const lacking = pass.items.map((id) => item(data, id)).filter((it) => it && !it.evidence.some((id) => usable(data.evidence.find((e) => e.id === id))) && it.impact !== 'low');
  const moreAllowed = data.counters.research_passes < S.research_passes;
  if (!brief) {
    if (moreAllowed) {
      data.research.retry = { brief_only: rec.scouts.every((s) => s.ok), items: pass.items, failed: rec.scouts.filter((s) => !s.ok).map((s) => s.mode) };
      log(data, 'research_retry', 'the brief writer returned nothing: one more pass');
      return { next: 'research', retry: true };
    }
    data.parked = { kind: 'research', stage: 'research', reason: `Research could not produce a brief in ${data.counters.research_passes} pass(es): the brief writer ${rec.failures.find((f) => f.what === 'the brief writer').reason}.` };
    return { next: 'park' };
  }
  if (transient && lacking.length && moreAllowed) {
    data.research.retry = { brief_only: false, items: lacking.map((x) => x.id), failed: rec.scouts.filter((s) => !s.ok).map((s) => s.mode) };
    log(data, 'research_retry', `${rec.failures.length} failure(s); ${lacking.length} item(s) still without a usable source: one more pass`);
    return { next: 'research', retry: true };
  }
  data.research.retry = null;
  for (const id of pass.items) {
    const it = item(data, id);
    if (!it) continue;
    it.needs_research = false;
    if (it.kind === 'decision' && it.researched === undefined) it.researched = false;
  }
  return { next: 'route' };
}

// Pinned evidence against something the user said: a decision for the user, never an overwrite.
function contradiction(data, factItem, ref, ids) {
  const said = item(data, ref);
  if (!said || said.strength !== 'user' || !factItem) return;
  if (data.items.some((x) => x.contradiction && x.contradiction.said === said.id && x.status !== 'dropped')) return;
  const ev = ids.map((id) => data.evidence.find((e) => e.id === id)).filter(usable);
  if (!ev.length) return;
  const quote = (said.source && said.source.quote) || said.value;
  const it = newItem(data, { kind: 'decision', text: `You said "${clip(quote, 160)}"; ${clip(ev[0].claim, 200)}`, status: 'to_decide', impact: 'high', origin: 'research', extra: { contradiction: { said: said.id, fact: factItem.id }, researched: true } }, 'research');
  it.options = [{ key: 'a', text: `Go by the source: ${clip(ev[0].claim, 200)}`, consequences: 'the contract follows the documentation' }, { key: 'b', text: `Keep what you said: ${clip(said.value, 200)}`, consequences: 'the contract follows your statement against the documentation' }];
  it.recommendation = 'a';
  it.why = `the documentation${ev[0].version ? ` for ${ev[0].version}` : ''} says otherwise`;
  it.evidence = ev.map((e) => e.id);
  said.challenged_by = it.id;
  itemEvent(said, 'challenged', 'research', `${ev[0].source}: ${ev[0].claim}`);
}

// ---------------------------------------------------------------- the decision sheet
function buildSheet(data, S) {
  const pending = data.items.filter((it) => route(it, data, S) === 'sheet').sort((a, b) => IMPACT[a.impact] - IMPACT[b.impact] || (a.contradiction ? -1 : 0) - (b.contradiction ? -1 : 0) || num(a.id) - num(b.id));
  const asked = new Set(data.sheets.flatMap((s) => s.decisions.filter((d) => d.answered).map((d) => d.item)));
  const take = pending.slice(0, S.sheet_decisions);
  const n = data.sheets.length + 1;
  const decisions = take.map((it, i) => {
    it.status = 'to_decide';
    return { no: i + 1, id: `D-${n}.${i + 1}`, item: it.id, question: it.text, options: it.options || [], recommendation: it.recommendation || null, why: it.why || null, researched: Boolean(it.researched), evidence: it.evidence.filter((id) => usable(data.evidence.find((e) => e.id === id))), gap: it.gap || it.unconfirmed || null, reasked: asked.has(it.id), answered: null, kind: it.kind };
  });
  const facts = unshownFacts(data).map((it, i) => {
    it.shown = n;
    return { no: i + 1, item: it.id, text: it.value, source: factSource(data, it) };
  });
  data.sheets.push({ n, at: nowIso(), decisions, facts, queued: pending.length - take.length, answered_at: null, failures_at: data.failures.length });
  log(data, 'sheet', `sheet ${n}: ${decisions.length} decision(s), ${facts.length} fact(s), ${pending.length - take.length} waiting`);
}

function currentSheet(data) {
  const s = data.sheets[data.sheets.length - 1];
  return s && !s.answered_at ? s : null;
}

function evidenceText(data, ids, n = 2) {
  return ids.map((id) => data.evidence.find((e) => e.id === id)).filter(usable).slice(0, n).map((e) => `${e.source}${e.verdict === 'pinned' && e.version ? ` (${e.version})` : ''}, ${e.id}`).join('; ');
}

function factSource(data, it) {
  const s = it.source || {};
  if (it.strength === 'user') return s.quote ? `your words: "${clip(s.quote, 120)}"` : 'you';
  const ev = it.evidence.map((id) => data.evidence.find((e) => e.id === id)).filter(usable);
  if (it.strength === 'evidence' && ev.length) return ev.slice(0, 2).map((e) => (e.verdict === 'repo' ? `${e.source}` : `${e.source}${e.version ? ` (${e.version})` : ''}`) + `, ${e.id}`).join('; ');
  if (it.strength === 'accepted') return `you accepted it${ev.length ? ` (${ev[0].source})` : ''}`;
  return `my assumption, not confirmed: ${it.unconfirmed || 'no source'}`;
}

function sheetScreen(state, data) {
  const s = currentSheet(data);
  if (!s) return '';
  const passes = data.research.passes.length;
  const L = [`**Decisions · ${state.id}**${passes ? ` (research: ${passes} pass${passes > 1 ? 'es' : ''})` : ''}`, ''];
  for (const d of s.decisions.filter((x) => !x.answered)) {
    L.push(`${d.no}. **${d.question}**${d.reasked ? ' (reopened)' : ''}`);
    for (const o of d.options) L.push(`   - ${o.key}) ${o.text}${o.key === d.recommendation ? ' **(recommended)**' : ''}`);
    if (!d.options.length) L.push('   - (no options: answer in your own words)');
    const ev = evidenceText(data, d.evidence);
    if (d.recommendation && d.why) L.push(`   Why ${d.recommendation}: ${d.why}${ev ? ` (${ev})` : d.researched ? '' : ' — my recommendation; no source decides this'}`);
    if (!d.researched) {
      const fails = data.failures.filter((f) => f.plan && data.plan.some((p) => p.id === f.plan && p.item === d.item)).map((f) => f.reason);
      const web = data.failures.find((f) => f.what === 'the web');
      const timeout = data.failures.find((f) => / researcher$/.test(f.what) && /timed out/.test(f.reason));
      const why = d.gap || fails[0] || (web && web.reason) || (timeout && `the ${timeout.what.replace(/^the /, '')} ${timeout.reason}`) || null;
      if (why && !/preference/.test(why)) L.push(`   Not researched: ${why}.`);
    }
    if (!d.recommendation) L.push('   No recommendation: answer it yourself, or "defer" it to design.');
  }
  const facts = s.facts;
  if (facts.length) {
    L.push('', "**Facts I'll assume** (say if one is wrong)");
    for (const f of facts) L.push(`${f.no}. ${f.text} (${f.source})`);
  }
  const fails = openFailures(data).filter((f) => !/^skipped:/.test(f.reason)).slice(0, 12);
  if (fails.length) {
    L.push('', '**Not researched**');
    for (const f of fails) L.push(`- ${f.what}: ${f.reason}`);
  }
  const skipped = skippedSources(data);
  if (skipped.length) {
    L.push('', `**Sources skipped** (not relied on)`);
    for (const k of skipped.slice(0, 8)) L.push(`- ${k.source}: ${k.why}`);
  }
  if (s.queued) L.push('', `${s.queued} more decision(s) come on the next sheet.`);
  L.push('', 'Reply **ok** to take my recommendations, or say what to change: **ok, but 2 b**, **3: other: <your words>**, **2 defer**, **fact 1: <correction>**. Plain words work too.');
  return L.join('\n');
}

const ACCEPT = /^(ok|okay|k|yes|y|yep|yeah|go|go ahead|proceed|accept(ed)?|accept all|agreed|fine|sure|looks good|lgtm|sounds good|correct|right|confirmed?|as recommended|take (your|the) recommendations?|all recommended|start|start research)[.!]*$/i;
const ACCEPT_HEAD = /^(ok|okay|yes|yep|fine|sure|agreed|looks good|lgtm|sounds good|accept(?: all)?|go ahead)\s*[,.;:!]?\s*(?:but|except|and|although|though)?\s*[,:;-]?\s*/i;

// A sheet reply in plain words: { accept, answers: [{no, choice|text|defer}], facts: [{no, text}] },
// or null when it is not that shape (it goes to the interviewer then).
function parseSheetReply(text, sheet) {
  let t = String(text || '').trim();
  if (!t) return null;
  if (ACCEPT.test(t)) return { accept: true, answers: [], facts: [] };
  let accept = false;
  const head = ACCEPT_HEAD.exec(t);
  if (head && head[0].trim() && t.length > head[0].length) {
    accept = true;
    t = t.slice(head[0].length).trim();
  }
  const segs = t.includes('\n') ? t.split('\n').map((x) => x.trim()).filter(Boolean) : t.split(/[;,]\s*(?=(?:fact\s*|f)?\d{1,2}\s*(?:[:.)\-]|\s+[a-e]\b|\s+(?:ok|defer|other)))/i).map((x) => x.trim()).filter(Boolean);
  const answers = [];
  const facts = [];
  for (const seg of segs) {
    const m = /^(fact\s*|f)?(\d{1,2})\s*[:.)\-]?\s*(.*)$/i.exec(seg);
    if (!m || !m[3].trim()) return null;
    const no = Number(m[2]);
    const body = m[3].trim().replace(/[.!]+$/, '');
    if (m[1]) {
      if (!sheet.facts.some((f) => f.no === no)) return null;
      facts.push({ no, text: body });
      continue;
    }
    if (!sheet.decisions.some((d) => d.no === no)) return null;
    let a;
    const key = /^\(?([a-e])\)?$/i.exec(body);
    if (key) a = { no, choice: key[1].toLowerCase() };
    else if (/^(ok|okay|yes|recommended|as recommended|fine|agreed)$/i.test(body)) a = { no, choice: 'recommended' };
    else if (/^(defer|deferred|later|skip|design( decides)?|you decide|your call|let design decide)$/i.test(body)) a = { no, defer: true };
    else {
      const other = /^other\s*[:\-]?\s*(.+)$/i.exec(body);
      a = { no, text: other ? other[1].trim() : body };
    }
    answers.push(a);
  }
  if (!answers.length && !facts.length) return accept ? { accept: true, answers: [], facts: [] } : null;
  return { accept, answers, facts };
}

function applySheet(data, sheet, parsed, word, how = 'reply') {
  const out = { decided: [], open: [], facts: [] };
  const actor = how === 'interpret' ? 'user (read by the interviewer)' : 'user';
  for (const a of parsed.answers) {
    const d = sheet.decisions.find((x) => x.no === a.no);
    const it = d && item(data, d.item);
    if (!it || d.answered) continue;
    if (a.defer) {
      it.status = 'deferred';
      it.owner = 'design';
      it.strength = 'user';
      it.value = 'deferred to design';
      itemEvent(it, 'deferred', actor, word.text);
    } else if (a.choice === 'recommended') {
      if (!d.recommendation) continue;
      const o = d.options.find((x) => x.key === d.recommendation);
      setValue(it, { value: o.text, strength: 'accepted', source: { kind: 'sheet', ref: d.id, word: word.id }, actor: `${actor} (accepted the recommendation)`, text: word.text });
    } else if (a.choice) {
      const o = d.options.find((x) => x.key === a.choice);
      if (!o) continue;
      setValue(it, { value: o.text, strength: 'user', source: { kind: 'sheet', ref: d.id, word: word.id, quote: a.quote || `${d.no} ${a.choice}` }, actor, text: word.text }); // the user's own words when the interviewer quoted them
    } else {
      setValue(it, { value: a.text, strength: 'user', source: { kind: 'word', ref: word.id, quote: a.quote || a.text }, actor, text: word.text });
    }
    d.answered = { at: nowIso(), word: word.id, how };
    out.decided.push(it.id);
    afterDecision(data, it);
  }
  if (parsed.accept) {
    for (const d of sheet.decisions.filter((x) => !x.answered)) {
      const it = item(data, d.item);
      if (!it || !d.recommendation) continue;
      const o = d.options.find((x) => x.key === d.recommendation);
      setValue(it, { value: o.text, strength: 'accepted', source: { kind: 'sheet', ref: d.id, word: word.id }, actor: `${actor} (accepted the recommendation)`, text: word.text });
      d.answered = { at: nowIso(), word: word.id, how };
      out.decided.push(it.id);
      afterDecision(data, it);
    }
  }
  for (const f of parsed.facts || []) {
    const sf = sheet.facts.find((x) => x.no === f.no);
    const it = sf && item(data, sf.item);
    if (!it) continue;
    if (/^(ok|yes|right|correct)$/i.test(f.text)) continue;
    setValue(it, { value: f.text, strength: 'user', source: { kind: 'word', ref: word.id, quote: f.text }, actor, text: word.text });
    sf.corrected = word.id;
    out.facts.push(it.id);
  }
  if (parsed.accept) {
    for (const sf of sheet.facts) {
      const it = item(data, sf.item);
      if (it && !sf.corrected && it.strength === 'assumption') setValue(it, { value: it.value, strength: 'accepted', actor: 'user (accepted the facts)', status: 'decided', text: word.text });
    }
  }
  out.open = sheet.decisions.filter((d) => !d.answered).map((d) => d.no);
  if (!out.open.length) sheet.answered_at = nowIso();
  return out;
}

// A decided contradiction settles the user's statement it was about.
function afterDecision(data, it) {
  if (!it.contradiction) return;
  const said = item(data, it.contradiction.said);
  if (!said) return;
  const tookSource = /^Go by the source/.test(it.value || '');
  said.superseded = tookSource ? { by: it.id, value: it.value } : null;
  itemEvent(said, tookSource ? 'superseded' : 'kept', 'user', it.value);
}

// ---------------------------------------------------------------- redirects
function startRedirect(data, text, via, gate = null) {
  const w = addWord(data, text, via);
  const R = { id: nextId(data.redirects, 'R'), at: nowIso(), gate, word: w.id, text: w.text, status: 'interpreting', clauses: [], from_stage: data.stage };
  data.redirects.push(R);
  data.stage = 'redirect';
  log(data, 'redirect', text);
  return R;
}

function currentRedirect(data) {
  return [...data.redirects].reverse().find((r) => ['interpreting', 'to_confirm'].includes(r.status)) || null;
}

// The redirect's sentences: what must each be quoted by some clause.
function sentences(text) {
  return String(text).split(/(?<=[.;!?])\s+|;\s*/).map((x) => x.trim().replace(/[.;]+$/, '')).filter((x) => x.length >= 6);
}

function applyRedirect(data, out) {
  const R = currentRedirect(data);
  if (!R) return;
  const clauses = [];
  for (const c of (out && Array.isArray(out.clauses) ? out.clauses : []).slice(0, 12)) {
    if (!norm(R.text).includes(norm(c.quote)) || norm(c.quote).length < 4) continue;
    const it = c.item && c.item !== 'new' ? item(data, c.item) : null;
    const action = ['research', 'decide', 'fix', 'fact', 'instruction'].includes(c.action) ? c.action : 'instruction';
    clauses.push({ n: clauses.length + 1, quote: clip(c.quote, 400), item: it ? it.id : null, action, text: clip(c.text || c.quote, 300), tag: ['repo', 'docs'].includes(c.tag) ? c.tag : null });
  }
  // conservation: a sentence no clause quotes becomes an instruction, verbatim
  for (const s of sentences(R.text)) {
    if (clauses.some((c) => norm(c.quote).includes(norm(s)) || norm(s).includes(norm(c.quote)))) continue;
    clauses.push({ n: clauses.length + 1, quote: s, item: null, action: 'instruction', text: s, tag: null, unread: true });
  }
  R.clauses = clauses;
  R.status = 'to_confirm';
  data.stage = 'redirect_wait';
}

const ACTION_TEXT = { research: 'research it, then decide', decide: 'put it on the decision sheet', fix: 'change the contract', fact: 'record it as your fact', instruction: 'follow it when the contract is written' };

function redirectScreen(state, data) {
  const R = currentRedirect(data);
  if (!R) return '';
  const L = [`**Your redirect · ${state.id}** — I took it as:`, ''];
  for (const c of R.clauses) {
    const it = c.item && item(data, c.item);
    L.push(`${c.n}. "${c.quote}" → ${ACTION_TEXT[c.action]}${it ? ` (reopens: ${it.text})` : ' (new)'}`);
  }
  L.push('', 'Reply **ok** and I restart from the earliest step this touches, or tell me what I got wrong.');
  return L.join('\n');
}

const STAGE_OF = { research: 'research', decide: 'research', fix: 'assemble', fact: 'assemble', instruction: 'assemble' };

function confirmRedirect(data, word) {
  const R = currentRedirect(data);
  R.status = 'confirmed';
  R.confirmed = { at: nowIso(), word: word.id };
  for (const c of R.clauses) {
    let it = c.item ? item(data, c.item) : null;
    if (c.action === 'research' || c.action === 'decide') {
      if (it) {
        if (c.tag && !it.tag) it.tag = c.tag;
        if (!it.tag || it.tag === 'decision') it.tag = c.tag || (it.kind === 'decision' ? 'docs' : it.tag);
        reopen(it, 'user (redirect)', c.quote);
        it.needs_research = true;
      } else {
        it = newItem(data, { kind: c.action === 'decide' ? 'decision' : 'fact', text: c.text, tag: c.tag || 'docs', impact: 'high', needs_research: true, origin: 'redirect', pins: Object.keys(pinsBySystem(data)) }, 'user (redirect)');
      }
      if (!it.pins.length) it.pins = Object.keys(pinsBySystem(data)).slice(0, 2);
    } else if (c.action === 'fact') {
      if (it) setValue(it, { value: c.text, strength: 'user', source: { kind: 'word', ref: word.id === R.word ? R.word : R.word, quote: c.quote }, actor: 'user (redirect)' });
      else it = newItem(data, { kind: 'fact', text: c.text, value: c.text, status: 'decided', strength: 'user', source: { kind: 'word', ref: R.word, quote: c.quote }, origin: 'redirect' }, 'user (redirect)');
    } else {
      it = newItem(data, { kind: 'instruction', text: c.text, value: c.quote, status: 'open', strength: 'user', source: { kind: 'word', ref: R.word, quote: c.quote }, origin: 'redirect' }, 'user (redirect)');
    }
    it.links = [...new Set([...(it.links || []), R.id])];
    c.item = it.id;
    c.stage = STAGE_OF[c.action];
    c.started_at = nowIso();
    c.pass_at = data.research.passes.length;
    planFor(data, it);
  }
  // the decisions the redirect touches are asked again once they are researched
  data.counters.research_passes = 0;
  data.counters.writer_attempts = 0;
  const earliest = R.clauses.map((c) => ORDER[c.stage]).reduce((m, x) => Math.min(m, x), 9);
  R.restart = Object.keys(ORDER).find((k) => ORDER[k] === earliest) || 'assemble';
  log(data, 'redirect_confirmed', `${R.clauses.length} clause(s); restart at ${R.restart}`);
}

// Did a clause get done? (shown at H1, item by item)
function clauseOutcome(data, R, c) {
  const it = c.item && item(data, c.item);
  if (!it) return { done: false, how: 'not linked to anything' };
  if (c.action === 'research') {
    const fresh = it.evidence.map((id) => data.evidence.find((e) => e.id === id)).filter((e) => usable(e) && Math.max(...(e.passes || [e.pass || 0])) > (c.pass_at || 0));
    if (!FINAL.has(it.status)) return { done: false, how: `still ${it.status}` };
    if (!fresh.length) return { done: false, how: `no source for the confirmed version was found${it.gap ? ` (${it.gap})` : ''}` };
    return { done: true, how: `researched (${fresh.slice(0, 2).map((e) => e.source).join('; ')})${it.kind === 'decision' ? `; decided: ${clip(it.value, 120)} (${byWhom(it)})` : ''}` };
  }
  if (c.action === 'decide') return FINAL.has(it.status) && it.status !== 'dropped' ? { done: true, how: `${it.status === 'deferred' ? 'deferred to design' : `decided: ${clip(it.value, 140)}`} (${byWhom(it)})` } : { done: false, how: `still ${it.status}` };
  const last = data.checks[data.checks.length - 1];
  const handled = !last || !(last.objections || []).some((o) => o.severity === 'blocker' && o.check === 'instructions_handled');
  if (it.covered && it.covered.where && handled) return { done: true, how: `in the contract: ${it.covered.where}` };
  return { done: false, how: it.covered ? 'God Eye says it is not handled' : 'not in the contract' };
}

// ---------------------------------------------------------------- the contract
function byWhom(it) {
  if (it.status === 'deferred') return 'deferred to design';
  if (it.strength === 'user') return 'you';
  if (it.strength === 'accepted' && ['intent', 'pin', 'scope'].includes(it.kind)) return 'you confirmed it on the read-back';
  if (it.strength === 'accepted') return 'recommended; you accepted';
  if (it.strength === 'evidence') return 'evidence';
  return 'my assumption';
}

function sectionLines(data) {
  const live = data.items.filter((it) => it.status !== 'dropped');
  const decisions = live.filter((it) => it.kind === 'decision' && ['decided', 'deferred'].includes(it.status)).map((it) => {
    const ev = evidenceText(data, it.evidence, 2);
    return `- ${it.text} → ${it.status === 'deferred' ? 'deferred to design' : clip(it.value, 300)} (${byWhom(it)}${ev ? `; ${ev}` : ''})`;
  });
  for (const p of live.filter((it) => it.kind === 'pin' && it.value)) decisions.unshift(`- ${p.system} version → ${p.value} (${byWhom(p)}${p.source && p.source.quote ? `: "${clip(p.source.quote, 80)}"` : ''})`);
  const facts = live.filter((it) => it.kind === 'fact' && ['decided', 'assumed'].includes(it.status) && it.value && !it.superseded).map((it) => `- ${clip(it.value, 300)} (${factSource(data, it)})`);
  const design = live.filter((it) => it.status === 'deferred' && (it.kind === 'design' || it.kind === 'fact' || it.kind === 'question')).map((it) => `- ${it.text}${it.unconfirmed ? ` (not researched: ${it.unconfirmed})` : ''}`);
  const gaps = openFailures(data).map((f) => `- ${f.what}: ${f.reason}`);
  return { decisions, facts, design, gaps };
}

function writeSections(text, data) {
  const contract = require('./contract');
  const s = sectionLines(data);
  let out = text;
  // v2's CLI sections give way to v3's
  for (const old of ['assumptions (evidence-backed)', 'clarifications (settled)', 'deferred to design']) out = dropSection(out, old);
  out = contract.setSection(out, SECTIONS.decisions, SECTION_COMMENT, s.decisions.length ? s.decisions : ['- None'], /^##\s+assumptions\s*$/i);
  out = contract.setSection(out, SECTIONS.facts, SECTION_COMMENT, s.facts.length ? s.facts : ['- None'], /^##\s+assumptions\s*$/i);
  out = contract.setSection(out, SECTIONS.design, SECTION_COMMENT, s.design.length ? s.design : ['- None'], /^##\s+assumptions\s*$/i);
  out = contract.setSection(out, SECTIONS.gaps, SECTION_COMMENT, s.gaps.length ? s.gaps : ['- None'], /^##\s+assumptions\s*$/i);
  return out;
}

function dropSection(text, key) {
  const all = String(text).split('\n');
  const start = all.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase() === key);
  if (start < 0) return text;
  let end = all.findIndex((l, i) => i > start && /^##\s+/.test(l));
  if (end < 0) end = all.length;
  return [...all.slice(0, start), ...all.slice(end)].join('\n');
}

function contractHash(root, state) {
  return require('./contract').hash(root, state);
}

// The writer's text, checked; the CLI-owned sections written from the record.
function applyWriter(root, state, data, out) {
  const contract = require('./contract');
  const res = { written: false, refused: null };
  if (!out || typeof out.contract !== 'string' || !out.contract.trim()) {
    res.refused = 'no contract text';
    return res;
  }
  const next = writeSections(out.contract.replace(/\s+$/, '\n'), data);
  const parsed = contract.parse(next);
  const probs = contract.problems(parsed);
  if (!parsed.intent.present) res.refused = 'the contract has no Intent section';
  else if (probs.length) res.refused = `the contract has problems: ${probs.slice(0, 4).join('; ')}`;
  else if (/^## Reply format|^# Factory [a-z-]+ — this run/m.test(next)) res.refused = "the contract carries the agent's own instructions";
  if (res.refused) return res;
  writeText(jobPaths(root, state.id).contract, next);
  res.written = true;
  const sections = contract.sections(next);
  const acIds = new Set(parsed.acs.map((a) => a.id));
  const has = (where) => {
    const w = String(where || '').trim();
    if (/^(E-)?AC-\d+$/i.test(w)) return acIds.has(w.toUpperCase());
    return Object.keys(sections).includes(w.toLowerCase());
  };
  for (const it of data.items) it.covered = null;
  for (const c of Array.isArray(out.covers) ? out.covers : []) {
    const it = item(data, c.item);
    if (!it || !has(c.where)) continue;
    it.covered = { where: clip(c.where, 60), how: clip(c.how, 200) };
  }
  for (const u of Array.isArray(out.uncovered) ? out.uncovered : []) {
    const it = item(data, u.item);
    if (it) it.uncovered = clip(u.why, 200);
  }
  for (const it of data.items) if (it.kind === 'instruction' && it.covered && it.status === 'open') { it.status = 'done'; itemEvent(it, 'done', 'contract-writer', it.covered.where); }
  data.contract.written_hash = contractHash(root, state);
  data.contract.edited_by_hand = false;
  return res;
}

// ---------------------------------------------------------------- readiness
function liveForCoverage(it) {
  if (it.status === 'dropped' || it.status === 'deferred' || it.superseded) return false;
  if (['design', 'question'].includes(it.kind)) return false;
  if (it.kind === 'intent' || it.kind === 'scope') return false;
  if (it.kind === 'pin') return Boolean(it.value);
  return ['decided', 'assumed', 'done'].includes(it.status) || it.kind === 'instruction';
}

function deterministic(root, state, data) {
  const contract = require('./contract');
  const text = contract.read(root, state.id);
  const parsed = contract.parse(text);
  const out = [];
  const add = (check, stage, ref, why) => out.push({ check, stage, ref, why: clip(why, 300), severity: 'blocker', by: 'cli' });
  for (const p of contract.problems(parsed)) add('acs_testable', 'assemble', 'contract', p);
  const covered = new Set(parsed.verifyCommands.flatMap((v) => v.covers));
  for (const ac of parsed.acs) if (ac.evidence.some((t) => t === 'test' || t === 'run') && !covered.has(ac.id)) add('acs_testable', 'assemble', ac.id, `${ac.id} needs ${ac.evidence.join('/')} evidence but no verify command covers it`);
  const sections = contract.sections(text);
  const acIds = new Set(parsed.acs.map((a) => a.id));
  for (const it of data.items.filter(liveForCoverage)) {
    const w = it.covered && it.covered.where;
    const ok = w && (/^(E-)?AC-\d+$/i.test(w) ? acIds.has(w.toUpperCase()) : Object.keys(sections).includes(w.toLowerCase()));
    if (!ok) add(it.kind === 'instruction' ? 'instructions_handled' : it.strength === 'user' ? 'facts_honoured' : 'self_consistent', 'assemble', it.id, `${it.id} (${clip(it.text, 120)}) is not in the contract${w ? ` (${w} is gone)` : ''}${it.uncovered ? `: ${it.uncovered}` : ''}`);
  }
  for (const it of data.items) {
    if (!['decision', 'question'].includes(it.kind) || it.status === 'dropped') continue;
    if (it.impact === 'high' && !['decided', 'deferred'].includes(it.status)) add('decisions_closed', 'sheet', it.id, `${it.id} (${clip(it.text, 120)}) is neither decided nor deferred`);
  }
  // what the writer wrote (the factory's own sections list rejected sources on purpose)
  let own = text;
  for (const k of Object.values(SECTIONS)) own = dropSection(own, k.replace(/^##\s+/, '').toLowerCase());
  for (const e of data.evidence) if (!usable(e) && own.includes(e.source)) add('facts_honoured', 'assemble', e.id, `the contract cites ${e.source}, which is ${e.verdict}`);
  for (const R of data.redirects.filter((r) => r.status === 'confirmed')) {
    for (const c of R.clauses) {
      const it = c.item && item(data, c.item);
      if (!it) add('instructions_handled', 'assemble', R.id, `clause ${c.n} of ${R.id} is linked to nothing`);
      else if (['research', 'decide'].includes(c.action) && !FINAL.has(it.status)) add('instructions_handled', c.action === 'decide' ? 'sheet' : 'research', it.id, `clause ${c.n} of ${R.id} ("${clip(c.quote, 80)}") is still ${it.status}`);
    }
  }
  return out;
}

function earliest(blockers) {
  return blockers.map((b) => b.stage).filter((s) => ORDER[s] !== undefined).sort((a, b) => ORDER[a] - ORDER[b])[0] || 'assemble';
}

// A blocker goes back to its stage: what that means for the record.
function sendBack(root, state, data, blockers, S) {
  const stage = earliest(blockers);
  data.blockers = blockers.map((b) => ({ ...b }));
  log(data, 'back', `${blockers.length} blocker(s): back to ${stage}`);
  if (stage === 'assemble') {
    if (data.counters.writer_attempts >= S.writer_attempts) {
      data.parked = { kind: 'writer', stage: 'assemble', reason: `The contract still fails its readiness check after ${data.counters.writer_attempts} writer attempt(s): ${blockers.slice(0, 4).map((b) => `${b.ref}: ${b.why || b.issue}`).join('; ')}` };
      return 'park';
    }
    return 'assemble';
  }
  if (stage === 'readback') {
    data.readback_objections = blockers.filter((b) => b.stage === 'readback');
    return 'readback';
  }
  if (stage === 'research') {
    for (const b of blockers.filter((x) => x.stage === 'research')) {
      const it = item(data, b.ref);
      if (it && !it.needs_research) reopen(it, b.by === 'cli' ? 'readiness check' : 'God Eye', b.why || b.issue);
      else if (!it) newItem(data, { kind: 'fact', text: b.issue || b.why, tag: 'docs', impact: 'high', needs_research: true, origin: 'check', pins: Object.keys(pinsBySystem(data)) }, 'God Eye');
    }
    data.counters.research_passes = 0;
    return 'research';
  }
  // the sheet: a decision God Eye says is missing becomes one
  for (const b of blockers.filter((x) => x.stage === 'sheet')) {
    const it = item(data, b.ref);
    if (!it) newItem(data, { kind: 'decision', text: b.issue || b.why, status: 'to_decide', impact: 'high', origin: 'check', extra: { researched: false, why: b.fix || null } }, 'God Eye');
    else if (FINAL.has(it.status) && it.status !== 'dropped') reopen(it, 'God Eye', b.issue || b.why);
  }
  for (const it of data.items) if (it.kind === 'decision' && it.needs_research) it.needs_research = false;
  return 'route';
}

function readinessInput(root, state, data) {
  const live = data.items.filter((it) => it.status !== 'dropped');
  return {
    contract: jobPaths(root, state.id).contract,
    focus: 'readiness',
    checklist: CHECKLIST,
    stated: live.filter((it) => it.strength === 'user' && it.source && it.source.quote).map((it) => ({ id: it.id, text: it.value || it.text, quote: it.source.quote, covered: it.covered ? it.covered.where : null })),
    decisions: live.filter((it) => it.kind === 'decision' || it.kind === 'question').map((it) => ({ id: it.id, text: it.text, value: it.value, status: it.status, by: byWhom(it), impact: it.impact })),
    instructions: live.filter((it) => it.kind === 'instruction').map((it) => ({ id: it.id, text: it.text, quote: it.value, covered: it.covered ? it.covered.where : null })),
    facts: live.filter((it) => it.kind === 'fact' && it.value).map((it) => ({ id: it.id, text: it.value, source: factSource(data, it) })),
    design_may_choose: live.filter((it) => it.status === 'deferred').map((it) => it.text),
    gaps: openFailures(data).map((f) => `${f.what}: ${f.reason}`),
  };
}

function applyCheck(root, state, data, out, S) {
  const g = out || {};
  const objections = (Array.isArray(g.objections) ? g.objections : []).slice(0, 20).map((o) => ({
    check: CHECKLIST.includes(o.check) ? o.check : 'self_consistent',
    severity: o.severity === 'blocker' ? 'blocker' : 'note',
    stage: ORDER[o.stage] !== undefined ? o.stage : 'assemble',
    ref: clip(o.ref, 60),
    issue: clip(o.issue, 400),
    fix: clip(o.fix, 300),
    by: 'god-eye',
  }));
  const checklist = {};
  for (const k of CHECKLIST) checklist[k] = Boolean(g.checklist && g.checklist[k] === true);
  // a "false" on the checklist with no objection is an objection too (it is never silently a pass)
  for (const k of CHECKLIST) if (!checklist[k] && !objections.some((o) => o.check === k && o.severity === 'blocker')) objections.push({ check: k, severity: 'blocker', stage: 'assemble', ref: 'contract', issue: `God Eye answered ${k} false without saying why`, fix: '', by: 'god-eye' });
  const rec = { n: data.checks.length + 1, at: nowIso(), contract_hash: contractHash(root, state), deterministic: [], checklist, objections, restatement: g.restatement || null, ok: !objections.some((o) => o.severity === 'blocker') };
  data.checks.push(rec);
  return rec;
}

// ---------------------------------------------------------------- what runs next (the brief)
function readbackInput(root, state, data) {
  return {
    mode: 'readback',
    job: state.id,
    title: state.title,
    contract: jobPaths(root, state.id).contract,
    words: data.words.map((w) => ({ id: w.id, via: w.via, text: w.text })),
    items: data.items.filter((it) => it.status !== 'dropped').map(slimItem),
    previous: data.readback ? { intent: data.readback.intent, scope: data.readback.scope } : null,
    objections: (data.readback_objections || []).map((b) => ({ issue: b.issue || b.why, fix: b.fix || '' })),
  };
}

function slimItem(it) {
  return { id: it.id, kind: it.kind, text: it.text, value: it.value, status: it.status, strength: it.strength, tag: it.tag, ...(it.system ? { system: it.system } : {}) };
}

function researchPass(data, S) {
  const retry = data.research.retry;
  const ids = retry ? retry.items : researchItems(data, S).map((it) => it.id);
  const items = ids.map((id) => item(data, id)).filter(Boolean);
  const pins = Object.entries(pinsBySystem(data)).map(([system, version]) => ({ system, version }));
  const stated = data.items.filter((it) => it.strength === 'user' && it.kind === 'fact' && it.status !== 'dropped').map((it) => ({ id: it.id, text: it.value || it.text }));
  const plan = items.map((it) => {
    const pe = planFor(data, it);
    return { id: pe.id, item: it.id, what: it.text, tag: it.kind === 'decision' ? 'decision' : it.tag || 'docs', pins: it.pins, ...(it.options ? { options: it.options.map((o) => o.text) } : {}) };
  });
  const repo = plan.filter((p) => p.tag === 'repo' || p.tag === 'decision');
  const docs = plan.filter((p) => p.tag === 'docs' || p.tag === 'decision');
  // a first pass runs every researcher it needs; a retry only the ones that failed (none when
  // only the brief writer failed: its researchers' findings are kept)
  const want = (mode) => (!retry ? true : retry.brief_only ? false : (retry.failed || []).includes(mode));
  const scouts = [];
  const avoid = data.evidence.filter((e) => !usable(e) && /^https?:/.test(e.source)).map((e) => ({ source: e.source, why: e.verdict === 'other_version' ? 'documents another version' : e.verdict === 'unpinned' ? 'a moving page (stable/latest), not the pinned version' : e.verdict }));
  const failedSources = data.failures.filter((f) => /^https?:/.test(f.what) && /HTTP|unreachable|timed out/i.test(f.reason)).map((f) => ({ source: f.what, why: f.reason }));
  if (repo.length && want('repo')) scouts.push({ mode: 'repo', label: 'research · repo', plan: repo });
  if (docs.length && want('docs')) {
    if (S.web) scouts.push({ mode: 'docs', label: 'research · docs', plan: docs });
    else addFailure(data, { what: 'the web', reason: 'web research is off by policy (intent_research.web)' });
  }
  const priorEvidence = data.evidence.filter((e) => ids.includes(e.item) && usable(e)).map((e) => ({ plan: e.plan, claim: e.claim, source: e.source, verdict: e.verdict }));
  return { ids, plan, pins, stated, scouts, avoid: [...avoid, ...failedSources], priorEvidence };
}

// What the stage `factory run clarify` runs now: its agents in groups (a later group gets the
// earlier replies under INPUTS). Throws when clarify waits on the user or is done.
function stagePlan(root, state) {
  const data = get(root, state);
  if (data.tampered) fail(`${state.id}'s clarify.json fails its seal (edited by hand?). Nothing was started.`, 'tampered');
  if (WAITS.has(data.stage)) fail(`Clarify waits for the user's reply (${data.stage.replace('_wait', '')}): show the screen from factory next and record their words with factory clarify reply "<their words>". Nothing was started.`, 'not_waiting_for_workflow', { stage: data.stage });
  if (data.stage === 'ready') fail('Clarify is done: run factory next for gate H1. Nothing was started.', 'not_waiting_for_workflow', { stage: data.stage });
  const S = settings(root, state);
  // which agent plays each part: config/workflows/clarify.json
  const roles = readJson(require('../lib/paths').pluginPath('config', 'workflows', 'clarify.json')).agents;
  const A = (key, label, mode, input, timeout, schema, attempts = 2) => ({ role: roles[key].role, label, mode, input, timeout_sec: timeout, schema, attempts });
  const stage = data.stage;
  let groups = [];
  if (stage === 'readback') groups = [[A('interviewer', 'read-back', 'readback', readbackInput(root, state, data), S.agent_sec.interviewer, 'readback')]];
  else if (stage === 'redirect') {
    const R = currentRedirect(data);
    groups = [[A('interviewer', 'redirect', 'redirect', { mode: 'redirect', redirect: { id: R.id, text: R.text }, items: data.items.filter((it) => it.status !== 'dropped').map(slimItem) }, S.agent_sec.interviewer, 'redirect')]];
  } else if (stage === 'interpret') {
    const s = currentSheet(data);
    const w = data.words.find((x) => x.id === data.pending_reply);
    groups = [[A('interviewer', 'interpret', 'interpret', { mode: 'interpret', reply: { id: w.id, text: w.text }, sheet: { decisions: s.decisions.filter((d) => !d.answered).map((d) => ({ no: d.no, question: d.question, options: d.options.map((o) => ({ key: o.key, text: o.text })), recommendation: d.recommendation })), facts: s.facts.map((f) => ({ no: f.no, text: f.text })) } }, S.agent_sec.interviewer, 'interpret')]];
  } else if (stage === 'research') {
    const p = researchPass(data, S);
    const common = { pins: p.pins, stated: p.stated, minutes: Math.max(1, Math.round(S.research_sec / 60)), avoid: p.avoid, ...(S.search_mcp ? { search_tool: S.search_mcp } : {}) };
    const scouts = p.scouts.map((s) => A(s.mode, s.label, s.mode, { mode: s.mode, plan: s.plan, ...common }, S.research_sec, 'research', 1));
    const brief = A('brief', 'research brief', 'brief', { plan: p.plan, pins: p.pins, stated: p.stated, evidence: p.priorEvidence, failures: data.failures.map((f) => `${f.what}: ${f.reason}`) }, S.agent_sec['brief-writer'], 'brief');
    groups = scouts.length ? [scouts, [brief]] : [[brief]];
  } else if (stage === 'assemble') {
    groups = [[A('writer', 'contract', 'write', writerInput(root, state, data), S.agent_sec['contract-writer'], 'contract-write')]];
  } else if (stage === 'check') {
    groups = [[A('check', 'readiness', 'readiness', readinessInput(root, state, data), S.agent_sec['god-eye'], 'readiness')]];
  } else fail(`Clarify is at an unknown stage (${stage}).`, 'internal');
  // what each group is called while it runs (the console's live step list)
  const PH = { readback: ['read your words back'], redirect: ['read your redirect back'], interpret: ['read your sheet answer'], assemble: ['write the contract'], check: ['readiness check'] };
  const phases = stage === 'research' ? groups.map((g) => (g.some((a) => a.role === roles.brief.role) ? 'research brief' : `research (${g.map((a) => a.mode).join(', ')})`)) : PH[stage];
  return { stage, rev: data.rev || 0, groups, phases, contract_hash: contractHash(root, state) };
}

function writerInput(root, state, data) {
  const rb = data.readback || { intent: {}, scope: { in: [], out: [] } };
  const live = data.items.filter((it) => it.status !== 'dropped' && !['intent'].includes(it.kind));
  return {
    contract: jobPaths(root, state.id).contract,
    intent: rb.intent,
    scope: rb.scope,
    items: live.map((it) => ({ id: it.id, kind: it.kind, text: it.text, value: it.value, status: it.status, strength: it.strength, by: byWhom(it), source: it.kind === 'fact' || it.kind === 'pin' ? factSource(data, it) : null, ...(it.superseded ? { superseded_by: it.superseded.by } : {}) })),
    evidence: data.evidence.filter(usable).map((e) => ({ id: e.id, item: e.item, claim: e.claim, source: e.source })),
    instructions: live.filter((it) => it.kind === 'instruction').map((it) => ({ id: it.id, text: it.text, quote: it.value })),
    blockers: (data.blockers || []).map((b) => ({ check: b.check, ref: b.ref, issue: b.issue || b.why, fix: b.fix || '' })),
    design_may_choose: live.filter((it) => it.status === 'deferred').map((it) => it.text),
    gaps: data.failures.map((f) => `${f.what}: ${f.reason}`),
  };
}

// ---------------------------------------------------------------- recording a stage
function ledgerNote(root, state, data, outcome, detail = {}) {
  require('./ledger').append(root, state.id, { kind: 'clarify', stage: data.stage, outcome, rev: data.rev || 0, detail });
}

// `factory record` for workflow clarify: apply the stage's replies, then move on by the rules.
function record(root, state, env) {
  const data = get(root, state);
  const d = env.data || {};
  const S = settings(root, state);
  if (d.stage !== data.stage) return { status: 'stale', message: `The clarify record moved on (it is at ${data.stage}, the run was for ${d.stage}). Nothing recorded; run factory next.` };
  const outputs = d.outputs || {};
  const runs = Array.isArray(d.runs) ? d.runs : [];
  const failedRun = (label) => {
    const r = runs.filter((x) => x.label === label || x.label === `${label} (retry)`).pop();
    return r ? (r.outcome === 'timeout' ? `timed out after ${r.time_cap_sec || '?'}s` : `${r.outcome}${(r.errors || [])[0] ? `: ${clip(r.errors[0], 120)}` : ''}`) : 'returned nothing';
  };
  const stage = data.stage;
  let next = null;
  let result = {};
  const agentFailed = (label, who) => {
    const why = failedRun(label);
    addFailure(data, { what: `the ${who}`, reason: why });
    data.parked = { kind: 'agent', stage, reason: `The ${who} failed twice at the ${stage} stage (${why}); nothing was recorded from it.` };
    return 'park';
  };
  if (stage === 'readback') {
    const out = outputs['read-back'];
    if (!out) next = agentFailed('read-back', 'interviewer');
    else {
      applyReadback(root, state, data, out);
      data.readback_objections = null;
      next = 'readback_wait';
    }
  } else if (stage === 'redirect') {
    const out = outputs.redirect;
    if (!out) next = agentFailed('redirect', 'interviewer');
    else {
      applyRedirect(data, out);
      next = 'redirect_wait';
    }
  } else if (stage === 'interpret') {
    const out = outputs.interpret;
    const s = currentSheet(data);
    const w = data.words.find((x) => x.id === data.pending_reply);
    data.pending_reply = null;
    if (!out || !s || !w) {
      result.note = 'The interviewer could not read that reply: answer by number (e.g. "1 a, 2: <your words>").';
      next = 'sheet_wait';
    } else {
      const answers = (out.answers || []).filter((a) => norm(w.text).includes(norm(a.quote || '')) && norm(a.quote || '').length >= 2).map((a) => ({ no: Number(a.decision), ...(a.choice === 'defer' ? { defer: true } : ['recommended', 'a', 'b', 'c', 'd', 'e'].includes(a.choice) ? { choice: a.choice, quote: clip(a.quote, 300) } : { text: clip(a.text || a.quote, 400), quote: a.quote }) }));
      const facts = (out.facts || []).filter((f) => norm(w.text).includes(norm(f.quote || ''))).map((f) => ({ no: Number(f.fact), text: clip(f.text, 400) }));
      const r = applySheet(data, s, { accept: false, answers, facts }, w, 'interpret');
      result.applied = r;
      next = r.open.length ? 'sheet_wait' : 'route';
      if (r.open.length) result.note = `Still open on the sheet: ${r.open.join(', ')}.`;
    }
  } else if (stage === 'research') {
    const p = researchPass(data, S);
    const pass = { items: p.ids, scouts: p.scouts.map((s) => ({ label: s.label, mode: s.mode })), brief: 'research brief' };
    const r = applyResearch(root, state, data, outputs, runs, S, pass);
    next = r.next === 'park' ? 'park' : r.next === 'research' ? 'research' : 'route';
    result.research = { pass: data.counters.research_passes, failures: data.research.passes[data.research.passes.length - 1].failures };
  } else if (stage === 'assemble') {
    data.counters.writer_attempts += 1;
    const out = outputs.contract;
    if (!out) next = agentFailed('contract', 'contract writer');
    else {
      const w = applyWriter(root, state, data, out);
      if (w.refused) {
        const b = [{ check: 'acs_testable', stage: 'assemble', ref: 'contract', why: `the CLI refused the writer's contract: ${w.refused}`, severity: 'blocker', by: 'cli' }];
        next = sendBack(root, state, data, b, S);
        result.refused = w.refused;
      } else next = 'check';
    }
  } else if (stage === 'check') {
    const out = outputs.readiness;
    if (!out) next = agentFailed('readiness', 'God Eye readiness check');
    else {
      const rec = applyCheck(root, state, data, out, S);
      const blockers = rec.objections.filter((o) => o.severity === 'blocker');
      if (blockers.length) {
        next = sendBack(root, state, data, blockers, S);
        if (next === 'park') data.parked.reason = `God Eye's readiness check still blocks after ${data.counters.writer_attempts} writer attempt(s): ${blockers.slice(0, 3).map((b) => `${b.check} (${b.ref}): ${b.issue}`).join('; ')}`;
      } else next = 'ready';
    }
  }
  return finish(root, state, data, next, S, result);
}

// Move to the next stage (routing by current state), save, and say what happens now.
function finish(root, state, data, next, S, result = {}) {
  if (next === 'route') next = advance(data, S);
  if (next === 'assemble' && data.stage !== 'assemble' && data.stage !== 'check') data.counters.writer_attempts = 0;
  if (next === 'check') {
    // the deterministic half first: a blocker goes back without spending God Eye
    data.stage = 'check';
    const det = deterministic(root, state, data);
    if (det.length) {
      data.checks.push({ n: data.checks.length + 1, at: nowIso(), contract_hash: contractHash(root, state), deterministic: det, checklist: null, objections: det, ok: false });
      next = sendBack(root, state, data, det, S);
      if (next === 'route') next = advance(data, S);
    }
  }
  if (next === 'ready') {
    data.contract.checked_hash = contractHash(root, state);
    data.blockers = null;
    for (const R of data.redirects.filter((r) => r.status === 'confirmed')) R.status = 'done';
  }
  if (next === 'park') {
    data.stage = data.parked.stage;
    save(root, state.id, data);
    ledgerNote(root, state, data, 'park', { reason: data.parked.reason });
    return { status: 'park', park_from: 'clarify', park_reason: `${data.parked.reason} Reply "resume" for one more try${data.parked.kind === 'agent' ? '' : ', or "proceed" to go on with the gaps shown'}.`, stage: data.stage, message: 'Parked.' };
  }
  data.stage = next;
  data.parked = null;
  save(root, state.id, data);
  ledgerNote(root, state, data, next, { counters: data.counters, caps: { research_passes: S.research_passes, writer_attempts: S.writer_attempts }, failures: data.failures.length });
  if (next === 'ready') {
    const b = require('./invalidation').current(root, state);
    const last = data.checks[data.checks.length - 1] || {};
    require('./ledger').append(root, state.id, { kind: 'step', step: 'clarify', ok: true, bound: { contract: b.contract }, detail: { version: 3, items: data.items.length, decisions: data.items.filter((x) => x.kind === 'decision').length, sheets: data.sheets.length, research_passes: data.research.passes.length, failures: data.failures.length, checks: data.checks.length, notes: (last.objections || []).filter((o) => o.severity === 'note').length, ...(data.proceeded ? { proceeded: data.proceeded } : {}), ...((last.objections || []).some((o) => o.severity === 'blocker') ? { approved: false, god_eye_objects: (last.objections || []).filter((o) => o.severity === 'blocker').length } : {}) } });
    return { status: 'ok', next_gate: state.epic ? 'EH1' : 'H1', stage: next, ...result, message: 'The contract passed its readiness check. Run factory next: gate H1 shows it.' };
  }
  if (WAITS.has(next)) {
    return { status: 'needs_user', stage: next, screen: screen(state, data), ...result, message: `Show the screen to the user as it is, then stop. Record their reply with factory clarify reply "<their words>" (unless the reply hook already did: factory next's last_reply says so).${result.note ? ` ${result.note}` : ''}` };
  }
  return { status: 'continue', stage: next, ...result, message: `Clarify moves on to ${next}: run factory next (it runs factory run clarify again).` };
}

function screen(state, data) {
  if (data.stage === 'readback_wait') return readbackScreen(state, data);
  if (data.stage === 'sheet_wait') return sheetScreen(state, data);
  if (data.stage === 'redirect_wait') return redirectScreen(state, data);
  return '';
}

// ---------------------------------------------------------------- replies (no agent)
function reply(root, { jobId, text, via = 'cli' }) {
  const job = require('./job');
  const state = job.resolve(root, jobId);
  if (['closed', 'cancelled', 'abandoned'].includes(state.status)) fail(`${state.id} is ${state.status}; nothing to reply to.`, 'not_active');
  if (state.approvals && (state.approvals.H1 || state.approvals.EH1)) fail(`${state.id}'s contract is approved: clarify takes no more replies. To change it, start an amendment (factory amend start --reason "…").`, 'approved');
  const t = String(text || '').trim();
  if (!t) fail('Say the reply: factory clarify reply "<the user\'s words>".', 'bad_input');
  const data = get(root, state);
  if (data.tampered) fail(`${state.id}'s clarify.json fails its seal.`, 'tampered');
  const S = settings(root, state);
  sync(root, state, data);
  const last = data.words[data.words.length - 1];
  if (last && last.text === t && /chat/.test(last.via) !== (via === 'chat') && Date.now() - Date.parse(last.at) < 10 * 60 * 1000) return { job: state.id, stage: data.stage, duplicate: true, message: 'Already recorded (the reply hook applied it): run factory next.' };
  if (!WAITS.has(data.stage)) {
    // words outside a reply screen: a redirect (the user changes course)
    if (['ready', 'assemble', 'check', 'research', 'readback'].includes(data.stage) && /\S/.test(t)) return redirect(root, { jobId: state.id, text: t, via });
    fail(`Clarify is not waiting for a reply (it is at ${data.stage}): run factory next.`, 'not_waiting');
  }
  const w = addWord(data, t, via === 'chat' ? 'reply (chat)' : 'reply');
  if (w.duplicate) return { job: state.id, stage: data.stage, duplicate: true, message: 'Already recorded (the same reply came twice).' };
  let msg;
  let next;
  if (data.stage === 'readback_wait') {
    if (ACCEPT.test(t)) {
      confirmReadback(data, w, S);
      judge(root, data);
      data.counters.research_passes = 0;
      next = 'route';
      msg = 'Read-back confirmed.';
      const queued = data.redirects.find((r) => r.status === 'queued');
      if (queued) {
        queued.status = 'interpreting';
        next = 'redirect';
        msg = `Read-back confirmed; your earlier denial (${queued.id}) is read back next.`;
      }
    } else {
      next = 'readback';
      msg = 'Your words are recorded; the read-back runs again with them.';
    }
  } else if (data.stage === 'redirect_wait') {
    if (ACCEPT.test(t)) {
      confirmRedirect(data, w);
      const R = data.redirects[data.redirects.length - 1];
      next = 'route';
      msg = `Redirect confirmed: ${R.clauses.length} item(s), restarting at ${R.restart}.`;
    } else {
      const R = currentRedirect(data);
      R.text = `${R.text}\n${t}`;
      R.status = 'interpreting';
      next = 'redirect';
      msg = 'Your correction is recorded; the redirect is read again.';
    }
  } else {
    const s = currentSheet(data);
    const parsed = parseSheetReply(t, s);
    if (!parsed) {
      data.pending_reply = w.id;
      next = 'interpret';
      msg = 'Recorded; the interviewer reads your words against the sheet (one short call).';
    } else {
      const r = applySheet(data, s, parsed, w);
      next = r.open.length ? 'sheet_wait' : 'route';
      msg = `Recorded: ${r.decided.length} decision(s)${r.facts.length ? `, ${r.facts.length} fact(s) corrected` : ''}.${r.open.length ? ` Still open: ${r.open.join(', ')} (no recommendation, or not answered).` : ''}`;
    }
  }
  const res = finish(root, state, data, next, S);
  require('./events').append(root, { event: 'clarify_reply', job: state.id, via, stage: res.stage, words: w.id });
  return { job: state.id, word: w.id, ...res, message: `${msg} ${res.message}` };
}

function redirect(root, { jobId, text, via = 'cli', gate = null }) {
  const job = require('./job');
  const state = job.resolve(root, jobId);
  if (state.approvals && (state.approvals.H1 || state.approvals.EH1)) fail(`${state.id}'s contract is approved: start an amendment instead (factory amend start --reason "…").`, 'approved');
  const t = String(text || '').trim();
  if (!t) fail('Say the redirect: factory clarify redirect "<the user\'s words>".', 'bad_input');
  const data = get(root, state);
  if (data.tampered) fail(`${state.id}'s clarify.json fails its seal.`, 'tampered');
  const R = startRedirect(data, t, via === 'denial' ? 'denial' : via === 'chat' ? 'redirect (chat)' : 'redirect', gate);
  save(root, state.id, data);
  ledgerNote(root, state, data, 'redirect', { redirect: R.id });
  return { job: state.id, redirect: R.id, stage: data.stage, status: 'continue', message: `Redirect ${R.id} recorded. Run factory next: the interviewer reads it back to you (one short call).` };
}

// A chat message the prompt hook may apply: only an unmistakable reply while clarify waits
// (ok on a read-back or redirect, a numbered sheet reply). Anything else is left for the main
// session to record with factory clarify reply. Returns the receipt, or null.
function chatReply(root, text, { jobId } = {}) {
  const job = require('./job');
  let state;
  try {
    state = job.resolve(root, jobId);
  } catch {
    return null;
  }
  if (state.status !== 'active' || (state.approvals && (state.approvals.H1 || state.approvals.EH1))) return null;
  const data = load(root, state.id);
  if (!data || data.tampered || !WAITS.has(data.stage)) return null;
  const t = String(text || '').trim();
  if (!t || /\?\s*$/.test(t) || t.includes('\n\n')) return null;
  if (data.stage === 'sheet_wait') {
    const s = currentSheet(data);
    if (!s || !parseSheetReply(t, s)) return null;
  } else if (!ACCEPT.test(t)) return null;
  return reply(root, { jobId: state.id, text: t, via: 'chat' });
}

// ---------------------------------------------------------------- sync, readiness, views
// On every factory next: a new H1 denial becomes a redirect; a contract edited by hand since it
// passed (or since the writer wrote it) is checked again.
function sync(root, state, data) {
  let changed = false;
  const H = ['H1', 'EH1'];
  const approvedAt = (g) => (state.approvals && state.approvals[g] ? state.approvals[g].at : '');
  const fresh = (state.denials || []).filter((x) => H.includes(x.gate) && x.at > approvedAt(x.gate) && x.at > (data.denials_seen || ''));
  for (const d of fresh) {
    startRedirect(data, d.reason || '(no reason given)', 'denial', d.gate);
    data.denials_seen = d.at;
    changed = true;
  }
  if (['ready'].includes(data.stage) && data.contract.checked_hash && contractHash(root, state) !== data.contract.checked_hash) {
    data.stage = 'check';
    data.contract.edited_by_hand = true;
    log(data, 'edited', 'contract.md changed after the readiness check: checked again');
    changed = true;
  }
  return changed;
}

function ready(root, state) {
  const data = load(root, state.id);
  if (!data) {
    // a job clarify v3 never touched: v2 jobs approved before the upgrade keep their record
    const approved = state.approvals && (state.approvals.H1 || state.approvals.EH1);
    return Boolean(approved);
  }
  if (data.tampered || data.stage !== 'ready') return false;
  const H = ['H1', 'EH1'];
  const approvedAt = (g) => (state.approvals && state.approvals[g] ? state.approvals[g].at : '');
  if ((state.denials || []).some((x) => H.includes(x.gate) && x.at > approvedAt(x.gate) && x.at > (data.denials_seen || ''))) return false;
  return contractHash(root, state) === data.contract.checked_hash;
}

// For factory next while clarify is the step: run, or wait on the user (with the screen).
function nextInfo(root, state) {
  const data = get(root, state);
  if (data.tampered) return { stage: null, run: null, waiting_for_user: false, error: 'clarify.json fails its seal (edited by hand?)', status_command: `factory clarify status --job ${state.id}` };
  const migrating = !load(root, state.id);
  const changed = sync(root, state, data);
  if (changed || migrating) save(root, state.id, data);
  const waiting = WAITS.has(data.stage);
  return {
    stage: data.stage,
    run: RUNS.has(data.stage) ? 'factory run clarify' : null,
    waiting_for_user: waiting,
    ...(waiting ? { screen: screen(state, data), reply_command: 'factory clarify reply "<the user\'s words>"' } : {}),
    ...(data.migration && migrating ? { migrated: data.migration } : {}),
    status_command: `factory clarify status --job ${state.id}`,
  };
}

function waitingForUser(root, state) {
  const data = load(root, state.id);
  if (!data || data.tampered || !WAITS.has(data.stage)) return null;
  return { readback_wait: 'clarify read-back waits for your ok or your edit', sheet_wait: 'clarify decision sheet waits for your answers', redirect_wait: 'clarify waits for you to confirm how it read your redirect' }[data.stage];
}

function h1View(root, state, data = load(root, state.id)) {
  if (!data || data.tampered) return null;
  const contract = require('./contract');
  const text = contract.read(root, state.id);
  const p = contract.parse(text);
  const live = data.items.filter((it) => it.status !== 'dropped');
  const checked = [];
  for (const it of live) {
    const s = it.source || {};
    if (it.kind === 'pin') {
      for (const c of it.candidates || []) {
        if (c.source.kind !== 'word') continue;
        const ok = compatible(it.value || '', c.version) || compatible(c.version, it.value || '');
        checked.push({ item: it.id, quote: c.source.quote, text: `${it.system} ${c.version}`, ok, where: ok ? `every source cited documents ${it.value}` : `you confirmed ${it.value} on the read-back (${it.resolved ? it.resolved.by : 'conflict'})` });
      }
      continue;
    }
    if (it.strength !== 'user' || !s.quote || !['fact', 'decision', 'instruction', 'question'].includes(it.kind)) continue;
    const sup = it.superseded;
    checked.push({ item: it.id, quote: clip(s.quote, 200), text: it.value || it.text, ok: !sup && Boolean(it.covered || it.status === 'deferred'), where: sup ? `you went by the source instead: ${clip(sup.value, 160)}` : it.covered ? it.covered.where : it.status === 'deferred' ? 'deferred to design' : 'not in the contract' });
  }
  const last = data.checks[data.checks.length - 1] || null;
  const objections = last ? (last.objections || []).map((o) => ({ check: o.check, severity: o.severity, issue: o.issue || o.why, fix: o.fix || '', ref: o.ref, open: o.severity === 'blocker' })) : [];
  const redirects = data.redirects.map((R) => {
    const clauses = R.clauses.map((c) => ({ quote: c.quote, action: c.action, ...clauseOutcome(data, R, c) }));
    return { id: R.id, words: R.text, done: clauses.filter((c) => c.done).length, of: clauses.length, clauses };
  });
  const v = {
    goal: p.goal,
    done: p.acs.map((a) => ({ id: a.id, text: a.text, evidence: a.evidence })),
    checked,
    decisions: live.filter((it) => it.kind === 'decision' && ['decided', 'deferred'].includes(it.status)).map((it) => ({ item: it.id, text: it.text, value: it.status === 'deferred' ? 'deferred to design' : it.value, by: byWhom(it) })),
    design_may_choose: live.filter((it) => it.status === 'deferred').map((it) => it.text),
    gaps: openFailures(data).map((f) => ({ what: f.what, reason: f.reason })),
    skipped: skippedSources(data),
    objections,
    proceeded: data.proceeded || null,
    redirects,
    edited_by_hand: Boolean(data.contract.edited_by_hand),
  };
  // the 0.6.1 guarantees, under the names the gate skill shows: what was dropped (who, why),
  // what research could not do, and God Eye's objections, which are never approval
  const dropped = data.items.filter((it) => it.status === 'dropped').map((it) => {
    const h = [...(it.history || [])].reverse().find((x) => /dropped/.test(x.event)) || {};
    return `${it.id}: ${clip(it.text, 160)} (dropped by ${h.actor || 'nobody'}: ${h.text ? clip(h.text, 160) : 'no reason recorded'})`;
  });
  if (dropped.length) v.dropped = dropped;
  if (v.gaps.length) v.research_incomplete = `Research is incomplete: ${v.gaps.map((g) => `${g.what}: ${g.reason}`).join('; ')}.`;
  const open = objections.filter((o) => o.open);
  if (open.length) {
    v.god_eye_objects = open.map((o) => `${o.severity} (${o.ref || o.check}): ${clip(o.issue, 240)}${o.fix ? ` — suggests: ${clip(o.fix, 160)}` : ''}`);
    v.approved = false;
  }
  v.status_command = `factory clarify status --job ${state.id}`;
  v.screen = h1Screen(state, v);
  return v;
}

function h1Screen(state, v) {
  const L = [`**Contract · ${state.id} ${state.title}**`, '', `**Goal:** ${v.goal}`, '', '**Done means**'];
  for (const a of v.done) L.push(`- ${a.id} ${a.text}`);
  if (v.checked.length) {
    L.push('', '**Checked against what you said**');
    for (const c of v.checked) L.push(`- ${c.ok ? '✓' : '✗'} "${c.quote}" → ${c.where}`);
  }
  if (v.decisions.length) {
    L.push('', '**Decisions and who made them**');
    for (const d of v.decisions) L.push(`- ${d.text} → ${d.value} (${d.by})`);
  }
  if (v.design_may_choose.length) L.push('', `**Design may still choose:** ${v.design_may_choose.join('; ')}.`);
  if (v.gaps.length) L.push('', '**Research gaps**', ...v.gaps.map((g) => `- ${g.what}: ${g.reason}`));
  if (v.skipped.length) L.push('', `**Sources skipped:** ${v.skipped.length} (${[...new Set(v.skipped.map((x) => x.why))].join('; ')}); none of them is relied on.`);
  const open = v.objections.filter((o) => o.open);
  const notes = v.objections.filter((o) => !o.open);
  if (open.length) L.push('', '**God Eye objects** (it did not approve this contract; you chose to proceed: `approve` takes it on over them, `deny <what must change>` sends it back)', ...open.map((o) => `- ${o.check} (${o.ref}): ${o.issue}`));
  if (v.dropped) L.push('', '**Dropped**', ...v.dropped.map((x) => `- ${x}`));
  else L.push('', `**God Eye:** all ${CHECKLIST.length} checks pass${notes.length ? `; remarks: ${notes.map((o) => o.issue).join('; ')}` : ''}.`);
  for (const R of v.redirects) {
    L.push('', `**Your redirect ${R.id}:** ${R.done} of ${R.of} done`);
    for (const c of R.clauses) L.push(`- ${c.done ? '✓' : '✗'} "${clip(c.quote, 120)}" — ${c.how}`);
  }
  if (v.edited_by_hand) L.push('', 'The contract was edited by hand after the writer; it was checked again.');
  return L.join('\n');
}

function view(root, state, data) {
  const s = currentSheet(data);
  return {
    job: state.id,
    version: 3,
    stage: data.stage,
    rev: data.rev || 0,
    items: data.items.map((it) => ({ ...it, history: (it.history || []).slice(-6), route: route(it, data, null) })),
    evidence: data.evidence,
    pins: data.items.filter((it) => it.kind === 'pin').map((it) => ({ id: it.id, system: it.system, value: it.value, status: it.status, strength: it.strength })),
    sheet: s ? { n: s.n, decisions: s.decisions.filter((d) => !d.answered), facts: s.facts, queued: s.queued } : null,
    sheets: data.sheets.length,
    research: { passes: data.research.passes.length, summary: data.research.summary || null },
    failures: data.failures,
    redirects: data.redirects,
    checks: data.checks.map((c) => ({ n: c.n, ok: c.ok, objections: c.objections })),
    parked: data.parked,
    migration: data.migration,
    words: data.words.length,
    h1: data.stage === 'ready' || data.proceeded ? h1View(root, state, data) : null,
  };
}

const STATUS_WORD = { open: 'open', to_decide: 'on the sheet', decided: 'decided', assumed: 'assumed', deferred: 'to design', done: 'done', dropped: 'dropped' };

function statusText(state, data) {
  const L = [`Clarify — ${state.id}: stage ${data.stage}; ${data.items.length} item(s), ${data.evidence.length} finding(s), ${data.research.passes.length} research pass(es), ${data.sheets.length} sheet(s), ${data.failures.length} failure(s)`];
  if (data.parked) L.push(`Parked: ${data.parked.reason}`);
  L.push('');
  const pad = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s).padEnd(n));
  L.push(`${pad('ID', 6)} ${pad('KIND', 11)} ${pad('STATUS', 13)} ${pad('BY', 12)} WHAT`);
  for (const it of data.items) L.push(`${pad(it.id, 6)} ${pad(it.kind, 11)} ${pad(STATUS_WORD[it.status] || it.status, 13)} ${pad(it.strength ? byWhom(it) : '—', 12)} ${clip(it.text, 70)}${it.value && it.kind !== 'intent' ? ` → ${clip(it.value, 60)}` : ''}`);
  const drops = data.items.filter((it) => it.status === 'dropped');
  if (drops.length) {
    L.push('', 'Dropped:');
    for (const it of drops) {
      const h = [...(it.history || [])].reverse().find((x) => /dropped/.test(x.event)) || {};
      L.push(`  ${it.id}: ${clip(it.text, 100)} (dropped by ${h.actor || 'nobody'}: ${h.text ? clip(h.text, 120) : 'no reason recorded'})`);
    }
  }
  if (data.failures.length) {
    L.push('', 'Not researched / failed:');
    for (const f of data.failures) L.push(`  - ${f.what}: ${f.reason}`);
  }
  if (WAITS.has(data.stage)) L.push('', screen(state, data));
  if (data.migration) L.push('', `Migrated from clarify v${data.migration.from}: ${data.migration.summary}.`);
  return L.join('\n');
}

function status(root, { jobId, json = false, h1 = false } = {}) {
  const job = require('./job');
  const state = job.resolve(root, jobId);
  const data = peek(root, state);
  if (!data) {
    const msg = { job: state.id, record: false, message: 'No clarify v3 record: this job\'s contract was approved before clarify v3 (factory intent show prints its research).' };
    return json ? msg : `${state.id}: ${msg.message}`;
  }
  if (data.tampered) {
    const msg = { job: state.id, record: false, tampered: true, message: 'clarify.json fails its seal (edited by hand?).' };
    return json ? msg : `${state.id}: ${msg.message}`;
  }
  if (h1) {
    const v = h1View(root, state, data);
    return json ? v : (v ? v.screen : 'No contract yet.');
  }
  return json ? view(root, state, data) : statusText(state, data);
}

// ---------------------------------------------------------------- parks: resume and proceed
function onResume(root, state) {
  const data = load(root, state.id);
  if (!data || !data.parked) return;
  if (data.parked.kind === 'research') data.counters.research_passes = Math.max(0, data.counters.research_passes - 1);
  if (data.parked.kind === 'writer') data.counters.writer_attempts = Math.max(0, data.counters.writer_attempts - 1);
  log(data, 'resumed', data.parked.reason);
  data.parked = null;
  save(root, state.id, data);
}

// `proceed` (human-only): go on from a cap park with the gaps explicit.
function proceed(root, { jobId, channel }) {
  const human = require('./human');
  human.requireHumanChannel(channel);
  const job = require('./job');
  const state = job.resolve(root, jobId);
  if (state.status !== 'parked' || !state.park || state.park.from !== 'clarify') fail(`${state.id} is not parked by clarify; "proceed" only continues a clarify park.`, 'not_parked');
  const data = load(root, state.id);
  if (!data || !data.parked) fail(`${state.id}'s clarify record has no park to proceed from.`, 'not_parked');
  if (data.parked.kind === 'agent') fail(`${state.id} parked because an agent failed (${data.parked.reason}); there is nothing to proceed with. Reply "resume" to try again.`, 'not_proceedable');
  human.confirmTyped(channel, state.id, 'proceed with the gaps shown');
  const S = settings(root, state);
  const was = data.parked;
  data.proceeded = { at: nowIso(), from: was.kind, reason: was.reason, channel };
  data.parked = null;
  let next;
  if (was.kind === 'research') {
    for (const it of data.items) if (it.needs_research) {
      it.needs_research = false;
      if (it.kind === 'decision') it.researched = false;
      addFailure(data, { what: it.text, reason: 'not researched: you chose to proceed after research failed' });
    }
    data.research.retry = null;
    next = 'route';
  } else next = 'ready';
  state.status = 'active';
  state.park = null;
  state.resumed = { at: nowIso(), from: 'clarify', step: 'proceed' };
  state.repeat = { key: null, count: 0 };
  job.save(root, state);
  const res = finish(root, state, data, next, S);
  require('./decisions').write(root, { job: state.id, action: 'human.proceed', chosen: 'proceed', rule: 'human', channel, from: was.kind });
  return { job: state.id, ...res, message: `Proceeding from the ${was.kind} cap with the gaps shown${next === 'ready' ? ': H1 lists the open objections' : ''}. ${res.message}` };
}

// ---------------------------------------------------------------- for ground, decide, floors, the console
function briefText(root, state) {
  const data = load(root, state.id);
  if (!data || data.tampered) return '';
  const L = [];
  const pins = pinsBySystem(data);
  if (Object.keys(pins).length) L.push(`- Versions (confirmed in clarify): ${Object.entries(pins).map(([s, v]) => `${s} ${v}`).join(', ')}. Research these versions only.`);
  const facts = data.items.filter((it) => it.kind === 'fact' && ['decided', 'assumed'].includes(it.status) && it.value);
  if (facts.length) L.push('- Facts clarify settled (with sources):', ...facts.slice(0, 20).map((it) => `  - ${clip(it.value, 200)} (${factSource(data, it)})`));
  const dec = data.items.filter((it) => it.kind === 'decision' && it.status === 'decided');
  if (dec.length) L.push('- Decisions made in clarify:', ...dec.slice(0, 15).map((it) => `  - ${clip(it.text, 160)} → ${clip(it.value, 160)} (${byWhom(it)})`));
  if (data.failures.length) L.push('- Research gaps clarify left:', ...data.failures.slice(0, 10).map((f) => `  - ${f.what}: ${f.reason}`));
  return L.join('\n');
}

function deferredText(root, state) {
  const data = load(root, state.id);
  if (!data || data.tampered) {
    const legacy = require('./intent').load(root, state.id);
    return legacy && !legacy.tampered ? require('./clarify-migrate').legacyDeferredText(legacy) : '';
  }
  const d = data.items.filter((it) => it.status === 'deferred');
  if (!d.length) return '';
  return ['- Design may choose (clarify handed these over; settle them here, cite your sources):', ...d.map((it) => `  - ${it.id} ${clip(it.text, 200)}${it.unconfirmed ? ` (clarify could not research it: ${it.unconfirmed})` : ''}`)].join('\n');
}

// Floor intent_grounded for a v3 job: nothing the contract cites rests on unusable evidence.
function floorOk(ctx) {
  const data = load(ctx.root, ctx.state.id);
  if (!data) return require('./intent').floorOk(ctx);
  if (data.tampered) return false;
  let text = require('./contract').read(ctx.root, ctx.state.id);
  for (const k of Object.values(SECTIONS)) text = dropSection(text, k.replace(/^##\s+/, '').toLowerCase());
  return !data.evidence.some((e) => !usable(e) && text.includes(e.source));
}

function inClarify(state) {
  return !(state.approvals && (state.approvals.H1 || state.approvals.EH1));
}

// For the console: the stage, the items, the sheet, the failures (the latest state).
function consoleBlock(root, state) {
  const data = load(root, state.id);
  if (!data || data.tampered) return null;
  const s = currentSheet(data);
  const count = (st) => data.items.filter((it) => it.status === st).length;
  return {
    version: 3,
    stage: data.stage,
    waiting_for_user: WAITS.has(data.stage),
    totals: { items: data.items.length, decided: count('decided') + count('done'), assumed: count('assumed'), deferred: count('deferred'), open: count('open') + count('to_decide'), dropped: count('dropped') },
    questions: s ? s.decisions.filter((d) => !d.answered).map((d) => ({ id: `${d.no}`, question: clip(d.question, 200), recommendation: d.recommendation ? clip((d.options.find((o) => o.key === d.recommendation) || {}).text, 140) : null })) : [],
    items: data.items.slice(0, 80).map((it) => ({ id: it.id, kind: it.kind, text: clip(it.text, 160), value: it.value ? clip(it.value, 140) : null, status: it.status, by: it.strength ? byWhom(it) : null, tag: it.tag })),
    failures: data.failures.slice(0, 20).map((f) => ({ what: clip(f.what, 160), reason: clip(f.reason, 160) })),
    // research gaps still open (a later pass may have settled an earlier failure)
    gaps: openFailures(data).slice(0, 20).map((f) => ({ what: clip(f.what, 160), reason: clip(f.reason, 160) })),
    pins: data.items.filter((it) => it.kind === 'pin' && it.status !== 'dropped').map((it) => ({ id: it.id, text: clip(`${it.system ? `${it.system} ` : ''}${it.value || it.text}`, 80), by: byWhom(it) })),
    // every finding with its source and the CLI's verdict on it (usable or why not)
    evidence: data.evidence.slice(0, 60).map((e) => ({ id: e.id, item: e.item, claim: clip(e.claim, 200), source: clip(e.source, 200), version: e.version || null, retrieved_at: e.retrieved_at || null, verdict: e.verdict || null, usable: usable(e) })),
    dropped: data.items.filter((it) => it.status === 'dropped').map((it) => { const h = [...(it.history || [])].reverse().find((x) => x.event === 'dropped') || {}; return { id: it.id, text: clip(it.text, 160), actor: h.actor || null, reason: h.text || null }; }),
    sheets: data.sheets.length,
    passes: data.research.passes.length,
    checks: data.checks.length,
    redirects: data.redirects.map((R) => ({ id: R.id, status: R.status, clauses: R.clauses.length })),
    migration: data.migration ? { from: data.migration.from, summary: data.migration.summary } : null,
  };
}

// `factory clarify split`: v3 has no folded issues (migration made each alias its own item).
function split(root, { jobId }) {
  const state = require('./job').resolve(root, jobId);
  return { job: state.id, message: 'Clarify v3 keeps no folded issues: every item has its own id (migration turned each v2 alias into its own item). Nothing to split; factory clarify status lists them.' };
}

module.exports = {
  STAGES, WAITS, KINDS, STATUSES, STRENGTH, CHECKLIST, SECTIONS,
  file, load, save, get, peek, empty, settings, addWord, newItem, item, setValue, reopen,
  pinOf, compatible, urlVersion, inRange, verdictOf, usable, judge, route, advance,
  applyReadback, readbackScreen, parseSheetReply, applySheet, sheetScreen, buildSheet,
  startRedirect, applyRedirect, confirmRedirect, redirectScreen, sentences,
  applyWriter, writeSections, sectionLines, deterministic, applyCheck,
  stagePlan, record, reply, redirect, chatReply, sync, ready, nextInfo, waitingForUser,
  h1View, h1Summary: (root, state) => h1View(root, state), view, status, statusText, onResume, proceed, briefText, deferredText, floorOk, inClarify, consoleBlock, split, ACCEPT,
};
