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

const STAGES = ['readback', 'readback_wait', 'research', 'sheet_wait', 'interpret', 'redirect', 'redirect_wait', 'assemble', 'check', 'dispute', 'diagnose', 'ready'];
const WAITS = new Set(['readback_wait', 'sheet_wait', 'redirect_wait']);
const RUNS = new Set(['readback', 'research', 'interpret', 'redirect', 'assemble', 'check', 'dispute', 'diagnose']);
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
    // automatic contract-writer rounds on findings the writer can fix from what is settled
    // (limits.clarify_writer_rounds): the loop also stops early when a round makes no progress
    writer_rounds: Math.max(1, pos((pol.limits || {}).clarify_writer_rounds, pos(c.max_writer_rounds, caps.max_writer_rounds || 5))),
    // readiness checks that send work back (to the writer, the sheet, research or the read-back)
    // before the job parks: a God Eye that keeps finding a new blocker cannot loop the user
    readiness_cycles: Math.max(1, pos(c.max_readiness_cycles, caps.max_readiness_cycles || 3)),
    // the shared loop engine's settings for the writer ⇄ God Eye loop (cli/core/loop.js): the
    // ceiling is limits.clarify_writer_rounds; policy.loops gives the stall rule, the stronger
    // model and whether a diagnosis runs before the loop ends (at H1, never in a park)
    loops: require('./loop').policyFor(pol, { ceiling: Math.max(1, pos((pol.limits || {}).clarify_writer_rounds, pos(c.max_writer_rounds, caps.max_writer_rounds || 5))) }),
    // the read-back is shown, not waited on, unless a pin conflicts or a question only the user can
    // answer is on it (clarify.readback "wait" restores the old blocking read-back)
    readback_wait: c.readback === 'wait',
    // facts research settled are shown on the sheet when there is one and at H1; a sheet of facts
    // alone is not a turn of its own (clarify.facts_sheet true restores it)
    facts_sheet: c.facts_sheet === true,
    // a blocker that survives a writer round that had its fix is checked by the finding-verifier
    // once (clarify.tiebreak false turns it off)
    tiebreak: c.tiebreak !== false,
    research_sec: Math.max(1, Math.round(pos(minutes, { low: 6, medium: 10, high: 15 }[state.risk] || 10) * 60)),
    agent_sec: { interviewer: pos(sec.interviewer, 600), 'brief-writer': pos(sec['brief-writer'], 900), 'contract-writer': pos(sec['contract-writer'], 900), 'god-eye': pos(sec['god-eye'], 900), 'finding-verifier': pos(sec['finding-verifier'], 600) },
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
  // relayed: the words reached the factory through a command the main session ran on the user's
  // behalf (job new --request, clarify reply, clarify redirect), not through the reply hook or a
  // human-only gate verb. The factory cannot tell them from the user's own; H1 says which they are.
  const w = { id: nextId(data.words, 'W'), at: nowIso(), via, stage, text: t.slice(0, 4000), ...(['reply', 'redirect', 'request'].includes(via) ? { relayed: true } : {}) };
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
  // the user's later words win over their earlier ones, never silently: the change is kept and
  // shown on the next screen the user sees (the sheet, or H1) as "changed: X → Y because you said …"
  if (byUser && (it.strength === 'user' || it.strength === 'accepted' || it.kind === 'scope') && it.value !== null && it.value !== undefined && value !== null && value !== undefined && norm(value) !== norm(it.value)) {
    it.changes = [...(it.changes || []), { at: nowIso(), from: clip(it.value, 300), to: clip(value, 300), quote: clip((source && source.quote) || text || value, 300), word: source && (source.word || source.ref) ? source.word || source.ref : null, shown: false }].slice(-10);
  }
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
    if (it.record) it.record.usable = (it.record.evidence || []).filter((id) => usable(data.evidence.find((e) => e.id === id))).length;
    // a decision whose researched recommendation rested on findings that no longer hold (the pin
    // changed): asked again, unless the user decided it themselves
    if (it.kind === 'decision' && it.researched && it.status === 'decided' && it.strength !== 'user' && !it.evidence.length && it.rejected.length) {
      reopen(it, 'cli', `its sources document another version than the one now confirmed`);
      it.researched = undefined;
      it.record = null;
      continue;
    }
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

// The systems a finding must be judged against: the system it names when that system has a pin
// (or a range); a finding that names no system is judged against its item's pinned systems, or
// every pinned system when its item names none (a page cannot slip past the pins by leaving the
// system out, as migrated v1/v2 findings and some researchers do). System names compare without
// case or punctuation ("Nautobot" is the pinned "nautobot"); a different name is another system.
const sysKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function systemsFor(e, it, constrained) {
  const keys = Object.keys(constrained);
  const named = sysKey(e.system);
  if (named) return keys.filter((k) => sysKey(k) === named);
  const own = ((it && it.pins) || []).map((p) => keys.find((k) => sysKey(k) === sysKey(p))).filter(Boolean);
  return own.length ? own : keys;
}

// Exact pins by system, and the repository's ranges for systems with no exact pin yet.
function rangesBySystem(data) {
  const out = {};
  for (const it of data.items) if (it.kind === 'pin' && it.status !== 'dropped' && !(it.status === 'decided' && it.value) && (it.allows || []).length) out[it.system] = it.allows.map((a) => a.range);
  return out;
}

