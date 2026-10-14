'use strict';
// factory-inspect — audits the Software Factory from the outside.
// It reads the factory's sealed records and each job's declared rulebook, checks what
// happened against what was promised, and keeps a register of findings for you.
// It never blocks, approves or changes a job, a recipe or a policy.

const path = require('path');
const { findRoot, nowIso } = require('./io');
const { observe, isRouting } = require('./observe');
const rules = require('./rules');
const model = require('./model');
const register = require('./register');
const config = require('./config');

function requireRoot(opt) {
  const root = findRoot(opt.root ? path.resolve(opt.root) : process.cwd());
  if (!root) throw Object.assign(new Error('No .factory/ here or above: nothing to inspect.'), { code: 'no_factory' });
  return root;
}

function humanOnly(channel) {
  if (channel === 'chat') return;
  if (channel === 'tty' && process.stdin.isTTY && process.stdout.isTTY) return;
  throw Object.assign(new Error('This is a human-only action. Reply in chat (e.g. "ack finding F3", "inspect mode bug@low sample 10") or run it from your own terminal.'), { code: 'human_only' });
}

// pending: closed jobs not yet inspected since they closed. explicit: the given job (any status).
// active: also every active or parked job, as it stands now (issues happen mid-job).
function run(root, { job: only, all = false, active = false } = {}) {
  const obs = observe(root);
  const cfg = config.load(root);
  const reg = register.load(root);
  const result = { at: nowIso(), inspected: [], skipped: [], added: [], reopened: [], rearmed: [] };
  const opts = { limits: cfg.limits, now: result.at };
  const keep = (list) => list.filter((fd) => config.ruleOn(cfg, fd.rule));
  const ids = only ? [only] : Object.keys(obs.jobs);

  for (const id of ids) {
    const job = obs.jobs[id];
    if (!job) {
      result.skipped.push({ job: id, why: 'no such job' });
      continue;
    }
    const status = job.state ? job.state.status : 'unknown';
    const prior = reg.inspected[id];
    const isClosed = ['closed', 'cancelled', 'abandoned'].includes(status);
    const isLive = ['active', 'parked'].includes(status);
    if (!only && !all && !(active && isLive) && (!isClosed || (prior && prior.status === status))) continue;
    const recipeId = (job.lock && job.lock.id) || (job.state && job.state.recipe && job.state.recipe.id) || 'unknown';
    const rulebook = model.rulebookKey(job.lock);
    const re = config.rearmIfChanged(cfg, recipeId, rulebook);
    if (re.rearmed) result.rearmed.push({ recipe: recipeId, was: re.was || 'default' });
    const gate = config.shouldInspect(cfg, recipeId, id);
    if (!only && !gate.inspect) {
      result.skipped.push({ job: id, why: gate.why });
      reg.inspected[id] = { at: nowIso(), status, skipped: gate.why, rulebook };
      continue;
    }
    const found = keep(rules.inspectJob(job, opts));
    const m = register.merge(reg, found, rulebook);
    result.added.push(...m.added);
    result.reopened.push(...m.reopened);
    const ids4job = [...m.added, ...m.reopened, ...m.seen];
    result.inspected.push({ job: id, recipe: recipeId, status, findings: ids4job.length });
    if (isClosed && !(prior && prior.status === status && !prior.skipped)) {
      const r = config.recipeCfg(cfg, recipeId);
      r.inspected = (r.inspected || 0) + 1;
      const counted = reg.findings.filter((x) => ids4job.includes(x.id) && x.status !== 'wont_fix');
      r.streak = counted.length ? 0 : (r.streak || 0) + 1;
    }
    reg.inspected[id] = { at: nowIso(), status, findings: ids4job, rulebook };
  }

  const g = register.merge(reg, keep(rules.inspectGlobal(obs, cfg.threshold, opts)), null);
  result.added.push(...g.added);
  result.reopened.push(...g.reopened);
  reg.runs.push({ at: result.at, scope: only || (all ? 'all' : active ? 'pending+active' : 'pending'), inspected: result.inspected.length, added: result.added.length, reopened: result.reopened.length });
  reg.runs = reg.runs.slice(-200);
  register.save(root, reg);
  config.save(root, cfg);
  result.open = counts(reg);
  result.suggestions = config.suggestions(cfg);
  return result;
}

