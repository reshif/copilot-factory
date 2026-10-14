export const meta = {
  name: 'fanout-judge',
  description: 'Software Factory engine for clarify, decide and challenge: N independent agents in parallel, retry once, a judge merges, an optional cold critique, and per-finding verifiers. Pass the JSON brief from `factory wfargs fanout-judge --config <clarify|decide|challenge>` as args.',
}

// ---- brief (from the factory CLI; workflows cannot read files or run commands) ----
const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'fanout-judge') throw new Error('fanout-judge needs the JSON brief from `factory wfargs fanout-judge --config …` as its args')
  return a
})()

// Every agent runs as its real factory agent (agents/<role>.md): its system prompt,
// tool limits and model apply. The brief names it; a missing one is a broken brief.
function opts(spec, label, model, timeoutSec) {
  if (!spec || !/^factory:[a-z-]+$/.test(spec.agent_type || '')) throw new Error(`Brief item "${label}" has no factory agent_type`)
  const o = { schema: spec.schema, label, agentType: spec.agent_type }
  const m = model || spec.model
  if (m) o.model = m
  // A time cap counted from the call (the runner skips an agent whose budget ran out while it queued).
  if (timeoutSec) o.timeoutSec = timeoutSec
  return o
}

// Every agent call is noted in the envelope's roster, so the console can show which
// factory agents ran, on which model, and how each one came back.
const roster = []
async function call(prompt, o) {
  const r = await agent(prompt, o)
  const outcome = !r ? 'no_result' : r.status || (typeof r.pass === 'boolean' ? (r.pass ? 'pass' : 'fail') : r.verdict || 'ok')
  roster.push({ label: o.label, agent_type: o.agentType, model: o.model || null, retry: /\(retry\)$/.test(o.label), outcome })
  return r
}

let runs = 0
async function one(prompt, spec, label, timeoutSec) {
  runs += 1
  let r = await call(prompt, opts(spec, label, null, timeoutSec))
  if (!r) {
    runs += 1
    r = await call(prompt, opts(spec, `${label} (retry)`, null, timeoutSec))
  }
  return r || null
}
async function fan(items) {
  if (!items.length) return []
  runs += items.length
  const first = await pipeline(items, (it) => call(`${it.prompt}${brief.config === 'clarify' ? evidenceBlock() : ''}`, opts(it, it.label)))
  const out = first.slice()
  const failed = items.map((it, i) => (out[i] ? null : i)).filter((i) => i !== null)
  if (failed.length) {
    runs += failed.length
    const again = await pipeline(failed.map((i) => items[i]), (it) => call(`${it.prompt}${brief.config === 'clarify' ? evidenceBlock() : ''}`, opts(it, `${it.label} (retry)`)))
    failed.forEach((idx, k) => { out[idx] = again[k] || null })
  }
  return out
}
function envelope(status, summary, data, extra = {}) {
  return {
    workflow: 'fanout-judge',
    config: brief.config,
    mode: brief.mode || null,
    job: brief.job,
    status,
    next_gate: null,
    input_hash: brief.input_hash,
    agents: roster,
    budgets: { used: { agent_runs: runs }, limit: (brief.budgets && brief.budgets.limit) || {} },
    artifacts: [],
    questions: [],
    park_reason: null,
    summary,
    data,
    ...extra,
  }
}

