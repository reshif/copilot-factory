'use strict';
// Telemetry for the monthly human review. Computed by the CLI from state, ledger and
// decision records — never by agents. Primary metrics are pre-registered: escaped
// defects and reverts within 30 days of merge, and cost. The rest are diagnostics.

const path = require('path');
const { writeJson, nowIso } = require('../lib/util');
const { project } = require('../lib/paths');
const git = require('../lib/git');
const job = require('./job');
const ledger = require('./ledger');
const decisions = require('./decisions');

const DAY = 864e5;

// Grounded intent: how often a researchable question still reached the user, how often the
// user overrode what research assumed, and what the scout phase cost (runs and agent time,
// from the runner's agent_run lines for clarify's scout labels).
const SCOUT_LABEL = /^(intent map|scout · (repo|web)|verify evidence|research · (repo|docs)|research brief)/;
let EVENTS = null;
function scoutEvents(root) {
  if (EVENTS && EVENTS.root === root) return EVENTS.byJob;
  const byJob = {};
  try {
    for (const l of require('fs').readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').split('\n')) {
      if (!l || !l.includes('agent_run')) continue;
      let e;
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      if (e.event !== 'agent_run' || (e.config !== 'clarify' && e.workflow !== 'clarify') || !SCOUT_LABEL.test(String(e.label || ''))) continue;
      (byJob[e.job] = byJob[e.job] || []).push(e);
    }
  } catch {
    /* no event log */
  }
  EVENTS = { root, byJob };
  return byJob;
}

function intentMetrics(root, state) {
  const intent = require('./intent');
  const data = intent.load(root, state.id);
  const log = state.question_log || [];
  const asked = log.length;
  const researchable = log.filter((q) => q.researchable).length;
  const runs = scoutEvents(root)[state.id] || [];
  const intents = ledger.all(root, state.id).filter((e) => e.kind === 'intent');
  const h1 = (state.approvals || {})[state.epic ? 'EH1' : 'H1'];
  return {
    questions_asked: asked,
    researchable_questions_asked: researchable,
    researchable_question_rate: asked ? Math.round((researchable / asked) * 100) / 100 : null,
    researchable_dropped: intents.reduce((n, e) => n + ((e.researchable_dropped || []).length), 0),
    assumptions: data && !data.tampered ? intent.liveAssumptions(data).length : 0,
    assumptions_overridden: data && !data.tampered ? data.assumptions.filter((a) => a.overridden || a.dropped).length : state.counters.assumptions_overridden || 0,
    scout_rounds: intents.filter((e) => e.scouted).length,
    scout_runs: runs.length,
    scout_seconds: Math.round(runs.reduce((n, e) => n + (Number(e.ms) || 0), 0) / 1000),
    time_to_h1_hours: h1 ? Math.round(((Date.parse(h1.at) - Date.parse(state.created_at)) / 36e5) * 10) / 10 : null,
    rework_after_h1: (state.amendments_count || 0) + (state.denials || []).filter((d) => d.gate !== 'H1' && d.gate !== 'EH1').length,
  };
}

// Clarify v3: what clarify cost the user (turns) and the factory (passes, checks), and what it
// could not research.
function clarifyMetrics(root, state) {
  const data = require('./clarify').load(root, state.id);
  if (!data || data.tampered) return null;
  return {
    version: 3,
    user_turns: data.words.filter((w) => w.via !== 'request' && w.via !== 'migration').length,
    research_passes: data.research.passes.length,
    sheets: data.sheets.length,
    decisions: data.items.filter((it) => it.kind === 'decision').length,
    decided_by_user: data.items.filter((it) => it.kind === 'decision' && it.strength === 'user').length,
    recommendations_accepted: data.items.filter((it) => it.kind === 'decision' && it.strength === 'accepted').length,
    redirects: data.redirects.length,
    readiness_checks: data.checks.length,
    failures: data.failures.length,
    proceeded: Boolean(data.proceeded),
    migrated_from: data.migration ? data.migration.from : null,
  };
}

