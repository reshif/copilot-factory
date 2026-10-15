'use strict';
// Clarify v2: the issue ledger (docs/DESIGN-CLARIFY-v2.md).
//
// The ledger is the job's sealed intent-evidence.json at version 2: every unknown (U-n) is
// an issue with a stable subject, an owner (research | user | design), a status
// (open → researching → proposed → settled, or deferred_to_design / dropped) and how it was
// settled. The CLI owns it: the workflow proposes, `factory record` re-applies the rules,
// `factory answer` and `factory clarify note` are the only other writers.
//
// The subject and dedup rules are written twice: here and in workflows/fanout-judge.js
// (workflows cannot import). tests/clarify-v2.test.js checks they agree.

const path = require('path');
const { readJson, nowIso, fail } = require('../lib/util');
const { jobPaths, pluginPath } = require('../lib/paths');

const KINDS = ['intent', 'scope', 'constraint', 'acceptance', 'repo', 'world', 'decision', 'user'];
const OWNERS = ['research', 'user', 'design'];
const STATUSES = ['open', 'researching', 'proposed', 'settled', 'deferred_to_design', 'dropped'];
const SETTLED_BY = ['evidence', 'user', 'assumption_accepted', 'design_deferral'];
const FINAL = new Set(['settled', 'deferred_to_design', 'dropped']);
const QUESTION_KINDS = new Set(['intent', 'scope', 'constraint', 'acceptance']);

// ---------------------------------------------------------------- subjects and identity
const STOP = new Set('a an the of to for in on at by with and or is are be been does do did should shall which what when where who whom how this that these those it its as from into per than then there their our we you your can could will would must may might not no yes any all each either via vs about exact exactly precise specific confirm confirmed check verify whether if use used using uses one two new current currently today get gets set sets'.split(' '));
const SYN = { cli: 'command', cmd: 'command', commands: 'command', syntax: 'command', configures: 'configure', configured: 'configure', configuring: 'configure', configuration: 'configure', config: 'configure', ports: 'port', interfaces: 'interface', vlans: 'vlan', fields: 'field', names: 'name', lines: 'line' };
const ALSO_STOP = new Set(['form', 'forms', 'way', 'kind', 'thing', 'value', 'list']);

function norm(s) {
  return String(s || '').toLowerCase().replace(/\b([a-z0-9]{1,3})-([a-z0-9]{1,3})\b/g, '$1$2');
}
function stem(w) {
  if (SYN[w]) return SYN[w];
  let x = w;
  if (x.length > 4 && x.endsWith('ies')) x = `${x.slice(0, -3)}y`;
  else if (x.length > 5 && /(ches|shes|xes|sses)$/.test(x)) x = x.slice(0, -2);
  else if (x.length > 3 && x.endsWith('s') && !/(ss|os|us|is)$/.test(x)) x = x.slice(0, -1);
  return SYN[x] || x;
}
// Significant tokens of a text, in order of first appearance.
function tokens(text) {
  const out = [];
  for (const w of norm(text).split(/[^a-z0-9]+/)) {
    if (!w || w.length < 2 || STOP.has(w) || /^\d+$/.test(w)) continue;
    const s = stem(w);
    if (STOP.has(s) || ALSO_STOP.has(s) || out.includes(s)) continue;
    out.push(s);
  }
  return out;
}
// The normalised subject key: "NX-OS switchport command" → "nxos.switchport.command".
function subjectKey(s) {
  return tokens(norm(s).replace(/[._/:-]+/g, ' ')).join('.');
}
// An issue's subject: the agent's, normalised, or derived from its text (first four tokens).
function subjectOf(raw) {
  if (raw && raw.subject && subjectKey(raw.subject)) return { subject: subjectKey(raw.subject), explicit: true };
  return { subject: tokens((raw && (raw.text || raw.question)) || '').slice(0, 4).join('.'), explicit: false };
}
// The faces an issue is known by: its subject and text, and each alias's text.
function faces(x) {
  const subj = tokens(norm(x.subject).replace(/[._/:-]+/g, ' '));
  const out = [new Set([...subj, ...tokens(x.text || x.question || '')])];
  for (const a of x.aliases || []) out.push(new Set(tokens(a.text || '')));
  return out.filter((f) => f.size);
}
function faceMatch(ta, tb, strict) {
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  if (shared < 3) return false;
  const jac = shared / (ta.size + tb.size - shared);
  const ovl = shared / Math.min(ta.size, tb.size);
  return strict ? jac >= 0.6 : jac >= 0.5 || ovl >= 0.75;
}
// Same issue? Deterministic: same_as is handled by the caller; here the subject key, then
// significant tokens of any face (the issue or one of its aliases).
function sameIssue(a, b) {
  // equal subject keys: agent-given, or derived with at least two tokens ("repo" alone says nothing)
  if (a.subject && a.subject === b.subject && (a.subject_explicit || b.subject_explicit || a.subject.includes('.'))) return true;
  const strict = Boolean(a.subject_explicit && b.subject_explicit && a.subject !== b.subject);
  const fa = faces(a);
  const fb = faces(b);
  return fa.some((x) => fb.some((y) => faceMatch(x, y, strict)));
}
// The live issue a raised item is about: same_as, then an alias, then the dedup rule.
function findSame(list, raw) {
  const ref = String((raw && (raw.same_as || raw.unknown)) || '').trim().toUpperCase();
  if (/^U-\d+$/.test(ref)) {
    const hit = list.find((u) => u.id === ref || (u.aliases || []).some((a) => a.id === ref));
    if (hit) return hit;
  }
  if (ref === 'NEW' && !raw.subject && !(raw.text || raw.question)) return null;
  const s = subjectOf(raw);
  const probe = { subject: s.subject, subject_explicit: s.explicit, text: raw.text || raw.question || '' };
  return list.find((u) => sameIssue(probe, u)) || null;
}

