'use strict';
// SubagentStop: records that a factory agent finished. It no longer blocks: workflow agents
// return through a JSON schema the runtime enforces, and factory record re-checks every
// artifact an agent was meant to write (design files, threat model, plan) before it counts.

const { safe } = require('./lib');

safe((input) => {
  require('./activity-log').log(input, 'SubagentStop', { role: String(input.agent_type || '').split(':').pop() || null });
});
