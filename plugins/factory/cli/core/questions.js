'use strict';
// The clarify question protocol, enforced by the CLI (the workflow applies the same
// rules first; record re-applies them, so a judge can't talk its way past them):
// intent first and alone, then scope > constraint > acceptance; a per-round budget;
// never re-ask; every question carries an id, a category, why, and a default.

const CATEGORIES = ['intent', 'scope', 'constraint', 'acceptance'];
const FOCUS_CATEGORY = { intent: 'intent', ambiguity: 'scope', scope: 'scope', constraints: 'constraint', constraint: 'constraint', testability: 'acceptance', acceptance: 'acceptance' };

// Round r (1-based): early rounds get early_questions, later ones later_questions,
// the last allowed round none (record assumptions instead).
function budget(cfg, round, L) {
  if (round >= L.max_intent_rounds) return 0;
  return round <= cfg.limits.early_rounds ? cfg.limits.early_questions : cfg.limits.later_questions;
}

const key = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function category(q) {
  const c = String((q && (q.category || q.focus)) || '').toLowerCase();
  return CATEGORIES.includes(c) ? c : FOCUS_CATEGORY[c] || 'scope';
}

// Everything already asked or answered, as text (answers.json may hold ground's questions too).
function askedList(state, answers = []) {
  return [...new Set([...(state.asked_questions || []), ...answers.map((a) => a.question).filter(Boolean)])];
}

// -> { questions, held, dropped }. held = lower categories kept back while intent is open.
function shape(list, { budget: max = Infinity, asked = [], startId = 0 } = {}) {
  const seen = new Set(asked.map(key));
  const dropped = [];
  const ok = [];
  for (const q of list || []) {
    if (!q || !q.question) continue;
    const k = key(q.question);
    if (seen.has(k)) { dropped.push({ question: q.question, reason: 'already asked' }); continue; }
    seen.add(k);
    ok.push({
      question: String(q.question).trim(),
      category: category(q),
      why: String(q.why || '').trim(),
      default: String(q.default || '').trim() || (category(q) === 'intent' ? 'None: the factory will not guess the intent' : 'None given: answer needed'),
      ...(Array.isArray(q.options) && q.options.length ? { options: q.options.slice(0, 5).map(String) } : {}),
      ...GROUNDED_FIELDS.reduce((o, k) => (q[k] !== undefined ? { ...o, [k]: q[k] } : o), {}),
    });
  }
  const intentOpen = ok.some((q) => q.category === 'intent');
  const held = intentOpen ? ok.filter((q) => q.category !== 'intent') : [];
  const pick = (intentOpen ? ok.filter((q) => q.category === 'intent') : ok).map((q, i) => ({ q, i }))
    .sort((a, b) => CATEGORIES.indexOf(a.q.category) - CATEGORIES.indexOf(b.q.category) || a.i - b.i).map((x) => x.q);
  for (const q of pick.slice(max)) dropped.push({ question: q.question, reason: 'over budget' });
  const questions = pick.slice(0, max).map((q, i) => ({ id: `Q-${startId + i + 1}`, ...q }));
  return { questions, held, dropped, intent_open: intentOpen };
}

// Grounded intent: every question names the unknown (U-n) it is for, and its default
// either cites evidence (E-n) or is explicitly the user's preference ("your call").
//   - a question for a repo or world unknown that research already settled (an evidence-
//     backed assumption) is not asked: it is dropped as researchable
//   - a repo or world question research could not settle is asked, marked researchable,
//     with the reason (web off, unverified, contradicted, nothing found, budget spent)
//   - no unknown named (or an unknown that doesn't exist): recorded as a new unknown of the
//     question's kind (user when it says none) and flagged
//   - evidence ids that don't exist are removed; no evidence and no preference flag: the
//     question is shown as the user's call and flagged
// data: the intent record (cli/core/intent.js). -> { questions, researchable, flagged, created }
const GROUNDED_FIELDS = ['unknown', 'kind', 'evidence', 'preference', 'researchable', 'note'];
const KINDS = ['repo', 'world', 'decision', 'user'];

function ground(list, data) {
  const unknowns = (data && data.unknowns) || [];
  const evidence = new Set(((data && data.evidence) || []).map((e) => e.id));
  const byId = Object.fromEntries(unknowns.map((u) => [u.id, u]));
  let n = unknowns.reduce((m, u) => Math.max(m, Number(String(u.id).replace('U-', '')) || 0), 0);
  const out = [];
  const researchable = [];
  const flagged = [];
  const created = [];
  for (const q of list || []) {
    if (!q || !q.question) continue;
    const ref = String(q.unknown || '').trim().toUpperCase();
    let u = byId[ref];
    if (!u) {
      const kind = KINDS.includes(q.kind) ? q.kind : 'user';
      n += 1;
      u = { id: `U-${n}`, text: String(q.question).slice(0, 400), kind, impact: 'high', draft: String(q.question).slice(0, 400), research: kind === 'repo' ? 'repo' : kind === 'world' ? 'web' : 'none', resolution: 'question', evidence: [], assumption: null, question_id: null, answer: null, note: ['repo', 'world'].includes(kind) ? 'raised in clarify after research ran; not researched' : null, researched: false, source: 'judge', round: null };
      byId[u.id] = u;
      created.push(u);
      flagged.push({ question: q.question, unknown: u.id, reason: ref ? `names ${ref}, which is not a mapped unknown: recorded as new ${kind} unknown ${u.id}` : `names no unknown: recorded as new ${kind} unknown ${u.id}` });
    }
    const research = ['repo', 'world'].includes(u.kind);
    if (research && u.resolution === 'assumption') {
      researchable.push({ question: q.question, unknown: u.id, evidence: u.evidence || [], assumption: u.assumption || null, reason: `research answered it${u.assumption ? ` (${u.assumption})` : ''}` });
      continue;
    }
    const ev = [...new Set((Array.isArray(q.evidence) ? q.evidence : []).map((e) => String(e).toUpperCase()).filter((e) => evidence.has(e)))];
    let preference = q.preference === true;
    if (!ev.length && !preference) {
      preference = true;
      flagged.push({ question: q.question, unknown: u.id, reason: 'default cites no evidence and was not marked a preference: shown as your call' });
    }
    out.push({ ...q, unknown: u.id, kind: u.kind, evidence: ev, preference, ...(research ? { researchable: true, note: u.note || 'research did not settle it' } : {}) });
  }
  return { questions: out, researchable, flagged, created };
}

module.exports = { CATEGORIES, FOCUS_CATEGORY, budget, shape, ground, askedList, key, GROUNDED_FIELDS };