// ---------------------------------------------------------------- classification
// Implementation detail belongs to ground/decide, not to intent: exact API field names,
// source line ranges, command syntax, parser behaviour.
const IMPL = /\b(exact|precise|specific)\s+(syntax|commands?|fields?|names?|format|lines?|api|endpoints?|regex|signatures?|parameters?|keys?|path)\b|\b(command|cli)\s+(syntax|forms?|format)\b|\bsyntax\b|\bline ranges?\b|\bline numbers?\b|\blines?\s+\d+\s*[-–]\s*\d+|\b(api|json|payload|response|schema|serializer)\s+(fields?|keys?|attributes?)\b|\bfield names?\b|\battribute names?\b|\bparser\b|\bparsing\b|\bparses\b|\bregex\b|\bwhich ([\w-]+ )?(cli )?commands?\b|\bcli commands?\b|\bcommand (form|forms|format)\b/i;
function isImplementationFact(text) {
  return IMPL.test(String(text || ''));
}
// owner from the agent's field, else the fallback rule.
function classify(raw, kind) {
  if (OWNERS.includes(raw && raw.owner)) return raw.owner;
  if (['repo', 'world'].includes(kind) && isImplementationFact(`${raw.text || raw.question || ''} ${raw.draft || ''}`)) return 'design';
  if (['repo', 'world'].includes(kind)) return 'research';
  if (kind === 'decision' && ['repo', 'web'].includes(raw && raw.research)) return 'research';
  return 'user';
}

// ---------------------------------------------------------------- limits
function liveLimits() {
  try {
    return readJson(pluginPath('policy', 'default-policy.json')).limits || {};
  } catch {
    return {};
  }
}
// Pre-v2 policy snapshots (no clarify_no_progress_rounds) keep their old cap (max + 2) or
// the new default ceiling, whichever is higher.
function limits(state) {
  const L = (state.policy && state.policy.limits) || {};
  const live = liveLimits();
  const v2 = L.clarify_no_progress_rounds !== undefined;
  const base = Number(L.max_intent_rounds) || Number(live.max_intent_rounds) || 10;
  const ceiling = v2 ? base : Math.max(base + 2, Number(live.max_intent_rounds) || 10);
  const c = state.counters || {};
  return {
    ceiling: ceiling + (c.clarify_bonus_rounds || 0),
    no_progress: Number(L.clarify_no_progress_rounds ?? live.clarify_no_progress_rounds ?? 2) || 2,
    counted: Math.max(0, (c.clarify_rounds || 0) - (c.clarify_degraded_rounds || 0)),
    legacy_snapshot: !v2,
  };
}

// ---------------------------------------------------------------- issues
const clip = (s, n) => String(s === undefined || s === null ? '' : s).slice(0, n);
const num = (id) => Number(String(id || '').replace(/^[A-Z]-/, '')) || 0;
const isNone = (d) => !d || /^none\b/i.test(String(d).trim()) || /^your call\.?:?\s*$/i.test(String(d).trim());
// "Your call: keep coercion" → "keep coercion" (the default itself, not the label)
const defaultValue = (d) => String(d || '').replace(/^your call\s*:\s*/i, '').trim();

function event(u, round, ev, actor, text) {
  u.history = u.history || [];
  u.history.push({ round: round || null, event: ev, actor, ...(text ? { text: clip(text, 300) } : {}), at: nowIso() });
}

// The v1 resolution, derived, for older readers (console research view, inspector, docs).
function compatResolution(u) {
  if (u.status === 'dropped') return u.dismissed ? 'dismissed' : 'dropped';
  if (u.status === 'deferred_to_design') return 'deferred';
  if (u.status === 'settled') {
    if (u.settled_by === 'evidence') return 'assumption';
    if (u.settled_by === 'assumption_accepted' && !u.answer) return 'deferred';
    return 'answered';
  }
  if (u.status === 'proposed') return 'question';
  return 'pending';
}

