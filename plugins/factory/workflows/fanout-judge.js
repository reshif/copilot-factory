export const meta = {
  name: 'fanout-judge',
  description: 'Software Factory engine for decide and challenge: N independent agents in parallel, retry once, a judge merges, an optional cold critique, and per-finding verifiers. Pass the JSON brief from `factory wfargs fanout-judge --config <decide|challenge>` as args.',
}

// ---- brief (from the factory CLI; workflows cannot read files or run commands) ----
const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'fanout-judge') throw new Error('fanout-judge needs the JSON brief from `factory wfargs fanout-judge --config …` as its args')
  if (a.config === 'clarify') throw new Error('clarify v3 runs as its own workflow (workflows/clarify.js); fanout-judge --config clarify is retired')
  return a
})()

// Every agent runs as its real factory agent (agents/<role>.md): its system prompt,
// tool limits and model apply. The brief names it; a missing one is a broken brief.
function opts(spec, label, model, timeoutSec, scale) {
  if (!spec || !/^factory:[a-z-]+$/.test(spec.agent_type || '')) throw new Error(`Brief item "${label}" has no factory agent_type`)
  const o = { schema: spec.schema, label, agentType: spec.agent_type }
  const m = model || spec.model
  if (m) o.model = m
  // A time cap counted from the call (the runner skips an agent whose budget ran out while it queued).
  if (timeoutSec) o.timeoutSec = timeoutSec
  // A multiple of the agent time cap (copilot.agent_timeout_seconds), for an agent that ran out of time before.
  if (scale && scale > 1) o.timeoutScale = scale
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
// One agent, retried once when it returns nothing; with `longer`, the retry gets twice the
// time cap (an agent that ran out of time once is given room, not the same wall again).
async function one(prompt, spec, label, timeoutSec, longer = false) {
  runs += 1
  let r = await call(prompt, opts(spec, label, null, timeoutSec))
  if (!r) {
    runs += 1
    r = await call(prompt, opts(spec, `${label} (retry)`, null, timeoutSec && longer ? timeoutSec * 2 : timeoutSec))
  }
  return r || null
}
async function fan(items) {
  if (!items.length) return []
  runs += items.length
  const first = await pipeline(items, (it) => call(`${it.prompt}${ctxBlock()}`, opts(it, it.label, null, null, it.scale)))
  const out = first.slice()
  const failed = items.map((it, i) => (out[i] ? null : i)).filter((i) => i !== null)
  if (failed.length) {
    runs += failed.length
    const again = await pipeline(failed.map((i) => items[i]), (it) => call(`${it.prompt}${ctxBlock()}`, opts(it, `${it.label} (retry)`, null, null, it.retry_scale || it.scale)))
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

const ctxBlock = () => ''

// ---- 1. fan-out ----
if (brief.fanout.length) phase(`${brief.config}: fan-out (${brief.fanout.length})`)
const outs = await fan(brief.fanout)
const inputsNow = () => brief.fanout.map((f, i) => ({ id: f.id, ...(f.category ? { category: f.category } : {}), output: outs[i] })).filter((x) => x.output)
const degradedNow = () => brief.fanout.filter((f, i) => !outs[i]).map((f) => f.id)

// ---- 2. config-specific ----
const degraded = degradedNow()
const inputs = inputsNow()
if (degraded.length) log(`No result after retry: ${degraded.join(', ')}`)

// ---- decide: critics with evidence (0.10.0) ----
// The design is critiqued by God Eye and, when the job has dependency source, the API-conformance
// critic, in parallel. Every serious (blocker/major) item goes to a finding verifier, as review
// findings do in challenge; refuted items cost no revise. An API item must carry evidence (a
// dependency file:line with its quote, or a probe's output); a source quote the CLI cannot find
// at its line does not count as serious. While serious items stay open the architect revises —
// always once more after the last critique, so the gate never shows an unrevised critique — and
// the loop stops when the open set stops shrinking, or at the ceiling. Every stop goes to the
// human gate with the open objections shown; decide never parks on its critique.
// The loop's stop rule is 0.9.0's shared engine (cli/core/loop.js shouldContinue, through
// factory.loop): it goes on while the open set shrinks, escalates to the stronger model when it
// stalls, runs a diagnosis agent before it stops, and stops with a specific question. For the
// design loop a stop never parks: it goes to the gate with the objections and that question.
// Without the factory API (another runtime) a minimal local rule stands in.
function localLoop(state, blockers) {
  const s = state || { rounds: 0, best: null }
  const open = [...new Set(blockers)].sort()
  if (!open.length) return { action: 'done', rule: 'resolved', open, state: s }
  const progress = s.best === null || open.length < s.best
  const next = { rounds: s.rounds + 1, best: Math.min(s.best === null ? Infinity : s.best, open.length) }
  return { action: progress ? 'continue' : 'stop', rule: progress ? 'progress' : 'no_progress', open, state: next }
}
// One step of a loop: the engine's verdict, with its diagnosis run when it asks for one.
// `diag(v)` runs the diagnosis agent and returns its answer (or null).
async function loopStep(loopState, blockers, policy, diag) {
  const F = typeof factory !== 'undefined' && factory && factory.loop ? factory : null
  if (!F) return localLoop(loopState, blockers)
  let v = await F.loop(loopState, blockers, policy)
  if (v.action === 'diagnose') {
    const d = diag ? await diag(v) : null
    const ls = await F.recordDiagnosis(v.state, d || { cause: 'the diagnosis agent returned nothing', needs_user: true, approach: '', question: '', options: [], recommendation: '' })
    v = await F.loop(ls, blockers, policy)
    v.diagnosed = Boolean(d)
  }
  return v
}
const SERIOUS = ['blocker', 'major']
const itemKey = (it) => `${it.critic}:${String(it.symbol || it.issue || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)}`

async function critiqueRound(design, round, model = null) {
  const critics = brief.critics && brief.critics.length ? brief.critics : [brief.critique]
  phase(`decide: critics round ${round} (${critics.map((c) => c.id || 'god-eye').join(' + ')})`)
  const outs = await pipeline(critics, (c) => one(`${c.prompt}\n\nINPUTS:\n${JSON.stringify({ design }, null, 2)}`, model ? { ...c, model } : c, `${c.id || 'god-eye'} · design #${round}`))
  const items = []
  const verdicts = {}
  critics.forEach((c, i) => {
    const o = outs[i]
    const id = c.id || 'god-eye'
    verdicts[id] = o ? o.verdict : null
    ;((o && o.items) || []).forEach((it, k) => items.push({ ...it, critic: id, id: it.id || `${id}-${round}-${k + 1}` }))
  })
  // evidence first: an API item with a source quote is checked by the CLI like a ledger entry
  const sourced = items.filter((it) => it.critic !== 'god-eye' && SERIOUS.includes(it.severity) && it.evidence && it.evidence.kind === 'source')
  if (sourced.length && typeof factory !== 'undefined' && factory && factory.checkLedger) {
    const asEntries = sourced.map((it) => { const m = /^(.*):(\d+)$/.exec(String(it.evidence.ref || '')); return { probe: it.id, symbol: it.symbol || it.id, file: m ? m[1] : String(it.evidence.ref || ''), line: m ? Number(m[2]) : 0, quote: it.evidence.quote || '' } })
    const chk = await factory.checkLedger(asEntries)
    for (const r of chk.rejected || []) {
      const it = items.find((x) => x.id === r.probe)
      if (it) { it.severity = 'minor'; it.evidence_rejected = r.why }
    }
  }
  for (const it of items) {
    if (it.critic !== 'god-eye' && SERIOUS.includes(it.severity) && !(it.evidence && it.evidence.ref)) { it.severity = 'minor'; it.evidence_rejected = 'a serious API finding must cite dependency source (file:line and quote) or a probe\'s output' }
  }
  const serious = items.filter((it) => SERIOUS.includes(it.severity))
  let verifications = []
  if (serious.length && brief.verifier) {
    phase(`decide: verify ${serious.length} serious item(s)`)
    const res = await fan(serious.map((it) => ({ prompt: brief.verifier.prompt_template.replace('{{finding}}', () => JSON.stringify({ id: it.id, critic: it.critic, severity: it.severity, symbol: it.symbol, issue: it.issue, evidence: it.evidence, suggestion: it.suggestion }, null, 2)), schema: brief.verifier.schema, agent_type: brief.verifier.agent_type, model: brief.verifier.model, label: `verify ${it.id}` })))
    verifications = res.map((r, i) => (r ? { ...r, finding_id: serious[i].id } : { finding_id: serious[i].id, status: 'unverifiable', evidence: '', reason: 'the verifier returned nothing' }))
  }
  const status = (it) => { const v = verifications.find((x) => x.finding_id === it.id); return v ? v.status : brief.verifier ? 'unverifiable' : 'confirmed' }
  for (const it of serious) it.verified = status(it)
  const open = serious.filter((it) => it.verified !== 'refuted')
  // a critic that returned nothing (twice) approved nothing: the round is not an approval
  const missing = critics.filter((c, i) => !outs[i]).map((c) => c.id || 'god-eye')
  const verdict = open.length || missing.length ? 'revise' : 'approve'
  return { round, verdict, verdicts, items, verifications, open, missing }
}

if (brief.config === 'decide') {
  let design
  if (brief.targeted && brief.prior_design) {
    // a deny that names a defect: the architect fixes it, the critics re-check (no new options)
    phase('decide: architect revises for your deny')
    design = await one(`${brief.critique.revise.prompt}\n\nINPUTS:\n${JSON.stringify({ human_denial: brief.targeted, your_previous_output: brief.prior_design }, null, 2)}`, brief.critique.revise, 'architect · revise (deny)')
    if (!design) design = brief.prior_design
  } else {
    phase('decide: architect')
    design = await one(`${brief.judge.prompt}\n\nINPUTS:\n${JSON.stringify(inputs, null, 2)}`, brief.judge, 'architect')
  }
  if (!design) return envelope('error', 'The architect returned nothing twice.', { options: inputs, degraded })
  const critiques = []
  const max = Math.max(1, brief.critique.max_rounds || 3)
  // the engine's ceiling counts the rounds before this one: max critiques, then a diagnosis
  const policy = { stall_rounds: 1, ...(brief.loop || {}), ceiling: Math.max(1, max - 1) }
  let loopState = null
  let model = null
  let approach = null
  let stop = 'ceiling'
  let question = null
  let revisedAfterLast = false
  const withModel = (spec) => (model ? { ...spec, model } : spec)
  for (let round = 1; round <= max + 1; round++) {
    const c = await critiqueRound(design, round, model)
    critiques.push(c)
    revisedAfterLast = false
    if (!c.open.length) { stop = c.missing.length ? 'critic_failed' : 'approved'; break }
    const v = await loopStep(loopState, c.open.map(itemKey), policy, brief.diagnosis ? async () => {
      phase(`decide: diagnosis (round ${round})`)
      return one(`${brief.diagnosis.prompt}\n\nDIAGNOSIS INPUT (JSON):\n${JSON.stringify({ focus: 'diagnosis', loop: 'the design critique loop: the critics object, the architect revises, the critics check again', rounds: critiques.map((x) => ({ round: x.round, open: x.open.map((it) => ({ id: it.id, critic: it.critic, severity: it.severity, issue: it.issue, evidence: it.evidence })) })), design }, null, 2)}`, brief.diagnosis, `god-eye · diagnosis (design)`)
    } : null)
    loopState = v.state
    if (v.model) model = v.model
    if (v.approach) approach = v.approach
    // always one revise after the last critique: the gate gets the design with these addressed
    phase(`decide: architect revises (round ${round})`)
    const revised = await one(`${brief.critique.revise.prompt}\n\nINPUTS:\n${JSON.stringify({ critique: { verdict: 'revise', items: c.open.map((it) => ({ id: it.id, critic: it.critic, severity: it.severity, symbol: it.symbol, issue: it.issue, evidence: it.evidence, suggestion: it.suggestion, verified: it.verified })) }, ...(approach ? { approach_from_diagnosis: approach } : {}), your_previous_output: design }, null, 2)}`, withModel(brief.critique.revise), `architect · revise #${round}${model ? ' (escalated)' : ''}`)
    if (revised) { design = revised; revisedAfterLast = true }
    if (v.action === 'stop' || round >= max) {
      const shrank = critiques.length > 1 && c.open.length < critiques[critiques.length - 2].open.length
      stop = v.action === 'stop' && v.rule === 'ceiling' && shrank ? 'ceiling' : v.action === 'stop' ? 'no_progress' : 'ceiling'
      question = typeof factory !== 'undefined' && factory && factory.loopQuestion ? await factory.loopQuestion(loopState, { what: 'The design critique loop', blockers: c.open.map(itemKey), fallbackOptions: ['Approve the design with these objections open', 'Deny naming the defect: a targeted revise', 'Deny rethink: new options'], fallbackRecommendation: 'b' }) : null
      break
    }
  }
  const last = critiques[critiques.length - 1]
  // the shape recDecide has always read (verdict, items per round), plus the evidence
  const out = critiques.map((c) => ({ round: c.round, verdict: c.verdict, verdicts: c.verdicts, items: c.items, verifications: c.verifications, open: c.open.map((it) => it.id), ...(c.missing.length ? { missing: c.missing } : {}) }))
  return envelope('ok', `Design: ${design.kind} (${(design.paths || []).join(', ')}). Critics: ${last ? last.verdict : 'none'} after ${critiques.length} round(s)${stop !== 'approved' ? ` (${stop === 'no_progress' ? 'no progress' : stop === 'critic_failed' ? `no result from ${last.missing.join(', ')}` : 'ceiling'}; ${last.open.length} open${stop === 'critic_failed' ? '' : ', revised after the last critique'}: shown at the gate)` : ''}.`, { options: inputs, degraded, judge: design, critiques: out, stop, revised_after_last: revisedAfterLast, ...(question ? { question } : {}), ...(loopState ? { loop: { rounds: loopState.rounds, escalated: Boolean(model), diagnosed: Boolean(loopState.diagnosis) } } : {}), open: last ? last.open : [], targeted: Boolean(brief.targeted) }, { threat_model: Boolean(brief.threat_model) })
}

if (brief.config === 'challenge') {
  const lanes = inputs.map((x) => ({ lane: x.id, findings: x.output.findings || [] }))
  const serious = lanes.flatMap((l) => l.findings.filter((f) => (brief.verifier.severities || ['blocker', 'major']).includes(f.severity)).map((f) => ({ ...f, lane: l.lane })))
  // Findings an earlier round left unverified are re-verified every round until settled, with
  // twice the time cap; a verifier that runs out of time is retried with twice the cap too.
  const carried = (brief.config === 'challenge' && brief.carried) || []
  const scale = brief.verifier.reverify_scale || 2
  let verifications = []
  if (serious.length || carried.length) {
    phase(`challenge: verify ${serious.length} finding(s)${carried.length ? ` + ${carried.length} carried` : ''}`)
    // a carried finding (the first verifier could not settle it) gets a second verifier on the
    // stronger model that reproduces it in the build environment
    const item = (f, label, sc, again = false) => ({
      prompt: `${brief.verifier.prompt_template.replace('{{finding}}', JSON.stringify(f, null, 2))}${again && brief.verifier.carried_note && !brief.verifier.prompt_template.includes(brief.verifier.carried_note) ? `\n\n${brief.verifier.carried_note}` : ''}`,
      schema: brief.verifier.schema,
      agent_type: brief.verifier.agent_type,
      model: (again && brief.verifier.carried_model) || brief.verifier.model,
      label,
      scale: sc,
      retry_scale: scale,
    })
    const items = [...serious.map((f) => item(f, `verify ${f.id}`, null)), ...carried.map((f) => item(f, `verify ${f.id} (carried from round ${f.from_round})`, scale, true))]
    const res = await fan(items)
    verifications = res.map((r, i) => (r ? (i < serious.length ? { ...r, finding_id: serious[i].id } : { ...r, finding_id: carried[i - serious.length].id, carried: true }) : null)).filter(Boolean)
  }
  const confirmed = verifications.filter((v) => v.status === 'confirmed').length
  const unverifiable = verifications.filter((v) => v.status === 'unverifiable').length
  const summary = `${lanes.length}/${brief.fanout.length} lane(s) reviewed; ${serious.length} serious finding(s)${carried.length ? ` and ${carried.length} carried unverified` : ''}, ${confirmed} confirmed${unverifiable ? `, ${unverifiable} unverifiable` : ''}.${degraded.length ? ` Missing lanes: ${degraded.join(', ')}.` : ''}`
  return envelope(degraded.length ? 'degraded' : 'ok', summary, { lanes, degraded, verifications }, { fingerprint: brief.fingerprint || null, lanes_requested: brief.lanes_requested || null })
}

// the loop engine's diagnosis of a router loop that stopped making progress (cli/core/loop.js)
if (brief.config === 'diagnose') {
  phase('diagnose: God Eye')
  const d = await one(brief.judge.prompt, brief.judge, 'diagnosis')
  return envelope('ok', d ? `Diagnosis of the ${brief.mode} loop: ${d.needs_user ? 'a question for the human' : 'a different approach'}.` : 'The diagnosis agent returned nothing.', { loop: brief.mode, diagnosis: d || null })
}

throw new Error(`Unknown config ${brief.config}`)