// ---- 0. clarify scout phase: research first, ask only what research can't answer ----
// intent-mapper → unknowns (U-n: kind repo|world|decision|user, impact high|medium|low)
// → repo and web scouts (researcher role) in parallel, within the risk budget (no retry:
// a scout that fails or runs out of time leaves its unknowns unverified, to be asked)
// → verifier on high-impact and web findings (E-n) → sort: confirmed → evidence-backed
// assumption (A-n); contradicted / unverified / not researched → question; user and
// decision → question. `factory record` re-checks and re-sorts all of it.
const SC = brief.config === 'clarify' && brief.scout ? brief.scout : null
const KINDS = ['repo', 'world', 'decision', 'user']
const IMPACTS = ['high', 'medium', 'low']
const IRANK = { high: 0, medium: 1, low: 2 }
let scout = null
function scoutState() {
  const P = SC.prior || {}
  const ids = SC.next_ids || { U: 0, E: 0, A: 0 }
  return {
    ran: true,
    round: SC.round || brief.round || null,
    web: { enabled: Boolean(SC.web && SC.web.enabled), reason: (SC.web && SC.web.reason) || null, available: null, search_mcp: (SC.web && SC.web.search_mcp) || null },
    map: { ran: false, ok: null },
    unknowns: (P.unknowns || []).map((u) => ({ ...u })),
    evidence: (P.evidence || []).map((e) => ({ ...e })),
    assumptions: (P.assumptions || []).filter((a) => !a.dropped).map((a) => ({ ...a })),
    versions: (P.versions || []).slice(),
    scouts: [],
    verifiers: 0,
    degraded: [],
    used: { repo: 0, web: 0 },
    budget: SC.budget || {},
    ids: { U: ids.U || 0, E: ids.E || 0, A: ids.A || 0 },
  }
}
const ukey = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
function addUnknown(raw, source) {
  if (!raw || !(raw.text || raw.question)) return null
  const text = String(raw.text || raw.question)
  const dup = scout.unknowns.find((u) => ukey(u.text) === ukey(text))
  if (dup) return dup
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'user'
  scout.ids.U += 1
  const u = {
    id: `U-${scout.ids.U}`, text, kind,
    impact: IMPACTS.includes(raw.impact) ? raw.impact : 'high',
    draft: String(raw.draft || text),
    ...(Array.isArray(raw.options) && raw.options.length ? { options: raw.options.slice(0, 5) } : {}),
    research: ['repo', 'web', 'none'].includes(raw.research) ? raw.research : kind === 'repo' ? 'repo' : kind === 'world' ? 'web' : 'none',
    ...(raw.search ? { search: String(raw.search) } : {}),
    ...(raw.why ? { why: String(raw.why) } : {}),
    resolution: 'pending', evidence: [], assumption: null, question_id: null, answer: null, note: null, researched: false,
    source, round: scout.round,
  }
  scout.unknowns.push(u)
  return u
}
// Where an unknown is researched: repo / web, or null (not researchable, or low impact).
function lane(u) {
  if (u.impact === 'low') return null
  if (u.kind === 'repo') return 'repo'
  if (u.kind === 'world') return 'web'
  if (u.kind === 'decision' && (u.research === 'repo' || u.research === 'web')) return u.research
  return null
}
function usable(e, u) {
  if (!e || e.verdict === 'contradicted' || e.verdict === 'unverified') return false
  if (e.verdict === 'confirmed') return true
  return e.scout === 'repo' && u.impact !== 'high' && e.confidence !== 'low'
}
function sortUnknowns() {
  for (const u of scout.unknowns) {
    const evs = scout.evidence.filter((e) => e.unknown === u.id)
    u.evidence = evs.map((e) => e.id)
    const a = scout.assumptions.find((x) => x.unknown === u.id)
    if (a && a.overridden) { u.resolution = 'assumption'; u.assumption = a.id; continue }
    if (['answered', 'dismissed', 'dropped'].includes(u.resolution)) continue
    const good = evs.filter((e) => usable(e, u))
    let res
    if (u.kind === 'user') res = 'question'
    else if (u.kind === 'decision') res = u.impact === 'low' && !evs.length ? 'deferred' : 'question'
    else if (good.length) res = 'assumption'
    else if (u.impact === 'low' && !evs.length) res = 'deferred'
    else if (u.resolution === 'pending' && !u.researched) res = 'pending'
    else res = 'question'
    if (res === 'question' && evs.length && !good.length && !u.note) {
      u.note = evs.some((e) => e.verdict === 'contradicted') ? `sources disagree (${evs.map((e) => `${e.id} ${e.verdict}`).join(', ')})` : `research did not confirm it (${evs.map((e) => `${e.id} ${e.verdict}`).join(', ')})`
    }
    if (res === 'deferred' && !u.note) u.note = 'low impact: assumed, not researched'
    u.resolution = res
    if (res === 'assumption') {
      const statement = good.map((e) => e.claim).join('; ')
      if (a) Object.assign(a, { statement, evidence: good.map((e) => e.id) })
      else {
        scout.ids.A += 1
        scout.assumptions.push({ id: `A-${scout.ids.A}`, unknown: u.id, statement, evidence: good.map((e) => e.id) })
      }
      u.assumption = (a || scout.assumptions[scout.assumptions.length - 1]).id
    } else if (a) {
      scout.assumptions = scout.assumptions.filter((x) => x !== a)
      u.assumption = null
    }
  }
}
// Research these unknowns: group them onto scouts within what is left of the budget.
async function research(list, why) {
  const B = scout.budget
  const per = B.unknowns_per_scout || 3
  const plan = []
  for (const kind of ['repo', 'web']) {
    const mine = list.filter((u) => lane(u) === kind).sort((a, b) => IRANK[a.impact] - IRANK[b.impact])
    if (!mine.length) continue
    if (kind === 'web' && !scout.web.enabled) {
      mine.forEach((u) => { u.researched = false; u.resolution = 'question'; u.note = `not researched (web off${scout.web.reason ? `: ${scout.web.reason}` : ''})` })
      continue
    }
    const cap = kind === 'repo' ? B.repo_scouts || 0 : B.web_scouts || 0
    const n = Math.min(Math.max(0, cap - scout.used[kind]), Math.ceil(mine.length / per))
    const groups = Array.from({ length: n }, () => [])
    mine.slice(0, n * per).forEach((u, i) => groups[i % n].push(u))
    mine.slice(n * per).forEach((u) => { u.researched = false; u.resolution = 'question'; u.note = `not researched (${kind} research budget spent)` })
    groups.forEach((g) => { scout.used[kind] += 1; plan.push({ kind, unknowns: g, label: `scout · ${kind} #${scout.used[kind]}` }) })
  }
  if (!plan.length) return
  phase(`clarify: scout · research ${plan.reduce((k, p) => k + p.unknowns.length, 0)} unknown(s) with ${plan.length} scout(s)${why ? ` (${why})` : ''}`)
  runs += plan.length
  const slim = (u) => ({ id: u.id, text: u.text, kind: u.kind, impact: u.impact, claim_to_check: u.draft, ...(u.options ? { options: u.options } : {}), ...(u.search ? { start_at: u.search } : {}) })
  const outs = await pipeline(plan, (p) => {
    const spec = p.kind === 'repo' ? SC.repo_scout : SC.web_scout
    return call(spec.prompt_template.replace('{{unknowns}}', JSON.stringify(p.unknowns.map(slim), null, 2)), opts(spec, p.label, null, scout.budget.time_sec))
  })
  const fresh = []
  plan.forEach((p, i) => {
    const o = outs[i]
    scout.scouts.push({ label: p.label, mode: p.kind, unknowns: p.unknowns.map((u) => u.id), outcome: o ? 'ok' : 'no_result' })
    p.unknowns.forEach((u) => { u.researched = true })
    if (!o) {
      scout.degraded.push(p.label)
      p.unknowns.forEach((u) => { u.note = `not verified: the ${p.kind} scout failed or ran out of time` })
      return
    }
    if (p.kind === 'web') {
      if (o.web_available === false) {
        scout.web.available = false
        p.unknowns.forEach((u) => { u.note = 'not verified: no web access (no network or no web tool)' })
      } else if (scout.web.available === null) scout.web.available = true
    }
    for (const v of o.versions || []) if (v && v.name && !scout.versions.some((x) => x.name === v.name)) scout.versions.push(v)
    const mine = new Set(p.unknowns.map((u) => u.id))
    for (const e of o.evidence || []) {
      if (!e || !mine.has(e.unknown)) continue
      if (p.kind === 'web' && o.web_available === false) continue
      scout.ids.E += 1
      const ev = { id: `E-${scout.ids.E}`, ...e, scout: p.kind, verdict: 'unchecked', round: scout.round }
      scout.evidence.push(ev)
      fresh.push(ev)
    }
    for (const r of o.unresolved || []) {
      const u = p.unknowns.find((x) => x.id === r.unknown)
      if (u && !scout.evidence.some((e) => e.unknown === u.id)) u.note = `research found nothing conclusive: ${r.reason}`
    }
  })
  await verify(fresh)
  sortUnknowns()
}
// The verifier re-checks web findings and high-impact ones; strict (high risk): a confirmed
// high-impact finding without a second independent source stays unverified.
async function verify(list) {
  const B = scout.budget
  const byU = Object.fromEntries(scout.unknowns.map((u) => [u.id, u]))
  const todo = list.filter((e) => e.scout === 'web' || (byU[e.unknown] && byU[e.unknown].impact === 'high'))
  if (!todo.length || !SC.verifier) return
  const size = B.verifier_batch || 4
  const batches = []
  for (let i = 0; i < todo.length && batches.length < (B.max_verifiers || 2); i += size) batches.push(todo.slice(i, i + size))
  todo.slice(batches.length * size).forEach((e) => { e.verdict_reason = 'not re-checked (verifier budget spent)' })
  phase(`clarify: scout · verify ${batches.reduce((k, b) => k + b.length, 0)} finding(s)`)
  runs += batches.length
  const labels = batches.map(() => { scout.verifiers += 1; return `verify evidence #${scout.verifiers}` })
  const jobs = batches.map((b, i) => ({ b, label: labels[i] }))
  const outs = await pipeline(jobs, (j) => call(SC.verifier.prompt_template.replace('{{findings}}', JSON.stringify({ findings: j.b.map((e) => ({ ...e, impact: (byU[e.unknown] || {}).impact || null })), versions: scout.versions }, null, 2)), opts(SC.verifier, j.label, null, B.time_sec)))
  batches.forEach((b, i) => {
    const o = outs[i]
    if (!o) {
      scout.degraded.push(labels[i])
      b.forEach((e) => { e.verdict = e.scout === 'web' ? 'unverified' : e.verdict; e.verdict_reason = 'the verifier failed or ran out of time' })
      return
    }
    for (const v of o.verdicts || []) {
      const e = b.find((x) => x.id === v.evidence_id)
      if (!e) continue
      e.verdict = ['confirmed', 'contradicted', 'unverified'].includes(v.verdict) ? v.verdict : 'unverified'
      if (v.quote_found === false && e.verdict === 'confirmed') e.verdict = 'unverified'
      if (v.version_applies === false && e.verdict === 'confirmed') e.verdict = 'unverified'
      e.verdict_confidence = v.confidence || null
      e.verdict_reason = v.reason || null
      e.second_source = v.second_source || null
      e.counter_source = v.counter_source || null
      const u = byU[e.unknown]
      if (B.strict_second_source && u && u.impact === 'high' && e.verdict === 'confirmed' && !(v.second_source && v.second_source.source)) {
        e.verdict = 'unverified'
        e.verdict_reason = `${v.reason || ''} (high risk: no independent second source)`.trim()
      }
    }
    b.filter((e) => e.verdict === 'unchecked' && e.scout === 'web').forEach((e) => { e.verdict = 'unverified'; e.verdict_reason = 'the verifier gave no verdict' })
  })
}
async function scoutPhase() {
  scout = scoutState()
  if (SC.map_needed) {
    phase('clarify: scout · map the unknowns')
    const m = await one(SC.mapper.prompt, SC.mapper, 'intent map', (SC.budget && SC.budget.mapper_sec) || null)
    scout.map = { ran: true, ok: Boolean(m) }
    if (!m) scout.degraded.push('intent-mapper')
    else for (const u of (m.unknowns || []).slice(0, (SC.budget && SC.budget.max_unknowns) || 12)) addUnknown(u, 'mapper')
  }
  const pend = new Set(SC.pending || [])
  const todo = scout.unknowns.filter((u) => (u.resolution === 'pending' || pend.has(u.id)) && lane(u))
  await research(todo, '')
  sortUnknowns()
}
// What the analysts, the judge and God Eye are given: the research, and what must be asked.
function openUnknowns() {
  return scout.unknowns.filter((u) => u.resolution === 'question' && !u.question_id && u.impact !== 'low').map((u) => ({
    unknown: u.id, kind: u.kind, impact: u.impact, ask: u.draft, ...(u.options ? { options: u.options } : {}), evidence: u.evidence, note: u.note || null,
    preference: u.kind === 'user' || !u.evidence.length,
  }))
}
function evidenceBlock() {
  if (!scout) return ''
  const view = {
    rules: 'Research came first. Never ask what an assumption or confirmed evidence answers. Every question names its unknown (U-n) and either cites evidence (E-n) for its default or is preference: true ("your call"). Ask a repo or world unknown only when research could not settle it, and say why.',
    web_research: scout.web,
    versions: scout.versions,
    findings: scout.evidence.map((e) => ({ id: e.id, unknown: e.unknown, claim: e.claim, source: e.source, source_tier: e.source_tier, retrieved_at: e.retrieved_at || null, applies_to_version: e.applies_to_version || null, confidence: e.confidence, verdict: e.verdict })),
    assumptions: scout.assumptions.map((a) => ({ id: a.id, unknown: a.unknown, statement: a.statement, evidence: a.evidence, ...(a.overridden ? { overridden_by_user: true } : {}) })),
    must_ask: openUnknowns(),
    unknowns: scout.unknowns.map((u) => ({ id: u.id, text: u.text, kind: u.kind, impact: u.impact, resolution: u.resolution, ...(u.note ? { note: u.note } : {}) })),
  }
  return `\n\nINTENT EVIDENCE:\n${JSON.stringify(view, null, 2)}`
}
// Apply the question rules here too (record re-applies them): drop questions research has
// answered; a question about a new repo/world unknown is researched first, once, if budget is left.
function groundQuestions(list) {
  const keep = []
  const researchable = []
  const fresh = []
  for (const q of list || []) {
    if (!q || !q.question) continue
    let u = scout.unknowns.find((x) => x.id === String(q.unknown || '').toUpperCase())
    if (!u && ['repo', 'world'].includes(q.kind)) {
      u = addUnknown({ text: q.question, kind: q.kind, impact: 'high', draft: q.question }, 'judge')
      if (u.resolution === 'pending' && !u.researched) fresh.push(u)
    }
    if (u && ['repo', 'world'].includes(u.kind) && u.resolution === 'assumption') {
      researchable.push({ question: q.question, unknown: u.id, evidence: u.evidence, reason: `research answered it (${u.assumption})` })
      continue
    }
    keep.push(u ? { ...q, unknown: u.id, kind: u.kind } : q)
  }
  return { keep, researchable, fresh }
}
const budgetLeft = (kind) => (kind === 'repo' ? (scout.budget.repo_scouts || 0) - scout.used.repo : scout.web.enabled ? (scout.budget.web_scouts || 0) - scout.used.web : 0)
if (SC) await scoutPhase()