// A v2 issue from anything (a v1 unknown, a workflow item, an agent's raw output).
function cleanIssue(u, { round = null } = {}) {
  const kind = KINDS.includes(u.kind) ? u.kind : 'user';
  const s = u.subject ? { subject: subjectKey(u.subject) || subjectOf(u).subject, explicit: u.subject_explicit !== false && Boolean(u.subject) } : subjectOf(u);
  const owner = OWNERS.includes(u.owner) ? u.owner : classify(u, kind);
  const status = STATUSES.includes(u.status) ? u.status : owner === 'design' ? 'deferred_to_design' : owner === 'user' ? 'proposed' : 'open';
  const out = {
    id: String(u.id),
    subject: s.subject,
    subject_explicit: Boolean(s.explicit),
    text: clip(u.text || u.question, 400),
    kind,
    impact: ['high', 'medium', 'low'].includes(u.impact) ? u.impact : 'medium',
    owner,
    status,
    settled_by: SETTLED_BY.includes(u.settled_by) ? u.settled_by : status === 'deferred_to_design' ? 'design_deferral' : null,
    draft: clip(u.draft || u.text || u.question, 400),
    ...(Array.isArray(u.options) && u.options.length ? { options: u.options.slice(0, 5).map((o) => clip(o, 160)) } : {}),
    default: u.default ? clip(u.default, 300) : null,
    reason: u.reason ? clip(u.reason, 300) : null,
    research: ['repo', 'web', 'none'].includes(u.research) ? u.research : kind === 'repo' ? 'repo' : kind === 'world' ? 'web' : 'none',
    ...(u.search ? { search: clip(u.search, 300) } : {}),
    ...(u.why ? { why: clip(u.why, 300) } : {}),
    evidence: Array.isArray(u.evidence) ? u.evidence.map(String) : [],
    assumption: u.assumption || null,
    question_id: u.question_id || null,
    answer: u.answer || null,
    ...(u.answered ? { answered: u.answered } : {}),
    ...(u.user_asserted ? { user_asserted: true } : {}),
    ...(u.dismissed ? { dismissed: true } : {}),
    aliases: Array.isArray(u.aliases) ? u.aliases.map((a) => ({ id: String(a.id), text: clip(a.text, 300) })) : [],
    attempts: Number(u.attempts) || 0,
    failed_sources: Array.isArray(u.failed_sources) ? u.failed_sources.slice(-10).map((f) => ({ source: clip(f.source || f, 300), reason: clip(f.reason || '', 160) })) : [],
    notes: Array.isArray(u.notes) ? u.notes.slice(-20) : [],
    history: Array.isArray(u.history) ? u.history.slice(-40) : [],
    applied_round: u.applied_round || null,
    edit_attempts: Number(u.edit_attempts) || 0,
    researched: Boolean(u.researched),
    note: u.note ? clip(u.note, 300) : null,
    source: u.source || 'mapper',
    round: u.round || round || null,
  };
  out.resolution = compatResolution(out);
  return out;
}

function settle(u, by, round, actor, text) {
  u.status = 'settled';
  u.settled_by = by;
  if (by === 'user') u.owner = 'user'; // the user's word settles it, whoever owned it
  event(u, round, `settled:${by}`, actor, text);
  u.resolution = compatResolution(u);
}

// ---------------------------------------------------------------- migration (v1 → v2)
// A v1 record (no version 2): subjects derived, duplicates folded into the earliest id,
// answered → settled by user (free-form answers matched by overlap), implementation facts
// deferred to design. Returns { data, report } and never touches the contract.
function migrate(v1, state, answers = []) {
  const log = state.question_log || [];
  const report = { from: v1.version || 1, at: nowIso(), folded: [], matched_answers: [], unmatched_answers: [], deferred: [], settled: [], ceiling: limits(state).ceiling, legacy_policy: limits(state).legacy_snapshot };
  const old = (v1.unknowns || []).slice().sort((a, b) => num(a.id) - num(b.id));
  const issues = [];
  const into = {};
  for (const u0 of old) {
    const s = subjectOf(u0);
    const probe = { ...u0, subject: s.subject, subject_explicit: false };
    const hit = issues.find((x) => sameIssue(probe, x));
    if (hit) {
      hit.aliases.push({ id: u0.id, text: clip(u0.text, 300) });
      into[u0.id] = hit.id;
      hit._group.push(u0);
      report.folded.push({ id: u0.id, into: hit.id, text: clip(u0.text, 160) });
      continue;
    }
    const kind = KINDS.includes(u0.kind) ? u0.kind : 'user';
    const base = { ...u0, subject: s.subject, subject_explicit: false, kind, status: undefined, owner: undefined, aliases: [] };
    const iss = cleanIssue(base);
    iss._group = [u0];
    into[u0.id] = iss.id;
    issues.push(iss);
  }
  const RANK = { answered: 0, assumption: 1, dismissed: 2, dropped: 3, deferred: 4, question: 5, pending: 6 };
  for (const iss of issues) {
    const group = iss._group;
    delete iss._group;
    const best = group.slice().sort((a, b) => (RANK[a.resolution] ?? 9) - (RANK[b.resolution] ?? 9))[0];
    iss.evidence = [...new Set(group.flatMap((g) => g.evidence || []))];
    iss.question_id = group.map((g) => g.question_id).find(Boolean) || null;
    iss.answer = group.map((g) => g.answer).find(Boolean) || null;
    iss.assumption = best.assumption || group.map((g) => g.assumption).find(Boolean) || null;
    iss.researched = group.some((g) => g.researched);
    iss.note = best.note || null;
    const r = best.resolution;
    if (r === 'answered') settle(iss, 'user', null, 'migration', 'answered before v2');
    else if (r === 'assumption') settle(iss, 'evidence', null, 'migration', `evidence-backed (${iss.assumption || iss.evidence.join(', ')})`);
    else if (r === 'deferred') settle(iss, 'assumption_accepted', null, 'migration', iss.note || 'low impact: assumed');
    else if (r === 'dismissed' || r === 'dropped') {
      iss.status = 'dropped';
      if (r === 'dismissed') iss.dismissed = true;
      event(iss, null, 'dropped', 'migration', iss.note);
    } else if (r === 'question') {
      iss.status = 'proposed';
      iss.owner = iss.owner === 'design' ? 'design' : 'user';
      iss.default = iss.default || (['repo', 'world'].includes(iss.kind) ? iss.draft : null);
      iss.reason = iss.note || null;
    } else {
      iss.status = iss.owner === 'design' ? 'deferred_to_design' : iss.owner === 'user' ? 'proposed' : 'open';
    }
  }
  // Answers: by Q-n through the question log, then free-form text by overlap.
  const byQ = Object.fromEntries(log.map((q) => [q.id, q]));
  for (const a of answers) {
    let hit = null;
    let how = null;
    const q = a.id ? byQ[a.id] : log.find((x) => String(x.question).toLowerCase().trim() === String(a.question || '').toLowerCase().trim());
    if (q && q.unknown) {
      hit = issues.find((x) => x.id === (into[q.unknown] || q.unknown));
      how = a.id ? `by ${a.id}` : 'by question text';
    }
    if (!hit) {
      hit = findSame(issues, { text: a.question || '' });
      how = hit ? 'by overlap' : null;
    }
    if (!hit) {
      report.unmatched_answers.push({ question: clip(a.question, 160), answer: clip(a.answer, 160) });
      continue;
    }
    if (how === 'by overlap') report.matched_answers.push({ question: clip(a.question, 160), issue: hit.id, answer: clip(a.answer, 160) });
    if (!hit.answer || hit.status !== 'settled' || hit.settled_by !== 'user') {
      hit.answer = clip(a.answer, 400);
      hit.answered = { via: 'migration', at: a.at || null, question_id: a.id || (q && q.id) || null };
      if (hit.status !== 'settled' || hit.settled_by === 'assumption_accepted') settle(hit, 'user', null, 'migration', `answer matched ${how}`);
      if (hit.kind === 'world') hit.user_asserted = true;
    }
  }
  // Implementation facts still open become design's.
  for (const iss of issues) {
    if (FINAL.has(iss.status)) continue;
    if (['repo', 'world'].includes(iss.kind) && isImplementationFact(`${iss.text} ${iss.draft} ${(iss.aliases || []).map((x) => x.text).join(' ')}`)) {
      iss.owner = 'design';
      iss.status = 'deferred_to_design';
      iss.settled_by = 'design_deferral';
      event(iss, null, 'deferred_to_design', 'migration', 'implementation detail: settled in ground/decide');
      report.deferred.push({ id: iss.id, text: clip(iss.text, 160) });
    }
  }
  for (const iss of issues) iss.resolution = compatResolution(iss);
  report.settled = issues.filter((x) => x.status === 'settled').map((x) => ({ id: x.id, by: x.settled_by }));
  // Re-point evidence and assumptions at the canonical ids.
  const evidence = (v1.evidence || []).map((e) => ({ ...e, unknown: into[e.unknown] || e.unknown }));
  const assumptions = (v1.assumptions || []).map((a) => ({ ...a, unknown: into[a.unknown] || a.unknown }));
  const data = { ...v1, version: 2, unknowns: issues, evidence, assumptions, notes: v1.notes || [], migration: report };
  return { data, report };
}

