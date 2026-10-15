export const meta = {
  name: 'fanout-judge',
  description: 'Software Factory engine for clarify, decide and challenge: N independent agents in parallel, retry once, a judge merges, an optional cold critique, and per-finding verifiers. Pass the JSON brief from `factory wfargs fanout-judge --config <clarify|decide|challenge>` as args.',
}

// ---- brief (from the factory CLI; workflows cannot read files or run commands) ----
const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'fanout-judge') throw new Error('fanout-judge needs the JSON brief from `factory wfargs fanout-judge --config …` as its args')
  return a
})()

// Every agent runs as its real factory agent (agents/<role>.md): its system prompt,
// tool limits and model apply. The brief names it; a missing one is a broken brief.
function opts(spec, label, model, timeoutSec) {
  if (!spec || !/^factory:[a-z-]+$/.test(spec.agent_type || '')) throw new Error(`Brief item "${label}" has no factory agent_type`)
  const o = { schema: spec.schema, label, agentType: spec.agent_type }
  const m = model || spec.model
  if (m) o.model = m
  // A time cap counted from the call (the runner skips an agent whose budget ran out while it queued).
  if (timeoutSec) o.timeoutSec = timeoutSec
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
  const first = await pipeline(items, (it) => call(`${it.prompt}${ctxBlock()}`, opts(it, it.label)))
  const out = first.slice()
  const failed = items.map((it, i) => (out[i] ? null : i)).filter((i) => i !== null)
  if (failed.length) {
    runs += failed.length
    const again = await pipeline(failed.map((i) => items[i]), (it) => call(`${it.prompt}${ctxBlock()}`, opts(it, `${it.label} (retry)`)))
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

// ---- 0. clarify v2: the issue ledger, research first (docs/DESIGN-CLARIFY-v2.md) ----
// Every unknown is an issue (U-n) with a stable subject, an owner (research | user | design)
// and a status (open → researching → proposed → settled, or deferred_to_design / dropped).
// intent-mapper → issues; repo and web scouts research the research-owned ones (one attempt,
// one retry with a longer budget when a scout failed or ran out of time); the verifier
// re-checks; what research cannot settle (unreachable, unverified, contradicted, verifier
// timeout, budget spent) goes to the user as ONE question with a proposed default.
// Settled is final. Everything raised again (judge, analysts, God Eye) goes through the
// subject dedup below. `factory record` re-applies all of it on the CLI's own copy.
const SC = brief.config === 'clarify' && brief.scout ? brief.scout : null
const LG = brief.config === 'clarify' ? brief.ledger || null : null
const KINDS = ['intent', 'scope', 'constraint', 'acceptance', 'repo', 'world', 'decision', 'user']
const IMPACTS = ['high', 'medium', 'low']
const IRANK = { high: 0, medium: 1, low: 2 }
const FINALS = new Set(['settled', 'deferred_to_design', 'dropped'])
let scout = null

// -- subjects and identity (same rules as cli/core/clarify.js) --
const STOP = new Set('a an the of to for in on at by with and or is are be been does do did should shall which what when where who whom how this that these those it its as from into per than then there their our we you your can could will would must may might not no yes any all each either via vs about exact exactly precise specific confirm confirmed check verify whether if use used using uses one two new current currently today get gets set sets'.split(' '))
const SYN = { cli: 'command', cmd: 'command', commands: 'command', syntax: 'command', configures: 'configure', configured: 'configure', configuring: 'configure', configuration: 'configure', config: 'configure', ports: 'port', interfaces: 'interface', vlans: 'vlan', fields: 'field', names: 'name', lines: 'line' }
const ALSO_STOP = new Set(['form', 'forms', 'way', 'kind', 'thing', 'value', 'list'])
const normText = (s) => String(s || '').toLowerCase().replace(/\b([a-z0-9]{1,3})-([a-z0-9]{1,3})\b/g, '$1$2')
function stem(w) {
  if (SYN[w]) return SYN[w]
  let x = w
  if (x.length > 4 && x.endsWith('ies')) x = `${x.slice(0, -3)}y`
  else if (x.length > 5 && /(ches|shes|xes|sses)$/.test(x)) x = x.slice(0, -2)
  else if (x.length > 3 && x.endsWith('s') && !/(ss|os|us|is)$/.test(x)) x = x.slice(0, -1)
  return SYN[x] || x
}
function tokens(text) {
  const out = []
  for (const w of normText(text).split(/[^a-z0-9]+/)) {
    if (!w || w.length < 2 || STOP.has(w) || /^\d+$/.test(w)) continue
    const s = stem(w)
    if (STOP.has(s) || ALSO_STOP.has(s) || out.includes(s)) continue
    out.push(s)
  }
  return out
}
const subjectKey = (s) => tokens(normText(s).replace(/[._/:-]+/g, ' ')).join('.')
function subjectOf(raw) {
  if (raw && raw.subject && subjectKey(raw.subject)) return { subject: subjectKey(raw.subject), explicit: true }
  return { subject: tokens((raw && (raw.text || raw.question)) || '').slice(0, 4).join('.'), explicit: false }
}
// For comparing faces only (subject keys keep tokens()): "failed"/"fails", "required"/"require"
// and "allowed"/"allows" meet on one root.
function wordRoot(w) {
  let x = w
  if (x.length > 5 && x.endsWith('ing')) x = x.slice(0, -3)
  else if (x.length > 4 && x.endsWith('ed')) x = x.slice(0, -2)
  if (x.length > 4 && x.endsWith('e')) x = x.slice(0, -1)
  return x
}
function faces(x) {
  const subj = tokens(normText(x.subject).replace(/[._/:-]+/g, ' '))
  const out = [new Set([...subj, ...tokens(x.text || x.question || '')])]
  for (const a of x.aliases || []) out.push(new Set(tokens(a.text || '')))
  return out.map((f) => new Set([...f].map(wordRoot))).filter((f) => f.size)
}
function faceMatch(ta, tb, strict) {
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared += 1
  if (shared < 3) return false
  // a word swapped for another ("native VLAN" / "allowed VLANs", "leaf" / "spine", "add" /
  // "remove"): that difference may be the point, so fold only on a wide common core. (One side
  // saying more, "in scope?" / "in scope (leaf, spine, border)?", is not a swap.)
  const onlyA = ta.size - shared
  const onlyB = tb.size - shared
  if (onlyA && onlyA === onlyB && shared < 5) return false
  const jac = shared / (ta.size + tb.size - shared)
  const ovl = shared / Math.min(ta.size, tb.size)
  return strict ? jac >= 0.6 : jac >= 0.5 || ovl >= 0.75
}
function sameIssue(a, b) {
  // equal subject keys given by an agent; a derived key (the text's first words) is no identity
  // on its own ("nautobot.interface.vlan.api" starts two different questions): the words decide
  if (a.subject && a.subject === b.subject && (a.subject_explicit || b.subject_explicit)) return true
  const strict = Boolean(a.subject_explicit && b.subject_explicit && a.subject !== b.subject)
  const fa = faces(a)
  const fb = faces(b)
  return fa.some((x) => fb.some((y) => faceMatch(x, y, strict)))
}
const IMPL = /\b(exact|precise|specific)\s+(syntax|commands?|fields?|names?|format|lines?|api|endpoints?|regex|signatures?|parameters?|keys?|path)\b|\b(command|cli)\s+(syntax|forms?|format)\b|\bsyntax\b|\bline ranges?\b|\bline numbers?\b|\blines?\s+\d+\s*[-–]\s*\d+|\b(api|json|payload|response|schema|serializer)\s+(fields?|keys?|attributes?)\b|\bfield names?\b|\battribute names?\b|\bparser\b|\bparsing\b|\bparses\b|\bregex\b|\bwhich ([\w-]+ )?(cli )?commands?\b|\bcli commands?\b|\bcommand (form|forms|format)\b/i
function classify(raw, kind) {
  if (['research', 'user', 'design'].includes(raw && raw.owner)) return raw.owner
  if (['repo', 'world'].includes(kind) && IMPL.test(`${raw.text || raw.question || ''} ${raw.draft || ''}`)) return 'design'
  if (['repo', 'world'].includes(kind)) return 'research'
  if (kind === 'decision' && ['repo', 'web'].includes(raw && raw.research)) return 'research'
  return 'user'
}
const isNone = (d) => !d || /^none\b/i.test(String(d).trim()) || /^your call\.?:?\s*$/i.test(String(d).trim())
// the v1 resolution, derived, for older readers (cli/core/clarify.js compatResolution)
const compatRes = (u) => (u.status === 'dropped' ? (u.dismissed ? 'dismissed' : 'dropped') : u.status === 'deferred_to_design' ? 'deferred' : u.status === 'settled' ? (u.settled_by === 'evidence' ? 'assumption' : u.settled_by === 'assumption_accepted' && !u.answer ? 'deferred' : 'answered') : u.status === 'proposed' ? 'question' : 'pending')
function hist(u, event, actor, text) {
  u.history = u.history || []
  u.history.push({ round: scout ? scout.round : null, event, actor, ...(text ? { text: String(text).slice(0, 300) } : {}) })
}
function settleIssue(u, by, actor, text) {
  u.status = 'settled'
  u.settled_by = by
  hist(u, `settled:${by}`, actor, text)
}
function propose(u, why) {
  u.owner = 'user'
  u.status = 'proposed'
  u.reason = String(why || 'research could not settle it').slice(0, 300)
  u.note = u.reason
  if (isNone(u.default)) u.default = u.draft
  hist(u, 'proposed', 'research', u.reason)
}

// A prior issue without v2 fields (an older brief): owner, status and subject from its v1 resolution.
function normalise(u) {
  if (!u.subject) Object.assign(u, (({ subject, explicit }) => ({ subject, subject_explicit: explicit }))(subjectOf(u)))
  if (!u.owner) u.owner = classify(u, u.kind)
  if (!u.status) {
    const r = u.resolution
    if (r === 'assumption') Object.assign(u, { status: 'settled', settled_by: 'evidence' })
    else if (r === 'answered') Object.assign(u, { status: 'settled', settled_by: 'user' })
    else if (r === 'deferred') Object.assign(u, { status: 'settled', settled_by: 'assumption_accepted' })
    else if (r === 'dismissed' || r === 'dropped') u.status = 'dropped'
    else if (r === 'question') Object.assign(u, { status: 'proposed', owner: u.owner === 'design' ? 'design' : 'user' })
    else u.status = u.owner === 'design' ? 'deferred_to_design' : u.owner === 'user' ? 'proposed' : 'open'
  }
  return u
}
function scoutState() {
  const P = SC.prior || {}
  const ids = SC.next_ids || { U: 0, E: 0, A: 0 }
  return {
    ran: true,
    round: SC.round || brief.round || null,
    web: { enabled: Boolean(SC.web && SC.web.enabled), reason: (SC.web && SC.web.reason) || null, available: null, search_mcp: (SC.web && SC.web.search_mcp) || null },
    map: { ran: false, ok: null },
    unknowns: (P.unknowns || []).map((u) => normalise({ ...u, history: (u.history || []).slice(), notes: (u.notes || []).slice(), aliases: (u.aliases || []).slice(), failed_sources: (u.failed_sources || []).slice() })),
    evidence: (P.evidence || []).map((e) => ({ ...e })),
    assumptions: (P.assumptions || []).filter((a) => !a.dropped).map((a) => ({ ...a })),
    versions: (P.versions || []).slice(),
    scouts: [],
    verifiers: 0,
    degraded: [],
    used: { repo: 0, web: 0 },
    budget: SC.budget || {},
    ids: { U: ids.U || 0, E: ids.E || 0, A: ids.A || 0 },
    raised: { created: [], folded: [], notes: [] },
  }
}
// The live issue an item is about: same_as / unknown, an alias, then the subject rule.
function findSame(raw) {
  const ref = String((raw && (raw.same_as || raw.unknown)) || '').trim().toUpperCase()
  if (/^U-\d+$/.test(ref)) {
    const hit = scout.unknowns.find((u) => u.id === ref || (u.aliases || []).some((a) => a.id === ref))
    if (hit) return hit
  }
  const s = subjectOf(raw)
  const probe = { subject: s.subject, subject_explicit: s.explicit, text: raw.text || raw.question || '' }
  return scout.unknowns.find((u) => sameIssue(probe, u)) || null
}
// Raise an issue: folded into a live one (a raise against a settled subject is a note, never
// a reopen), or created with an owner and a status.
function raise(raw, source) {
  if (!raw || !(raw.text || raw.question)) return { issue: null }
  const text = String(raw.text || raw.question)
  const hit = findSame({ ...raw, text })
  if (hit) {
    if (FINALS.has(hit.status)) {
      hit.notes = hit.notes || []
      hit.notes.push({ round: scout.round, actor: source, text: `raised again (not reopened): ${text.slice(0, 200)}` })
      scout.raised.notes.push({ issue: hit.id, source, text: text.slice(0, 200) })
    } else if (text !== hit.text) scout.raised.folded.push({ issue: hit.id, source, text: text.slice(0, 200) })
    return { issue: hit, folded: true, settled: FINALS.has(hit.status) }
  }
  const kind = KINDS.includes(raw.kind) ? raw.kind : KINDS.includes(raw.category) ? raw.category : 'user'
  const owner = classify(raw, kind)
  const s = subjectOf({ ...raw, text })
  scout.ids.U += 1
  const u = {
    id: `U-${scout.ids.U}`, subject: s.subject, subject_explicit: s.explicit, text, kind,
    impact: IMPACTS.includes(raw.impact) ? raw.impact : 'high',
    owner,
    status: owner === 'design' ? 'deferred_to_design' : owner === 'user' ? 'proposed' : 'open',
    settled_by: owner === 'design' ? 'design_deferral' : null,
    draft: String(raw.draft || text),
    ...(Array.isArray(raw.options) && raw.options.length ? { options: raw.options.slice(0, 5) } : {}),
    default: raw.default && !isNone(raw.default) ? String(raw.default) : null,
    reason: raw.reason ? String(raw.reason) : null,
    research: ['repo', 'web', 'none'].includes(raw.research) ? raw.research : kind === 'repo' ? 'repo' : kind === 'world' ? 'web' : 'none',
    ...(raw.search ? { search: String(raw.search) } : {}),
    ...(raw.why ? { why: String(raw.why) } : {}),
    evidence: [], assumption: null, question_id: null, answer: null, note: null, researched: false,
    aliases: [], attempts: 0, failed_sources: [], notes: [], history: [], applied_round: null,
    source, round: scout.round,
  }
  hist(u, owner === 'design' ? 'deferred_to_design' : 'opened', source, owner === 'design' ? 'implementation detail: settled in ground/decide' : null)
  scout.unknowns.push(u)
  scout.raised.created.push({ issue: u.id, source })
  return { issue: u, created: true }
}
// Where an issue is researched: repo / web, or null (not research's, final, or low impact).
function lane(u) {
  if (u.owner !== 'research' || FINALS.has(u.status) || u.status === 'proposed' || u.impact === 'low') return null
  if (u.kind === 'repo') return 'repo'
  if (u.kind === 'world') return 'web'
  if (u.kind === 'decision' && (u.research === 'repo' || u.research === 'web')) return u.research
  return null
}
function usable(e, u) {
  if (!e || e.verdict === 'contradicted' || e.verdict === 'unverified') return false
  if (e.verdict === 'confirmed') return true
  return e.scout === 'repo' && u.impact !== 'high' && e.confidence !== 'low'
}
// The state machine for every issue that is not final (cli/core/intent.js advance()).
function sortIssues() {
  for (const u of scout.unknowns) {
    const evs = scout.evidence.filter((e) => e.unknown === u.id)
    u.evidence = evs.map((e) => e.id)
    const a = scout.assumptions.find((x) => x.unknown === u.id)
    if (a && a.overridden && !FINALS.has(u.status)) { settleIssue(u, 'user', 'user', `changed ${a.id}`); u.assumption = a.id; continue }
    if (FINALS.has(u.status)) continue
    if (u.owner === 'design') { u.status = 'deferred_to_design'; u.settled_by = 'design_deferral'; continue }
    if (u.owner === 'research') {
      const good = evs.filter((e) => usable(e, u))
      if (good.length) {
        const statement = good.map((e) => e.claim).join('; ')
        if (a) Object.assign(a, { statement, evidence: good.map((e) => e.id) })
        else {
          scout.ids.A += 1
          scout.assumptions.push({ id: `A-${scout.ids.A}`, unknown: u.id, statement, evidence: good.map((e) => e.id) })
        }
        u.assumption = (a || scout.assumptions[scout.assumptions.length - 1]).id
        settleIssue(u, 'evidence', 'research', u.evidence.join(', '))
        continue
      }
      if (u.impact === 'low' && !evs.length) { u.note = u.note || 'low impact: assumed, not researched'; settleIssue(u, 'assumption_accepted', 'workflow', u.note); continue }
      if ((u.status === 'open' && !u.researched && !evs.length) || u.status === 'researching') continue
      const bad = evs.filter((e) => !usable(e, u))
      propose(u, u.note || (bad.length ? (bad.some((e) => e.verdict === 'contradicted') ? `sources disagree (${bad.map((e) => `${e.id} ${e.verdict}`).join(', ')})` : `research did not confirm it (${bad.map((e) => `${e.id} ${e.verdict}${e.verdict_reason ? `: ${e.verdict_reason}` : ''}`).join(', ')})`) : 'research could not settle it'))
    } else if (u.impact === 'low' && !u.question_id) {
      u.note = u.note || 'low impact: assumed, not asked'
      settleIssue(u, 'assumption_accepted', 'workflow', u.note)
    } else if (u.status === 'open') u.status = 'proposed'
    if (a) { scout.assumptions = scout.assumptions.filter((x) => x !== a); u.assumption = null }
  }
}
// Unreachable sources (HTTP errors, no network): research cannot settle these by retrying.
const UNREACHABLE = /\bHTTP\s*\d{3}\b|\b(401|403|404|410|429|500|502|503|504)\b|unreachable|could not (fetch|reach|open)|ENOTFOUND|ECONN|EAI_AGAIN|no network|no web|network error|blocked|forbidden|not found/i
// Research these issues: group them onto scouts within what is left of the budget. A retry
// gets twice the time budget and does not count against the scout caps.
async function research(list, why, retry = false) {
  const B = scout.budget
  const per = B.unknowns_per_scout || 3
  const plan = []
  for (const kind of ['repo', 'web']) {
    const mine = list.filter((u) => lane(u) === kind).sort((a, b) => IRANK[a.impact] - IRANK[b.impact])
    if (!mine.length) continue
    if (kind === 'web' && !scout.web.enabled) {
      mine.forEach((u) => { u.researched = false; propose(u, `not researched (web off${scout.web.reason ? `: ${scout.web.reason}` : ''})`) })
      continue
    }
    const cap = kind === 'repo' ? B.repo_scouts || 0 : B.web_scouts || 0
    const n = retry ? Math.ceil(mine.length / per) : Math.min(Math.max(0, cap - scout.used[kind]), Math.ceil(mine.length / per))
    const groups = Array.from({ length: n }, () => [])
    mine.slice(0, n * per).forEach((u, i) => groups[i % n].push(u))
    mine.slice(n * per).forEach((u) => { u.researched = true; propose(u, `not researched (${kind} research budget spent)`) })
    groups.forEach((g, gi) => {
      if (!retry) scout.used[kind] += 1
      plan.push({ kind, unknowns: g, label: retry ? `scout · ${kind} #${gi + 1} (retry)` : `scout · ${kind} #${scout.used[kind]}` })
    })
  }
  if (!plan.length) return
  phase(`clarify: scout · research ${plan.reduce((k, p) => k + p.unknowns.length, 0)} unknown(s) with ${plan.length} scout(s)${why ? ` (${why})` : ''}`)
  runs += plan.length
  const slim = (u) => ({ id: u.id, text: u.text, kind: u.kind, impact: u.impact, claim_to_check: u.draft, ...(u.options ? { options: u.options } : {}), ...(u.search ? { start_at: u.search } : {}), ...((u.failed_sources || []).length ? { do_not_fetch_again: u.failed_sources.map((f) => f.source) } : {}) })
  const time = retry ? (B.time_sec || 120) * 2 : B.time_sec
  const outs = await pipeline(plan, (p) => {
    const spec = p.kind === 'repo' ? SC.repo_scout : SC.web_scout
    return call(spec.prompt_template.replace('{{unknowns}}', JSON.stringify(p.unknowns.map(slim), null, 2)), opts(spec, p.label, null, time))
  })
  const fresh = []
  plan.forEach((p, i) => {
    const o = outs[i]
    scout.scouts.push({ label: p.label, mode: p.kind, unknowns: p.unknowns.map((u) => u.id), outcome: o ? 'ok' : 'no_result', ...(retry ? { retry: true } : {}) })
    p.unknowns.forEach((u) => { u.researched = true; u.attempts = (u.attempts || 0) + 1 })
    if (!o) {
      scout.degraded.push(p.label)
      p.unknowns.forEach((u) => {
        if (u.attempts < 2) { u.status = 'researching'; u.note = `the ${p.kind} scout failed or ran out of time: one retry with a longer budget`; hist(u, 'researching', 'research', u.note) }
        else propose(u, `not verified: the ${p.kind} scout failed or ran out of time twice`)
      })
      return
    }
    for (const fsrc of o.failed_sources || []) {
      const u = p.unknowns.find((x) => x.id === fsrc.unknown) || (p.unknowns.length === 1 ? p.unknowns[0] : null)
      if (u && fsrc.source && !(u.failed_sources || []).some((x) => x.source === fsrc.source)) u.failed_sources = [...(u.failed_sources || []), { source: String(fsrc.source).slice(0, 300), reason: String(fsrc.reason || '').slice(0, 160) }]
    }
    if (p.kind === 'web') {
      if (o.web_available === false) {
        scout.web.available = false
        p.unknowns.forEach((u) => propose(u, 'not verified: no web access (no network or no web tool)'))
      } else if (scout.web.available === null) scout.web.available = true
    }
    for (const v of o.versions || []) if (v && v.name && !scout.versions.some((x) => x.name === v.name)) scout.versions.push(v)
    const mine = new Set(p.unknowns.map((u) => u.id))
    for (const e of o.evidence || []) {
      if (!e || !mine.has(e.unknown)) continue
      if (p.kind === 'web' && o.web_available === false) continue
      scout.ids.E += 1
      const ev = { id: `E-${scout.ids.E}`, ...e, scout: p.kind, verdict: 'unchecked', round: scout.round }
      scout.evidence.push(ev)
      fresh.push(ev)
    }
    for (const r of p.kind === 'web' && o.web_available === false ? [] : o.unresolved || []) {
      const u = p.unknowns.find((x) => x.id === r.unknown)
      if (!u || scout.evidence.some((e) => e.unknown === u.id)) continue
      const reach = UNREACHABLE.test(String(r.reason || '')) || (u.failed_sources || []).length > 0
      propose(u, `${reach ? 'source unreachable' : 'research found nothing conclusive'}: ${r.reason}`)
    }
    p.unknowns.filter((u) => u.status === 'researching').forEach((u) => { u.status = 'open' })
  })
  await verify(fresh)
  sortIssues()
}
// The verifier re-checks web findings and high-impact ones; strict (high risk): a confirmed
// high-impact finding without a second independent source stays unverified. A verifier that
// times out leaves its findings unverified: those issues go to the user (no automatic retry).
async function verify(list) {
  const B = scout.budget
  const byU = Object.fromEntries(scout.unknowns.map((u) => [u.id, u]))
  const todo = list.filter((e) => e.scout === 'web' || (byU[e.unknown] && byU[e.unknown].impact === 'high'))
  if (!todo.length || !SC.verifier) return
  const size = B.verifier_batch || 4
  const batches = []
  for (let i = 0; i < todo.length && batches.length < (B.max_verifiers || 2); i += size) batches.push(todo.slice(i, i + size))
  todo.slice(batches.length * size).forEach((e) => { e.verdict_reason = 'not re-checked (verifier budget spent)' })
  phase(`clarify: scout · verify ${batches.reduce((k, b) => k + b.length, 0)} finding(s)`)
  runs += batches.length
  const labels = batches.map(() => { scout.verifiers += 1; return `verify evidence #${scout.verifiers}` })
  const jobs = batches.map((b, i) => ({ b, label: labels[i] }))
  const outs = await pipeline(jobs, (j) => call(SC.verifier.prompt_template.replace('{{findings}}', JSON.stringify({ findings: j.b.map((e) => ({ ...e, impact: (byU[e.unknown] || {}).impact || null })), versions: scout.versions }, null, 2)), opts(SC.verifier, j.label, null, B.time_sec)))
  batches.forEach((b, i) => {
    const o = outs[i]
    if (!o) {
      scout.degraded.push(labels[i])
      b.forEach((e) => { e.verdict = e.scout === 'web' || (byU[e.unknown] && byU[e.unknown].impact === 'high') ? 'unverified' : e.verdict; e.verdict_reason = 'the verifier failed or ran out of time' })
      return
    }
    for (const v of o.verdicts || []) {
      const e = b.find((x) => x.id === v.evidence_id)
      if (!e) continue
      e.verdict = ['confirmed', 'contradicted', 'unverified'].includes(v.verdict) ? v.verdict : 'unverified'
      if (v.quote_found === false && e.verdict === 'confirmed') e.verdict = 'unverified'
      if (v.version_applies === false && e.verdict === 'confirmed') e.verdict = 'unverified'
      e.verdict_confidence = v.confidence || null
      e.verdict_reason = v.reason || null
      e.second_source = v.second_source || null
      e.counter_source = v.counter_source || null
      const u = byU[e.unknown]
      if (B.strict_second_source && u && u.impact === 'high' && e.verdict === 'confirmed' && !(v.second_source && v.second_source.source)) {
        e.verdict = 'unverified'
        e.verdict_reason = `${v.reason || ''} (high risk: no independent second source)`.trim()
      }
    }
    b.filter((e) => e.verdict === 'unchecked' && e.scout === 'web').forEach((e) => { e.verdict = 'unverified'; e.verdict_reason = 'the verifier gave no verdict' })
  })
}
async function scoutPhase() {
  scout = scoutState()
  if (SC.map_needed) {
    phase('clarify: scout · map the unknowns')
    const m = await one(SC.mapper.prompt, SC.mapper, 'intent map', (SC.budget && SC.budget.mapper_sec) || null, true)
    scout.map = { ran: true, ok: Boolean(m) }
    if (!m) scout.degraded.push('intent-mapper')
    else for (const u of (m.unknowns || []).slice(0, (SC.budget && SC.budget.max_unknowns) || 12)) raise(u, 'mapper')
  }
  sortIssues()
  const pend = new Set(SC.pending || [])
  const todo = scout.unknowns.filter((u) => (u.status === 'open' || u.status === 'researching' || pend.has(u.id)) && lane(u))
  await research(todo, '')
  // one retry, with a longer budget, for what a failed or timed-out scout left behind
  const again = scout.unknowns.filter((u) => u.status === 'researching' && (u.attempts || 0) < 2 && lane(u))
  if (again.length) await research(again, 'retry with a longer budget', true)
  scout.unknowns.filter((u) => u.status === 'researching').forEach((u) => propose(u, u.note || 'research did not finish'))
  sortIssues()
}
// What the analysts, the judge and God Eye are given: the research and the ledger.
function openQuestions() {
  return scout.unknowns.filter((u) => u.status === 'proposed' && u.owner === 'user' && !u.question_id && u.impact !== 'low').map((u) => ({
    unknown: u.id, subject: u.subject, kind: u.kind, impact: u.impact, ask: u.draft, ...(u.options ? { options: u.options } : {}), default: u.default || null, evidence: u.evidence, reason: u.reason || u.note || null,
    preference: ['user', 'intent', 'scope', 'constraint', 'acceptance', 'decision'].includes(u.kind) || !u.evidence.length,
  }))
}
function ledgerView() {
  const L = LG || {}
  const brief1 = (u) => ({ id: u.id, subject: u.subject, text: String(u.text).slice(0, 200), kind: u.kind, owner: u.owner, status: u.status, ...(u.question_id ? { question: u.question_id } : {}), ...(u.answer ? { answer: String(u.answer).slice(0, 200) } : {}), ...(u.settled_by ? { settled_by: u.settled_by } : {}) })
  return {
    rules: 'The issue ledger is the single list of what is open. Never re-raise a settled issue (use same_as with its id; a raise against a settled subject is only noted). Ask only about the open issues; raise a new one only when no listed issue covers it, with same_as "new" and a short subject key. Implementation detail (exact API field names, source line ranges, command syntax, parser behaviour) is design\'s: owner "design", never a question for the user.',
    settled_do_not_reraise: scout.unknowns.filter((u) => u.status === 'settled' || u.status === 'dropped').map(brief1),
    open_the_only_things_to_ask_about: scout.unknowns.filter((u) => !FINALS.has(u.status)).map(brief1),
    deferred_to_design_not_yours: scout.unknowns.filter((u) => u.status === 'deferred_to_design').map(brief1),
    new_since_last_round: L.new_since || {},
    contract_sections_changed: L.changed_sections || null,
    contract_sections_settled: L.settled_sections || [],
  }
}
function evidenceBlock() {
  if (!scout) return ''
  const view = {
    rules: 'Research came first. Never ask what an assumption or confirmed evidence answers. Every question names its issue (U-n) and either cites evidence (E-n) for its default or is preference: true ("your call"). Ask a repo or world issue only when research could not settle it, and say why.',
    web_research: scout.web,
    versions: scout.versions,
    findings: scout.evidence.map((e) => ({ id: e.id, unknown: e.unknown, claim: e.claim, source: e.source, source_tier: e.source_tier, retrieved_at: e.retrieved_at || null, applies_to_version: e.applies_to_version || null, confidence: e.confidence, verdict: e.verdict })),
    assumptions: scout.assumptions.map((a) => ({ id: a.id, unknown: a.unknown, statement: a.statement, evidence: a.evidence, ...(a.overridden ? { overridden_by_user: true } : {}) })),
    must_ask: openQuestions(),
    unknowns: scout.unknowns.map((u) => ({ id: u.id, subject: u.subject, text: u.text, kind: u.kind, impact: u.impact, owner: u.owner, status: u.status, resolution: compatRes(u), ...(u.note ? { note: u.note } : {}) })),
  }
  return `\n\nINTENT EVIDENCE:\n${JSON.stringify(view, null, 2)}\n\nCLARIFY LEDGER:\n${JSON.stringify(ledgerView(), null, 2)}`
}
// Judge and analyst questions go through the ledger: a question about a settled issue is
// dropped (noted), an implementation detail is deferred to design, a new research-owned one
// is researched first (once, within the budget).
function groundQuestions(list) {
  const keep = []
  const researchable = []
  const fresh = []
  for (const q of list || []) {
    if (!q || !q.question) continue
    const r = raise({ ...q, text: q.question, kind: q.kind || q.category, impact: q.impact || 'high', draft: q.question }, 'judge')
    const u = r.issue
    if (!u) continue
    if (u.status === 'settled' && u.settled_by === 'evidence') { researchable.push({ question: q.question, unknown: u.id, evidence: u.evidence, reason: `research answered it (${u.assumption || u.evidence.join(', ')})` }); continue }
    if (FINALS.has(u.status)) continue
    if (u.owner === 'research' && u.status === 'open' && !u.researched) { fresh.push(u); continue }
    if (u.question_id) continue
    keep.push({ ...q, unknown: u.id, kind: u.kind, subject: u.subject })
  }
  return { keep, researchable, fresh }
}
// The ledger's own proposals are asked even if the judge left them out (research could not
// settle them, God Eye's blockers, decisions, user issues), with their reason and default.
function ledgerAsks(questions, dismissed) {
  const covered = new Set([...(questions || []).map((q) => String(q.unknown || '').toUpperCase()), ...(dismissed || []).map((d) => String(d.unknown || '').toUpperCase())])
  const cat = (k) => (['intent', 'scope', 'constraint', 'acceptance'].includes(k) ? k : k === 'user' || k === 'decision' ? 'scope' : 'constraint')
  return openQuestions().filter((q) => !covered.has(q.unknown)).map((q) => ({
    question: /\?$/.test(q.ask) ? q.ask : ['repo', 'world'].includes(q.kind) ? `Is this right: ${q.ask}?` : q.ask,
    category: cat(q.kind),
    why: q.reason ? `${['repo', 'world'].includes(q.kind) ? 'Research could not settle it' : 'Open'}: ${q.reason}.` : 'Only you can settle it.',
    default: q.default || 'None: answer needed', unknown: q.unknown, kind: q.kind, evidence: q.evidence, preference: q.preference, ...(q.options ? { options: q.options } : {}),
  }))
}
const budgetLeft = (kind) => (kind === 'repo' ? (scout.budget.repo_scouts || 0) - scout.used.repo : scout.web.enabled ? (scout.budget.web_scouts || 0) - scout.used.web : 0)
if (SC) await scoutPhase()

// ---- clarify: the contract editor (one writer: it returns the text, the CLI writes it) ----
let revised = null
const edits = []
async function editContract(todo, label) {
  if (!brief.editor || !todo.length) return null
  if (label === 'God Eye\'s items') phase(`clarify: contract editor (God Eye's items)`)
  else phase('clarify: contract editor (apply what was settled)')
  const r = await one(`${brief.editor.prompt}\n\nCHANGES TO APPLY:\n${JSON.stringify(todo, null, 2)}${revised ? `\n\nCURRENT CONTRACT (revised earlier this round; edit this text, not the file):\n----- BEGIN CONTRACT -----\n${revised}\n----- END CONTRACT -----` : ''}`, brief.editor, `contract editor · ${label}`)
  if (!r || typeof r.contract !== 'string' || !r.contract.trim()) { edits.push({ label, ok: false }); return null }
  revised = r.contract
  // requested: what the editor was given (the CLI accepts a removal only for a settled issue or a
  // God Eye item, note or denial it was given); removed: what it took out, and why
  edits.push({ label, ok: true, applied: r.applied || [], skipped: r.skipped || [], removed: r.removed || [], requested: todo.map((t) => ({ from: t.from, ref: t.ref || null })) })
  for (const s of r.skipped || []) if (scout && s && s.question) raise({ text: s.question, kind: 'scope', owner: 'user', impact: 'high', default: s.default || null, reason: s.reason || null }, 'contract-editor')
  return r
}
const revisedBlock = () => (revised ? `\n\nREVISED CONTRACT (this round's revision of the contract file; the CLI writes it when it records the round, so read this text instead of the file):\n----- BEGIN CONTRACT -----\n${revised}\n----- END CONTRACT -----` : '')
const ctxBlock = () => `${brief.config === 'clarify' ? evidenceBlock() : ''}${revisedBlock()}`
if (brief.config === 'clarify' && brief.editor && (brief.editor.todo || []).length) await editContract(brief.editor.todo, 'apply what was settled')

// ---- 1. fan-out (clarify: the intent gate runs first and alone; a later round with nothing
// changed and nothing new skips the analysts and the judge: the ledger's proposals are asked)
const quiet = brief.config === 'clarify' && LG && LG.nothing_new === true && !revised
const gate = brief.config === 'clarify' && !quiet ? brief.fanout.filter((f) => f.gate || f.category === 'intent') : []
const rest = quiet ? [] : brief.fanout.filter((f) => !gate.includes(f))
const outs = brief.fanout.map(() => null)
const put = (list, res) => list.forEach((f, i) => { outs[brief.fanout.indexOf(f)] = res[i] || null })
if (quiet) log('Nothing changed since the last round and nothing new came in: the analysts and the judge are skipped; the ledger\'s open questions are asked.')
if (gate.length) {
  phase(`clarify: intent gate (${gate.length})`)
  put(gate, await fan(gate))
}
const intentOpen = gate.some((f) => { const o = outs[brief.fanout.indexOf(f)]; return Boolean(o && (o.questions || []).some((q) => q.blocking)) })
async function fanRest() {
  if (!rest.length) return
  phase(`${brief.config}: fan-out (${rest.length})`)
  put(rest, await fan(rest))
}
if (!intentOpen) await fanRest()
else log(`Intent is not clear yet: holding back ${rest.map((f) => f.id).join(', ')}`)
const inputsNow = () => brief.fanout.map((f, i) => ({ id: f.id, ...(f.category ? { category: f.category } : {}), output: outs[i] })).filter((x) => x.output)
const degradedNow = (held) => [...(scout && scout.degraded.includes('intent-mapper') ? ['intent-mapper'] : []), ...brief.fanout.filter((f, i) => !outs[i] && !held.includes(f) && (!quiet || brief.config !== 'clarify')).map((f) => f.id)]

// ---- clarify question protocol (factory record re-applies it): intent first and alone,
// then scope > constraint > acceptance; never re-ask; at most limits.max_questions.
const PRI = (brief.limits && brief.limits.priority) || ['intent', 'scope', 'constraint', 'acceptance']
function shape(list) {
  const key = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const seen = new Set((brief.asked || []).map(key))
  const seenU = new Set()
  const dropped = []
  const ok = []
  for (const q of list || []) {
    if (!q || !q.question) continue
    if (seen.has(key(q.question))) { dropped.push({ question: q.question, reason: 'already asked' }); continue }
    if (q.unknown && seenU.has(q.unknown)) { dropped.push({ question: q.question, reason: `same issue as another question (${q.unknown})` }); continue }
    seen.add(key(q.question))
    if (q.unknown) seenU.add(q.unknown)
    ok.push({ ...q, category: PRI.includes(q.category) ? q.category : 'scope' })
  }
  const open = ok.some((q) => q.category === 'intent')
  const held = open ? ok.filter((q) => q.category !== 'intent') : []
  const pick = (open ? ok.filter((q) => q.category === 'intent') : ok).map((q, i) => ({ q, i })).sort((a, b) => PRI.indexOf(a.q.category) - PRI.indexOf(b.q.category) || a.i - b.i).map((x) => x.q)
  const max = brief.limits && typeof brief.limits.max_questions === 'number' ? brief.limits.max_questions : pick.length
  pick.slice(max).forEach((q) => dropped.push({ question: q.question, reason: 'over budget' }))
  return { questions: pick.slice(0, max), held, dropped, intent_open: open }
}

// God Eye's verdict through the checklist: every item points at an AC, a section or an issue.
// About a settled issue or a duplicate subject → a note; a pointed blocker or major → actionable
// (the contract editor revises, God Eye looks once more); what stays a blocker becomes a user
// issue whose default is God Eye's suggestion; the rest are notes (approve-with-notes).
const notes = []
function triage(c) {
  const actionable = []
  if (!c) return { actionable, approved: false }
  const approved = c.verdict === 'approve' && c.intent_confirmed !== false
  if (c.intent_confirmed === false) {
    const r = c.restatement || {}
    actionable.push({ ref: 'Intent', severity: 'blocker', issue: `God Eye could not confirm the intent from the contract; it reads it as: ${[r.problem, r.outcome].filter(Boolean).join(' → ')}`, suggestion: `Align the Intent and Goal with: problem "${r.problem || ''}", who "${r.who || ''}", outcome "${r.outcome || ''}", success "${r.success || ''}"`, subject: 'intent.restatement', kind: 'intent' })
  }
  for (const it of c.items || []) {
    if (!it || !it.issue) continue
    const ref = String(it.ref || '').trim()
    const refU = /^U-\d+$/i.test(ref) ? scout && scout.unknowns.find((u) => u.id === ref.toUpperCase() || (u.aliases || []).some((a) => a.id === ref.toUpperCase())) : null
    const same = scout && (it.same_as || it.subject) ? findSame({ text: it.issue, same_as: it.same_as, subject: it.subject }) : null
    const known = refU || (same && FINALS.has(same.status) ? same : null)
    if (known && FINALS.has(known.status)) { notes.push({ ref: known.id, severity: it.severity, text: `already settled (${known.status}${known.settled_by ? `: ${known.settled_by}` : ''}): ${it.issue}` }); continue }
    if (refU) { notes.push({ ref: refU.id, severity: it.severity, text: `tracked as ${refU.id}: ${it.issue}` }); continue }
    if (ref && ['blocker', 'major'].includes(it.severity)) actionable.push({ ...it, ref })
    else notes.push({ ref: ref || null, severity: it.severity, text: it.issue })
  }
  return { actionable, approved }
}
const kindOfRef = (ref) => (/^(E-)?AC-\d+/i.test(ref) || /acceptance/i.test(ref) ? 'acceptance' : /intent|goal/i.test(ref) ? 'intent' : /non-goal|scope|allowed/i.test(ref) ? 'scope' : 'constraint')

// ---- 2. config-specific ----
if (brief.config === 'clarify') {
  const judgeOnce = (note, label = 'judge') => one(`${brief.judge.prompt}${note}${ctxBlock()}\n\nINPUTS:\n${JSON.stringify(inputsNow(), null, 2)}`, brief.judge, label)
  let judge = { questions: [], dismissed: [], held: [] }
  let held = intentOpen ? rest : []
  let researchable = []
  if (!quiet) {
    phase('clarify: judge')
    judge = await judgeOnce(intentOpen ? '\n\nINTENT GATE: the intent is not clear yet, so the other angles were held back. Ask only intent questions this round.' : '')
    if (judge && intentOpen && !shape(judge.questions).intent_open) {
      // the judge found the intent clear after all: run the held angles and judge again
      held = []
      await fanRest()
      phase('clarify: judge (all angles)')
      judge = await judgeOnce('')
    }
    // Research before asking: a question about a new research-owned issue goes to the
    // scouts first (once, within the budget), then the judge sees the evidence.
    if (judge && scout) {
      const g = groundQuestions(judge.questions)
      const go = g.fresh.filter((u) => budgetLeft(lane(u)) > 0)
      g.fresh.filter((u) => !go.includes(u)).forEach((u) => { u.researched = true; propose(u, `raised in clarify after research ran; ${lane(u) || 'research'} budget spent`) })
      if (go.length) {
        await research(go, 'raised by the judge')
        phase('clarify: judge (with the new evidence)')
        const again = await judgeOnce('\n\nNEW EVIDENCE: some of your questions were researched; do not ask what the evidence below now answers.', 'judge (after research)')
        if (again) judge = again
      }
      const g2 = groundQuestions(judge.questions)
      researchable = [...g.researchable.filter((r) => !g2.researchable.some((x) => x.question === r.question)), ...g2.researchable]
      judge = { ...judge, questions: g2.keep }
    }
  }
  const degraded = degradedNow(held)
  const inputs = inputsNow()
  if (degraded.length) log(`No result after retry: ${degraded.join(', ')}`)
  if (!judge) return envelope('error', 'The judge returned nothing twice.', { analysts: inputs, degraded })
  const withLedger = (j) => (scout ? [...(j.questions || []), ...ledgerAsks(j.questions, j.dismissed)] : j.questions || [])
  let shaped = shape(withLedger(judge))
  let critique = null
  const critiques = []
  if (shaped.questions.length === 0 && !shaped.intent_open && (degraded.length === 0 || brief.accept_degraded)) {
    const godEye = async (label, extra = '') => {
      phase(`clarify: God Eye (intent${label ? `, ${label}` : ''})`)
      const c = await one(`${brief.critique.prompt}${ctxBlock()}${extra}`, brief.critique, `god-eye · intent${label ? ` (${label})` : ''}`)
      if (c) critiques.push(c)
      return c
    }
    critique = await godEye('')
    // Researchable questions God Eye marks as blockers go back to the scouts (once, within
    // the budget), through the subject dedup; the rest are notes.
    const rq = (critique && critique.researchable_questions) || []
    if (scout && rq.length) {
      const fresh = []
      for (const q of rq) {
        if (q.blocker !== true || !q.why) { notes.push({ ref: [q.unknown, q.same_as].find((x) => /^U-\d+$/i.test(String(x || ''))) || null, severity: 'minor', text: `not a blocker: ${q.question}` }); continue }
        const r = raise({ text: q.question, kind: q.kind, impact: 'high', draft: q.question, why: q.why, same_as: q.same_as || q.unknown, subject: q.subject }, 'god-eye')
        if (r.created && r.issue.owner === 'research') fresh.push(r.issue)
      }
      const go = fresh.filter((u) => budgetLeft(lane(u)) > 0)
      fresh.filter((u) => !go.includes(u)).forEach((u) => { u.researched = true; propose(u, `raised by God Eye; ${lane(u) || 'research'} budget spent`) })
      if (go.length) {
        await research(go, 'sent back by God Eye')
        const again = await godEye('with the new evidence', '\n\nNEW EVIDENCE: your blocking researchable questions were researched; list only what is still open.')
        if (again) critique = again
      }
    }
    let t = triage(critique)
    if (critique && !t.approved && t.actionable.length && brief.editor) {
      const r = await editContract(t.actionable.map((a) => ({ from: 'god-eye', ref: a.ref, severity: a.severity, issue: a.issue, suggestion: a.suggestion || null })), 'God Eye\'s items')
      if (r) {
        const again = await godEye('after the revision', '\n\nREVISION: the contract was revised for your items (REVISED CONTRACT above). Judge the revised text; list only what is still wrong.')
        if (again) { critique = again; t = triage(again) }
      }
    }
    // What is still an actionable blocker becomes ONE user question each, with God Eye's
    // suggestion as the default (one word to accept); majors and the rest are notes.
    if (critique && !t.approved && scout) {
      for (const a of t.actionable) {
        if (a.severity !== 'blocker') { notes.push({ ref: a.ref, severity: a.severity, text: a.issue }); continue }
        const r = raise({ text: a.issue, kind: a.kind || kindOfRef(a.ref), owner: 'user', impact: 'high', draft: a.issue, default: a.suggestion || null, reason: `God Eye (${a.ref})`, subject: a.subject, same_as: a.same_as }, 'god-eye')
        if (r.settled) notes.push({ ref: r.issue.id, severity: a.severity, text: `already settled: ${a.issue}` })
      }
    }
    // Without a ledger (no scout phase) the blockers are asked directly.
    const direct = critique && !t.approved && !scout ? t.actionable.filter((a) => a.severity === 'blocker').map((a) => ({ question: a.kind === 'intent' ? `${a.issue}. Is that the intent?` : `${a.issue}: ${a.suggestion || 'how should the contract say it'}?`, category: a.kind || kindOfRef(a.ref), why: `God Eye (${a.ref})`, default: a.kind === 'intent' ? 'None: the factory will not guess the intent' : a.suggestion || 'None: answer needed' })) : []
    // God Eye's blockers (and research it sent back that could not settle) are questions now
    if (critique) shaped = shape([...withLedger(judge), ...direct])
  }
  const approved = Boolean(critique && critique.verdict === 'approve' && critique.intent_confirmed !== false)
  const withNotes = Boolean(critique && !approved && !shaped.questions.length)
  const status = degraded.length && !brief.accept_degraded ? 'degraded' : shaped.questions.length ? 'needs_user' : critique ? 'ok' : 'needs_user'
  const summary = degraded.length
    ? `Missing angle(s): ${degraded.join(', ')}.`
    : shaped.questions.length
      ? `${shaped.questions.length} ${shaped.intent_open ? 'intent ' : ''}question(s) for you.${held.length ? ` Held until intent is clear: ${held.map((f) => f.id).join(', ')}.` : ''}`
      : critique ? `God Eye: ${approved ? 'approve' : withNotes ? `approve with notes (${notes.length})` : critique.verdict}.` : 'No critique.'
  if (scout) for (const u of scout.unknowns) u.resolution = compatRes(u)
  const scoutData = scout ? { ...scout, open: openQuestions(), researchable_dropped: researchable } : null
  const researchNote = scout ? ` Ledger: ${scout.unknowns.length} issue(s), ${scout.unknowns.filter((u) => FINALS.has(u.status)).length} closed, ${scout.raised.created.length} new, ${scout.raised.folded.length + scout.raised.notes.length} raised again and folded; ${scout.evidence.length} finding(s)${scout.degraded.length ? `, degraded: ${scout.degraded.join(', ')}` : ''}.` : ''
  const contract = revised ? { text: revised, edits } : edits.length ? { text: null, edits } : null
  return envelope(status, `${summary}${researchNote}`, { analysts: inputs, degraded, quiet, intent_open: shaped.intent_open || (intentOpen && held.length > 0), held_back: held.map((f) => f.id), judge: { ...judge, questions: shaped.questions, held: [...(judge.held || []), ...shaped.held.map((q) => ({ question: q.question, category: q.category }))], over_budget_or_repeat: shaped.dropped }, critique, critiques: critiques.length, approved_with_notes: withNotes, notes, ...(contract ? { contract } : {}), ...(scoutData ? { scout: scoutData } : {}) }, { questions: shaped.questions })
}

const degraded = degradedNow([])
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
  let verifications = []
  if (serious.length) {
    phase(`challenge: verify ${serious.length} finding(s)`)
    const items = serious.map((f) => ({
      prompt: brief.verifier.prompt_template.replace('{{finding}}', JSON.stringify(f, null, 2)),
      schema: brief.verifier.schema,
      agent_type: brief.verifier.agent_type,
      model: brief.verifier.model,
      label: `verify ${f.id}`,
    }))
    const res = await fan(items)
    verifications = res.map((r, i) => (r ? { ...r, finding_id: serious[i].id } : null)).filter(Boolean)
  }
  const confirmed = verifications.filter((v) => v.status === 'confirmed').length
  const unverifiable = verifications.filter((v) => v.status === 'unverifiable').length
  const summary = `${lanes.length}/${brief.fanout.length} lane(s) reviewed; ${serious.length} serious finding(s), ${confirmed} confirmed${unverifiable ? `, ${unverifiable} unverifiable` : ''}.${degraded.length ? ` Missing lanes: ${degraded.join(', ')}.` : ''}`
  return envelope(degraded.length ? 'degraded' : 'ok', summary, { lanes, degraded, verifications }, { fingerprint: brief.fingerprint || null, lanes_requested: brief.lanes_requested || null })
}

throw new Error(`Unknown config ${brief.config}`)