function reverts(root, state) {
  if (!state.pr || !state.pr.merge_commit) return 0;
  try {
    const since = new Date(Date.parse(state.pr.merged_at || state.updated_at)).toISOString();
    const log = git.out(root, ['log', state.base_branch, `--since=${since}`, '--format=%B%x00']);
    return log.split('\0').filter((m) => m.includes(`This reverts commit ${state.pr.merge_commit}`) || m.includes(`Factory-Revert-Of: ${state.id}`)).length;
  } catch {
    return 0;
  }
}

function jobMetrics(root, state, all) {
  const steps = ledger.all(root, state.id).filter((e) => e.kind === 'step');
  const challenges = steps.filter((e) => e.step === 'challenge' && e.detail && e.detail.findings);
  const byLane = {};
  for (const c of challenges) {
    for (const f of c.detail.findings) {
      const l = (byLane[f.lane] = byLane[f.lane] || { raised: 0, confirmed: 0, refuted: 0, unverified: 0, minor: 0 });
      l.raised += 1;
      if (f.status === 'confirmed') l.confirmed += 1;
      else if (f.status === 'refuted') l.refuted += 1;
      else if (f.status === 'unverified') l.unverified += 1;
      else l.minor += 1;
    }
  }
  const mergedAt = state.pr && state.pr.merged_at ? Date.parse(state.pr.merged_at) : null;
  const escaped = all.filter((j) => j.followup_of === state.id && mergedAt && Date.parse(j.created_at) - mergedAt <= 30 * DAY).length;
  const decs = decisions.forJob(root, state.id);
  return {
    job: state.id,
    recipe: state.recipe.id,
    work_type: state.work_type,
    risk: state.risk,
    status: state.status,
    merged: Boolean(state.pr && state.pr.merged),
    escaped_defects_30d: escaped,
    reverts_30d: reverts(root, state),
    agent_runs: state.counters.agent_runs || 0,
    wall_hours: Math.round(((Date.parse(state.closed_at || state.updated_at) - Date.parse(state.created_at)) / 36e5) * 10) / 10,
    review_fix_rounds: state.counters.review_rounds,
    verify_fix_rounds: state.counters.verify_fix_rounds,
    clarify_rounds: state.counters.clarify_rounds,
    gate_denials: (state.denials || []).length,
    amendments: state.amendments_count || 0,
    parked: decs.filter((d) => d.action === 'parked').length,
    decisions: decs.length,
    lanes: byLane,
    intent: intentMetrics(root, state),
    clarify: clarifyMetrics(root, state),
  };
}

// ---------------------------------------------------------------- quality (Tier 4)

// Live quality signals from what the factory already logs, for the review skill:
//   per role (agent_run lines): schema-correction-turn rate (runs that needed the runner's
//     corrective turn) and null-result rate (runs that returned no valid object);
//   per review lane (challenge ledger findings): the finding-verifier's refute rate;
//   park reasons (decision records, by rule); God Eye's revise rate per focus (agent_run
//     verdicts, logged by the runner since 0.3.2).
const rate = (n, d) => (d ? Math.round((n / d) * 100) / 100 : null);

