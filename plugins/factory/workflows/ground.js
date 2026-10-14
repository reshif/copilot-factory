export const meta = {
  name: 'ground',
  description: 'Software Factory: establish cited facts before decisions — parallel research probes (codebase, interfaces, history, external) merged by the CLI into findings.md. Pass the JSON brief from `factory wfargs ground` as args.',
}

const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'ground') throw new Error('ground needs the JSON brief from `factory wfargs ground` as its args')
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

let runs = brief.probes.length
phase(`ground: ${brief.probes.length} probe(s)`)
const first = await pipeline(brief.probes, (p) => call(p.prompt, opts(p, p.label)))
const out = first.slice()
const failed = brief.probes.map((p, i) => (out[i] ? null : i)).filter((i) => i !== null)
if (failed.length) {
  runs += failed.length
  const again = await pipeline(failed.map((i) => brief.probes[i]), (p) => call(p.prompt, opts(p, `${p.label} (retry)`)))
  failed.forEach((idx, k) => { out[idx] = again[k] || null })
}
const degraded = brief.probes.filter((_, i) => !out[i]).map((p) => p.id)
const topics = out.filter(Boolean)
const blocking = topics.flatMap((t) => t.unknowns.filter((u) => u.blocking).map((u) => u.question))
const claims = topics.reduce((n, t) => n + t.claims.length, 0)

return {
  workflow: 'ground',
  config: null,
  mode: brief.mode || null,
  job: brief.job,
  status: topics.length === 0 ? 'error' : blocking.length ? 'needs_user' : degraded.length ? 'degraded' : 'ok',
  next_gate: null,
  input_hash: brief.input_hash,
  agents: roster,
  budgets: { used: { agent_runs: runs }, limit: (brief.budgets && brief.budgets.limit) || {} },
  artifacts: [],
  questions: blocking.map((q) => ({ question: q, why: 'Blocks the design' })),
  park_reason: null,
  summary: `${topics.length} topic(s), ${claims} claim(s), ${blocking.length} blocking unknown(s)${degraded.length ? `; no result for ${degraded.join(', ')}` : ''}.`,
  data: { topics, degraded },
}