// ---- 1. fan-out (clarify: the intent gate runs first and alone) ----
const gate = brief.config === 'clarify' ? brief.fanout.filter((f) => f.gate || f.category === 'intent') : []
const rest = brief.fanout.filter((f) => !gate.includes(f))
const outs = brief.fanout.map(() => null)
const put = (list, res) => list.forEach((f, i) => { outs[brief.fanout.indexOf(f)] = res[i] || null })
if (gate.length) {
  phase(`clarify: intent gate (${gate.length})`)
  put(gate, await fan(gate))
}
const intentOpen = gate.some((f) => { const o = outs[brief.fanout.indexOf(f)]; return Boolean(o && (o.questions || []).some((q) => q.blocking)) })
async function fanRest() {
  if (!rest.length) return
  phase(`${brief.config}: fan-out (${rest.length})`)
  put(rest, await fan(rest))
}
if (!intentOpen) await fanRest()
else log(`Intent is not clear yet: holding back ${rest.map((f) => f.id).join(', ')}`)
const inputsNow = () => brief.fanout.map((f, i) => ({ id: f.id, ...(f.category ? { category: f.category } : {}), output: outs[i] })).filter((x) => x.output)
const degradedNow = (held) => [...(scout && scout.degraded.includes('intent-mapper') ? ['intent-mapper'] : []), ...brief.fanout.filter((f, i) => !outs[i] && !held.includes(f)).map((f) => f.id)]

