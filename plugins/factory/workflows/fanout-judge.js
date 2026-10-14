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
function opts(spec, label, model) {
  if (!spec || !/^factory:[a-z-]+$/.test(spec.agent_type || '')) throw new Error(`Brief item "${label}" has no factory agent_type`)
  const o = { schema: spec.schema, label, agentType: spec.agent_type }
  const m = model || spec.model
  if (m) o.model = m
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
async function one(prompt, spec, label) {
  runs += 1
  let r = await call(prompt, opts(spec, label))
  if (!r) {
    runs += 1
    r = await call(prompt, opts(spec, `${label} (retry)`))
  }
  return r || null
}
async function fan(items) {
  if (!items.length) return []
  runs += items.length
  const first = await pipeline(items, (it) => call(it.prompt, opts(it, it.label)))
  const out = first.slice()
  const failed = items.map((it, i) => (out[i] ? null : i)).filter((i) => i !== null)
  if (failed.length) {
    runs += failed.length
    const again = await pipeline(failed.map((i) => items[i]), (it) => call(it.prompt, opts(it, `${it.label} (retry)`)))
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
const degradedNow = (held) => brief.fanout.filter((f, i) => !outs[i] && !held.includes(f)).map((f) => f.id)

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
  const judgeOnce = (note) => one(`${brief.judge.prompt}${note}\n\nINPUTS:\n${JSON.stringify(inputsNow(), null, 2)}`, brief.judge, 'judge')
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
  const degraded = degradedNow(held)
  const inputs = inputsNow()
  if (degraded.length) log(`No result after retry: ${degraded.join(', ')}`)
  if (!judge) return envelope('error', 'The judge returned nothing twice.', { analysts: inputs, degraded })
  const shaped = shape(judge.questions)
  judge = { ...judge, questions: shaped.questions, held: [...(judge.held || []), ...shaped.held.map((q) => ({ question: q.question, category: q.category }))], over_budget_or_repeat: shaped.dropped }
  let critique = null
  if (shaped.questions.length === 0 && !shaped.intent_open && (degraded.length === 0 || brief.accept_degraded)) {
    phase('clarify: God Eye (intent)')
    critique = await one(brief.critique.prompt, brief.critique, 'god-eye · intent')
  }
  const approved = critique && critique.verdict === 'approve' && critique.intent_confirmed !== false
  const status = degraded.length && !brief.accept_degraded ? 'degraded' : shaped.questions.length ? 'needs_user' : approved ? 'ok' : 'needs_user'
  const summary = degraded.length
    ? `Missing angle(s): ${degraded.join(', ')}.`
    : shaped.questions.length
      ? `${shaped.questions.length} ${shaped.intent_open ? 'intent ' : ''}question(s) for you.${held.length ? ` Held until intent is clear: ${held.map((f) => f.id).join(', ')}.` : ''}`
      : critique ? `God Eye: ${critique.verdict}${critique.intent_confirmed === false ? ' (intent not confirmed)' : ''}.` : 'No critique.'
  return envelope(status, summary, { analysts: inputs, degraded, intent_open: shaped.intent_open || (intentOpen && held.length > 0), held_back: held.map((f) => f.id), judge, critique }, { questions: shaped.questions })
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