// Cheap check for hooks that run often: closed/cancelled/abandoned jobs whose current status
// the register hasn't seen yet. Reads only each job's state.json, not the logs.
function pending(root) {
  const L = require('./io').layout(root);
  const { readJson } = require('./io');
  const reg = register.load(root);
  let ids = [];
  try { ids = require('fs').readdirSync(L.jobs).filter((d) => /^J-\d+$/.test(d)); } catch { return []; }
  return ids.filter((id) => {
    const st = readJson(L.job(id).state, null);
    const status = st && st.status;
    if (!['closed', 'cancelled', 'abandoned'].includes(status)) return false;
    const prior = reg.inspected[id];
    return !(prior && prior.status === status);
  });
}

// One line for a run's result, or null when it found nothing worth saying.
function summary(r) {
  if (!r.inspected.length && !r.added.length && !r.reopened.length && !r.rearmed.length) return null;
  const parts = [];
  if (r.inspected.length) parts.push(`inspected ${r.inspected.map((i) => i.job).join(', ')}`);
  if (r.added.length || r.reopened.length) parts.push(`${r.added.length} new finding(s)${r.reopened.length ? `, ${r.reopened.length} came back` : ''} — ${r.open.open} open (${r.open.high} high)`);
  else parts.push('no new findings');
  if (r.rearmed.length) parts.push(`rules changed for ${r.rearmed.map((x) => x.recipe).join(', ')}: inspecting every job again`);
  if (r.suggestions.length) parts.push(`suggestion: ${r.suggestions[0].suggest} (${r.suggestions[0].why})`);
  return `[inspector] ${parts.join('; ')}.`;
}

function counts(reg) {
  const open = reg.findings.filter((x) => x.status === 'open');
  return { open: open.length, high: open.filter((x) => x.severity === 'high').length, deviations: open.filter((x) => x.class === 'deviation').length, ambiguities: open.filter((x) => x.class === 'ambiguity').length, gaps: open.filter((x) => x.class === 'gap').length };
}