// The ledger for this job as v2 (migrated in memory when needed). null when clarify never researched.
function ensure(root, state, data) {
  const intent = require('./intent');
  const d = data === undefined ? intent.load(root, state.id) : data;
  if (!d || d.tampered) return d;
  if (d.version === 2) return d;
  const answers = readJson(jobPaths(root, state.id).answers, []);
  return migrate(d, state, answers).data;
}

// Questions asked in an earlier round and still unanswered take their default (the
// question said so); questions without one (intent) stay open for the user.
function acceptDefaults(data, state, round) {
  const log = state.question_log || [];
  const asked = Object.fromEntries(log.map((q) => [q.id, q]));
  const out = [];
  for (const u of data.unknowns) {
    if (u.status !== 'proposed' || !u.question_id) continue;
    const q = asked[u.question_id];
    if (!q || (q.round || 0) >= round) continue;
    const d = isNone(u.default) ? q.default : u.default;
    if (isNone(d) || q.category === 'intent' || u.kind === 'intent') continue;
    u.answer = clip(defaultValue(d), 400);
    u.answered = { via: 'default', at: nowIso(), question_id: u.question_id, default_accepted: true };
    settle(u, 'assumption_accepted', round, 'default', `unanswered: the default "${clip(d, 120)}" applies`);
    out.push(u.id);
  }
  return out;
}

// ---------------------------------------------------------------- answers and notes
// The questions the last clarify round showed, in the order shown (what "1", "2" … in a
// numbered reply refer to): the ids factory record kept, else the last round's questions.
function questionSet(state) {
  const log = state.question_log || [];
  if (!log.length) return [];
  const byId = Object.fromEntries(log.map((q) => [q.id, q]));
  if (Array.isArray(state.clarify_shown) && state.clarify_shown.length) {
    const shown = state.clarify_shown.map((id) => byId[id]).filter(Boolean);
    if (shown.length) return shown;
  }
  const last = Math.max(...log.map((q) => q.round || 0));
  return log.filter((q) => (q.round || 0) === last);
}

// Find the issue an answer is for: U-n, Q-n, or free text.
function resolveRef(data, state, ref, text) {
  const list = data.unknowns;
  const R = String(ref || '').trim().toUpperCase();
  if (/^U-\d+$/.test(R)) return list.find((u) => u.id === R || (u.aliases || []).some((a) => a.id === R)) || null;
  if (/^Q-\d+$/.test(R)) {
    const byQ = list.find((u) => u.question_id === R);
    if (byQ) return byQ;
    const q = (state.question_log || []).find((x) => x.id === R);
    if (q && q.unknown) return list.find((u) => u.id === q.unknown || (u.aliases || []).some((a) => a.id === q.unknown)) || null;
    return null;
  }
  if (text) {
    const q = (state.question_log || []).find((x) => String(x.question).toLowerCase().trim() === String(text).toLowerCase().trim());
    if (q) return resolveRef(data, state, q.id);
    const live = list.filter((u) => !['dropped'].includes(u.status));
    return findSame(live, { text });
  }
  return null;
}

