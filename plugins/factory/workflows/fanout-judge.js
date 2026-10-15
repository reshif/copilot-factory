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
  // Findings an earlier round left unverified are re-verified every round until settled, with
  // twice the time cap; a verifier that runs out of time is retried with twice the cap too.
  const carried = (brief.config === 'challenge' && brief.carried) || []
  const scale = brief.verifier.reverify_scale || 2
  let verifications = []
  if (serious.length || carried.length) {
    phase(`challenge: verify ${serious.length} finding(s)${carried.length ? ` + ${carried.length} carried` : ''}`)
    const item = (f, label, sc) => ({
      prompt: brief.verifier.prompt_template.replace('{{finding}}', JSON.stringify(f, null, 2)),
      schema: brief.verifier.schema,
      agent_type: brief.verifier.agent_type,
      model: brief.verifier.model,
      label,
      scale: sc,
      retry_scale: scale,
    })
    const items = [...serious.map((f) => item(f, `verify ${f.id}`, null)), ...carried.map((f) => item(f, `verify ${f.id} (carried from round ${f.from_round})`, scale))]
    const res = await fan(items)
    verifications = res.map((r, i) => (r ? (i < serious.length ? { ...r, finding_id: serious[i].id } : { ...r, finding_id: carried[i - serious.length].id, carried: true }) : null)).filter(Boolean)
  }
  const confirmed = verifications.filter((v) => v.status === 'confirmed').length
  const unverifiable = verifications.filter((v) => v.status === 'unverifiable').length
  const summary = `${lanes.length}/${brief.fanout.length} lane(s) reviewed; ${serious.length} serious finding(s)${carried.length ? ` and ${carried.length} carried unverified` : ''}, ${confirmed} confirmed${unverifiable ? `, ${unverifiable} unverifiable` : ''}.${degraded.length ? ` Missing lanes: ${degraded.join(', ')}.` : ''}`
  return envelope(degraded.length ? 'degraded' : 'ok', summary, { lanes, degraded, verifications }, { fingerprint: brief.fingerprint || null, lanes_requested: brief.lanes_requested || null })
}

throw new Error(`Unknown config ${brief.config}`)
