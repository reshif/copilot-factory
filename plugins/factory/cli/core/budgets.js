'use strict';
// Budgets per job and per tree (an epic plus its slices). Hitting a cap parks the job.
// Agent runs are counted from workflow envelopes; wall time from job timestamps.

const job = require('./job');

function treeRootId(root, state) {
  return state.parent || state.id;
}

function treeAgentRuns(root, state) {
  const top = job.load(root, treeRootId(root, state));
  let total = top.counters.agent_runs || 0;
  for (const c of top.children || []) {
    try {
      total += job.load(root, c).counters.agent_runs || 0;
    } catch {
      /* a missing child is ignored */
    }
  }
  return total;
}

function addAgentRuns(state, n) {
  state.counters.agent_runs = (state.counters.agent_runs || 0) + Math.max(0, Number(n) || 0);
}

// Returns a reason string when a cap is exceeded, otherwise null.
function exceeded(root, state) {
  const L = state.policy.limits;
  if ((state.counters.agent_runs || 0) > L.max_agent_runs_per_job) {
    return `agent-run budget for this job is spent (${state.counters.agent_runs} > ${L.max_agent_runs_per_job})`;
  }
  const tree = treeAgentRuns(root, state);
  if (tree > L.max_agent_runs_per_tree) return `agent-run budget for the whole tree is spent (${tree} > ${L.max_agent_runs_per_tree})`;
  return null;
}

function snapshot(root, state) {
  const L = state.policy.limits;
  return {
    used: {
      agent_runs: state.counters.agent_runs || 0,
      tree_agent_runs: treeAgentRuns(root, state),
      clarify_rounds: state.counters.clarify_rounds,
      review_rounds: state.counters.review_rounds,
      verify_fix_rounds: state.counters.verify_fix_rounds,
      wall_hours: Math.round(((Date.now() - Date.parse(state.created_at)) / 36e5) * 10) / 10,
    },
    limit: {
      agent_runs: L.max_agent_runs_per_job,
      tree_agent_runs: L.max_agent_runs_per_tree,
      clarify_rounds: L.max_intent_rounds + 2,
      review_rounds: L.max_review_rounds,
      verify_fix_rounds: L.max_verify_fix_rounds,
    },
  };
}

module.exports = { addAgentRuns, exceeded, snapshot, treeAgentRuns };