const ACCEPT = /^(default|accept|accepted|ok|okay|sure|fine|agreed|yes,? (use|take) the default|use the default|take the default|👍)$/i;

// Settle one issue with the user's answer. via: cli | chat. Returns a row for the receipt.
function applyAnswer(data, state, { issue, answer, acceptDefault = false, via = 'cli', round, questionId }) {
  const u = issue;
  let text = String(answer || '').replace(/\s+/g, ' ').trim();
  const yes = /^(y|yes)$/i.test(text) && !(u.options || []).some((o) => /^yes\b/i.test(o));
  const takeDefault = acceptDefault || ACCEPT.test(text) || (yes && !isNone(u.default));
  if (takeDefault) {
    if (isNone(u.default)) fail(`${u.id} has no proposed default to accept: answer it in words (factory answer ${u.question_id || u.id} "…").`, 'no_default');
    text = defaultValue(u.default);
  }
  if (!text) fail('The answer is empty.', 'bad_input');
  const was = { status: u.status, settled_by: u.settled_by, answer: u.answer };
  if (u.status === 'settled' && u.settled_by === 'evidence' && !takeDefault) {
    // The user overrides research: their word counts, recorded as user-asserted.
    u.user_asserted = true;
  }
  u.answer = clip(text, 400);
  u.answered = { via, at: nowIso(), question_id: questionId || u.question_id || null, ...(takeDefault ? { default_accepted: true } : {}) };
  if (['world', 'repo'].includes(u.kind)) u.user_asserted = true;
  u.applied_round = null;
  u.edit_attempts = 0;
  settle(u, takeDefault ? 'assumption_accepted' : 'user', round, via === 'chat' ? 'user (chat)' : 'user', clip(text, 200));
  if (u.status === 'settled' && was.status === 'deferred_to_design') u.owner = 'user';
  return { issue: u.id, question: u.question_id || null, answer: u.answer, settled_by: u.settled_by, was: was.status === 'settled' ? `settled by ${was.settled_by}${was.answer ? `: ${clip(was.answer, 80)}` : ''}` : was.status };
}

function openIds(data) {
  return data.unknowns.filter((u) => !FINAL.has(u.status)).map((u) => `${u.id}${u.question_id ? ` (${u.question_id})` : ''}`);
}

// In clarify: the contract is not approved yet and clarify has run at least once.
function inClarify(state) {
  const approved = state.approvals && (state.approvals.H1 || state.approvals.EH1);
  return !approved && (state.counters && state.counters.clarify_rounds) >= 1;
}

// `factory answer`: U-n / Q-n / free text. Writes the ledger and answers.json.
function answer(root, { jobId, ref, text, question, acceptDefault = false, via = 'cli' }) {
  const job = require('./job');
  const intent = require('./intent');
  const { writeJson } = require('../lib/util');
  const state = job.resolve(root, jobId);
  if (['closed', 'cancelled', 'abandoned'].includes(state.status)) fail(`${state.id} is ${state.status}; nothing to answer.`, 'not_active');
  const raw = intent.load(root, state.id);
  if (raw && raw.tampered) fail(`${state.id}'s intent-evidence.json fails its seal: run clarify again before answering.`, 'tampered');
  const data = raw ? ensure(root, state, raw) : null;
  const f = jobPaths(root, state.id).answers;
  const list = readJson(f, []);
  const R = String(ref || '').trim().toUpperCase();
  const round = (state.counters.clarify_rounds || 0) + 1;
  let issue = data ? resolveRef(data, state, R, R ? null : question) : null;
  const logged = /^Q-\d+$/.test(R) ? (state.question_log || []).find((q) => q.id === R) : issue && issue.question_id ? (state.question_log || []).find((q) => q.id === issue.question_id) : null;
  if (R && !issue && !logged) fail(`${state.id} has no issue or question ${R}.${data ? ` Open: ${openIds(data).join(', ') || 'none'}.` : ''}`, 'bad_input');
  if (!issue && data && inClarify(state)) {
    fail(`No clarify issue matches "${clip(question || R, 120)}": nothing was recorded. Answer by id: factory answer <U-n|Q-n> "<answer>". Open: ${openIds(data).join(', ') || 'none'}.`, 'no_match');
  }
  if (!text && !acceptDefault) fail('Need the answer: factory answer <U-n|Q-n> "<answer>" (or --default to accept the proposed default).', 'bad_input');
  let row = null;
  if (issue) {
    row = applyAnswer(data, state, { issue, answer: text, acceptDefault, via, round, questionId: logged ? logged.id : null });
    intent.save(root, state.id, data);
    intent.render(root, state, data);
  }
  const q = logged ? logged.question : issue ? issue.text : question;
  list.push({ ...(logged ? { id: logged.id, category: logged.category } : {}), ...(issue ? { issue: issue.id } : {}), question: q, answer: row ? row.answer : text, via, at: nowIso() });
  writeJson(f, list);
  return {
    job: state.id,
    ...(logged ? { id: logged.id } : {}),
    ...(row ? { issue: row.issue, settled_by: row.settled_by, answer: row.answer, ...(row.was !== 'proposed' && row.was !== 'open' ? { was: row.was } : {}) } : {}),
    answers: list.length,
    message: row ? `${row.issue}${row.question ? ` (${row.question})` : ''} settled by ${row.settled_by === 'user' ? 'your answer' : 'the accepted default'}: ${clip(row.answer, 120)}` : `Recorded the answer to "${clip(q, 80)}".`,
  };
}