function report(root, { status = 'open', health: withHealth = true } = {}) {
  const reg = register.load(root);
  const want = status === 'all' ? null : status === 'open' ? ['open', 'acknowledged'] : [status];
  const sev = { high: 0, medium: 1, low: 2 };
  const list = reg.findings.filter((x) => !want || want.includes(x.status)).sort((a, b) => sev[a.severity] - sev[b.severity] || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { counts: counts(reg), findings: list, ...(withHealth ? { health: health(root) } : {}) };
}

// Factory-wide health: what the factory says about itself, counted, whatever the findings.
function health(root, { now = nowIso() } = {}) {
  const obs = observe(root);
  const L = config.load(root).limits;
  const ev = obs.events;
  const by = (pred) => ev.filter(pred);
  const top = (items, keyFn, n = 3) => [...items.reduce((m, x) => m.set(keyFn(x), (m.get(keyFn(x)) || 0) + 1), new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));
  const jobs = Object.values(obs.jobs);
  const cli = by((e) => e.event === 'cli');
  const failed = cli.filter((e) => e.ok === false);
  const ledger = jobs.flatMap((j) => j.ledger);
  const runs = ledger.filter((e) => e.kind === 'agents').flatMap((e) => e.agents || []);
  const open = new Map();
  for (const e of ev) {
    if (e.event === 'SubagentStart' && e.agent_id) open.set(e.agent_id, e);
    if (e.event === 'SubagentStop' && e.agent_id) open.delete(e.agent_id);
  }
  const hoursSince = (t) => (Date.parse(now) - Date.parse(t)) / 36e5;
  const idle = jobs
    .filter((j) => j.state && j.state.status === 'active' && !j.state.pending_gate)
    .map((j) => {
      const last = [...j.events.map((e) => e.ts), ...j.decisions.map((d) => d.ts), ...j.ledger.map((e) => e.at), j.state.updated_at].filter(Boolean).sort().pop();
      return { job: j.id, idle_hours: last ? Math.round(hoursSince(last)) : null };
    })
    .filter((x) => x.idle_hours !== null && x.idle_hours >= L.idle_hours);
  const waits = [];
  for (const j of jobs) {
    for (const g of j.decisions.filter((d) => isRouting(d) && d.action === 'gate')) {
      const r = j.decisions.filter((d) => ['human.approve', 'human.deny'].includes(d.action) && (!d.gate || d.gate === g.step) && d.ts >= g.ts).sort((a, b) => (a.ts < b.ts ? -1 : 1))[0];
      if (r) waits.push((Date.parse(r.ts) - Date.parse(g.ts)) / 36e5);
    }
  }
  waits.sort((a, b) => a - b);
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    jobs: { total: jobs.length, ...Object.fromEntries(top(jobs, (j) => (j.state && j.state.status) || 'unknown', 10).map((x) => [x.key, x.count])) },
    seals: obs.sealsChecked ? 'checked' : 'not checked (no factory secret on this machine)',
    unsealed_lines: obs.unsealed.events.length + obs.unsealed.decisions.length + jobs.reduce((n, j) => n + j.ledgerLines.filter((l) => !l.sealed && !l.torn).length, 0),
    torn_lines: obs.torn.events.length + obs.torn.decisions.length + jobs.reduce((n, j) => n + (j.ledgerTorn || []).length, 0),
    hook_errors: top(by((e) => e.event === 'hook_error'), (e) => e.hook || 'unknown', 10),
    inspector_hook_errors: (obs.inspectorHookErrors || []).length,
    guard_denials: { total: by((e) => e.event === 'guard_deny').length, top: top(by((e) => e.event === 'guard_deny'), (e) => `${e.agent_type || 'main session'}: ${String(e.reason || '').slice(0, 80)}`) },
    stop_blocks: by((e) => e.event === 'stop_block').length,
    replies: { refused: by((e) => e.event === 'reply_refused').length, unparsed: by((e) => e.event === 'reply_unparsed').length },
    cli: { runs: cli.length, failed: failed.length, crashes: failed.filter((e) => e.code === 'internal').length, by_code: top(failed, (e) => `${e.cmd}${e.sub ? ` ${e.sub}` : ''}: ${e.code || 'error'}`, 6) },
    records: { stale: cli.filter((e) => e.cmd === 'record' && e.status === 'stale').length, degraded: cli.filter((e) => e.cmd === 'record' && e.status === 'degraded').length, workflow_errors: ledger.filter((e) => e.kind === 'error').length },
    agents: { runs: runs.length, retries: runs.filter((a) => a.retry || /#([2-9]|\d{2,})$/.test(a.label || '')).length, failed: runs.filter((a) => rules.AGENT_FAILED.has(a.outcome)).length, started: by((e) => e.event === 'SubagentStart').length, not_stopped: open.size },
    parks: obs.decisions.filter((d) => d.action === 'parked').length,
    resumes: obs.decisions.filter((d) => d.action === 'human.resume').length,
    idle_jobs: idle,
    gate_wait_hours: waits.length ? { median: r1(waits[Math.floor(waits.length / 2)]), max: r1(waits[waits.length - 1]), n: waits.length } : null,
  };
}

function healthMd(h) {
  const n = (x) => (x && x.length ? x.map((t) => `${t.key} ×${t.count}`).join(', ') : 'none');
  return [
    '## Factory health',
    '',
    `- Jobs: ${Object.entries(h.jobs).map(([k, v]) => `${k} ${v}`).join(' · ')}${h.idle_jobs.length ? ` · idle: ${h.idle_jobs.map((x) => `${x.job} (${x.idle_hours} h)`).join(', ')}` : ''}`,
    `- Records: seals ${h.seals} · unsealed lines ${h.unsealed_lines} · torn lines ${h.torn_lines}`,
    `- Hook errors: ${n(h.hook_errors)}${h.inspector_hook_errors ? ` · inspector hooks ${h.inspector_hook_errors}` : ''}`,
    `- Hook pushback: guard denials ${h.guard_denials.total}${h.guard_denials.total ? ` (${n(h.guard_denials.top)})` : ''} · stop blocks ${h.stop_blocks} · replies refused ${h.replies.refused} · look-alike replies ${h.replies.unparsed}`,
    `- CLI: ${h.cli.runs} commands, ${h.cli.failed} failed${h.cli.crashes ? `, ${h.cli.crashes} crashed` : ''}${h.cli.failed ? ` (${n(h.cli.by_code)})` : ''}`,
    `- Workflows: stale results ${h.records.stale} · degraded ${h.records.degraded} · errors ${h.records.workflow_errors}`,
    `- Agents: ${h.agents.runs} runs · ${h.agents.retries} retries · ${h.agents.failed} failed · ${h.agents.not_stopped} of ${h.agents.started} started never stopped`,
    `- Parks ${h.parks} · resumes ${h.resumes}${h.gate_wait_hours ? ` · gate replies: median ${h.gate_wait_hours.median} h, max ${h.gate_wait_hours.max} h` : ''}`,
  ].join('\n');
}

function reportMd(r) {
  const L = ['# Factory inspection', '', `Open: ${r.counts.open} (${r.counts.high} high) · deviations ${r.counts.deviations} · ambiguities ${r.counts.ambiguities} · gaps ${r.counts.gaps}`, ''];
  const tail = r.health ? ['', healthMd(r.health)] : [];
  if (!r.findings.length) return [...L, 'No findings. The factory behaved as its rulebooks say.', ...tail].join('\n');
  L.push('| ID | Severity | Class | Rule | Job | What happened | Question | Status |', '|---|---|---|---|---|---|---|---|');
  for (const x of r.findings) {
    L.push(`| ${x.id}${x.regressed ? ' ↺' : ''} | ${x.severity} | ${x.class} | ${x.rule} | ${x.job || '—'} | ${String(x.summary).replace(/\|/g, '\\|')} | ${String(x.question).replace(/\|/g, '\\|')} | ${x.status} |`);
  }
  L.push('', 'Reply `ack finding F3`, `fixed finding F3` or `wontfix finding F3 <why>`. ↺ = came back after being marked fixed.', ...tail);
  return L.join('\n');
}

function status(root) {
  const cfg = config.load(root);
  const reg = register.load(root);
  const recipes = Object.entries(cfg.recipes).map(([id, r]) => {
    const m = config.modeFor(cfg, id);
    return { recipe: id, mode: m.mode, sample_every: m.mode === 'sample' ? m.every : null, clean_streak: r.streak || 0, inspected: r.inspected || 0, rearmed_at: r.rearmed_at };
  });
  return { mode: cfg.mode, sample_every: cfg.sample_every, settle_after: cfg.settle_after, threshold: cfg.threshold, limits: cfg.limits, rules_off: cfg.rules_off, recipes, open: counts(reg), suggestions: config.suggestions(cfg), last_run: reg.runs[reg.runs.length - 1] || null };
}

function mark(root, { id, to, reason, channel }) {
  humanOnly(channel);
  const reg = register.load(root);
  const fd = register.mark(reg, id, to, reason);
  register.save(root, reg);
  return { finding: fd.id, status: fd.status, message: `Finding ${fd.id} marked ${fd.status}.` };
}

function setMode(root, { target, mode, every, channel }) {
  humanOnly(channel);
  const cfg = config.setMode(config.load(root), target, mode, every);
  config.save(root, cfg);
  return { target, mode, every: every || null, message: `Inspection for ${target === 'all' ? 'all recipes' : target}: ${mode}${mode === 'sample' ? ` (1 in ${every || cfg.sample_every})` : ''}.` };
}

// A readable timeline of one job: each routing decision and the commands run under it.
function trace(root, { job: id }) {
  const obs = observe(root);
  const job = obs.jobs[id];
  if (!job) throw Object.assign(new Error(`No job ${id}`), { code: 'bad_input' });
  const L = [`# Trace — ${id}`, '', `Recipe: ${(job.lock && `${job.lock.id} v${job.lock.version}`) || 'unknown'} · status ${job.state && job.state.status}`, ''];
  const routing = job.decisions.filter(isRouting).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const human = job.decisions.filter((d) => !isRouting(d));
  for (const d of routing) {
    L.push(`**${d.id}** ${d.action} ${d.step || d.skill || d.command || ''} — ${d.rule || ''}${d.first_failing ? ` (first failing: ${d.first_failing})` : ''}`);
    for (const e of job.events.filter((x) => x.event === 'cli' && x.decision_id === d.id && x.cmd !== 'next')) L.push(`  - factory ${e.cmd}${e.sub ? ` ${e.sub}` : ''}${e.arg ? ` ${e.arg}` : ''}${e.workflow ? ` [${e.workflow}${e.config ? `/${e.config}` : ''}]` : ''} ${e.ok ? '' : `✗ ${e.code || ''}`}`);
    for (const h of human.filter((x) => x.during === d.id)) L.push(`  - you: ${h.action.replace('human.', '')}${h.gate ? ` ${h.gate}` : ''}${h.reason ? ` — ${h.reason}` : ''}`);
    for (const g of job.events.filter((x) => x.event === 'guard_deny' && x.decision_id === d.id)) L.push(`  - guard denied${g.agent_type ? ` ${g.agent_type}` : ''}: ${g.reason}`);
    for (const g of job.events.filter((x) => ['stop_block', 'hook_error', 'reply_refused', 'reply_unparsed'].includes(x.event) && x.decision_id === d.id)) L.push(`  - ${g.event.replace('_', ' ')}: ${g.hook ? `${g.hook}: ${g.message}` : (g.missing || []).join(', ') || g.reason || g.word || ''}`);
  }
  return L.join('\n');
}

// Chat replies for the inspector (applied by its prompt hook).
function parseReply(text) {
  const t = String(text || '').trim();
  if (!t || t.includes('\n')) return null;
  let m;
  if ((m = t.match(/^(ack|fixed|wontfix|reopen)\s+finding\s+(F\d+)(?:\s+(.*))?$/i))) return { cmd: 'mark', id: m[2].toUpperCase(), to: m[1].toLowerCase() === 'reopen' ? 'open' : m[1].toLowerCase(), reason: (m[3] || '').trim() };
  if ((m = t.match(/^inspect\s+mode\s+(all|[\w@.-]+)\s+(on|off|sample)(?:\s+(\d+))?$/i))) return { cmd: 'mode', target: m[1], mode: m[2].toLowerCase(), every: m[3] || null };
  return null;
}

function applyReply(root, p) {
  if (p.cmd === 'mark') return mark(root, { id: p.id, to: p.to, reason: p.reason, channel: 'chat' });
  if (p.cmd === 'mode') return setMode(root, { target: p.target, mode: p.mode, every: p.every, channel: 'chat' });
  throw new Error('unknown reply');
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) opt[a.slice(2, eq)] = a.slice(eq + 1);
      else if (['all', 'json', 'active'].includes(a.slice(2)) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) opt[a.slice(2)] = true;
      else opt[a.slice(2)] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

const HELP = `factory-inspect — audits the Software Factory against each job's declared rulebook

  run [--job J-0001 | --all | --active]
                                  inspect closed jobs not yet inspected (or one job, or everything,
                                  or also every active/parked job as it stands now)
  report [--status open|all|fixed|wont_fix] [--format md]   findings + factory health
  health [--format md]            factory-wide health only (hook errors, denials, CLI failures, agents…)
  status                          modes, clean streaks, suggestions
  show <F3>                       one finding in full
  trace --job J-0001              the job's decisions and the commands run under each
Human only (your terminal, or reply in chat):
  mark <F3> ack|fixed|wontfix|open [--reason "…"]
  mode <recipe|all> on|off|sample [N]`;

function cli(argv) {
  const { pos, opt } = parseArgs(argv);
  const [cmd, a, b, c] = pos;
  const tty = 'tty';
  switch (cmd) {
    case undefined:
    case 'help':
      return HELP;
    case 'run':
      return run(requireRoot(opt), { job: opt.job, all: Boolean(opt.all), active: Boolean(opt.active) });
    case 'health': {
      const h = health(requireRoot(opt));
      return opt.format === 'md' ? healthMd(h) : h;
    }
    case 'report': {
      const r = report(requireRoot(opt), { status: opt.status || 'open' });
      return opt.format === 'md' ? reportMd(r) : r;
    }
    case 'status':
      return status(requireRoot(opt));
    case 'show': {
      const fd = register.load(requireRoot(opt)).findings.find((x) => x.id === String(a || '').toUpperCase());
      if (!fd) throw Object.assign(new Error(`No finding ${a}`), { code: 'bad_input' });
      return fd;
    }
    case 'trace':
      return trace(requireRoot(opt), { job: opt.job || a });
    case 'mark':
      return mark(requireRoot(opt), { id: a, to: b, reason: opt.reason, channel: tty });
    case 'mode':
      return setMode(requireRoot(opt), { target: a, mode: b, every: c, channel: tty });
    default:
      throw Object.assign(new Error(`Unknown command "${cmd}"`), { code: 'bad_input' });
  }
}

function main(argv) {
  try {
    const res = cli(argv);
    process.stdout.write((typeof res === 'string' ? res : JSON.stringify(res, null, 2)) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: true, code: e.code || 'internal', message: e.message }, null, 2) + '\n');
    process.exitCode = 1;
  }
}

module.exports = { main, cli, run, pending, summary, report, reportMd, health, healthMd, status, mark, setMode, trace, parseReply, applyReply, counts };
