export const meta = {
  name: 'decompose',
  description: 'Software Factory: split an approved design into task contracts (plan.json) or an epic into slices (slices.json); the planner validates with the CLI, up to the round budget, then an optional cold plan critique. Pass the JSON brief from `factory wfargs decompose` as args.',
}

const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'decompose') throw new Error('decompose needs the JSON brief from `factory wfargs decompose` as its args')
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
async function plannerRound(extra, label) {
  runs += 1
  return (await call(`${brief.planner.prompt}${extra ? `\n\n${extra}` : ''}`, opts(brief.planner, label))) || null
}

let result = null
let errors = []
const max = Math.max(1, brief.planner.max_rounds || 3)
for (let round = 1; round <= max; round++) {
  phase(`decompose: ${brief.mode} round ${round}`)
  result = await plannerRound(errors.length ? `The validator reported these errors last round; fix all of them:\n- ${errors.join('\n- ')}` : '', `${brief.mode === 'slices' ? 'slicer' : 'planner'} #${round}`)
  if (result && result.valid) break
  errors = result ? result.errors : ['The planner returned nothing.']
}

let critique = null
if (result && result.valid && brief.critique) {
  for (let round = 1; round <= (brief.critique.max_rounds || 2); round++) {
    phase(`decompose: God Eye (plan) round ${round}`)
    runs += 1
    critique = (await call(brief.critique.prompt, opts(brief.critique, `god-eye · plan #${round}`))) || null
    if (!critique || critique.verdict === 'approve' || round === (brief.critique.max_rounds || 2)) break
    const revised = await plannerRound(`God Eye asked for revisions; address every item, keep the plan valid:\n${JSON.stringify(critique.items, null, 2)}`, `planner · revise #${round}`)
    if (!revised || !revised.valid) { result = revised || result; break }
    result = revised
  }
}

const valid = Boolean(result && result.valid)
return {
  workflow: 'decompose',
  config: null,
  mode: brief.mode,
  job: brief.job,
  status: valid ? 'ok' : 'needs_user',
  next_gate: null,
  input_hash: brief.input_hash,
  agents: roster,
  budgets: { used: { agent_runs: runs }, limit: (brief.budgets && brief.budgets.limit) || {} },
  artifacts: result && result.path ? [result.path] : [],
  questions: [],
  park_reason: null,
  summary: valid ? `Valid ${brief.mode}${critique ? `; plan critique: ${critique.verdict}` : ''}.` : `Still invalid after ${max} round(s): ${(result && result.errors || errors).slice(0, 3).join('; ')}`,
  data: { planner: result, critique },
}