// Numbered chat replies ("1 yes, 2 trunk ports too", one per line or comma-separated;
// "Q-4 no" names the question itself) as answers to the current question set. null when the
// text is not that shape. An item that ends in "?" is a question to the agent, not an answer:
// the whole message is then left alone.
function parseNumbered(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (/^(defaults|accept (all )?defaults|use (the )?defaults|all defaults)\.?$/i.test(t)) return { all_defaults: true, items: [] };
  const parts = t.includes('\n') ? t.split('\n').map((x) => x.trim()).filter(Boolean) : t.split(/[,;]\s*(?=(?:q-?)?\d{1,2}\s*[.):\-]?\s+\S)/i).map((x) => x.trim());
  const items = [];
  for (const p of parts) {
    const m = p.match(/^(q-?)?(\d{1,2})\s*[.):\-]?\s+(.+)$/i);
    if (!m) return null;
    const answerText = m[3].trim();
    if (/\?\s*$/.test(answerText)) return null;
    items.push({ n: Number(m[2]), ...(m[1] ? { q: `Q-${Number(m[2])}` } : {}), text: answerText });
  }
  if (!items.length) return null;
  return { all_defaults: false, items };
}

// Apply a numbered reply to the job's current question set. Returns the receipt, or null
// when the job has no open question set or no item names one of its questions (the hook
// leaves the message alone then: it was just a numbered message). All or nothing: an item
// for a question outside the set, the same question twice, or a question already settled
// refuses the whole reply, so a pasted list never overwrites an answer.
function applyNumbered(root, parsed, { jobId, via = 'chat' } = {}) {
  const job = require('./job');
  const state = job.resolve(root, jobId);
  if (state.status !== 'active' || !inClarify(state)) return null;
  const set = questionSet(state);
  if (!set.length) return null;
  const intent = require('./intent');
  const raw = intent.load(root, state.id);
  if (!raw || raw.tampered) return null;
  const data = ensure(root, state, raw);
  const issueOf = (q) => resolveRef(data, state, q.id);
  const open = set.filter((q) => {
    const u = issueOf(q);
    return u && u.status === 'proposed';
  });
  if (!open.length) return null;
  const log = state.question_log || [];
  const listed = () => set.map((q, i) => `${i + 1} = ${q.id}`).join(', ');
  const items = parsed.all_defaults
    ? open.map((q) => ({ q, text: 'default' }))
    : parsed.items.map((it) => ({ q: it.q ? log.find((x) => x.id === it.q) : set[it.n - 1], text: it.text, n: it.n, label: it.q || String(it.n) }));
  if (!parsed.all_defaults) {
    // nothing in it names a question of this set: not an answer set at all
    if (!items.some((it) => it.q && set.includes(it.q))) return null;
    const seen = new Set();
    for (const it of items) {
      if (!it.q) fail(`There is no question ${it.label}: this round asked ${set.length} (${listed()}). Nothing was recorded.`, 'bad_input');
      if (seen.has(it.q.id)) fail(`${it.q.id} is answered twice in that reply. Nothing was recorded.`, 'bad_input');
      seen.add(it.q.id);
      const u = issueOf(it.q);
      if (!u) fail(`${it.q.id} is not a clarify question of ${state.id}. Nothing was recorded.`, 'bad_input');
      if (u.status !== 'proposed') fail(`${it.q.id} (${it.label}) is already settled (${u.status}${u.answer ? `: ${clip(u.answer, 60)}` : ''}), so this reply was not read as answers. To change an answer, say so and run factory answer ${it.q.id} "…". Nothing was recorded.`, 'already_settled');
    }
  }
  const rows = [];
  for (const it of items) rows.push(answer(root, { jobId: state.id, ref: it.q.id, text: it.text, via }));
  return { job: state.id, answered: rows.map((r) => ({ id: r.id, issue: r.issue, answer: r.answer, settled_by: r.settled_by })), message: `Recorded ${rows.length} answer(s): ${rows.map((r) => `${r.id || r.issue} → ${clip(r.answer, 60)}`).join('; ')}.` };
}

// `factory clarify note U-n "…"`: context for the next round (the editor and the analysts read it).
function note(root, { jobId, ref, text, via = 'cli' }) {
  const job = require('./job');
  const intent = require('./intent');
  const state = job.resolve(root, jobId);
  const raw = intent.load(root, state.id);
  if (!raw) fail(`${state.id} has no clarify ledger yet: clarify has not run.`, 'no_ledger');
  if (raw.tampered) fail(`${state.id}'s intent-evidence.json fails its seal.`, 'tampered');
  const data = ensure(root, state, raw);
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) fail('Say the note: factory clarify note U-n "<note>".', 'bad_input');
  const R = String(ref || '').trim().toUpperCase();
  const round = (state.counters.clarify_rounds || 0) + 1;
  if (R && R !== 'CONTRACT') {
    const u = resolveRef(data, state, R);
    if (!u) fail(`${state.id} has no issue ${R}. Issues: ${data.unknowns.map((x) => x.id).join(', ')}.`, 'bad_input');
    u.notes.push({ round, actor: via === 'chat' ? 'user (chat)' : 'user', text: clip(t, 400), at: nowIso() });
    u.applied_round = u.status === 'settled' ? null : u.applied_round;
    event(u, round, 'note', 'user', t);
  } else {
    data.notes = data.notes || [];
    data.notes.push({ round, actor: 'user', ref: 'contract', text: clip(t, 400), at: nowIso(), applied: false });
  }
  intent.save(root, state.id, data);
  return { job: state.id, ref: R || 'contract', message: `Noted for ${R || 'the contract'}; clarify takes it into account next round (run factory next).` };
}

