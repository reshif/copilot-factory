'use strict';
// Clarify v1/v2 → v3 (docs/DESIGN-CLARIFY-v3.md, "Migration"). A job still in clarify with an
// intent-evidence.json (v1, or v2's issue ledger) and no clarify.json gets a v3 record on its
// first v3 touch; the old file is left as it was. Only the data is converted here: every rule
// that then applies to it is cli/core/clarify.js's.
//
//   v2 issue                         → v3 item
//   answered (settled by the user)   → strength user, the answer kept as a word W-n
//   default accepted                 → strength accepted
//   low impact, assumed, not asked   → strength assumption ("facts I'll assume")
//   settled by evidence              → strength evidence, re-judged against the confirmed pins
//   deferred to design               → deferred, owner design
//   dropped / dismissed              → dropped, with the reason (the user can reopen it)
//   open, researching, asked         → open (researched again, or asked on the sheet)
//   an alias a v2 fold merged        → its own item again, linked to the one it was folded into
//   an H1 denial since the last approval → a redirect, read back after the read-back

const { readJson, nowIso } = require('../lib/util');
const { jobPaths } = require('../lib/paths');

const clip = (s, n = 400) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// A v1 unknown or a v2 issue, as one shape: { status, settled_by, answer, accepted }.
function shape(u) {
  if (u.status && ['open', 'researching', 'proposed', 'settled', 'deferred_to_design', 'dropped'].includes(u.status)) {
    const accepted = u.settled_by === 'assumption_accepted' && Boolean(u.answer) && Boolean(u.answered && (u.answered.default_accepted || u.answered.via === 'default'));
    return { status: u.status, settled_by: u.settled_by, answer: u.answer, accepted };
  }
  const r = u.resolution;
  if (r === 'answered') return { status: 'settled', settled_by: 'user', answer: u.answer };
  if (r === 'assumption') return { status: 'settled', settled_by: 'evidence' };
  if (r === 'deferred') return { status: 'settled', settled_by: 'assumption_accepted', answer: null };
  if (r === 'dismissed' || r === 'dropped') return { status: 'dropped' };
  if (r === 'question') return { status: 'proposed' };
  return { status: 'open' };
}

function kindOf(u, open) {
  if (u.kind === 'decision') return { kind: 'decision', tag: 'decision' };
  if (u.kind === 'repo') return { kind: 'fact', tag: 'repo' };
  if (u.kind === 'world') return { kind: 'fact', tag: 'docs' };
  return { kind: open ? 'question' : 'fact', tag: null };
}