// ---- clarify question protocol (factory record re-applies it): intent first and alone,
// then scope > constraint > acceptance; never re-ask; at most limits.max_questions.
const PRI = (brief.limits && brief.limits.priority) || ['intent', 'scope', 'constraint', 'acceptance']
function shape(list) {
  const key = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const seen = new Set((brief.asked || []).map(key))
  const dropped = []
  const ok = []
  for (const q of list || []) {
    if (!q || !q.question) continue
    if (seen.has(key(q.question))) { dropped.push({ question: q.question, reason: 'already asked' }); continue }
    seen.add(key(q.question))
    ok.push({ ...q, category: PRI.includes(q.category) ? q.category : 'scope' })
  }
  const open = ok.some((q) => q.category === 'intent')
  const held = open ? ok.filter((q) => q.category !== 'intent') : []
  const pick = (open ? ok.filter((q) => q.category === 'intent') : ok).map((q, i) => ({ q, i })).sort((a, b) => PRI.indexOf(a.q.category) - PRI.indexOf(b.q.category) || a.i - b.i).map((x) => x.q)
  const max = brief.limits && typeof brief.limits.max_questions === 'number' ? brief.limits.max_questions : pick.length
  pick.slice(max).forEach((q) => dropped.push({ question: q.question, reason: 'over budget' }))
  return { questions: pick.slice(0, max), held, dropped, intent_open: open }
}