// ---------------------------------------------------------------- views
function nextAction(u, state) {
  if (u.status === 'settled') return u.settled_by === 'evidence' ? `none (evidence ${u.evidence.join(', ') || u.assumption || ''})`.trim() : 'none';
  if (u.status === 'dropped') return 'none';
  if (u.status === 'deferred_to_design') return 'ground/decide settle it';
  if (u.status === 'researching') return 'retry research with a longer budget';
  if (u.status === 'open' && u.owner === 'research') return 'research next round';
  if (u.question_id) return `answer: factory answer ${u.question_id} "…"${isNone(u.default) ? '' : ` (or --default: ${clip(u.default, 60)})`}`;
  return 'asked next round';
}

const OWNER_ORDER = { user: 0, research: 1, design: 2 };
const STATUS_ORDER = { proposed: 0, open: 1, researching: 2, deferred_to_design: 3, settled: 4, dropped: 5 };

function rows(data, state) {
  return data.unknowns
    .slice()
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || OWNER_ORDER[a.owner] - OWNER_ORDER[b.owner] || num(a.id) - num(b.id))
    .map((u) => ({ id: u.id, subject: u.subject, title: clip(u.text, 140), kind: u.kind, impact: u.impact, status: u.status, owner: u.owner, settled_by: u.settled_by, question_id: u.question_id, default: u.default, answer: u.answer ? clip(u.answer, 140) : null, aliases: (u.aliases || []).map((a) => a.id), next: nextAction(u, state), ...(u.reason ? { reason: clip(u.reason, 160) } : {}) }));
}

function totals(data) {
  const t = { issues: data.unknowns.length, open: 0, researching: 0, proposed: 0, settled: 0, deferred_to_design: 0, dropped: 0, by_owner: { user: 0, research: 0, design: 0 } };
  for (const u of data.unknowns) {
    t[u.status] = (t[u.status] || 0) + 1;
    if (!FINAL.has(u.status)) t.by_owner[u.owner] = (t.by_owner[u.owner] || 0) + 1;
  }
  t.closed = t.settled + t.deferred_to_design + t.dropped;
  return t;
}

function trend(data) {
  const r = (data.rounds || []).filter((x) => x.ledger);
  const list = r.map((x) => ({ round: x.round, opened: x.ledger.opened, settled: x.ledger.settled, deferred: x.ledger.deferred, asked: x.ledger.asked, progress: x.ledger.progress, degraded: Boolean(x.ledger.degraded) }));
  const last = list.slice(-2);
  const word = !list.length ? (data.migration ? 'no v2 rounds yet (migrated)' : 'no rounds yet') : last.every((x) => !x.progress && !x.degraded) && last.length === 2 ? 'stalled' : last.some((x) => x.settled > x.opened) ? 'converging' : last.some((x) => x.opened > x.settled) ? 'growing' : 'steady';
  return { rounds: list, trend: word };
}

function view(root, state, data) {
  const t = totals(data);
  const L = limits(state);
  const tr = trend(data);
  const logQ = Object.fromEntries((state.question_log || []).map((q) => [q.id, q]));
  const questions = data.unknowns.filter((u) => u.status === 'proposed' && u.owner === 'user' && u.question_id).map((u) => ({ id: u.question_id, issue: u.id, question: (logQ[u.question_id] && logQ[u.question_id].question) || u.draft || u.text, default: isNone(u.default) ? null : u.default }));
  return {
    job: state.id,
    version: data.version,
    totals: t,
    open_by_owner: t.by_owner,
    questions,
    answer_commands: questions.map((q) => `factory answer ${q.id} "<answer>"${q.default ? ` (or: factory answer ${q.id} --default)` : ''}`),
    issues: rows(data, state),
    deferred_to_design: data.unknowns.filter((u) => u.status === 'deferred_to_design').map((u) => ({ id: u.id, subject: u.subject, title: clip(u.text, 140) })),
    rounds: tr.rounds,
    trend: tr.trend,
    limits: { ceiling: L.ceiling, no_progress_rounds: L.no_progress, rounds_counted: L.counted, no_progress_streak: (state.counters && state.counters.clarify_no_progress) || 0 },
    notes: (data.notes || []).slice(-10),
    ...(data.migration ? { migration: data.migration } : {}),
  };
}