function migrate(root, state, legacy) {
  const C = require('./clarify');
  const data = C.empty(state);
  const from = legacy.version === 2 ? 2 : 1;
  const report = { from, at: nowIso(), items: 0, aliases_split: 0, answered: 0, accepted: 0, assumed: 0, evidence: 0, deferred: 0, dropped: 0, open: 0, redirect: false, summary: '' };
  if (state.request) C.addWord(data, state.request, 'request');
  const idMap = {};
  const evMap = {};
  // findings first, so items can point at them
  for (const e of legacy.evidence || []) {
    if (e.retired) continue;
    const id = `E-${data.evidence.length + 1}`;
    evMap[e.id] = id;
    data.evidence.push({ id, item: null, plan: null, claim: clip(e.claim, 300), source: clip(e.source, 400), quote: clip(e.quote, 400), version: e.applies_to_version ? clip(e.applies_to_version, 40) : null, system: null, tier: e.source_tier || (e.scout === 'repo' ? 'repo' : 'official'), retrieved_at: e.retrieved_at || null, by: e.scout === 'repo' ? 'repo' : 'docs', pass: 0, passes: [0], migrated_from: e.id });
    report.evidence += 1;
  }
  const add = (u, parent) => {
    const sh = parent ? { status: 'open' } : shape(u);
    const open = !['settled', 'deferred_to_design', 'dropped'].includes(sh.status);
    const k = kindOf(parent ? { kind: parent.kind } : u, open);
    const text = clip(u.text || u.draft, 300);
    let fields = { kind: k.kind, text, tag: k.tag, impact: (parent || u).impact, origin: 'migration', needs_research: false };
    if (sh.status === 'settled' && sh.settled_by === 'user' && sh.answer) {
      const w = C.addWord(data, sh.answer, 'migration');
      fields = { ...fields, value: sh.answer, status: 'decided', strength: 'user', source: { kind: 'word', ref: w.id, quote: clip(sh.answer, 300) } };
      report.answered += 1;
    } else if (sh.status === 'settled' && sh.accepted) {
      fields = { ...fields, value: sh.answer, status: 'decided', strength: 'accepted', source: { kind: 'migration', ref: u.question_id || u.id } };
      report.accepted += 1;
    } else if (sh.status === 'settled' && sh.settled_by === 'evidence') {
      const a = (legacy.assumptions || []).find((x) => x.id === u.assumption);
      fields = { ...fields, value: (a && (a.overridden ? a.override.value : a.statement)) || u.draft || text, status: 'decided', strength: a && a.overridden ? 'user' : 'evidence' };
    } else if (sh.status === 'settled') {
      fields = { ...fields, value: sh.answer || u.default || u.draft || text, status: 'assumed', strength: 'assumption', extra: { unconfirmed: 'assumed by the v2 rules without asking' } };
      report.assumed += 1;
    } else if (sh.status === 'deferred_to_design') {
      fields = { ...fields, status: 'deferred', owner: 'design' };
      report.deferred += 1;
    } else if (sh.status === 'dropped') {
      fields = { ...fields, status: 'dropped' };
      report.dropped += 1;
    } else {
      fields = { ...fields, status: 'open', needs_research: Boolean(k.tag) };
      report.open += 1;
    }
    const it = C.newItem(data, fields, 'migration');
    if (sh.status === 'dropped') it.history.push({ at: nowIso(), event: 'dropped', actor: 'clarify v2', text: clip(u.note || 'dropped before v3', 200) });
    if (parent) {
      it.folded_into = idMap[parent.id];
      it.history.push({ at: nowIso(), event: 'split', actor: 'migration', text: `v2 folded "${text}" into ${parent.id}; v3 keeps it as its own item` });
      report.aliases_split += 1;
    }
    it.v2_id = u.id;
    for (const eid of u.evidence || []) {
      const nid = evMap[eid];
      if (!nid) continue;
      it.evidence.push(nid);
      const e = data.evidence.find((x) => x.id === nid);
      if (e && !e.item) e.item = it.id;
    }
    if (it.tag && ['fact', 'decision'].includes(it.kind)) data.plan.push({ id: `P-${data.plan.length + 1}`, item: it.id, what: it.text, tag: it.kind === 'decision' ? 'decision' : it.tag, pins: [] });
    report.items += 1;
    return it;
  };
  for (const u of legacy.unknowns || []) {
    const it = add(u, null);
    idMap[u.id] = it.id;
    for (const a of u.aliases || []) {
      const ai = add({ id: a.id, text: a.text, impact: u.impact }, u);
      idMap[a.id] = ai.id;
    }
  }
  for (const e of data.evidence) if (e.item === null) e.item = null;
  // the answers.json lines no issue claimed: still the user's words
  const answers = readJson(jobPaths(root, state.id).answers, []) || [];
  for (const a of answers) if (a.answer && !data.words.some((w) => w.text === String(a.answer).trim())) C.addWord(data, a.answer, 'migration');
  // a denial since the last approval: a redirect, read back after the read-back
  const approvedAt = (g) => (state.approvals && state.approvals[g] ? state.approvals[g].at : '');
  const denials = (state.denials || []).filter((d) => ['H1', 'EH1'].includes(d.gate) && d.at > approvedAt(d.gate));
  if (denials.length) {
    const d = denials[denials.length - 1];
    const R = C.startRedirect(data, d.reason || '(no reason given)', 'denial', d.gate);
    R.status = 'queued';
    data.denials_seen = d.at;
    report.redirect = R.id;
  }
  data.stage = 'readback';
  report.summary = `${report.items} item(s) (${report.aliases_split} folded alias(es) made their own items again), ${report.answered} answered by you, ${report.accepted} accepted defaults, ${report.assumed} assumed without asking, ${report.deferred} deferred to design, ${report.dropped} dropped, ${report.open} still open, ${report.evidence} finding(s) to re-check against the confirmed versions${report.redirect ? `; your last denial is ${report.redirect}, read back after this` : ''}`;
  data.migration = report;
  data.history.push({ at: nowIso(), stage: 'readback', event: 'migrated', text: report.summary });
  return data;
}

// For ground and decide on a job approved under v2: what clarify handed to design.
function legacyDeferredText(data) {
  const d = (data && Array.isArray(data.unknowns) ? data.unknowns : []).filter((u) => u.status === 'deferred_to_design');
  if (!d.length) return '';
  return ['- Deferred to design by clarify (implementation detail: settle these here, cite your sources; they did not block H1):', ...d.map((u) => `  - ${u.id} [${u.kind}] ${clip(u.text, 200)}${u.aliases && u.aliases.length ? ` (also raised as ${u.aliases.map((a) => a.id).join(', ')})` : ''}`)].join('\n');
}

module.exports = { migrate, legacyDeferredText, shape };