function readEventLog(root) {
  try {
    return require('fs')
      .readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function focusOf(label) {
  const m = /god-eye · (intent|design|plan)/.exec(String(label || ''));
  if (m) return m[1];
  return /^readiness/.test(String(label || '')) ? 'readiness' : 'other'; // clarify v3's readiness check
}

function quality(root, { cutoff, jobIds, perJob }) {
  const inWindow = (ts) => !ts || Date.parse(ts) >= cutoff;
  const runs = readEventLog(root).filter((e) => e.event === 'agent_run' && inWindow(e.ts) && (!jobIds || jobIds.has(e.job)) && e.outcome !== 'copilot_unavailable');
  const roles = {};
  const godEye = {};
  for (const e of runs) {
    const role = e.role || String(e.agent_type || '').replace(/^factory:/, '') || 'unknown';
    const r = (roles[role] = roles[role] || { runs: 0, correction_turns: 0, null_results: 0, outcomes: {} });
    r.runs += 1;
    if (e.retry) r.correction_turns += 1;
    if (e.outcome !== 'ok') r.null_results += 1;
    r.outcomes[e.outcome || 'unknown'] = (r.outcomes[e.outcome || 'unknown'] || 0) + 1;
    if (role === 'god-eye' && e.outcome === 'ok' && e.verdict) {
      const g = (godEye[focusOf(e.label)] = godEye[focusOf(e.label)] || { verdicts: 0, approve: 0, revise: 0 });
      g.verdicts += 1;
      if (e.verdict === 'approve' || e.verdict === 'ready') g.approve += 1;
      else g.revise += 1;
    }
  }
  for (const r of Object.values(roles)) {
    r.correction_turn_rate = rate(r.correction_turns, r.runs);
    r.null_result_rate = rate(r.null_results, r.runs);
  }
  for (const g of Object.values(godEye)) g.revise_rate = rate(g.revise, g.verdicts);
  const lanes = {};
  for (const m of perJob) {
    for (const [lane, v] of Object.entries(m.lanes || {})) {
      const l = (lanes[lane] = lanes[lane] || { raised: 0, verified: 0, refuted: 0, unverified: 0 });
      l.raised += v.raised;
      l.verified += v.confirmed + v.refuted + v.unverified;
      l.refuted += v.refuted;
      l.unverified += v.unverified; // the finding-verifier's `unverifiable` verdict lands here
    }
  }
  for (const l of Object.values(lanes)) {
    l.refute_rate = rate(l.refuted, l.verified);
    l.unverified_rate = rate(l.unverified, l.verified);
  }
  const parks = {};
  for (const d of decisions.all(root)) {
    if (d.action !== 'parked' || !inWindow(d.ts) || (jobIds && !jobIds.has(d.job))) continue;
    const rule = d.rule || 'parked';
    const p = (parks[rule] = parks[rule] || { parks: 0, jobs: [], example: null });
    p.parks += 1;
    if (!p.jobs.includes(d.job)) p.jobs.push(d.job);
    if (!p.example && d.reason) p.example = String(d.reason).slice(0, 200);
  }
  return { roles, lanes, parks, god_eye: godEye };
}

function report(root, { sinceDays = 30 } = {}) {
  const cutoff = Date.now() - sinceDays * DAY;
  const all = job
    .listJobIds(root)
    .map((id) => {
      try {
        return job.load(root, id);
      } catch {
        return null; // tampered or unreadable: left out of the report
      }
    })
    .filter(Boolean);
  const jobs = all.filter((s) => Date.parse(s.updated_at || s.created_at) >= cutoff && !s.epic);
  const metrics = jobs.map((s) => jobMetrics(root, s, all));
  const byRecipe = {};
  for (const m of metrics) {
    const r = (byRecipe[m.recipe] = byRecipe[m.recipe] || { jobs: 0, merged: 0, parked_jobs: 0, escaped_defects_30d: 0, reverts_30d: 0, agent_runs: 0, wall_hours: 0, review_fix_rounds: 0, verify_fix_rounds: 0, gate_denials: 0, lanes: {}, intent: { questions_asked: 0, researchable_questions_asked: 0, assumptions: 0, assumptions_overridden: 0, scout_runs: 0, scout_seconds: 0, h1_hours: 0, h1_jobs: 0, rework_after_h1: 0 } });
    r.jobs += 1;
    if (m.merged) r.merged += 1;
    if (m.parked) r.parked_jobs += 1;
    for (const k of ['escaped_defects_30d', 'reverts_30d', 'agent_runs', 'wall_hours', 'review_fix_rounds', 'verify_fix_rounds', 'gate_denials']) r[k] += m[k];
    const ri = r.intent;
    for (const k of ['questions_asked', 'researchable_questions_asked', 'assumptions', 'assumptions_overridden', 'scout_runs', 'scout_seconds', 'rework_after_h1']) ri[k] += m.intent[k] || 0;
    if (m.clarify) {
      const rc = (r.clarify = r.clarify || { jobs: 0, user_turns: 0, research_passes: 0, decisions: 0, decided_by_user: 0, recommendations_accepted: 0, redirects: 0, readiness_checks: 0, failures: 0, proceeded: 0 });
      rc.jobs += 1;
      for (const k of Object.keys(rc)) if (k !== 'jobs') rc[k] += k === 'proceeded' ? (m.clarify.proceeded ? 1 : 0) : m.clarify[k] || 0;
    }
    if (m.intent.time_to_h1_hours !== null) {
      ri.h1_hours += m.intent.time_to_h1_hours;
      ri.h1_jobs += 1;
    }
    for (const [lane, v] of Object.entries(m.lanes)) {
      const t = (r.lanes[lane] = r.lanes[lane] || { raised: 0, confirmed: 0, refuted: 0, unverified: 0, minor: 0 });
      for (const k of Object.keys(t)) t[k] += v[k];
    }
  }
  for (const r of Object.values(byRecipe)) {
    r.avg_agent_runs = r.jobs ? Math.round((r.agent_runs / r.jobs) * 10) / 10 : 0;
    r.avg_wall_hours = r.jobs ? Math.round((r.wall_hours / r.jobs) * 10) / 10 : 0;
    const ri = r.intent;
    ri.researchable_question_rate = ri.questions_asked ? Math.round((ri.researchable_questions_asked / ri.questions_asked) * 100) / 100 : null;
    ri.override_rate = ri.assumptions ? Math.round((ri.assumptions_overridden / ri.assumptions) * 100) / 100 : null;
    ri.avg_time_to_h1_hours = ri.h1_jobs ? Math.round((ri.h1_hours / ri.h1_jobs) * 10) / 10 : null;
    for (const l of Object.values(r.lanes)) l.precision = l.confirmed + l.refuted ? Math.round((l.confirmed / (l.confirmed + l.refuted)) * 100) / 100 : null;
  }
  const q = quality(root, { cutoff, jobIds: new Set(jobs.map((j) => j.id)), perJob: metrics });
  const out = { generated_at: nowIso(), since_days: sinceDays, jobs: metrics.length, by_recipe: byRecipe, per_job: metrics, quality: q };
  const month = new Date().toISOString().slice(0, 7);
  writeJson(path.join(project(root).telemetryDir, `${month}.json`), out);
  return out;
}

function toMarkdown(r) {
  const L = [];
  L.push(`# Factory telemetry — last ${r.since_days} days`, '', `${r.jobs} jobs. Primary metrics: escaped defects and reverts within 30 days of merge, and cost. Everything else is diagnostic — watch it, don't optimise it.`, '');
  L.push('| Recipe | Jobs | Merged | Escaped defects | Reverts | Avg agent runs | Avg hours | Review fix rounds | Verify fix rounds | Gate denials | Parked |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [id, x] of Object.entries(r.by_recipe)) {
    L.push(`| ${id} | ${x.jobs} | ${x.merged} | ${x.escaped_defects_30d} | ${x.reverts_30d} | ${x.avg_agent_runs} | ${x.avg_wall_hours} | ${x.review_fix_rounds} | ${x.verify_fix_rounds} | ${x.gate_denials} | ${x.parked_jobs} |`);
  }
  L.push('', '## Clarify', '', 'What clarify cost you (your turns, redirects) and what it could not do (research gaps, God Eye objections you proceeded past). Many decisions you overrode point at the research brief; many gaps at `intent_research` or the time box.', '', '| Recipe | Jobs | Your turns | Research passes | Research runs | Research time (s) | Decisions | Decided by you | Recommendations accepted | Redirects | Readiness checks | Research gaps | Proceeded past God Eye | Avg hours to H1 | Rework after H1 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [id, x] of Object.entries(r.by_recipe)) {
    const i = x.intent || {};
    const c = x.clarify || {};
    L.push(`| ${id} | ${c.jobs || 0} | ${c.user_turns || 0} | ${c.research_passes || 0} | ${i.scout_runs || 0} | ${i.scout_seconds || 0} | ${c.decisions || 0} | ${c.decided_by_user || 0} | ${c.recommendations_accepted || 0} | ${c.redirects || 0} | ${c.readiness_checks || 0} | ${c.failures || 0} | ${c.proceeded || 0} | ${i.avg_time_to_h1_hours ?? '—'} | ${i.rework_after_h1 || 0} |`);
  }
  // jobs approved under clarify v1/v2 (intent-evidence.json): the old research-before-questions signals
  const legacy = Object.entries(r.by_recipe).filter(([, x]) => x.intent && (x.intent.questions_asked || x.intent.assumptions));
  if (legacy.length) {
    L.push('', '### Clarify v2 jobs', '', '| Recipe | Questions asked | Researchable asked | Rate | Assumptions | Overridden |', '|---|---|---|---|---|---|');
    for (const [id, x] of legacy) L.push(`| ${id} | ${x.intent.questions_asked || 0} | ${x.intent.researchable_questions_asked || 0} | ${x.intent.researchable_question_rate ?? '—'} | ${x.intent.assumptions || 0} | ${x.intent.assumptions_overridden || 0} |`);
  }
  L.push('', '## Review lanes', '', '| Recipe | Lane | Raised | Confirmed | Refuted | Unverified | Minor | Precision |', '|---|---|---|---|---|---|---|---|');
  for (const [id, x] of Object.entries(r.by_recipe)) {
    for (const [lane, l] of Object.entries(x.lanes)) L.push(`| ${id} | ${lane} | ${l.raised} | ${l.confirmed} | ${l.refuted} | ${l.unverified} | ${l.minor} | ${l.precision ?? '—'} |`);
  }
  const q = r.quality;
  if (q) {
    L.push('', '## Quality signals', '', 'Format reliability per role, reviewer false positives, why jobs parked and how often God Eye sent work back. Read a sample of the transcripts behind any number that moves.', '');
    L.push('| Role | Runs | Correction turns | Rate | Null results | Rate |', '|---|---|---|---|---|---|');
    for (const [role, x] of Object.entries(q.roles).sort((a, b) => b[1].runs - a[1].runs)) L.push(`| ${role} | ${x.runs} | ${x.correction_turns} | ${x.correction_turn_rate ?? '—'} | ${x.null_results} | ${x.null_result_rate ?? '—'} |`);
    L.push('', '| Lane | Findings raised | Verified | Refuted | Refute rate | Unverifiable | Unverifiable rate |', '|---|---|---|---|---|---|---|');
    for (const [lane, x] of Object.entries(q.lanes)) L.push(`| ${lane} | ${x.raised} | ${x.verified} | ${x.refuted} | ${x.refute_rate ?? '—'} | ${x.unverified} | ${x.unverified_rate ?? '—'} |`);
    L.push('', '| Park rule | Parks | Jobs | Example reason |', '|---|---|---|---|');
    for (const [rule, x] of Object.entries(q.parks)) L.push(`| ${rule} | ${x.parks} | ${x.jobs.join(', ')} | ${(x.example || '').replace(/\|/g, '/')} |`);
    L.push('', '| God Eye focus | Verdicts | Approve | Revise | Revise rate |', '|---|---|---|---|---|');
    for (const [f, x] of Object.entries(q.god_eye)) L.push(`| ${f} | ${x.verdicts} | ${x.approve} | ${x.revise} | ${x.revise_rate ?? '—'} |`);
  }
  return L.join('\n');
}

module.exports = { report, toMarkdown, jobMetrics, quality };