// ---- 2. config-specific ----
if (brief.config === 'clarify') {
  const judgeOnce = (note, label = 'judge') => one(`${brief.judge.prompt}${note}${evidenceBlock()}\n\nINPUTS:\n${JSON.stringify(inputsNow(), null, 2)}`, brief.judge, label)
  phase('clarify: judge')
  let judge = await judgeOnce(intentOpen ? '\n\nINTENT GATE: the intent is not clear yet, so the other angles were held back. Ask only intent questions this round.' : '')
  let held = intentOpen ? rest : []
  if (judge && intentOpen && !shape(judge.questions).intent_open) {
    // the judge found the intent clear after all: run the held angles and judge again
    held = []
    await fanRest()
    phase('clarify: judge (all angles)')
    judge = await judgeOnce('')
  }
  // Research before asking: a question about a new repo/world unknown goes to the scouts
  // first (once, within the budget), then the judge sees the evidence.
  let researchable = []
  if (judge && scout) {
    const g = groundQuestions(judge.questions)
    const go = g.fresh.filter((u) => budgetLeft(lane(u)) > 0)
    if (go.length) {
      await research(go, 'raised by the judge')
      phase('clarify: judge (with the new evidence)')
      const again = await judgeOnce('\n\nNEW EVIDENCE: some of your questions were researched; do not ask what the evidence below now answers.', 'judge (after research)')
      if (again) judge = again
    }
    const g2 = groundQuestions(judge.questions)
    researchable = [...g.researchable.filter((r) => !g2.researchable.some((x) => x.question === r.question)), ...g2.researchable]
    judge = { ...judge, questions: g2.keep }
  }
  const degraded = degradedNow(held)
  const inputs = inputsNow()
  if (degraded.length) log(`No result after retry: ${degraded.join(', ')}`)
  if (!judge) return envelope('error', 'The judge returned nothing twice.', { analysts: inputs, degraded })
  const shaped = shape(judge.questions)
  judge = { ...judge, questions: shaped.questions, held: [...(judge.held || []), ...shaped.held.map((q) => ({ question: q.question, category: q.category }))], over_budget_or_repeat: shaped.dropped }
  let critique = null
  if (shaped.questions.length === 0 && !shaped.intent_open && (degraded.length === 0 || brief.accept_degraded)) {
    phase('clarify: God Eye (intent)')
    critique = await one(`${brief.critique.prompt}${evidenceBlock()}`, brief.critique, 'god-eye · intent')
    // God Eye sends researchable questions back to the scouts (once, within the budget).
    const rq = (critique && critique.researchable_questions) || []
    if (scout && rq.length) {
      const fresh = rq.map((q) => addUnknown({ text: q.question, kind: q.kind, impact: 'high', draft: q.question, why: q.why }, 'god-eye')).filter((u) => u && u.resolution === 'pending' && !u.researched)
      const go = fresh.filter((u) => budgetLeft(lane(u)) > 0)
      if (go.length) {
        await research(go, 'sent back by God Eye')
        phase('clarify: God Eye (intent, with the new evidence)')
        const again = await one(`${brief.critique.prompt}${evidenceBlock()}\n\nNEW EVIDENCE: your researchable questions were researched; list only what is still open.`, brief.critique, 'god-eye · intent (after research)')
        if (again) critique = again
      }
    }
  }
  const approved = critique && critique.verdict === 'approve' && critique.intent_confirmed !== false && !((critique.researchable_questions || []).length)
  const status = degraded.length && !brief.accept_degraded ? 'degraded' : shaped.questions.length ? 'needs_user' : approved ? 'ok' : 'needs_user'
  const summary = degraded.length
    ? `Missing angle(s): ${degraded.join(', ')}.`
    : shaped.questions.length
      ? `${shaped.questions.length} ${shaped.intent_open ? 'intent ' : ''}question(s) for you.${held.length ? ` Held until intent is clear: ${held.map((f) => f.id).join(', ')}.` : ''}`
      : critique ? `God Eye: ${critique.verdict}${critique.intent_confirmed === false ? ' (intent not confirmed)' : ''}${(critique.researchable_questions || []).length ? ` (${critique.researchable_questions.length} researchable question(s))` : ''}.` : 'No critique.'
  const scoutData = scout ? { ...scout, open: openUnknowns(), researchable_dropped: researchable } : null
  const researchNote = scout ? ` Research: ${scout.unknowns.length} unknown(s), ${scout.evidence.length} finding(s), ${scout.assumptions.length} assumption(s)${scout.degraded.length ? `, degraded: ${scout.degraded.join(', ')}` : ''}.` : ''
  return envelope(status, `${summary}${researchNote}`, { analysts: inputs, degraded, intent_open: shaped.intent_open || (intentOpen && held.length > 0), held_back: held.map((f) => f.id), judge, critique, ...(scoutData ? { scout: scoutData } : {}) }, { questions: shaped.questions })
}

