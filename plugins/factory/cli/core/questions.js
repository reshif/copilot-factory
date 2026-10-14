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

module.exports = { CATEGORIES, FOCUS_CATEGORY, budget, shape, askedList, key };
