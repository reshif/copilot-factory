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
// ---- the API ledger (0.10.0): quoted facts from the pinned dependency source, checked by the CLI
// against the fetched files. Packages a probe asked for are fetched first (the CLI downloads them
// without running them; a failure is a gap, not a stop). A probe whose entries were rejected, or
// whose source just arrived, is asked again ONCE with the CLI's reasons; what still fails is
// dropped by the CLI when it records ground.
const ledgerOf = (t) => (t && Array.isArray(t.ledger) ? t.ledger : [])
const specOf = (d) => (d && d.name && d.version ? (d.ecosystem === 'pypi' ? `pypi:${d.name}==${d.version}` : `${d.ecosystem}:${d.name}@${d.version}`) : null)
let ledgerCheck = null
if (typeof factory !== 'undefined' && factory && factory.checkLedger) {
  const asked = []
  brief.probes.forEach((p, i) => { for (const d of (out[i] && out[i].deps) || []) { const s = specOf(d); if (s && !asked.includes(s)) asked.push(s) } })
  let arrived = []
  if (asked.length && factory.fetchDeps) {
    phase(`ground: fetch ${asked.length} dependency source package(s)`)
    const f = await factory.fetchDeps(asked)
    arrived = ((f && f.packages) || []).filter((p) => p.status === 'fetched' && asked.includes(p.package.replace(/^pypi:([^@]+)@/, 'pypi:$1==')))
  }
  const entries = () => brief.probes.flatMap((p, i) => ledgerOf(out[i]).map((e) => ({ ...e, probe: p.id })))
  let chk = entries().length ? await factory.checkLedger(entries()) : { rejected: [] }
  const redo = brief.probes.map((p, i) => i).filter((i) => out[i] && ((chk.rejected || []).some((r) => r.probe === brief.probes[i].id) || (arrived.length && (out[i].deps || []).length)))
  if (redo.length) {
    phase(`ground: ${redo.length} probe(s) fix their API ledger`)
    runs += redo.length
    const again = await pipeline(redo.map((i) => brief.probes[i]), (p) => {
      const why = (chk.rejected || []).filter((r) => r.probe === p.id).map((r) => `  - ${r.symbol || '?'} at ${r.file || '?'}:${r.line || '?'}: ${r.why}`)
      const got = arrived.map((a) => `  - ${a.package}: ${a.path}`)
      return call(`${p.prompt}\n\nThe factory CLI checked your API ledger against the fetched dependency source.${why.length ? `\nThese entries were rejected (the quote must be the exact text at the cited line of the fetched file, and the version the fetched one):\n${why.join('\n')}` : ''}${got.length ? `\nSource you asked for is now readable (read-only, never install or run it):\n${got.join('\n')}` : ''}\nRe-read the cited files, fix each entry or drop it, and return your full answer again.`, opts(p, `${p.label} (ledger)`))
    })
    redo.forEach((idx, k) => { if (again[k]) out[idx] = again[k] })
    chk = entries().length ? await factory.checkLedger(entries()) : { rejected: [] }
  }
  ledgerCheck = { entries: entries().length, rejected: (chk.rejected || []).length, reasked: redo.map((i) => brief.probes[i].id), fetched: arrived.map((a) => a.package) }
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
  summary: `${topics.length} topic(s), ${claims} claim(s), ${blocking.length} blocking unknown(s)${ledgerCheck && ledgerCheck.entries ? `, ${ledgerCheck.entries} API ledger entr${ledgerCheck.entries === 1 ? 'y' : 'ies'} (${ledgerCheck.rejected} rejected by the CLI)` : ''}${degraded.length ? `; no result for ${degraded.join(', ')}` : ''}.`,
  data: { topics, degraded, ...(ledgerCheck ? { ledger_check: ledgerCheck } : {}) },
}
