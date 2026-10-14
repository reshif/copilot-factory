'use strict';
// subagentStop: records that a factory agent finished. It doesn't block: workflow agents
// return through a JSON schema `factory run` enforces, and factory record re-checks every
// artifact an agent was meant to write (design files, threat model, plan) before it counts.
// Copilot sends agentName/agentType/agentId (camelCase) or agent_name/agent_type/agent_id;
// the built-in general-purpose agent sends no subagent events at all (hooks.md §5.5).

const { safe } = require('./lib');

safe((input) => {
  require('./activity-log').log(input, 'SubagentStop', { role: String(input.agent || '').split(':').pop() || null, agent_kind: input.agentKind || null });
});