function verdictOf(root, e, pins, data) {
  if (e.tier === 'repo' || (!/^https?:/i.test(e.source) && /:\d+/.test(e.source))) return repoQuoteOk(root, e) ? 'repo' : 'bad_quote';
  if (!/^https?:/i.test(e.source) || !String(e.quote || '').trim()) return 'unsourced';
  const it = item(data, e.item);
  const ranges = data && data.items ? rangesBySystem(data) : {};
  const u = urlVersion(e.source);
  const docVersion = (u && u.version) || (e.version ? pinOf(e.version) || e.version : null);
  const pinned = systemsFor(e, it, pins);
  if (pinned.length) {
    if (u && u.moving) return 'unpinned';
    if (!docVersion) return 'unpinned';
    const fits = (v) => pinned.some((s) => compatible(pins[s], v));
    return fits(docVersion) && (!e.version || !u || !u.version || fits(e.version)) ? 'pinned' : 'other_version';
  }
  // a system the repository constrains to a range, with no exact version confirmed yet: a moving
  // page or a page outside the range proves nothing about the version in use
  const ranged = systemsFor(e, it, ranges);
  if (ranged.length) {
    if (u && u.moving) return 'unpinned';
    if (docVersion && !ranged.every((s) => ranges[s].every((r) => inRange(docVersion, r)))) return 'other_version';
  }
  return 'docs';
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
  // facts not shown to the user yet: on the sheet when there is one, and at H1 (Facts relied on);
  // a sheet of facts alone is no turn of its own unless clarify.facts_sheet asks for it
  if (S && S.facts_sheet && unshownFacts(data).length) {
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
  // the scope, in and out, as items: a later redirect or sheet answer can change one by its id
  // (a changed scope line is shown as a change, never dropped silently)
  rb.scope_items = { in: [], out: [] };
  for (const side of ['in', 'out']) {
    for (const text of rb.scope[side]) {
      let it = data.items.find((x) => x.kind === 'scope' && x.scope === side && x.status !== 'dropped' && (norm(x.text) === norm(text) || norm(x.value) === norm(text)));
      if (!it) it = newItem(data, { kind: 'scope', text, value: text, status: 'decided', strength: 'assumption', origin: 'readback', extra: { scope: side } }, 'interviewer');
      referenced.add(it.id);
      rb.scope_items[side].push(it.id);
    }
  }
  // a scope line the user set (by a redirect or a sheet answer) stays, whatever this read-back says
  for (const it of data.items) {
    if (it.kind === 'scope' && it.status !== 'dropped' && !referenced.has(it.id)) {
      if (it.strength === 'user') {
        referenced.add(it.id);
        (rb.scope_items[it.scope === 'out' ? 'out' : 'in'] || []).push(it.id);
      } else {
        it.status = 'dropped';
        itemEvent(it, 'dropped', 'interviewer', 'not in the new read-back');
      }
    }
  }
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
      // the repository's exact version first; between the user's own words, the latest they said
      const latestUser = [...user].sort((a, b) => num(b.source.ref) - num(a.source.ref))[0];
      const rec = repo[0] || latestUser || exact[0];
      it.status = 'to_decide';
      it.options = distinct.length > 1 ? distinct.map((c, i) => ({ key: String.fromCharCode(97 + i), text: `${c.version} (${c.source.kind === 'word' ? `you said "${c.source.quote}"` : `${c.source.ref}`})`, version: c.version })) : [{ key: 'a', text: `${user[0].version} (you said "${user[0].source.quote}")`, version: user[0].version }];
      it.recommendation = it.options.find((x) => x.version === rec.version) ? it.options.find((x) => x.version === rec.version).key : 'a';
      it.why = distinct.length > 1 ? `the versions disagree; ${rec.source.kind === 'repo' ? `the repository installs ${rec.version}` : 'take the one you stated last'}` : `${user[0].version} is outside what the repository allows (${ranges.map((r) => r.version).join(', ')})`;
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
    // (only what is still open: a decided, assumed or deferred item is history the user saw, and a
    // read-back after a redirect does not drop it for not mentioning it again)
    if (referenced.has(it.id) || it.origin !== 'readback' || FINAL.has(it.status) || it.strength === 'user' || !data.readback) continue;
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
  L.push(`- Run as: ${state.work_type || 'work'} at ${state.risk} risk${state.epic ? ', as an epic' : ''} (from intake; say so if not)`);
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

// The read-back confirmed: by the user's ok, or (auto) because nothing on it needs the user (no
// pin conflict, no question only they can answer). An auto read-back is shown on the next screen
// the user sees (the sheet, or H1); its intent stays the factory's restatement until H1.
function readbackNeedsUser(data) {
  const rb = data.readback;
  if (!rb) return false;
  if (rb.pins.some((id) => (item(data, id) || {}).status === 'to_decide')) return true;
  if (rb.questions.some((id) => { const it = item(data, id); return it && !FINAL.has(it.status); })) return true;
  // a version the user changed in a redirect is read back before anything is researched against it
  if (data.redirects.some((R) => R.status === 'confirmed' && (R.clauses || []).some((c) => c.pin_change && !c.pin_read_back))) return true;
  return data.redirects.some((r) => r.status === 'queued');
}

function confirmReadback(data, word, S, auto = false) {
  const rb = data.readback;
  rb.confirmed = { at: nowIso(), word: word ? word.id : null, ...(auto ? { auto: true } : {}) };
  if (auto) {
    rb.auto = true;
    rb.shown = false;
    // the intent as the factory restated it: assumed until the user corrects it or approves H1
    for (const it of data.items) {
      if (it.kind === 'intent' && it.status === 'open' && it.strength !== 'user') {
        it.status = 'assumed';
        itemEvent(it, 'assumed', 'factory', 'the read-back was shown without waiting: H1 confirms it');
      }
    }
    log(data, 'readback_auto', 'nothing on the read-back needs the user: research starts; the read-back is shown on the next screen');
    return;
  }
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
  for (const R of data.redirects) for (const c of R.clauses || []) if (c.pin_change) c.pin_read_back = rb.confirmed.at;
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
    const pins = pinsBySystem(data);
    const sys = systemsFor(e, item(data, e.item), pins)[0] || systemsFor(e, item(data, e.item), rangesBySystem(data))[0];
    const pin = sys ? pins[sys] || `a version the repository allows (${(rangesBySystem(data)[sys] || []).join(', ')})` : 'version';
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
    // no park: research is over for these items; what it could not do is a gap the sheet and H1
    // show (the decisions are asked without a researched recommendation)
    const why = `the brief writer ${rec.failures.find((f) => f.what === 'the brief writer').reason} in ${data.counters.research_passes} pass(es)`;
    data.research.retry = null;
    for (const id of pass.items) {
      const it = item(data, id);
      if (!it) continue;
      it.needs_research = false;
      if (it.kind === 'decision' && it.researched === undefined) it.researched = false;
      it.gap = it.gap || clip(`not researched: ${why}`, 200);
    }
    addFailure(data, { what: 'research', reason: `no research brief: ${why}; the items it covered go on without a researched recommendation` });
    log(data, 'research_gave_up', why);
    return { next: 'route' };
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
  const rb = data.readback;
  const showReadback = Boolean(rb && rb.auto && !rb.shown);
  if (showReadback) rb.shown = n;
  // the user's own earlier words a later word changed: shown once, on this sheet
  const changes = data.items.flatMap((it) => (it.changes || []).filter((c) => !c.shown).map((c) => {
    c.shown = n;
    return { item: it.id, text: it.text, from: c.from, to: c.to, quote: c.quote };
  }));
  data.sheets.push({ n, at: nowIso(), decisions, facts, queued: pending.length - take.length, answered_at: null, failures_at: data.failures.length, ...(showReadback ? { readback: true } : {}), ...(changes.length ? { changes } : {}) });
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

// The read-back, compactly, on the first screen after it (it was shown, not waited on).
function readbackBrief(data, state = null) {
  const rb = data.readback;
  if (!rb) return [];
  const i = rb.intent || {};
  const L = ['**What I understood** (my read-back; correct anything in your reply)'];
  if (state) L.push(`- Run as: ${state.work_type || 'work'} at ${state.risk} risk${state.epic ? ', as an epic' : ''}`);
  if (i.problem || i.outcome) L.push(`- ${i.problem || ''}${i.outcome ? ` → ${i.outcome}` : ''}`);
  if (rb.scope.in.length) L.push(`- In scope: ${rb.scope.in.join('; ')}`);
  if (rb.scope.out.length) L.push(`- Out of scope: ${rb.scope.out.join('; ')}`);
  const took = rb.took.map((id) => item(data, id)).filter(Boolean);
  if (took.length) L.push(`- From your words: ${took.map((it) => `${it.value || it.text} ("${clip((it.source && it.source.quote) || '', 80)}")`).join('; ')}`);
  const pins = rb.pins.map((id) => item(data, id)).filter((p) => p && p.value);
  if (pins.length) L.push(`- Versions: ${pins.map((p) => `${p.system} ${p.value}${p.source && p.source.quote ? ` (${p.source.kind === 'word' ? `you said "${clip(p.source.quote, 80)}"` : `${p.source.ref}`})` : ''}`).join(', ')}`);
  return L;
}

function sheetScreen(state, data) {
  const s = currentSheet(data);
  if (!s) return '';
  const passes = data.research.passes.length;
  const L = [`**Decisions · ${state.id}**${passes ? ` (research: ${passes} pass${passes > 1 ? 'es' : ''})` : ''}`, ''];
  if (s.readback) L.push(...readbackBrief(data, state), '');
  if ((s.changes || []).length) {
    L.push('**Changed by your later words** (the later one wins; say if not)');
    for (const c of s.changes) L.push(`- changed: ${c.from} → ${c.to} because you said "${clip(c.quote, 160)}"`);
    L.push('');
  }
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
  const stuck = s.decisions.filter((d) => !d.answered && !d.recommendation);
  if (s.ok_without_answer && stuck.length) L.push('', `**You replied ok, but ${stuck.map((d) => d.no).join(', ')} ${stuck.length > 1 ? 'have' : 'has'} no recommendation to take.** Answer ${stuck.length > 1 ? 'them' : 'it'} in your own words, or reply **ok** again and design decides ${stuck.length > 1 ? 'them' : 'it'} (shown at H1 under "Design may still choose").`);
  L.push('', 'Reply **ok** to take my recommendations, or say what to change: **ok, but 2 b**, **3: other: <your words>**, **2 defer**, **fact 1: <correction>**. Plain words work too.');
  return L.join('\n');
}

// "proceed" is not an ok: it is the human-only verb that continues a park (factory proceed).
const ACCEPT = /^(ok|okay|k|yes|y|yep|yeah|go|go ahead|accept(ed)?|accept all|agreed|fine|sure|looks good|lgtm|sounds good|correct|right|confirmed?|as recommended|take (your|the) recommendations?|all recommended|start|start research)[.!]*$/i;
const ACCEPT_HEAD = /^(ok|okay|yes|yep|fine|sure|agreed|looks good|lgtm|sounds good|accept(?: all)?|go ahead)\s*[,.;:!]?\s*(?:but|except|and|although|though)?\s*[,:;-]?\s*/i;
// "otherwise ok", "the rest as recommended": an ok for whatever the numbered parts leave open
const ACCEPT_REST = /^(?:and\s+|but\s+)?(?:otherwise|the rest|rest|others|all others|everything else|all else)\s*(?:is\s+|are\s+|as\s+)?(?:ok|okay|fine|good|recommended|as recommended|as you recommend)$/i;
// where one numbered answer starts: "2 b", "2: …", "2) …", "fact 1: …", "3 defer", "1a"
const NUMBERED = String.raw`(?:fact\s*|f)?\d{1,2}(?:\s*[:)]|\s*[a-e](?![a-z])|\s+(?:ok|okay|defer|other)\b)`;

// A sheet reply in plain words: { accept, answers: [{no, choice|text|defer}], facts: [{no, text}] },
// or null when it is not exactly that shape: the interviewer reads it then (one call, every
// mapping quoted). Only an unambiguous reply is applied here: an option key, ok, defer, or
// free words after an explicit "2: …" / "2 other: …". "2 b please", "1 a 2 b and 3 defer" or
// "3 is b" are never taken word for word as the user's answer.
function parseSheetReply(text, sheet) {
  let t = String(text || '').trim();
  if (!t || !sheet) return null;
  if (ACCEPT.test(t)) return { accept: true, answers: [], facts: [] };
  let accept = false;
  const head = ACCEPT_HEAD.exec(t);
  if (head && head[0].trim() && t.length > head[0].length) {
    accept = true;
    t = t.slice(head[0].length).trim();
  }
  // split before every numbered answer: at a separator (newline ; , . and), or bare whitespace
  const segs = t.split(new RegExp(String.raw`(?:\s*(?:\n|[;,]|\.(?=\s)|\band\b)\s*|(?<!\bfact)\s+)(?=${NUMBERED})|\s*(?:\n|[;,]|\.(?=\s))\s*(?=(?:and\s+|but\s+)?(?:otherwise|the rest|rest|others|all others|everything else|all else)\b)`, 'i')).map((x) => x.trim()).filter(Boolean);
  const answers = [];
  const facts = [];
  for (const seg of segs) {
    if (ACCEPT_REST.test(seg.replace(/[.!]+$/, ''))) {
      accept = true;
      continue;
    }
    const m = /^(fact\s*|f)?(\d{1,2})\s*([:)\-.])?\s*(.*)$/i.exec(seg);
    if (!m || !m[4].trim()) return null;
    const no = Number(m[2]);
    const colon = Boolean(m[3] && m[3] !== '.');
    const body = m[4].trim().replace(/[.!]+$/, '');
    if (m[1]) {
      if (!colon || !sheet.facts.some((f) => f.no === no)) return null;
      facts.push({ no, text: body });
      continue;
    }
    if (!sheet.decisions.some((d) => d.no === no)) return null;
    if (answers.some((a) => a.no === no)) return null; // two answers to one decision: ask the interviewer
    let a;
    const key = /^\(?([a-e])\)?$/i.exec(body);
    if (key) a = { no, choice: key[1].toLowerCase() };
    else if (/^(ok|okay|yes|recommended|as recommended|fine|agreed)$/i.test(body)) a = { no, choice: 'recommended' };
    else if (/^(defer|deferred|later|skip|design( decides)?|you decide|your call|let design decide)$/i.test(body)) a = { no, defer: true };
    else {
      const other = /^other\s*[:\-]?\s*(.+)$/i.exec(body);
      // free words only after "2: " or "2 other …", and never starting with a bare option key
      // ("2: b please"): those are for the interviewer, who quotes what it maps
      if (!other && !colon) return null;
      const words = other ? other[1].trim() : body;
      if (!other && /^\(?[a-e]\)?(?:[\s,.;:)!-]|$)/i.test(words)) return null;
      a = { no, text: words };
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

// An ok (or an interpreted "as you recommend") that leaves decisions with no recommendation open:
// the sheet says so once; the second hands those decisions to design, with the words that did it,
// so the sheet never loops. Only when nothing else was left open (an unanswered decision that has
// a recommendation is the user's to answer).
function okWithoutRecommendation(data, s, r, w, nos) {
  const stuck = s.decisions.filter((d) => !d.answered && !d.recommendation && nos.includes(d.no));
  if (!stuck.length || stuck.length !== r.open.length) return;
  s.ok_without_answer = (s.ok_without_answer || 0) + 1;
  if (s.ok_without_answer < 2) return;
  for (const d of stuck) {
    const it = item(data, d.item);
    if (!it) continue;
    it.status = 'deferred';
    it.owner = 'design';
    it.strength = 'user';
    it.value = 'deferred to design';
    it.deferred_by_ok = true;
    itemEvent(it, 'deferred', 'user', `you replied ok twice to a decision with no recommendation: design decides it ("${clip(w.text, 80)}")`);
    d.answered = { at: nowIso(), word: w.id, how: 'ok twice: deferred to design' };
    r.decided.push(it.id);
  }
  r.open = [];
  s.answered_at = nowIso();
}

// A decided contradiction settles the user's statement it was about; a decision about an item
// the user's hand edit took out puts it back or drops it.
function afterDecision(data, it) {
  if (it.lost) {
    const target = item(data, it.lost.item);
    if (!target) return;
    const leaveOut = (it.options || [])[1] && it.value === it.options[1].text;
    if (leaveOut) {
      target.status = 'dropped';
      itemEvent(target, 'dropped', 'user (hand edit)', `you removed ${it.lost.where} from the contract and chose to leave it out (${it.id})`);
    } else itemEvent(target, 'restore', 'user (hand edit)', `put back (${it.id}): ${clip(it.value, 120)}`);
    return;
  }
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

// The parts of `text` no quote covers, verbatim, each with real content (more than glue words
// such as "and", "also", "please"). Quotes are matched without case or spacing differences.
const GLUE = new Set(['and', 'also', 'then', 'but', 'so', 'please', 'or', 'too', 'as', 'well', 'the', 'a', 'an', 'to', 'it', 'that', 'this', 'with', 'of', 'for', 'in', 'on', 'not', 'just']);
function unquoted(text, quotes) {
  const src = String(text);
  const lower = src.toLowerCase();
  const covered = new Array(src.length).fill(false);
  for (const q of quotes) {
    const words = String(q || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    // the quote's words in order, with any whitespace between them
    const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
    let m;
    while ((m = re.exec(lower))) {
      for (let i = m.index; i < m.index + m[0].length; i++) covered[i] = true;
      if (!m[0].length) re.lastIndex++;
    }
  }
  const out = [];
  let cur = '';
  const flush = () => {
    const parts = cur.split(/(?<=[.;!?])\s+|;\s*|\n+/);
    cur = '';
    for (const part of parts) {
      let t = part.replace(/^[\s,.;:!?\-–—()]+|[\s,.;:!?\-–—(]+$/g, '').trim();
      t = t.replace(/^(?:(?:and|also|then|but|so|plus)\b[\s,]*)+/i, '').trim();
      if (!t) continue;
      const content = t.toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w && !GLUE.has(w));
      if (content.length >= 2 || (content.length === 1 && content[0].length >= 6)) out.push(t);
    }
  };
  for (let i = 0; i < src.length; i++) {
    if (covered[i]) flush();
    else cur += src[i];
  }
  flush();
  return out;
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
  // conservation: every part of the redirect no clause quotes becomes an instruction, verbatim.
  // Not only whole sentences: "research X, and decide Y" with only "research X" quoted leaves
  // "decide Y" over, and that is tracked too.
  for (const s of unquoted(R.text, clauses.map((c) => c.quote))) clauses.push({ n: clauses.length + 1, quote: s, item: null, action: 'instruction', text: s, tag: null, unread: true });
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

const STAGE_OF = { research: 'research', decide: 'research', fix: 'assemble', fact: 'assemble', instruction: 'assemble', readback: 'readback' };

function confirmRedirect(data, word) {
  const R = currentRedirect(data);
  R.status = 'confirmed';
  R.confirmed = { at: nowIso(), word: word.id };
  for (const c of R.clauses) {
    let it = c.item ? item(data, c.item) : null;
    // a version the user states in a redirect ("we run 2.3, not 2.4"): pins come from the user's
    // words only through the read-back, so the version is read back and every finding judged
    // again against it. A clause on a pin item, or a stated fact that names a version.
    const pinChange = (it && it.kind === 'pin') || (!it && c.action === 'fact' && /\b\d+\.\d+/.test(c.quote));
    if (pinChange) {
      if (it) {
        itemEvent(it, 'reopened', 'user (redirect)', c.quote);
        it.value_before = it.value;
        it.value = null;
        it.strength = null;
        it.status = 'open';
        it.resolved = null;
      } else it = newItem(data, { kind: 'fact', text: c.text, value: c.text, status: 'decided', strength: 'user', source: { kind: 'word', ref: R.word, quote: c.quote }, origin: 'redirect' }, 'user (redirect)');
      it.links = [...new Set([...(it.links || []), R.id])];
      c.item = it.id;
      c.stage = 'readback';
      c.pin_change = true;
      c.started_at = nowIso();
      c.pass_at = data.research.passes.length;
      continue;
    }
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
  newWriterCycle(data);
  data.counters.readiness_cycles = 0;
  const earliest = R.clauses.map((c) => ORDER[c.stage]).reduce((m, x) => Math.min(m, x), 9);
  R.restart = Object.keys(ORDER).find((k) => ORDER[k] === earliest) || 'assemble';
  log(data, 'redirect_confirmed', `${R.clauses.length} clause(s); restart at ${R.restart}`);
}

// Did a clause get done? (shown at H1, item by item)
function clauseOutcome(data, R, c) {
  const it = c.item && item(data, c.item);
  if (!it) return { done: false, how: 'not linked to anything' };
  if (c.pin_change) {
    // done when a version was confirmed from words given with or after this redirect
    const pins = data.items.filter((x) => x.kind === 'pin' && x.status === 'decided' && x.value && (x.id === it.id || (x.history || []).some((h) => h.at >= R.at)));
    const fresh = pins.filter((p) => p.source && p.source.kind === 'word' && num(p.source.ref) >= num(R.word));
    if (!fresh.length) return { done: false, how: pins.length ? `the version was not changed: ${pins.map((p) => `${p.system} ${p.value}`).join(', ')} (${byWhom(pins[0])})` : 'no version is confirmed yet' };
    return { done: true, how: `read back and confirmed: ${fresh.map((p) => `${p.system} ${p.value}`).join(', ')}; every source judged again against it` };
  }
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
  for (const p of live.filter((it) => it.kind === 'pin' && !it.value)) decisions.unshift(`- ${p.system} version → not confirmed${(p.allows || []).length ? ` (the repository allows ${p.allows.map((a) => `"${a.range}"`).join(', ')}; sources were judged against that range)` : ''}`);
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

// The contract is an input only of the stages that read it (the read-back reads the draft, the
// writer and the readiness check the text): a hand edit while research runs (the long stage), a
// redirect or a sheet answer is read does not throw their results away.
function stageContractHash(root, state, stage) {
  return ['readback', 'assemble', 'check'].includes(stage) ? contractHash(root, state) : null;
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
  // nothing leaves the contract silently: once the factory has written a version (or the user
  // edited one), an acceptance criterion, constraint or non-goal the new text no longer has must be
  // listed under `removed` with the item, blocker or redirect it rests on
  const removedNow = [];
  const changedNow = [];
  if (data.contract.written_hash) {
    const before = contract.parse(contract.read(root, state.id));
    const key = (t) => norm(t).replace(/[.;]+$/, '');
    // a placeholder ("None", "n/a", "-") is no constraint or non-goal: replacing it drops nothing
    const placeholder = (t) => /^(none|n\/a|na|-|—|tbd|\(none\))$/i.test(key(t));
    const gone = [
      ...before.acs.filter((a) => !parsed.acs.some((b) => b.id === a.id)).map((a) => ({ ref: a.id, text: a.text })),
      ...before.constraints.filter((c) => !placeholder(c) && !parsed.constraints.some((d) => key(d) === key(c))).map((c) => ({ ref: 'Constraints', text: c })),
      ...before.nonGoals.filter((c) => !placeholder(c) && !parsed.nonGoals.some((d) => key(d) === key(c))).map((c) => ({ ref: 'Non-goals', text: c })),
    ];
    const listed = Array.isArray(out.removed) ? out.removed : [];
    // what a change may rest on: an item, a redirect, a blocker, or the user's own words (W-n)
    const known = (b) => Boolean(b) && Boolean(item(data, b) || data.redirects.some((R) => R.id === String(b).toUpperCase()) || data.words.some((w) => w.id === String(b).toUpperCase()) || (data.blockers || []).some((x) => x.ref === b) || data.checks.some((k) => (k.objections || []).some((o) => o.ref === b)));
    // a reworded constraint or non-goal is a cited change (old → new), not a drop
    const changedList = Array.isArray(out.changed) ? out.changed : [];
    const nowLines = [...parsed.constraints.map((c) => ({ ref: 'Constraints', text: c })), ...parsed.nonGoals.map((c) => ({ ref: 'Non-goals', text: c })), ...parsed.acs.map((a) => ({ ref: a.id, text: a.text }))];
    const unexplained = [];
    // the user's words (W-n) justify changing a line only when they came after the contract that
    // has it was written: older words (the request, W-1) were there when the line was written from
    // them, so citing them cannot turn it into something else (m11)
    const wordOf = (b) => data.words.find((w) => w.id === String(b || '').toUpperCase());
    const stale = (b) => {
      const w = wordOf(b);
      return Boolean(w && data.contract.written_at && Date.parse(w.at) < Date.parse(data.contract.written_at));
    };
    const staleCites = [];
    // and the words cited must say what the new line adds: one of its new words is in them
    const sig = (t) => new Set((String(t || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) || []).filter((x) => !['this', 'that', 'with', 'from', 'must', 'should', 'will', 'have', 'only', 'also', 'are', 'not'].includes(x)));
    const unsupported = (b, from, to) => {
      const w = wordOf(b);
      if (!w) return false;
      const old = sig(from);
      const added = [...sig(to)].filter((x) => !old.has(x));
      const said = String(w.text).toLowerCase();
      return added.length > 0 && !added.some((x) => said.includes(x.replace(/s$/, '')));
    };
    const quoteOf = (b) => (wordOf(b) ? clip(wordOf(b).text, 200) : null);
    for (const g of gone) {
      const ch = changedList.find((x) => x && (x.ref === g.ref || !x.ref) && x.from && key(x.from) === key(g.text) && x.to && nowLines.some((l) => key(l.text) === key(x.to)) && known(x.because));
      if (ch && stale(ch.because)) staleCites.push(`${g.ref}: "${clip(g.text, 80)}" (cites ${String(ch.because).toUpperCase()}, given before this line was written)`);
      else if (ch && unsupported(ch.because, g.text, ch.to)) staleCites.push(`${g.ref}: "${clip(g.text, 80)}" (cites ${String(ch.because).toUpperCase()}, whose words do not say what the new line says)`);
      else if (ch) {
        changedNow.push({ ref: g.ref, from: clip(g.text, 200), to: clip(ch.to, 200), because: String(ch.because), why: clip(ch.why || '', 200), ...(quoteOf(ch.because) ? { quote: quoteOf(ch.because) } : {}) });
        continue;
      }
      const l = listed.find((x) => (x.ref === g.ref || (x.text && key(x.text) === key(g.text))) && known(x.because));
      if (l && stale(l.because)) staleCites.push(`${g.ref}: "${clip(g.text, 80)}" (cites ${String(l.because).toUpperCase()}, given before this line was written)`);
      else if (l) removedNow.push({ ref: g.ref, text: clip(g.text, 200), because: String(l.because).toUpperCase() === String(l.because) ? l.because : String(l.because), why: clip(l.why || '', 200), ...(quoteOf(l.because) ? { quote: quoteOf(l.because) } : {}) });
      else if (ch) continue;
      else unexplained.push(g.ref === 'Constraints' || g.ref === 'Non-goals' ? `${g.ref}: "${clip(g.text, 80)}"` : g.ref);
    }
    if (staleCites.length) {
      res.refused = `the new text changes or drops ${staleCites.join(', ')}: a change rests on the user's words only when they came after the line was written and say what the new line says. Cite what changed since (an item I-n, a blocker, a redirect, or the user's later words), or keep the line`;
      return res;
    }
    if (unexplained.length) {
      res.refused = `the new text drops ${unexplained.join(', ')} with no reason: list each under changed (a rewording: from, to, because) or removed with the item (I-n), the user's words (W-n), the blocker or the redirect it rests on, or keep it`;
      return res;
    }
  }
  writeText(jobPaths(root, state.id).contract, next);
  if (removedNow.length) data.contract.removed = [...(data.contract.removed || []), ...removedNow.map((r) => ({ ...r, at: nowIso() }))].slice(-40);
  if (changedNow.length) data.contract.changed = [...(data.contract.changed || []), ...changedNow.map((r) => ({ ...r, at: nowIso() }))].slice(-40);
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
  data.contract.written_at = nowIso();
  data.contract.edited_by_hand = false;
  return res;
}

// ---------------------------------------------------------------- readiness
function liveForCoverage(it) {
  if (it.status === 'dropped' || it.status === 'deferred' || it.superseded || it.lost) return false;
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

// Who can fix a readiness blocker: the `writer` (from what is already settled: a weak or
// untestable verify command, the contract contradicting itself, a check that runs no test file,
// wording) or the `user` (a decision only they can make: their statements conflict, a scope
// question nobody answered, a value no evidence or answer settles). God Eye says so per objection
// (`fixable_by`); without that, the CLI decides from the blocker itself:
//   - its own checks: by the stage they concern (assemble: the writer; the sheet or the read-back:
//     the user);
//   - God Eye's: a blocker about the contract text (stage assemble) or a missing fact (research)
//     needs no user; a weak verify command (acs_testable) or a contradiction between the
//     contract's own sections (self_consistent, pointing at no item the user stated) never does,
//     whatever stage it names; anything else it sent to the sheet or the read-back is the user's.
function userStated(data, b) {
  const ids = `${b.ref || ''} ${b.issue || ''} ${b.why || ''}`.match(/\bI-\d+\b/gi) || [];
  return ids.some((id) => {
    const it = item(data, id);
    return Boolean(it && it.strength === 'user');
  });
}
function fixableBy(b, data) {
  if (b.fixable_by === 'writer' || b.fixable_by === 'user') return b.fixable_by;
  if (b.by === 'cli') return ['sheet', 'readback'].includes(b.stage) ? 'user' : 'writer';
  if (b.stage === 'assemble' || b.stage === 'research') return 'writer';
  if (b.check === 'acs_testable') return 'writer';
  if (b.check === 'self_consistent' && !userStated(data, b)) return 'writer';
  return 'user';
}

// Where a classified blocker goes: the writer (or research, for a missing fact) without the
// user; the user's to the decision sheet (or the read-back, when the intent itself is unclear).
function routeOf(b) {
  if (b.fixable_by === 'user') return b.stage === 'readback' ? 'readback' : 'sheet';
  return b.stage === 'research' ? 'research' : 'assemble';
}

function classify(data, blockers) {
  return blockers.map((b) => {
    const c = { ...b, fixable_by: fixableBy(b, data) };
    c.route = routeOf(c);
    return c;
  });
}

// The identity of a set of writer blockers, to tell a round that made progress (the set shrank
// or changed) from one that made none (the same set again). God Eye's ids are its check and what
// it points at; the CLI's own blockers add their (deterministic) text.
function blockerKey(b) {
  const ref = String(b.ref || '').trim().toUpperCase();
  return `${b.check}|${ref}${b.by === 'cli' ? `|${norm(b.why || b.issue).slice(0, 80)}` : ''}`;
}
function signature(blockers) {
  return [...new Set(blockers.map(blockerKey))].sort().join('\n');
}

function findingLine(b, i) {
  return `${i + 1}. ${b.check} (${b.ref || 'contract'}): ${clip(b.issue || b.why, 200)}${b.fix ? ` — suggested fix: ${clip(b.fix, 160)}` : ''}`;
}

function optionsOf(b) {
  const opts = (Array.isArray(b.options) ? b.options : []).slice(0, 5).map((o, i) => ({ key: 'abcde'[i], text: clip(typeof o === 'string' ? o : o && o.text, 200), consequences: clip(o && o.consequences, 200) })).filter((o) => o.text);
  const want = norm(b.recommendation);
  const rec = want ? opts.find((o) => o.key === want || norm(o.text) === want) : null;
  return { options: opts, recommendation: rec ? rec.key : null, why: clip(b.fix || '', 300) || null };
}

// A decision only the user can make, from a blocker: a question on the next decision sheet, with
// God Eye's options and recommendation when it gave them (never a generic park).
function userQuestion(data, b) {
  const by = b.by === 'cli' ? 'readiness check' : 'God Eye';
  const it = item(data, b.ref);
  if (it && ['decision', 'question'].includes(it.kind)) {
    if (FINAL.has(it.status) && it.status !== 'dropped') reopen(it, by, b.issue || b.why);
    if (!(it.options || []).length) Object.assign(it, optionsOf(b));
    return it;
  }
  const text = clip(b.question || b.issue || b.why, 300);
  if (data.items.some((x) => x.origin === 'check' && x.kind === 'decision' && !FINAL.has(x.status) && norm(x.text) === norm(text))) return null;
  return newItem(data, { kind: 'decision', text, status: 'to_decide', impact: 'high', origin: 'check', extra: { researched: false, ...(it ? { about: it.id } : {}), ...optionsOf(b) } }, by);
}

// The writer loop's state for the shared loop engine (cli/core/loop.js); a record from before 0.9.0
// (writer_loop { rounds, last: signature }) starts a fresh engine state.
function writerLoopState(data) {
  const w = data.writer_loop;
  if (!w || typeof w.last === 'string' || !('level' in w)) data.writer_loop = { ...require('./loop').fresh(), total: (w && w.total) || 0 };
  return data.writer_loop;
}

// One step of the writer ⇄ God Eye loop, by the loop engine: another writer round (on the stronger
// model once the loop escalated), the diagnosis, or the end of the loop: at H1 with the objections
// shown, or a sheet question when the diagnosis says only the user can settle it. Never a park.
function writerLoop(data, writer, S) {
  const Loop = require('./loop');
  const d = Loop.shouldContinue(writerLoopState(data), writer.map((b) => ({ key: blockerKey(b) })), S.loops);
  data.writer_loop = { ...d.state, total: (data.writer_loop.total || 0) + (['continue', 'escalate'].includes(d.action) ? 1 : 0), model: d.model || null, approach: d.approach || (d.state.diagnosis && d.state.diagnosis.approach) || null };
  data.counters.writer_rounds = d.state.rounds;
  if (d.action === 'diagnose') {
    log(data, 'diagnose', `the writer loop made no progress (${d.rule}): God Eye diagnoses it before the loop ends`);
    return 'diagnose';
  }
  if (d.action === 'stop' || d.action === 'done') return loopEnd(data, d, writer);
  data.sent_back = { blockers: writer.length, stage: 'assemble', writer_round: d.state.rounds, ...(d.model ? { model: d.model } : {}) };
  if (d.action === 'escalate') log(data, 'escalate', `no progress in ${S.loops.stall_rounds} round(s): the contract writer runs on ${d.model}`);
  return 'assemble';
}

// The writer loop is over without converging: the diagnosis's question goes on the sheet when it
// says only the user can settle it; otherwise the contract goes to H1 with the open objections
// (and the diagnosis) shown: H1 is the gate, never a park in front of it.
function loopEnd(data, d, writer) {
  const diag = d.state.diagnosis;
  const q = require('./loop').question(d.state, { what: 'the readiness loop', blockers: writer });
  data.loop_end = { at: nowIso(), rule: d.rule, rounds: d.state.rounds, findings: writer.map((b) => ({ check: b.check, ref: b.ref, issue: clip(b.issue || b.why, 300), fix: clip(b.fix, 300) })), ...(diag ? { diagnosis: { cause: diag.cause, question: diag.question, options: diag.options, recommendation: diag.recommendation } } : {}), text: q.text };
  ledgerNoteLater(data, 'loop_end', { rule: d.rule, writer_rounds: d.state.rounds, findings: writer.map((b) => `${b.check}|${b.ref}`), diagnosed: Boolean(diag), question: Boolean(diag && diag.question) });
  if (diag && diag.needs_user && diag.question && (data.counters.readiness_cycles || 0) < 99) {
    const it = userQuestion(data, { by: 'god-eye', check: 'decisions_closed', ref: 'contract', question: diag.question, issue: diag.cause, options: diag.options, recommendation: diag.recommendation, fix: diag.cause });
    if (it) {
      data.counters.readiness_cycles = (data.counters.readiness_cycles || 0) + 1;
      data.sent_back = { blockers: writer.length, stage: 'sheet' };
      log(data, 'loop_end', `the writer loop stopped (${d.rule}); the diagnosis's question goes on the sheet`);
      return 'route';
    }
  }
  log(data, 'loop_end', `the writer loop stopped (${d.rule}) with ${writer.length} objection(s) open: H1 shows them`);
  return 'ready';
}

// A ledger line written when the record is saved (finish), so it carries the saved rev.
function ledgerNoteLater(data, outcome, detail) {
  data.pending_notes = [...(data.pending_notes || []), { outcome, detail }];
}

// A blocker goes back to whoever can fix it (docs/DESIGN-CLARIFY-v3.md, "Readiness"):
//   - writer blockers only: the contract writer runs again with the exact findings and their
//     suggested fixes, automatically, while each round makes progress; the job parks only when a
//     round makes none (the same blockers twice in a row) or after limits.clarify_writer_rounds;
//   - a user blocker: a question on the decision sheet (or the read-back), never a generic park;
//     writer blockers raised with it are kept for the writer that runs after the user's answer;
//   - a missing fact: research again.
// Writer rounds are counted apart from the readiness cycles that reach the user.
function sendBack(root, state, data, raw, S) {
  // a blocker the tie-break verifier refuted is a note now (shown at H1), never a blocker again
  const refuted = (b) => ((data.disputes || {})[blockerKey(b)] || {}).status === 'refuted';
  const blockers = classify(data, raw).filter((b) => !refuted(b));
  data.blockers = blockers.map((b) => ({ ...b }));
  if (!blockers.length) return 'ready';
  const writer = blockers.filter((b) => b.route === 'assemble');
  const other = blockers.filter((b) => b.route !== 'assemble');
  if (!other.length) {
    log(data, 'back', `${writer.length} blocker(s) the writer can fix`);
    const loopState = writerLoopState(data);
    // disputed: God Eye raised it again after a writer round that was given its fix: the
    // finding-verifier settles it once before another round is spent on it
    // (only from a fresh check of a new version: a blocker carried past a refused text was not
    // checked again, so it is not disputed)
    const fresh = !writer.some((b) => b.refusal);
    const disputed = S.tiebreak && fresh ? writer.filter((b) => b.by === 'god-eye' && (loopState.last || []).includes(blockerKey(b)) && !(data.disputes || {})[blockerKey(b)]).slice(0, 3) : [];
    if (disputed.length) {
      data.dispute = { at: nowIso(), blockers: disputed.map((b) => ({ key: blockerKey(b), check: b.check, ref: b.ref, issue: clip(b.issue || b.why, 400), fix: clip(b.fix, 300) })) };
      log(data, 'dispute', `${disputed.length} blocker(s) survived a round that had their fix: the finding-verifier checks them`);
      return 'dispute';
    }
    return writerLoop(data, writer, S);
  }
  const stage = earliest(other.map((b) => ({ stage: b.route })));
  data.counters.readiness_cycles = (data.counters.readiness_cycles || 0) + 1;
  data.sent_back = { blockers: blockers.length, stage };
  log(data, 'back', `${blockers.length} blocker(s): back to ${stage}`);
  if (stage === 'readback') {
    data.readback_objections = other.filter((b) => b.route === 'readback');
    return 'readback';
  }
  if (stage === 'research') {
    for (const b of other.filter((x) => x.route === 'research')) {
      const it = item(data, b.ref);
      if (it && !it.needs_research) reopen(it, b.by === 'cli' ? 'readiness check' : 'God Eye', b.why || b.issue);
      else if (!it) newItem(data, { kind: 'fact', text: b.issue || b.why, tag: 'docs', impact: 'high', needs_research: true, origin: 'check', pins: Object.keys(pinsBySystem(data)) }, 'God Eye');
    }
    data.counters.research_passes = 0;
    return 'research';
  }
  // the sheet: each decision only the user can make becomes a question with its options
  for (const b of other.filter((x) => x.route === 'sheet')) userQuestion(data, b);
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
    ...(o.fixable_by === 'writer' || o.fixable_by === 'user' ? { fixable_by: o.fixable_by } : {}),
    ...(o.question ? { question: clip(o.question, 300) } : {}),
    ...(Array.isArray(o.options) && o.options.length ? { options: o.options.slice(0, 5).map((x) => (typeof x === 'string' ? { text: clip(x, 200) } : { text: clip(x && x.text, 200), consequences: clip(x && x.consequences, 200) })) } : {}),
    ...(o.recommendation ? { recommendation: clip(o.recommendation, 200) } : {}),
    by: 'god-eye',
  }));
  const checklist = {};
  for (const k of CHECKLIST) checklist[k] = Boolean(g.checklist && g.checklist[k] === true);
  // a "false" on the checklist with no objection is an objection too (it is never silently a pass)
  for (const k of CHECKLIST) if (!checklist[k] && !objections.some((o) => o.check === k && o.severity === 'blocker')) objections.push({ check: k, severity: 'blocker', stage: 'assemble', ref: 'contract', issue: `God Eye answered ${k} false without saying why`, fix: '', by: 'god-eye' });
  // who can fix each blocker (God Eye's word, else the CLI's fallback): shown at H1 and in status
  for (const o of objections) if (o.severity === 'blocker') o.fixable_by = fixableBy(o, data);
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
  const A = (key, label, mode, input, timeout, schema, attempts = 2, model = null) => ({ role: roles[key].role, label, mode, input, timeout_sec: timeout, schema, attempts, ...(model ? { model } : {}) });
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
    // once the writer loop escalated, the writer runs on the stronger model (the runner falls back
    // to the session default if the CLI refuses it)
    groups = [[A('writer', 'contract', 'write', writerInput(root, state, data), S.agent_sec['contract-writer'], 'contract-write', 2, (data.writer_loop && data.writer_loop.model) || null)]];
  } else if (stage === 'check') {
    groups = [[A('check', 'readiness', 'readiness', readinessInput(root, state, data), S.agent_sec['god-eye'], 'readiness')]];
  } else if (stage === 'dispute') {
    // the tie-break: one finding-verifier per blocker God Eye raised again after the writer had its fix
    const D = data.dispute || { blockers: [] };
    groups = [D.blockers.map((b, i) => A('verifier', `dispute ${i + 1}`, 'dispute', disputeInput(root, state, data, b), S.agent_sec['finding-verifier'], 'verifier', 1))];
  } else if (stage === 'diagnose') {
    groups = [[A('check', 'diagnosis', 'diagnosis', diagnosisInput(root, state, data, S), S.agent_sec['god-eye'], 'diagnosis')]];
  } else fail(`Clarify is at an unknown stage (${stage}).`, 'internal');
  // what each group is called while it runs (the console's live step list)
  const PH = { readback: ['read your words back'], redirect: ['read your redirect back'], interpret: ['read your sheet answer'], assemble: ['write the contract'], check: ['readiness check'], dispute: ['check disputed objections'], diagnose: ['diagnose the readiness loop'] };
  const phases = stage === 'research' ? groups.map((g) => (g.some((a) => a.role === roles.brief.role) ? 'research brief' : `research (${g.map((a) => a.mode).join(', ')})`)) : PH[stage];
  return { stage, rev: data.rev || 0, groups, phases, contract_hash: stageContractHash(root, state, stage) };
}

function scopeNow(data, rb) {
  const live = data.items.filter((it) => it.kind === 'scope' && it.status !== 'dropped');
  if (!live.length) return rb.scope;
  return { in: live.filter((it) => it.scope !== 'out').map((it) => it.value || it.text), out: live.filter((it) => it.scope === 'out').map((it) => it.value || it.text) };
}

// The tie-break: a readiness objection God Eye raised again after the writer was given its fix.
function disputeInput(root, state, data, b) {
  const live = data.items.filter((it) => it.status !== 'dropped');
  return {
    mode: 'dispute',
    contract: jobPaths(root, state.id).contract,
    finding: { id: b.key, check: b.check, ref: b.ref, issue: b.issue, fix: b.fix },
    note: 'A readiness objection on the contract (not on code). God Eye raised it again after the contract writer was given its fix. Read the contract and the items: confirmed when the objection holds as stated; refuted when the contract already settles it (quote the line); unverifiable when only the user could say.',
    stated: live.filter((it) => it.strength === 'user' && it.source && it.source.quote).map((it) => ({ id: it.id, text: it.value || it.text, quote: it.source.quote })),
    decisions: live.filter((it) => it.kind === 'decision').map((it) => ({ id: it.id, text: it.text, value: it.value, by: byWhom(it) })),
  };
}

// The diagnosis: why the writer ⇄ God Eye loop made no progress, and what would end it.
function diagnosisInput(root, state, data, S) {
  const live = data.items.filter((it) => it.status !== 'dropped');
  const w = data.writer_loop || {};
  return {
    focus: 'diagnosis',
    loop: 'clarify readiness: the contract writer fixes God Eye\'s readiness objections, round by round',
    contract: jobPaths(root, state.id).contract,
    rounds: (w.history || []).map((h) => ({ round: h.round, open: h.open })),
    ceiling: S.loops.ceiling,
    open: (data.blockers || []).map((b) => ({ key: blockerKey(b), check: b.check, ref: b.ref, issue: b.issue || b.why, fix: b.fix || '', ...((data.disputes || {})[blockerKey(b)] ? { verifier: data.disputes[blockerKey(b)] } : {}) })),
    stated: live.filter((it) => it.strength === 'user' && it.source && it.source.quote).map((it) => ({ id: it.id, text: it.value || it.text, quote: it.source.quote })),
    decisions: live.filter((it) => it.kind === 'decision' || it.kind === 'question').map((it) => ({ id: it.id, text: it.text, value: it.value, status: it.status, by: byWhom(it) })),
  };
}

function writerInput(root, state, data) {
  const rb = data.readback || { intent: {}, scope: { in: [], out: [] } };
  const live = data.items.filter((it) => it.status !== 'dropped' && !['intent'].includes(it.kind));
  return {
    contract: jobPaths(root, state.id).contract,
    intent: rb.intent,
    // the scope as its items say now (a redirect or a sheet answer may have changed a line)
    scope: scopeNow(data, rb),
    items: live.map((it) => ({ id: it.id, kind: it.kind, text: it.text, value: it.value, status: it.status, strength: it.strength, by: byWhom(it), source: it.kind === 'fact' || it.kind === 'pin' ? factSource(data, it) : null, ...(it.superseded ? { superseded_by: it.superseded.by } : {}) })),
    evidence: data.evidence.filter(usable).map((e) => ({ id: e.id, item: e.item, claim: e.claim, source: e.source })),
    instructions: live.filter((it) => it.kind === 'instruction').map((it) => ({ id: it.id, text: it.text, quote: it.value })),
    // the exact findings of the last readiness check the writer can fix, each with its suggested
    // fix (a user's decision among them is on the record as an item by now)
    blockers: (data.blockers || []).filter((b) => !b.route || b.route === 'assemble').map((b) => {
      const v = (data.disputes || {})[blockerKey(b)];
      return { check: b.check, ref: b.ref, issue: b.issue || b.why, fix: b.fix || '', ...(b.fixable_by ? { fixable_by: b.fixable_by } : {}), ...(v ? { verified: `the finding-verifier ${v.status === 'confirmed' ? 'confirmed it' : 'could not settle it'}: ${v.reason}` } : {}) };
    }),
    ...(data.writer_loop && data.writer_loop.rounds && (data.blockers || []).length ? { round: { n: data.writer_loop.rounds, of: settings(root, state).writer_rounds, ...(data.writer_loop.approach ? { approach: data.writer_loop.approach } : {}), note: `An automatic fix round: the readiness check found the blockers below in your last version. Fix every one${data.writer_loop.approach ? ', the way the diagnosis (approach) says' : ''}. Rounds continue while the open blockers shrink; when they stop shrinking the loop ends and the user sees what is still open at H1.` } } : {}),
    ...(data.contract.edited_by_hand ? { hand_edited: 'The user edited the contract file by hand since the last version the factory wrote. Start from the file as it is now and keep every change they made; change only what the items and blockers below require.' } : {}),
    design_may_choose: live.filter((it) => it.status === 'deferred').map((it) => it.text),
    gaps: data.failures.map((f) => `${f.what}: ${f.reason}`),
    // the user's own words by id, to cite (because: W-n) when their later words change the contract
    words: data.words.slice(-20).map((w) => ({ id: w.id, text: clip(w.text, 400) })),
  };
}

// ---------------------------------------------------------------- recording a stage
function ledgerNote(root, state, data, outcome, detail = {}) {
  require('./ledger').append(root, state.id, { kind: 'clarify', stage: data.stage, outcome, rev: data.rev || 0, detail });
}

// `factory record` for workflow clarify: apply the stage's replies, then move on by the rules.
function record(root, state, env) {
  const data = get(root, state);
  // a record that fails its seal is never written over (that would reseal the hand edit)
  if (data.tampered) fail(`${state.id}'s clarify.json fails its seal (edited by hand?). Nothing recorded; the user runs factory reseal in their own terminal to keep the file as it is.`, 'tampered');
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
      // shown, not waited on: research starts now; what the user says meanwhile is a correction
      if (!S.readback_wait && !readbackNeedsUser(data)) {
        confirmReadback(data, null, S, true);
        judge(root, data);
        data.counters.research_passes = 0;
        next = 'route';
        result.readback = 'shown';
      }
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
      // conservation: what the interviewer could not map (its `unclear`, word for word) and any
      // part of the reply no mapping quotes are kept verbatim as the user's instructions
      const quotes = [...(out.answers || []).map((a) => a.quote), ...(out.facts || []).map((f) => f.quote)].filter((q) => q && norm(w.text).includes(norm(q)));
      const unclear = (Array.isArray(out.unclear) ? out.unclear : []).map((u) => String(typeof u === 'string' ? u : (u && (u.quote || u.text)) || '')).filter((u) => norm(u).length >= 4 && norm(w.text).includes(norm(u)));
      const kept = [...new Set([...unclear, ...unquoted(w.text, [...quotes, ...unclear])])];
      for (const k of kept.slice(0, 8)) {
        if (data.items.some((x) => x.kind === 'instruction' && x.status !== 'dropped' && norm(x.value) === norm(k))) continue;
        newItem(data, { kind: 'instruction', text: k, value: k, status: 'open', strength: 'user', source: { kind: 'word', ref: w.id, quote: clip(k, 300) }, origin: 'sheet' }, 'user (unmapped words, kept verbatim)');
      }
      if (kept.length) result.instructions = kept.length;
      // "as you recommend" for a decision that has no recommendation is an ok without an answer
      okWithoutRecommendation(data, s, r, w, answers.filter((a) => a.choice === 'recommended').map((a) => a.no));
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
        // the refusal is one more blocker the writer can fix; the blockers its text was meant to
        // fix still stand (the contract on disk did not change)
        const b = [{ check: 'acs_testable', stage: 'assemble', ref: 'contract', why: `the CLI refused the writer's contract: ${w.refused}`, severity: 'blocker', by: 'cli', refusal: true }, ...(data.blockers || []).filter((x) => !x.refusal && (!x.route || x.route === 'assemble'))];
        data.checks.push({ n: data.checks.length + 1, at: nowIso(), contract_hash: contractHash(root, state), deterministic: b, checklist: null, objections: b, ok: false, refusal: true });
        next = sendBack(root, state, data, b, S);
        result.refused = w.refused;
      } else next = 'check';
    }
  } else if (stage === 'dispute') {
    const D = data.dispute || { blockers: [] };
    data.disputes = data.disputes || {};
    D.blockers.forEach((b, i) => {
      const out = outputs[`dispute ${i + 1}`];
      const st = out && ['confirmed', 'refuted', 'unverifiable'].includes(out.status) ? out.status : 'unverifiable';
      data.disputes[b.key] = { status: st, reason: clip((out && out.reason) || (out ? '' : `the finding-verifier ${failedRun(`dispute ${i + 1}`)}`), 400), evidence: clip(out && out.evidence, 400), at: nowIso() };
    });
    const last = data.checks[data.checks.length - 1];
    if (last) {
      for (const o of last.objections || []) {
        const v = o.severity === 'blocker' ? data.disputes[blockerKey(o)] : null;
        if (v && v.status === 'refuted') {
          o.severity = 'note';
          o.refuted = v.reason;
        }
      }
      last.ok = !(last.objections || []).some((o) => o.severity === 'blocker');
    }
    data.dispute = null;
    result.disputes = D.blockers.map((b) => ({ key: b.key, status: data.disputes[b.key].status }));
    next = sendBack(root, state, data, data.blockers || [], S);
  } else if (stage === 'diagnose') {
    const out = outputs.diagnosis;
    const Loop = require('./loop');
    const total = (data.writer_loop && data.writer_loop.total) || 0;
    data.writer_loop = { ...Loop.recordDiagnosis(writerLoopState(data), out ? { ...out, by: 'god-eye' } : { cause: `the diagnosis agent ${failedRun('diagnosis')}`, needs_user: false }), total };
    result.diagnosis = { needs_user: data.writer_loop.diagnosis.needs_user, question: data.writer_loop.diagnosis.question };
    next = writerLoop(data, (data.blockers || []).filter((b) => !b.route || b.route === 'assemble'), S);
  } else if (stage === 'check') {
    const out = outputs.readiness;
    if (!out) next = agentFailed('readiness', 'God Eye readiness check');
    else {
      const rec = applyCheck(root, state, data, out, S);
      const blockers = rec.objections.filter((o) => o.severity === 'blocker');
      if (blockers.length) {
        next = sendBack(root, state, data, blockers, S);
      } else next = 'ready';
    }
  }
  return finish(root, state, data, next, S, result);
}

function newWriterCycle(data) {
  data.counters.writer_attempts = 0;
  data.counters.writer_rounds = 0;
  data.writer_loop = { ...require('./loop').fresh(), total: (data.writer_loop && data.writer_loop.total) || 0 };
  data.loop_end = null;
}

// The exact replies a clarify park takes (the user's alone: resume and proceed are human-only).
function parkReplies(p, S) {
  if (p.kind === 'agent') return 'Reply "resume" to run it again, or "cancel job".';
  if (p.kind === 'writer' && p.rule) {
    return [
      'Reply:',
      `- "resume": one more automatic contract-writer round with these findings${p.rule === 'ceiling' ? ` (the ceiling is limits.clarify_writer_rounds = ${S.writer_rounds})` : ''};`,
      '- or edit contract.md yourself to settle them, then "resume": your text goes through the readiness check again and the writer keeps your edit;',
      '- "proceed": go to H1 with these findings shown as open God Eye objections (you decide there);',
      '- "cancel job" to stop.',
    ].join('\n');
  }
  return 'Reply "resume" for one more try, or "proceed" to go on with the gaps shown.';
}

// Move to the next stage (routing by current state), save, and say what happens now.
function finish(root, state, data, next, S, result = {}) {
  if (next === 'route') next = advance(data, S);
  // a new readiness cycle (the writer runs after a user's turn, research or a redirect): the
  // automatic writer rounds start again
  if (next === 'assemble' && !['assemble', 'check', 'dispute', 'diagnose'].includes(data.stage)) newWriterCycle(data);
  if (next === 'check') next = enterCheck(root, state, data, S);
  // the readiness cycle cap (work sent back to the user's stages more often than the cap allows):
  // the contract goes to H1 with the open objections shown; H1 is the gate, never a park before it
  if (data.sent_back && next !== 'park' && next !== 'ready' && data.counters.readiness_cycles > S.readiness_cycles) {
    const last = data.blockers || [];
    data.loop_end = { at: nowIso(), rule: 'readiness_cycles', rounds: data.counters.readiness_cycles, findings: last.map((b) => ({ check: b.check, ref: b.ref, issue: clip(b.issue || b.why, 300), fix: clip(b.fix, 300) })), text: `The readiness check sent the work back ${data.counters.readiness_cycles} times (the ceiling is ${S.readiness_cycles}); H1 shows what is still open.` };
    ledgerNoteLater(data, 'loop_end', { rule: 'readiness_cycles', readiness_cycles: data.counters.readiness_cycles, findings: last.map((b) => `${b.check}|${b.ref}`) });
    log(data, 'loop_end', `readiness cycles over the ceiling (${S.readiness_cycles}): H1 shows the open objections`);
    next = 'ready';
  }
  data.sent_back = null;
  if (next === 'ready') {
    data.contract.checked_hash = contractHash(root, state);
    data.blockers = null;
    for (const R of data.redirects.filter((r) => r.status === 'confirmed')) R.status = 'done';
  }
  if (next === 'park') {
    data.stage = data.parked.stage;
    const pn = data.pending_notes || [];
    data.pending_notes = null;
    save(root, state.id, data);
    for (const n of pn) ledgerNote(root, state, data, n.outcome, n.detail);
    ledgerNote(root, state, data, 'park', { reason: data.parked.reason, kind: data.parked.kind, ...(data.parked.rule ? { rule: data.parked.rule, writer_rounds: (data.writer_loop || {}).rounds || 0, findings: (data.parked.findings || []).map((b) => `${b.check}|${b.ref}`) } : {}) });
    const replies = parkReplies(data.parked, S);
    return { status: 'park', park_from: 'clarify', park_reason: `${data.parked.reason}\n${replies}`, park_next: replies, stage: data.stage, ...result, message: 'Parked.' };
  }
  data.stage = next;
  data.parked = null;
  const notes = data.pending_notes || [];
  data.pending_notes = null;
  save(root, state.id, data);
  for (const n of notes) ledgerNote(root, state, data, n.outcome, n.detail);
  ledgerNote(root, state, data, next, { counters: data.counters, caps: { research_passes: S.research_passes, writer_rounds: S.writer_rounds }, ...(data.writer_loop && data.writer_loop.level ? { loop: { level: data.writer_loop.level, rounds: data.writer_loop.rounds, model: data.writer_loop.model || null } } : {}), failures: data.failures.length });
  if (next === 'ready') {
    const b = require('./invalidation').current(root, state);
    const last = data.checks[data.checks.length - 1] || {};
    require('./ledger').append(root, state.id, { kind: 'step', step: 'clarify', ok: true, bound: { contract: b.contract }, detail: { version: 3, items: data.items.length, decisions: data.items.filter((x) => x.kind === 'decision').length, sheets: data.sheets.length, research_passes: data.research.passes.length, failures: data.failures.length, checks: data.checks.length, notes: (last.objections || []).filter((o) => o.severity === 'note').length, ...(data.proceeded ? { proceeded: data.proceeded } : {}), ...(data.loop_end ? { loop_end: { rule: data.loop_end.rule, rounds: data.loop_end.rounds, diagnosed: Boolean(data.loop_end.diagnosis) } } : {}), writer_rounds: (data.writer_loop && data.writer_loop.total) || 0, ...((last.objections || []).some((o) => o.severity === 'blocker') ? { approved: false, god_eye_objects: (last.objections || []).filter((o) => o.severity === 'blocker').length } : {}) } });
    const openN = (last.objections || []).filter((o) => o.severity === 'blocker').length;
    return { status: 'ok', next_gate: state.epic ? 'EH1' : 'H1', stage: next, ...result, ...(data.loop_end ? { loop_end: { rule: data.loop_end.rule, open: openN } } : {}), message: openN ? `The readiness loop ended (${data.loop_end ? data.loop_end.rule : 'proceeded'}) with ${openN} God Eye objection(s) open: run factory next; gate H1 shows the contract with them.` : 'The contract passed its readiness check. Run factory next: gate H1 shows it.' };
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
  if (state.status === 'parked') return storeParked(root, state, t, via === 'chat' ? 'reply (chat, while parked)' : 'reply (while parked)');
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
      next = R.restart === 'readback' ? 'readback' : 'route';
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
      if (parsed.accept) okWithoutRecommendation(data, s, r, w, s.decisions.filter((d) => !d.answered && !d.recommendation).map((d) => d.no));
      next = r.open.length ? 'sheet_wait' : 'route';
      msg = `Recorded: ${r.decided.length} decision(s)${r.facts.length ? `, ${r.facts.length} fact(s) corrected` : ''}.${r.open.length ? ` Still open: ${r.open.join(', ')} (no recommendation, or not answered).` : ''}`;
    }
  }
  const res = finish(root, state, data, next, S);
  require('./events').append(root, { event: 'clarify_reply', job: state.id, via, stage: res.stage, words: w.id });
  return { job: state.id, word: w.id, ...res, message: `${msg} ${res.message}` };
}

// Words sent while the job is parked are never refused: they are stored with the record (the
// user's words, verbatim) and become a redirect clarify reads back as soon as the job resumes.
// Only the user resumes it (human-only): their own reply in chat does (it is resume + content);
// words the main session relays are stored and wait for that.
function storeParked(root, state, text, via) {
  const data = load(root, state.id) || get(root, state);
  if (data.tampered) fail(`${state.id}'s clarify.json fails its seal.`, 'tampered');
  const w = addWord(data, text, via);
  if (w.duplicate) return { job: state.id, stage: data.stage, duplicate: true, stored: true, message: 'Already recorded (the same words came twice).' };
  data.parked_words = [...new Set([...(data.parked_words || []), w.id])];
  log(data, 'parked_words', text);
  save(root, state.id, data);
  ledgerNote(root, state, data, 'parked_words', { word: w.id });
  return { job: state.id, stage: data.stage, word: w.id, stored: true, status: 'parked', message: `${state.id} is parked (${clip((state.park && state.park.reason) || 'clarify', 160)}). Your words are recorded (${w.id}): clarify reads them back as a redirect as soon as the job resumes. Your own reply in chat resumes it with them; in a terminal, factory resume does.` };
}

// Words stored while parked: one redirect, read back once the job runs again.
function parkedWordsToRedirect(data) {
  const ids = data.parked_words || [];
  if (!ids.length) return null;
  const ws = ids.map((id) => data.words.find((w) => w.id === id)).filter(Boolean);
  data.parked_words = [];
  if (!ws.length) return null;
  const R = { id: nextId(data.redirects, 'R'), at: nowIso(), gate: null, word: ws[0].id, words: ws.map((w) => w.id), text: ws.map((w) => w.text).join('\n'), status: 'interpreting', clauses: [], from_stage: data.stage };
  data.redirects.push(R);
  data.stage = 'redirect';
  log(data, 'redirect', `words sent while parked (${ws.map((w) => w.id).join(', ')})`);
  return R;
}

function redirect(root, { jobId, text, via = 'cli', gate = null }) {
  const job = require('./job');
  const state = job.resolve(root, jobId);
  if (state.approvals && (state.approvals.H1 || state.approvals.EH1)) fail(`${state.id}'s contract is approved: start an amendment instead (factory amend start --reason "…").`, 'approved');
  const t = String(text || '').trim();
  if (!t) fail('Say the redirect: factory clarify redirect "<the user\'s words>".', 'bad_input');
  if (state.status === 'parked') return storeParked(root, state, t, via === 'chat' ? 'redirect (chat, while parked)' : 'redirect (while parked)');
  if (!['active'].includes(state.status)) fail(`${state.id} is ${state.status}; nothing to redirect.`, 'not_active');
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
  if (fresh.length) {
    // two denials before clarify saw either (two chat messages at H1): one redirect with both,
    // so neither is left half-read
    const texts = [...new Set(fresh.map((d) => String(d.reason || '').trim()).filter(Boolean))];
    const open = currentRedirect(data);
    if (open && open.status === 'interpreting' && open.gate) {
      open.text = [open.text, ...texts].join('\n');
      addWord(data, texts.join('\n'), 'denial');
    } else startRedirect(data, texts.join('\n') || '(no reason given)', 'denial', fresh[fresh.length - 1].gate);
    data.denials_seen = fresh[fresh.length - 1].at;
    changed = true;
  }
  if (handEdit(root, state, data)) changed = true;
  return changed;
}

// The user edited contract.md by hand (a hash the factory neither wrote nor checked). Before the
// readiness check passes, the next writer is told to keep the edit. Once it has passed (or while
// it runs), the edited text is checked again from the start: the deterministic checks first, and
// an item the edit took out of the contract (an AC the user deleted) becomes a decision on the
// sheet: put it back, or leave it out (the item is then dropped by the user). An edit never
// silently undoes what the user said, and the writer never silently undoes the edit.
function handEdit(root, state, data) {
  const cur = contractHash(root, state);
  const C = data.contract;
  if (!C.written_hash || !cur || [C.written_hash, C.checked_hash, C.seen_hash].includes(cur)) return false;
  C.seen_hash = cur;
  C.edited_by_hand = true;
  C.hand_edits = [...(C.hand_edits || []), { at: nowIso(), hash: cur, stage: data.stage }].slice(-20);
  log(data, 'edited', `contract.md changed by hand at ${data.stage}`);
  if (!['ready', 'check'].includes(data.stage)) return true;
  const S = settings(root, state);
  newWriterCycle(data);
  data.counters.readiness_cycles = 0;
  const lost = lostCoverage(root, state, data);
  for (const it of lost) {
    const d = newItem(data, { kind: 'decision', text: `You took ${it.covered.where} out of the contract by hand; it was where the contract honoured ${it.id}: ${clip(it.value || it.text, 160)}`, status: 'to_decide', impact: 'high', origin: 'edit', extra: { researched: true, lost: { item: it.id, where: it.covered.where } } }, 'cli');
    d.options = [
      { key: 'a', text: `Put it back: the contract honours ${it.id} again (your other edits stay)`, consequences: 'the writer restores it and keeps the rest of your edit' },
      { key: 'b', text: `Leave it out: drop ${it.id}`, consequences: `${it.id} is listed at H1 as dropped by you` },
    ];
    // the edit is the user's latest word; their own earlier words are not overruled silently
    d.recommendation = it.strength === 'user' ? null : 'b';
    d.why = it.strength === 'user' ? `${it.id} is something you said ("${clip((it.source && it.source.quote) || it.value, 100)}"): only you can drop it` : 'you removed it yourself';
    itemEvent(it, 'uncovered', 'user (hand edit)', `${it.covered.where} was removed from contract.md`);
    it.covered = null;
  }
  data.stage = lost.length ? advance(data, S) : enterCheck(root, state, data, S);
  if (data.stage === 'route') data.stage = advance(data, S);
  return true;
}

// Live items the contract no longer honours where the writer said it did (an AC or a section
// that is gone from the current text).
function lostCoverage(root, state, data) {
  const contract = require('./contract');
  const text = contract.read(root, state.id);
  const parsed = contract.parse(text);
  const acIds = new Set(parsed.acs.map((a) => a.id));
  const sections = Object.keys(contract.sections(text));
  return data.items.filter((it) => liveForCoverage(it) && it.covered && it.covered.where && !(/^(E-)?AC-\d+$/i.test(it.covered.where) ? acIds.has(it.covered.where.toUpperCase()) : sections.includes(it.covered.where.toLowerCase())));
}

// The readiness check, deterministic half first: a blocker goes back without spending God Eye.
// Returns the next stage ('check' runs God Eye).
function enterCheck(root, state, data, S) {
  data.stage = 'check';
  const det = deterministic(root, state, data);
  if (!det.length) return 'check';
  data.checks.push({ n: data.checks.length + 1, at: nowIso(), contract_hash: contractHash(root, state), deterministic: det, checklist: null, objections: det, ok: false });
  let next = sendBack(root, state, data, det, S);
  if (next === 'route') next = advance(data, S);
  return next;
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
  if (data.tampered) return { stage: null, run: null, waiting_for_user: false, error: `clarify.json fails its seal (edited by hand?): nothing in clarify runs or records until the user looks at it and, to keep the file as it now is, runs factory reseal --job ${state.id} in their own terminal (human-only)`, status_command: `factory clarify status --job ${state.id}` };
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
    const w = data.words.find((x) => x.id === (s.kind === 'sheet' ? s.word : s.ref));
    checked.push({ item: it.id, quote: clip(s.quote, 200), text: it.value || it.text, ok: !sup && Boolean(it.covered || it.status === 'deferred'), where: sup ? `you went by the source instead: ${clip(sup.value, 160)}` : it.covered ? it.covered.where : it.status === 'deferred' ? 'deferred to design' : 'not in the contract', ...(w && w.relayed ? { relayed: true } : {}) });
  }
  const last = data.checks[data.checks.length - 1] || null;
  const objections = last ? (last.objections || []).map((o) => ({ check: o.check, severity: o.severity, issue: o.issue || o.why, fix: o.fix || '', ref: o.ref, open: o.severity === 'blocker', ...(o.refuted ? { refuted: o.refuted } : {}), ...(o.fixable_by ? { fixable_by: o.fixable_by } : {}) })) : [];
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
    // the versions research went by (or that none was confirmed: then only the repo's range)
    versions: live.filter((it) => it.kind === 'pin').map((it) => (it.value ? `${it.system} ${it.value} (${byWhom(it)})` : `${it.system}: no exact version confirmed${(it.allows || []).length ? `; the repository allows ${it.allows.map((a) => a.range).join(', ')}` : ''}`)),
    gaps: openFailures(data).map((f) => ({ what: f.what, reason: f.reason })),
    skipped: skippedSources(data),
    objections,
    proceeded: data.proceeded || null,
    // the readiness loop ended without converging: why, and the diagnosis's question if it ran
    loop_end: data.loop_end ? { rule: data.loop_end.rule, rounds: data.loop_end.rounds, text: data.loop_end.text, diagnosis: data.loop_end.diagnosis || null } : null,
    // the read-back, when it was shown and not waited on and no sheet showed it yet
    readback: data.readback && data.readback.auto && !data.readback.shown ? readbackBrief(data, state) : null,
    // the user's later words that changed their earlier ones (the later one won)
    changes: data.items.flatMap((it) => (it.changes || []).map((c) => ({ item: it.id, from: c.from, to: c.to, quote: c.quote }))),
    // contract lines the writer reworded, each with what it rests on
    reworded: (data.contract.changed || []).map((c) => `${c.ref}: "${c.from}" → "${c.to}" because ${c.because}${c.quote ? ` (the user's words: "${c.quote}")` : ''}${c.why ? ` — ${c.why}` : ''}`),
    redirects,
    edited_by_hand: Boolean(data.contract.edited_by_hand),
    hand_edits: (data.contract.hand_edits || []).length,
    removed: (data.contract.removed || []).map((r) => `${r.ref}${r.ref === 'Constraints' || r.ref === 'Non-goals' ? ` "${r.text}"` : ` (${r.text})`}: because ${r.because}${r.why ? ` — ${r.why}` : ''}`),
    // the user's words as the factory received them: through the reply hook or a gate verb, or
    // relayed by the main session (which the user should recognise as theirs before approving)
    words: { total: data.words.length, relayed: data.words.filter((w) => w.relayed).map((w) => ({ id: w.id, via: w.via, text: clip(w.text, 200) })) },
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
  const L = [`**Contract · ${state.id} ${state.title}**`, ''];
  if (v.readback && v.readback.length) L.push(...v.readback, '');
  L.push(`**Goal:** ${v.goal}`, '', '**Done means**');
  for (const a of v.done) L.push(`- ${a.id} ${a.text}`);
  if (v.checked.length) {
    L.push('', '**Checked against what you said**');
    for (const c of v.checked) L.push(`- ${c.ok ? '✓' : '✗'} "${c.quote}"${c.relayed ? ' †' : ''} → ${c.where}`);
  }
  if (v.decisions.length) {
    L.push('', '**Decisions and who made them**');
    for (const d of v.decisions) L.push(`- ${d.text} → ${d.value} (${d.by})`);
  }
  if (v.versions.length) L.push('', `**Versions researched against:** ${v.versions.join('; ')}.`);
  if (v.design_may_choose.length) L.push('', `**Design may still choose:** ${v.design_may_choose.join('; ')}.`);
  if (v.gaps.length) L.push('', '**Research gaps**', ...v.gaps.map((g) => `- ${g.what}: ${g.reason}`));
  if (v.skipped.length) L.push('', `**Sources skipped:** ${v.skipped.length} (${[...new Set(v.skipped.map((x) => x.why))].join('; ')}); none of them is relied on.`);
  const open = v.objections.filter((o) => o.open);
  const notes = v.objections.filter((o) => !o.open);
  // God Eye's objections are never approval: with one open, the screen never says the checks pass
  if (open.length) L.push('', `**God Eye objects** (it did not approve this contract${v.proceeded ? '; you chose to proceed' : ''}: \`approve\` takes it on over them, \`deny <what must change>\` sends it back)`, ...open.map((o) => `- ${o.check} (${o.ref}): ${o.issue}${o.fix ? ` — suggests: ${clip(o.fix, 160)}` : ''}`));
  else L.push('', `**God Eye:** all ${CHECKLIST.length} checks pass${notes.length ? `; remarks: ${notes.map((o) => `${o.issue}${o.refuted ? ` (raised as a blocker; the finding-verifier refuted it: ${clip(o.refuted, 160)})` : ''}`).join('; ')}` : ''}.`);
  if (v.loop_end) {
    L.push('', `**The readiness loop ended** (${v.loop_end.rule}${v.loop_end.rounds ? `, ${v.loop_end.rounds} round(s)` : ''}): the objections above are what it could not settle by itself.`);
    const dg = v.loop_end.diagnosis;
    if (dg && (dg.cause || dg.question)) {
      L.push(`- Diagnosis: ${dg.cause || ''}`.trim());
      if (dg.question) L.push(`- Its question: ${dg.question}${(dg.options || []).length ? ` ${dg.options.map((o) => `${o.key}) ${o.text}${o.key === dg.recommendation ? ' (recommended)' : ''}`).join(' · ')}` : ''}`);
    }
    L.push('- `approve` takes the contract with them; `deny <what must change>` sends it back with your words.');
  }
  if (v.changes && v.changes.length) L.push('', '**Changed by your later words**', ...v.changes.map((c) => `- changed: ${c.from} → ${c.to} because you said "${clip(c.quote, 160)}"`));
  if (v.reworded && v.reworded.length) L.push('', '**Reworded in the contract**', ...v.reworded.map((x) => `- ${x}`));
  if (v.dropped) L.push('', '**Dropped**', ...v.dropped.map((x) => `- ${x}`));
  if (v.removed && v.removed.length) L.push('', '**Taken out of the contract**', ...v.removed.map((x) => `- ${x}`));
  for (const R of v.redirects) {
    L.push('', `**Your redirect ${R.id}:** ${R.done} of ${R.of} done`);
    for (const c of R.clauses) L.push(`- ${c.done ? '✓' : '✗'} "${clip(c.quote, 120)}" — ${c.how}`);
  }
  if (v.words.relayed.length) L.push('', `† ${v.words.relayed.length} of the ${v.words.total} things you said reached the factory through the assistant (factory clarify reply / redirect, or the request it filed), not through the reply hook: check they are your words before you approve (factory clarify status lists them).`);
  if (v.edited_by_hand || v.hand_edits) L.push('', `You edited the contract by hand${v.hand_edits > 1 ? ` (${v.hand_edits} times)` : ''}${v.edited_by_hand ? ' after the writer' : ''}; the edited text went through the readiness check again.`);
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
  const relayed = data.words.filter((w) => w.relayed);
  if (relayed.length) {
    L.push('', 'Your words as the assistant relayed them (factory clarify reply / redirect, job new --request; the reply hook did not see them):');
    for (const w of relayed) L.push(`  ${w.id} (${w.via}): ${clip(w.text, 160)}`);
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
// A park from before 0.8.3 (the writer-attempt or readiness-cycle cap) whose open blockers the
// writer can fix from what is settled: since 0.8.3 the factory runs those rounds itself, so on
// the user's `resume` it continues automatically (never without the user's resume).
function legacyWriterPark(data) {
  const p = data && data.parked;
  if (!p || p.rule || !['writer', 'check'].includes(p.kind)) return false;
  const bl = data.blockers || [];
  return bl.length > 0 && classify(data, bl).every((b) => b.route === 'assemble');
}

// For factory next on a job clarify parked: the exact replies, and for an upgraded job parked the
// old way, that resume now continues by itself. Read-only.
function parkAdvice(root, state) {
  const data = load(root, state.id);
  if (!data || data.tampered || !data.parked) return null;
  const S = settings(root, state);
  if (legacyWriterPark(data)) {
    const findings = classify(data, data.blockers);
    return {
      upgraded: true,
      findings: findings.map((b) => ({ check: b.check, ref: b.ref, issue: clip(b.issue || b.why, 300), fix: clip(b.fix, 300), fixable_by: b.fixable_by })),
      next: [
        `This job parked before factory 0.8.3, which now fixes these readiness findings itself: the contract writer can settle all ${findings.length} from what is already decided, so none of them needs your decision.`,
        ...findings.slice(0, 6).map(findingLine),
        `Reply "resume" and clarify continues automatically: the contract writer runs again with these findings and their suggested fixes, then the readiness check, for up to ${S.writer_rounds} round(s) while each round makes progress. Or "proceed" to go to H1 with them shown as open objections, or "cancel job".`,
      ].join('\n'),
    };
  }
  return { upgraded: false, findings: data.parked.findings || [], next: parkReplies(data.parked, S) };
}

function onResume(root, state, words = null) {
  const data = load(root, state.id);
  if (!data || data.tampered) return;
  if (!data.parked) {
    // parked by the router, not by clarify (a budget park mid-clarify): only the stored words
    if (words) {
      const w = addWord(data, words, 'resume (your words)');
      if (!w.duplicate) data.parked_words = [...new Set([...(data.parked_words || []), w.id])];
    }
    if ((data.parked_words || []).length && !WAITS.has(data.stage)) {
      parkedWordsToRedirect(data);
      save(root, state.id, data);
    } else if (words) save(root, state.id, data);
    return;
  }
  const S = settings(root, state);
  const p = data.parked;
  if (p.kind === 'research') data.counters.research_passes = Math.max(0, data.counters.research_passes - 1);
  if (legacyWriterPark(data)) {
    // upgraded mid-park: the automatic writer rounds take over from the old cap
    if (p.kind === 'check') data.counters.readiness_cycles = Math.max(0, (data.counters.readiness_cycles || 0) - 1);
    newWriterCycle(data);
    data.stage = 'assemble';
    log(data, 'resumed', 'upgraded park: the automatic writer rounds continue');
  } else if (p.kind === 'writer' && p.rule) {
    // one more writer round: it runs now; if the check still blocks, the job parks again
    const loop = data.writer_loop || { rounds: 0, last: null, total: 0, history: [] };
    loop.rounds = Math.max(loop.rounds, S.writer_rounds);
    data.writer_loop = loop;
    log(data, 'resumed', p.reason);
  } else {
    if (p.kind === 'writer') data.counters.writer_attempts = Math.max(0, data.counters.writer_attempts - 1);
    if (p.kind === 'check') data.counters.readiness_cycles = Math.max(0, (data.counters.readiness_cycles || 0) - 1);
    log(data, 'resumed', p.reason);
  }
  data.parked = null;
  // what the user said while it was parked (and their resume words) is read back as a redirect
  if (words) {
    const w = addWord(data, words, 'resume (your words)');
    if (!w.duplicate) data.parked_words = [...new Set([...(data.parked_words || []), w.id])];
  }
  parkedWordsToRedirect(data);
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
  if (data && data.tampered) fail(`${state.id}'s clarify.json fails its seal (edited by hand?); nothing was done.`, 'tampered');
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
  // a job whose rulebook (recipe.lock.json) predates the floor passes, as for v1/v2 jobs
  const lock = require('../lib/util').readJson(require('../lib/paths').jobPaths(ctx.root, ctx.state.id).recipeLock, null);
  if (lock && lock.floors && lock.floors.floors && !JSON.stringify(lock.floors.floors).includes('intent_grounded')) return true;
  const data = load(ctx.root, ctx.state.id);
  // no clarify record: an older job's v1/v2 intent record decides; with neither, nothing
  // grounds the contract and the floor fails (012D m-6)
  if (!data) return exists(require('./intent').files(ctx.root, ctx.state.id).json) && require('./intent').floorOk(ctx);
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
  applyWriter, writeSections, sectionLines, deterministic, applyCheck, fixableBy, classify, signature, sendBack,
  stagePlan, stageContractHash, record, reply, redirect, chatReply, sync, ready, nextInfo, waitingForUser,
  h1View, h1Summary: (root, state) => h1View(root, state), view, status, statusText, onResume, parkAdvice, proceed, briefText, deferredText, floorOk, inClarify, consoleBlock, split, ACCEPT,
};
