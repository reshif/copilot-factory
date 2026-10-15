export const meta = {
  name: 'realize',
  description: 'Software Factory: build tasks wave by wave, each in its own git worktree — builder, then `task verify` run by the CLI (its exit code decides), retried up to each task\'s limit; a blocked or exhausted task skips only its dependents. Pass the JSON brief from `factory wfargs realize` as args.',
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

// The raw `task verify` result as the next attempt's input: the failing command, its exit code
// and the tail of its output (verify keeps the last 4 KB), scope violations, or why verify
// refused. Never a paraphrase.
function tail(text, n) {
  const t = String(text || '')
  return t.length > n ? '…' + t.slice(t.length - n) : t
}
function verifyFailures(v) {
  if (!v) return ['task verify returned nothing.']
  if (v.error) return [`task verify refused (${v.error.code}): ${v.error.message}`]
  const out = []
  for (const f of v.failures || []) out.push(`\`${f.cmd}\` exited ${f.code}${f.flaky ? ' (it passed on a re-run: flaky, not accepted)' : ''}${f.timed_out ? ' (timed out)' : ''}. Output (tail):\n${tail(f.output, 1500).split('\n').map((l) => '      ' + l).join('\n')}`)
  for (const p of v.scope_violations || []) out.push(`${p} was changed but is outside this task's allowed paths (or protected).`)
  if (v.no_changes) out.push('No change was committed on the task branch since task start.')
  if (!out.length) out.push('task verify did not pass.')
  return out
}

let runs = 0
const checks = []
const T = brief.tasks
const st = {}
// attempts counts this run's attempts (the retry limit applies per run); attempt_base is what
// earlier runs used, so numbering and the failure history continue across `factory run`s.
for (const id of Object.keys(T)) st[id] = { outcome: 'pending', attempts: 0, failures: (T[id].previous_failures || []).slice(), swept: [], summary: '' }
const attemptNo = (id) => (T[id].attempt_base || 0) + st[id].attempts + 1
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
        .replace('{{attempt}}', () => String(attemptNo(id)))
        .replace('{{failures}}', () => (s.failures.length ? s.failures.map((f) => `  - ${f}`).join('\n') : '  - (none)'))
      // After a failed attempt the builder continues its previous Copilot session (the runner
      // resumes it when it has one), with the raw failure as this turn's input.
      const o = opts({ ...T[id].builder, schema: brief.builder_schema }, `build ${id} #${attemptNo(id)}`, builderModel(T[id].builder, s.attempts + 1))
      if (s.failures.length) o.resume = true
      return call(prompt, o)
    })
    const toVerify = []
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
      // attempt: verifying the branch would only re-check an older state. The attempt is spent.
      if (!b) {
        s.attempts += 1
        s.failures = [`Attempt ${attemptNo(id) - 1}: the builder returned no result (crashed, timed out or replied without the JSON); nothing was verified. Its uncommitted work, if any, was saved as a \`wip:\` commit on the task branch: continue from it.`]
        if (s.attempts >= (T[id].retry_limit || 3)) {
          s.outcome = 'exhausted'
          s.summary = `Exhausted after ${s.attempts} attempt(s): ${s.failures[0]}`
        }
        continue
      }
      s.swept = b.swept || []
      s.summary = b.summary || ''
      toVerify.push(id)
    }
    // The CLI's `task verify` decides, by its exit code: no agent reads the result back.
    const verified = {}
    for (const group of chunks(toVerify, cap)) {
      const res = await pipeline(group, (id) => factory.verify(id))
      group.forEach((id, i) => { verified[id] = res[i] || null })
    }
    for (const id of toVerify) {
      const s = st[id]
      s.attempts += 1
      const v = verified[id]
      checks.push({ task: id, attempt: s.attempts, pass: Boolean(v && v.pass), ...(v && v.error ? { refused: v.error.code } : {}) })
      if (v && v.pass) {
        s.outcome = 'done'
        continue
      }
      s.failures = verifyFailures(v).map((f) => `Attempt ${attemptNo(id) - 1}: ${f}`)
      if (s.attempts >= (T[id].retry_limit || 3)) {
        s.outcome = 'exhausted'
        s.summary = `Exhausted after ${s.attempts} attempt(s): ${s.failures.slice(0, 2).join('; ')}`
      }
    }
    // Optional, never deciding: a cheap agent looks at the places the builder says it swept
    // for the same bug class (policy agents.sweep_check). Its notes go to the summary only.
    const swept = toVerify.filter((id) => st[id].outcome === 'done' && T[id].sweep && st[id].swept.length)
    if (swept.length) {
      const notes = await runAll(swept, (id) => call(T[id].sweep_prompt.replace('{{swept}}', st[id].swept.join(', ')), opts({ ...T[id].sweep, schema: brief.sweep_schema }, `sweep ${id}`)))
      for (const id of swept) {
        const n = notes[id]
        if (n && (n.concerns || []).length) st[id].summary = `${st[id].summary} Sweep check concerns (not deciding): ${n.concerns.join('; ')}`.trim()
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
  data: { tasks, verifications: checks },
}
