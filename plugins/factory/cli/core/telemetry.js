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
    const r = (byRecipe[m.recipe] = byRecipe[m.recipe] || { jobs: 0, merged: 0, parked_jobs: 0, escaped_defects_30d: 0, reverts_30d: 0, agent_runs: 0, wall_hours: 0, review_fix_rounds: 0, verify_fix_rounds: 0, gate_denials: 0, lanes: {} });
    r.jobs += 1;
    if (m.merged) r.merged += 1;
    if (m.parked) r.parked_jobs += 1;
    for (const k of ['escaped_defects_30d', 'reverts_30d', 'agent_runs', 'wall_hours', 'review_fix_rounds', 'verify_fix_rounds', 'gate_denials']) r[k] += m[k];
    for (const [lane, v] of Object.entries(m.lanes)) {
      const t = (r.lanes[lane] = r.lanes[lane] || { raised: 0, confirmed: 0, refuted: 0, unverified: 0, minor: 0 });
      for (const k of Object.keys(t)) t[k] += v[k];
    }
  }
  for (const r of Object.values(byRecipe)) {
    r.avg_agent_runs = r.jobs ? Math.round((r.agent_runs / r.jobs) * 10) / 10 : 0;
    r.avg_wall_hours = r.jobs ? Math.round((r.wall_hours / r.jobs) * 10) / 10 : 0;
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
  L.push('', '## Review lanes', '', '| Recipe | Lane | Raised | Confirmed | Refuted | Unverified | Minor | Precision |', '|---|---|---|---|---|---|---|---|');
  for (const [id, x] of Object.entries(r.by_recipe)) {
    for (const [lane, l] of Object.entries(x.lanes)) L.push(`| ${id} | ${lane} | ${l.raised} | ${l.confirmed} | ${l.refuted} | ${l.unverified} | ${l.minor} | ${l.precision ?? '—'} |`);
  }
  return L.join('\n');
}

module.exports = { report, toMarkdown, jobMetrics };
