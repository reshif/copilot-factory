export const meta = {
  name: 'clarify',
  description: 'Software Factory clarify v3: runs the agents of one clarify stage (read-back, research, interpret, redirect, contract, readiness) as the brief names them, in groups, and returns their raw replies. Every rule is the CLI\'s (cli/core/clarify.js). Pass the JSON brief from `factory wfargs clarify` as args.',
}

// ---- brief (from the factory CLI; workflows cannot read files or run commands) ----
const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'clarify') throw new Error('clarify needs the JSON brief from `factory wfargs clarify` as its args')
  return a
})()

const roster = []
let runs = 0

// One agent, as its real factory agent, with the stage's time cap; tried `attempts` times
// when it returns nothing. A later group sees the earlier groups' replies under INPUTS.
async function one(spec, inputs) {
  if (!spec || !/^factory:[a-z-]+$/.test(spec.agent_type || '')) throw new Error(`Brief item "${spec && spec.label}" has no factory agent_type`)
  const tail = inputs.length ? `\n\nINPUTS (JSON):\n${JSON.stringify(inputs)}` : ''
  const attempts = Math.max(1, Math.min(2, spec.attempts || 1))
  for (let i = 0; i < attempts; i++) {
    runs += 1
    const label = i ? `${spec.label} (retry)` : spec.label
    const o = { schema: spec.schema, label, agentType: spec.agent_type }
    if (spec.model) o.model = spec.model
    if (spec.timeout_sec) o.timeoutSec = spec.timeout_sec
    const r = await agent(`${spec.prompt}${tail}`, o)
    roster.push({ label, agent_type: spec.agent_type, model: spec.model || null, retry: i > 0, outcome: r ? 'ok' : 'no_result' })
    if (r) return r
  }
  return null
}

const outputs = {}
const failed = []
for (let g = 0; g < brief.groups.length; g++) {
  const group = brief.groups[g]
  phase(`clarify: ${brief.stage} · ${group.map((a) => a.label).join(', ')}`)
  const inputs = Object.entries(outputs).filter(([, v]) => v).map(([label, output]) => ({ label, output }))
  const res = await pipeline(group, (a) => one(a, inputs))
  group.forEach((a, i) => {
    outputs[a.label] = res[i] || null
    if (!res[i]) failed.push(a.label)
  })
}
if (failed.length) log(`No result: ${failed.join(', ')}`)

return {
  workflow: 'clarify',
  config: null,
  mode: brief.stage,
  job: brief.job,
  status: failed.length ? 'degraded' : 'ok',
  next_gate: null,
  input_hash: brief.input_hash,
  agents: roster,
  budgets: { used: { agent_runs: runs }, limit: (brief.budgets && brief.budgets.limit) || {} },
  artifacts: [],
  questions: [],
  park_reason: null,
  summary: `clarify ${brief.stage}: ${Object.keys(outputs).length - failed.length} of ${Object.keys(outputs).length} agent(s) replied`,
  data: { stage: brief.stage, rev: brief.rev, outputs, failed },
}
