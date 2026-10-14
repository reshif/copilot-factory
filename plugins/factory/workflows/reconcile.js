export const meta = {
  name: 'reconcile',
  description: 'Software Factory: merge finished task branches into the job branch in dependency order via the CLI; textual conflicts inside the tasks\' scopes are resolved, behavioural ones aborted. Pass the JSON brief from `factory wfargs reconcile` as args.',
}

const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'reconcile') throw new Error('reconcile needs the JSON brief from `factory wfargs reconcile` as its args')
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

let runs = 1
phase('reconcile: integrate task branches')
let r = await call(brief.integrator.prompt, opts(brief.integrator, 'integrator'))
if (!r) {
  runs += 1
  r = await call(brief.integrator.prompt, opts(brief.integrator, 'integrator (retry)'))
}
return {
  workflow: 'reconcile',
  config: null,
  mode: null,
  job: brief.job,
  status: !r ? 'error' : r.status === 'merged' ? 'ok' : 'park',
  next_gate: null,
  input_hash: brief.input_hash,
  agents: roster,
  budgets: { used: { agent_runs: runs }, limit: (brief.budgets && brief.budgets.limit) || {} },
  artifacts: [],
  questions: [],
  park_reason: r && r.status !== 'merged' ? `${r.status}: ${r.summary}` : null,
  summary: r ? `${r.status}: ${r.summary}` : 'The integrator returned nothing twice.',
  data: { integrator: r },
}
