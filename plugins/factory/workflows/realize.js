export const meta = {
  name: 'realize',
  description: 'Software Factory: build tasks wave by wave, each in its own git worktree — builder then independent tester, retried up to each task\'s limit; a blocked or exhausted task skips only its dependents. Pass the JSON brief from `factory wfargs realize` as args.',
}

const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'realize') throw new Error('realize needs the JSON brief from `factory wfargs realize` as its args')
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

// Attempt 1 uses the builder's model; later attempts step through the escalation list.
function builderModel(spec, attempt) {
  const up = (spec && spec.escalate) || []
  if (attempt <= 1 || !up.length) return null
  return up[Math.min(attempt - 2, up.length - 1)]
}

let runs = 0
const T = brief.tasks
const st = {}
for (const id of Object.keys(T)) st[id] = { outcome: 'pending', attempts: 0, failures: [], swept: [], summary: '' }
const BAD = ['blocked', 'exhausted', 'skipped_dependency']
const cap = Math.max(1, brief.max_parallel_tasks || 4)

function chunks(list, n) {
  const out = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}
async function runAll(ids, make) {
  const results = {}
  for (const group of chunks(ids, cap)) {
    runs += group.length
    const res = await pipeline(group, (id) => make(id))
    group.forEach((id, i) => { results[id] = res[i] || null })
  }
  return results
}
function skipDependents() {
  let changed = true
  while (changed) {
    changed = false
    for (const id of Object.keys(T)) {
      if (st[id].outcome !== 'pending') continue
      const badDep = (T[id].depends_on || []).find((d) => st[d] && BAD.includes(st[d].outcome))
      if (badDep) {
        st[id].outcome = 'skipped_dependency'
        st[id].summary = `Skipped: depends on ${badDep} (${st[badDep].outcome})`
        changed = true
      }
    }
  }
}

for (let w = 0; w < brief.waves.length; w++) {
  skipDependents()
  let active = brief.waves[w].filter((id) => st[id] && st[id].outcome === 'pending')
  if (!active.length) continue
  phase(`realize: wave ${w + 1}/${brief.waves.length} (${active.join(', ')})`)
  while (active.length) {
    const built = await runAll(active, (id) => {
      const s = st[id]
      const prompt = T[id].builder_prompt
        .replace('{{attempt}}', String(s.attempts + 1))
        .replace('{{failures}}', s.failures.length ? s.failures.map((f) => `  - ${f}`).join('\n') : '  - (none)')
      return call(prompt, opts({ ...T[id].builder, schema: brief.builder_schema }, `build ${id} #${s.attempts + 1}`, builderModel(T[id].builder, s.attempts + 1)))
    })
    const toTest = []
    for (const id of active) {
      const b = built[id]
      const s = st[id]
      if (b && b.status === 'blocked') {
        s.outcome = 'blocked'
        // dependency_conflict is typed: the task's dependencies don't merge, a plan change
        // fixes it, and retrying the same merge would only fail again.
        s.summary = b.blocked_reason === 'dependency_conflict'
          ? `Blocked (dependency_conflict): ${b.summary || 'its dependencies do not merge'}`
          : `Blocked: needs ${(b.needs_paths || []).join(', ') || 'paths outside its scope'}. ${b.summary || ''}`
        continue
      }
      // A builder that returned nothing (crashed, timed out, no valid reply) built nothing this
      // attempt: testing the branch would only re-test an older state. The attempt is spent.
      if (!b) {
        s.attempts += 1
        s.failures = [`Attempt ${s.attempts}: the builder returned no result (crashed, timed out or replied without the JSON); nothing was tested. Check the worktree for its unfinished work.`]
        if (s.attempts >= (T[id].retry_limit || 3)) {
          s.outcome = 'exhausted'
          s.summary = `Exhausted after ${s.attempts} attempt(s): ${s.failures[0]}`
        }
        continue
      }
      s.swept = b.swept || []
      s.summary = b.summary || ''
      toTest.push(id)
    }
    const tested = await runAll(toTest, (id) => call(T[id].tester_prompt.replace('{{swept}}', st[id].swept.join(', ') || '(none listed)'), opts({ ...T[id].tester, schema: brief.tester_schema }, `test ${id}`)))
    for (const id of toTest) {
      const s = st[id]
      s.attempts += 1
      const t = tested[id]
      if (t && t.pass) {
        s.outcome = 'done'
        continue
      }
      s.failures = t ? t.failures : ['The tester returned nothing.']
      if (s.attempts >= (T[id].retry_limit || 3)) {
        s.outcome = 'exhausted'
        s.summary = `Exhausted after ${s.attempts} attempt(s): ${s.failures.slice(0, 2).join('; ')}`
      }
    }
    active = active.filter((id) => st[id].outcome === 'pending')
  }
}
skipDependents()

const tasks = Object.keys(T).map((id) => ({ id, outcome: st[id].outcome, attempts: st[id].attempts, summary: st[id].summary }))
const notDone = tasks.filter((t) => t.outcome !== 'done')
return {
  workflow: 'realize',
  config: null,
  mode: brief.scope || null,
  job: brief.job,
  status: notDone.length ? 'park' : 'ok',
  next_gate: null,
  input_hash: brief.input_hash,
  agents: roster,
  budgets: { used: { agent_runs: runs }, limit: (brief.budgets && brief.budgets.limit) || {} },
  artifacts: [],
  questions: [],
  park_reason: notDone.length ? `Tasks not done: ${notDone.map((t) => `${t.id} (${t.outcome})`).join(', ')}` : null,
  summary: `${tasks.length - notDone.length}/${tasks.length} task(s) done.`,
  data: { tasks },
}
