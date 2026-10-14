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
const SCOUT_LABEL = /^(intent map|scout · (repo|web)|verify evidence)/;
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
      if (e.event !== 'agent_run' || e.config !== 'clarify' || !SCOUT_LABEL.test(String(e.label || ''))) continue;
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
  };
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
  const out = { generated_at: nowIso(), since_days: sinceDays, jobs: metrics.length, by_recipe: byRecipe, per_job: metrics };
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
  L.push('', '## Grounded intent', '', 'Research before questions: a researchable question that still reached you, or an assumption you overrode, is a signal to improve the scouts or the mapper.', '', '| Recipe | Questions asked | Researchable asked | Rate | Assumptions | Overridden | Scout runs | Scout time (s) | Avg hours to H1 | Rework after H1 |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const [id, x] of Object.entries(r.by_recipe)) {
    const i = x.intent || {};
    L.push(`| ${id} | ${i.questions_asked || 0} | ${i.researchable_questions_asked || 0} | ${i.researchable_question_rate ?? '—'} | ${i.assumptions || 0} | ${i.assumptions_overridden || 0} | ${i.scout_runs || 0} | ${i.scout_seconds || 0} | ${i.avg_time_to_h1_hours ?? '—'} | ${i.rework_after_h1 || 0} |`);
  }
  L.push('', '## Review lanes', '', '| Recipe | Lane | Raised | Confirmed | Refuted | Unverified | Minor | Precision |', '|---|---|---|---|---|---|---|---|');
  for (const [id, x] of Object.entries(r.by_recipe)) {
    for (const [lane, l] of Object.entries(x.lanes)) L.push(`| ${id} | ${lane} | ${l.raised} | ${l.confirmed} | ${l.refuted} | ${l.unverified} | ${l.minor} | ${l.precision ?? '—'} |`);
  }
  return L.join('\n');
}

module.exports = { report, toMarkdown, jobMetrics };
