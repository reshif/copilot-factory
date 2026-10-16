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
let plannerModel = null // set when the loop engine escalates (cli/core/loop.js)
async function plannerRound(extra, label) {
  runs += 1
  // after the loop engine escalated (no progress), the planner runs on the stronger model
  return (await call(`${brief.planner.prompt}${extra ? `\n\n${extra}` : ''}`, opts(brief.planner, `${label}${plannerModel ? ' (escalated)' : ''}`, plannerModel))) || null
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

// ---- the plan probe (0.10.0): the CLI lints every verify command and dry-runs it in a scratch
// worktree inside the proposed build environment. Problems go back to the planner with the raw
// output; the loop stops when the problem set stops shrinking, or at its ceiling, and whatever is
// left is shown at the gate. The probe's record is the plan critique's evidence.
// The stop rule is 0.9.0's shared loop engine (cli/core/loop.js, through factory.loop): on while
// the problems shrink, the planner on the stronger model when they stall, stop at the ceiling or
// on no progress; whatever is left goes to the gate, never to a park. A minimal local rule
// stands in where the runtime has no factory API.
async function loopStep(state, blockers, policy) {
  if (typeof factory !== 'undefined' && factory && factory.loop) return factory.loop(state, blockers, policy)
  const s = state || { best: null }
  const progress = s.best === null || blockers.length < s.best
  return { action: !blockers.length ? 'done' : progress ? 'continue' : 'stop', rule: progress ? 'progress' : 'no_progress', state: { best: Math.min(s.best === null ? Infinity : s.best, blockers.length) } }
}
const probeKey = (p) => ((p && p.problems) || []).map((x) => String(x).replace(/Output \(tail\):.*$/, ''))
const canProbe = Boolean(brief.probe && typeof factory !== 'undefined' && factory && factory.probe)
let probe = null
let probeStop = null
async function probeLoop() {
  if (!canProbe || !(result && result.valid)) return
  const maxP = Math.max(1, brief.max_probe_rounds || 3)
  let ls = null
  for (let round = 1; round <= maxP; round++) {
    phase(`decompose: plan probe${round > 1 ? ` (round ${round})` : ''}`)
    probe = await factory.probe()
    if (!probe || probe.ok) { probeStop = 'ok'; return }
    // interrupted twice before (review MAJ-2): the planner cannot fix that; recording asks the human
    if (probe.needs_answer) { probeStop = 'interrupted'; return }
    const v = await loopStep(ls, probeKey(probe), { stall_rounds: 1, ...(brief.loop || {}), ceiling: Math.max(1, maxP - 1), diagnose: false })
    ls = v.state
    if (v.model) plannerModel = v.model
    const counts = (probeLoop.counts = [...(probeLoop.counts || []), probeKey(probe).length])
    const shrank = counts.length > 1 && counts[counts.length - 1] < counts[counts.length - 2]
    if (v.action === 'stop' || round === maxP) { probeStop = shrank ? 'ceiling' : 'no_progress'; return }
    const revised = await plannerRound(`The CLI's plan probe dry-ran every verify command in a scratch worktree inside the proposed build environment; fix every problem (the command, the task, or the environment proposal), keep the plan valid:\n- ${(probe.problems || []).join('\n- ')}`, `planner · probe fix #${round}`)
    if (!revised || !revised.valid) { result = revised || result; return }
    result = revised
  }
}
await probeLoop()

let critique = null
let critiqueLoop = null
if (result && result.valid && brief.critique) {
  for (let round = 1; round <= (brief.critique.max_rounds || 2); round++) {
    phase(`decompose: God Eye (plan) round ${round}`)
    runs += 1
    critique = (await call(`${brief.critique.prompt}${probe ? `\n\nINPUTS:\n${JSON.stringify({ plan_probe: { ok: probe.ok, setup: probe.setup, commands: probe.commands, lint: probe.lint, problems: probe.problems } }, null, 2)}` : ''}`, opts(brief.critique, `god-eye · plan #${round}`))) || null
    if (!critique || critique.verdict === 'approve' || round === (brief.critique.max_rounds || 2)) break
    const cv = await loopStep(critiqueLoop, (critique.items || []).filter((it) => it.severity !== 'minor').map((it) => String(it.issue || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)), { stall_rounds: 1, ...(brief.loop || {}), ceiling: Math.max(1, (brief.critique.max_rounds || 2) - 1), diagnose: false })
    critiqueLoop = cv.state
    if (cv.model) plannerModel = cv.model
    const revised = await plannerRound(`God Eye asked for revisions; address every item, keep the plan valid:\n${JSON.stringify(critique.items, null, 2)}`, `planner · revise #${round}`)
    if (!revised || !revised.valid) { result = revised || result; break }
    result = revised
    // a revised plan is probed again before the next critique reads it
    if (canProbe) await probeLoop()
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
  summary: valid ? `Valid ${brief.mode}${probe ? `; plan probe: ${probe.ok ? 'every verify command can run' : `${(probe.problems || []).length} problem(s) (${probeStop}), shown at the gate`}` : ''}${critique ? `; plan critique: ${critique.verdict}` : ''}.` : `Still invalid after ${max} round(s): ${(result && result.errors || errors).slice(0, 3).join('; ')}`,
  data: { planner: result, critique, ...(probe ? { probe: { ok: probe.ok, problems: probe.problems || [], stop: probeStop } } : {}) },
}