function statusText(v) {
  const L = [];
  L.push(`Clarify ledger — ${v.job}: ${v.totals.issues} issue(s), ${v.totals.closed} closed (${v.totals.settled} settled, ${v.totals.deferred_to_design} deferred to design, ${v.totals.dropped} dropped); open by owner: user ${v.open_by_owner.user}, research ${v.open_by_owner.research}, design ${v.open_by_owner.design}`);
  L.push(`Rounds counted ${v.limits.rounds_counted} of ${v.limits.ceiling} (ceiling); parks after ${v.limits.no_progress_rounds} rounds with no progress (now ${v.limits.no_progress_streak}). Trend: ${v.trend}.`);
  L.push('');
  const w = { id: 6, subject: 28, status: 18, owner: 8 };
  const pad = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s).padEnd(n));
  L.push(`${pad('ID', w.id)} ${pad('SUBJECT', w.subject)} ${pad('STATUS', w.status)} ${pad('OWNER', w.owner)} NEXT`);
  for (const r of v.issues) L.push(`${pad(r.id, w.id)} ${pad(r.subject || '—', w.subject)} ${pad(r.status === 'settled' ? `settled:${r.settled_by}` : r.status, w.status)} ${pad(r.owner, w.owner)} ${r.next}${r.aliases.length ? ` [aliases ${r.aliases.join(', ')}]` : ''}`);
  if (v.rounds.length) {
    L.push('', 'Round  opened  settled  deferred  asked  progress');
    for (const r of v.rounds) L.push(`${String(r.round).padEnd(6)} ${String(r.opened).padEnd(7)} ${String(r.settled).padEnd(8)} ${String(r.deferred).padEnd(9)} ${String(r.asked).padEnd(6)} ${r.degraded ? 'degraded (not counted)' : r.progress ? 'yes' : 'no'}`);
  }
  if (v.questions.length) {
    L.push('', 'Answer with:');
    for (const c of v.answer_commands) L.push(`  ${c}`);
  }
  if (v.migration) {
    const m = v.migration;
    L.push('', `Migrated from v${m.from}: ${m.folded.length} duplicate(s) folded${m.folded.length ? ` (${m.folded.map((x) => `${x.id}→${x.into}`).join(', ')})` : ''}; ${m.matched_answers.length} free-form answer(s) matched${m.matched_answers.length ? ` (${m.matched_answers.map((x) => x.issue).join(', ')})` : ''}; ${m.deferred.length} deferred to design${m.deferred.length ? ` (${m.deferred.map((x) => x.id).join(', ')})` : ''}; ceiling ${m.ceiling} rounds.`);
    if (m.unmatched_answers.length) L.push(`  Not matched: ${m.unmatched_answers.map((x) => `"${x.question}"`).join('; ')}`);
  }
  return L.join('\n');
}

// `factory clarify status`: read-only (a v1 record is shown migrated, not written).
function status(root, { jobId, json = false } = {}) {
  const job = require('./job');
  const intent = require('./intent');
  const state = job.resolve(root, jobId);
  const raw = intent.load(root, state.id);
  if (!raw) {
    const msg = { job: state.id, ledger: false, message: 'No clarify ledger yet: it is created by the first clarify round.' };
    return json ? msg : `${state.id}: ${msg.message}`;
  }
  if (raw.tampered) {
    const msg = { job: state.id, ledger: false, tampered: true, message: 'intent-evidence.json fails its seal (edited by hand?): run clarify again.' };
    return json ? msg : `${state.id}: ${msg.message}`;
  }
  const v = view(root, state, ensure(root, state, raw));
  return json ? v : statusText(v);
}

// For `factory next` while clarify is the step: a short ledger summary.
function nextSummary(root, state) {
  try {
    const intent = require('./intent');
    const raw = intent.load(root, state.id);
    if (!raw || raw.tampered) return null;
    const v = view(root, state, ensure(root, state, raw));
    return { open_by_owner: v.open_by_owner, settled: v.totals.settled, deferred_to_design: v.totals.deferred_to_design, questions: v.questions, answer_commands: v.answer_commands, trend: v.trend, status_command: `factory clarify status --job ${state.id}` };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the CLI-owned contract sections
function clarificationLines(data) {
  return data.unknowns
    .filter((u) => u.status === 'settled' && ['user', 'assumption_accepted'].includes(u.settled_by) && u.answer)
    .sort((a, b) => num(a.id) - num(b.id))
    .map((u) => `- ${u.id}${u.question_id ? ` (${u.question_id})` : ''}: ${clip(u.text, 200).replace(/\s+/g, ' ')} → ${clip(u.answer, 300).replace(/\s+/g, ' ')} (${u.settled_by === 'user' ? 'answered by user' : 'default accepted'})`);
}
function deferredLines(data) {
  return data.unknowns
    .filter((u) => u.status === 'deferred_to_design')
    .sort((a, b) => num(a.id) - num(b.id))
    .map((u) => `- ${u.id}: ${clip(u.text, 240).replace(/\s+/g, ' ')} (settled in ground/decide)`);
}

// For ground and decide: what clarify handed over.
function deferredText(data) {
  const d = (data && data.unknowns ? data.unknowns : []).filter((u) => u.status === 'deferred_to_design');
  if (!d.length) return '';
  return ['- Deferred to design by clarify (implementation detail: settle these here, cite your sources; they did not block H1):', ...d.map((u) => `  - ${u.id} [${u.kind}] ${clip(u.text, 200)}${u.aliases && u.aliases.length ? ` (also raised as ${u.aliases.map((a) => a.id).join(', ')})` : ''}`)].join('\n');
}

module.exports = {
  KINDS, OWNERS, STATUSES, SETTLED_BY, FINAL, QUESTION_KINDS,
  tokens, subjectKey, subjectOf, sameIssue, findSame, isImplementationFact, classify, limits, compatResolution, cleanIssue, settle, event,
  migrate, ensure, acceptDefaults, questionSet, resolveRef, applyAnswer, answer, parseNumbered, applyNumbered, note, inClarify, isNone, defaultValue,
  rows, totals, trend, view, statusText, status, nextSummary, clarificationLines, deferredLines, deferredText, openIds,
};