const degraded = degradedNow([])
const inputs = inputsNow()
if (degraded.length) log(`No result after retry: ${degraded.join(', ')}`)

if (brief.config === 'decide') {
  phase('decide: architect')
  let design = await one(`${brief.judge.prompt}\n\nINPUTS:\n${JSON.stringify(inputs, null, 2)}`, brief.judge, 'architect')
  if (!design) return envelope('error', 'The architect returned nothing twice.', { options: inputs, degraded })
  const critiques = []
  const max = Math.max(1, brief.critique.max_rounds || 2)
  for (let round = 1; round <= max; round++) {
    phase(`decide: God Eye (design) round ${round}`)
    const c = await one(`${brief.critique.prompt}\n\nINPUTS:\n${JSON.stringify({ design }, null, 2)}`, brief.critique, `god-eye · design #${round}`)
    if (!c) break
    critiques.push(c)
    if (c.verdict === 'approve' || round === max) break
    phase(`decide: architect revises (round ${round})`)
    const revised = await one(`${brief.critique.revise.prompt}\n\nINPUTS:\n${JSON.stringify({ critique: c, your_previous_output: design }, null, 2)}`, brief.critique.revise, `architect · revise #${round}`)
    if (revised) design = revised
  }
  const last = critiques[critiques.length - 1]
  return envelope('ok', `Design: ${design.kind} (${design.paths.join(', ')}). Critique: ${last ? last.verdict : 'none'} after ${critiques.length} round(s).`, { options: inputs, degraded, judge: design, critiques }, { threat_model: Boolean(brief.threat_model) })
}

if (brief.config === 'challenge') {
  const lanes = inputs.map((x) => ({ lane: x.id, findings: x.output.findings || [] }))
  const serious = lanes.flatMap((l) => l.findings.filter((f) => (brief.verifier.severities || ['blocker', 'major']).includes(f.severity)).map((f) => ({ ...f, lane: l.lane })))
  let verifications = []
  if (serious.length) {
    phase(`challenge: verify ${serious.length} finding(s)`)
    const items = serious.map((f) => ({
      prompt: brief.verifier.prompt_template.replace('{{finding}}', JSON.stringify(f, null, 2)),
      schema: brief.verifier.schema,
      agent_type: brief.verifier.agent_type,
      model: brief.verifier.model,
      label: `verify ${f.id}`,
    }))
    const res = await fan(items)
    verifications = res.map((r, i) => (r ? { ...r, finding_id: serious[i].id } : null)).filter(Boolean)
  }
  const confirmed = verifications.filter((v) => v.status === 'confirmed').length
  const summary = `${lanes.length}/${brief.fanout.length} lane(s) reviewed; ${serious.length} serious finding(s), ${confirmed} confirmed.${degraded.length ? ` Missing lanes: ${degraded.join(', ')}.` : ''}`
  return envelope(degraded.length ? 'degraded' : 'ok', summary, { lanes, degraded, verifications }, { fingerprint: brief.fingerprint || null, lanes_requested: brief.lanes_requested || null })
}

throw new Error(`Unknown config ${brief.config}`)
