'use strict';
// Builds what happened, per job and overall, from the factory's sealed records.

const fs = require('fs');
const { readJson, readLog, sealOk, layout, secret } = require('./io');

function jobIds(root) {
  const L = layout(root);
  try {
    return fs.readdirSync(L.jobs).filter((d) => /^J-\d+$/.test(d)).sort();
  } catch {
    return [];
  }
}

// The factory's activity lines, whichever casing wrote them: Copilot camelCase hook names
// (postToolUse, subagentStart, agentStop …) and snake/camel fields (agent_name, agentName,
// agentId) read as the Claude-era vocabulary the rules use (PostToolUse, SubagentStart,
// agent_type, agent_id); Copilot runtime tool names (bash, edit, create, view, apply_patch …)
// read as Bash/Edit/Write/Read. A copy is normalised: seals were checked on the raw line.
const EVENT_NAMES = { sessionstart: 'SessionStart', userpromptsubmitted: 'UserPromptSubmit', userpromptsubmit: 'UserPromptSubmit', pretooluse: 'PreToolUse', posttooluse: 'PostToolUse', posttoolusefailure: 'PostToolUseFailure', subagentstart: 'SubagentStart', subagentstop: 'SubagentStop', agentstop: 'Stop', stop: 'Stop', sessionend: 'SessionEnd' };
// Tool names: the hooks' own map (Copilot runtime and VS Code Local names, hooks/lib.js).
const { toolName } = require('../hooks/lib');

function normEvent(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  const e = { ...rec };
  if (typeof e.event === 'string' && EVENT_NAMES[e.event.toLowerCase()]) e.event = EVENT_NAMES[e.event.toLowerCase()];
  const tool = e.tool || e.tool_name || e.toolName;
  if (tool) e.tool = toolName(tool, null) || tool;
  if (!e.agent_type) e.agent_type = e.agent_name || e.agentName || e.agentType || e.agent_type || null;
  if (!e.agent_id) e.agent_id = e.agentId || e.agent_id || null;
  return e;
}

// Agents that started and never reported stopping. Copilot's subagentStart carries no
// agent id (only agentName; hooks.md §4), so a start without one is paired with the oldest
// unmatched stop of the same agent type.
function openAgents(events) {
  const byId = new Map();
  const byType = new Map();
  for (const e of events) {
    if (e.event === 'SubagentStart') {
      if (e.agent_id) byId.set(e.agent_id, e);
      else {
        const k = e.agent_type || '';
        if (!byType.has(k)) byType.set(k, []);
        byType.get(k).push(e);
      }
    } else if (e.event === 'SubagentStop') {
      if (e.agent_id && byId.has(e.agent_id)) byId.delete(e.agent_id);
      else {
        const q = byType.get(e.agent_type || '');
        if (q && q.length) q.shift();
      }
    }
  }
  return [...byId.values(), ...[...byType.values()].flat()].sort((a, b) => (String(a.ts) < String(b.ts) ? -1 : 1));
}

function observe(root) {
  const L = layout(root);
  const decisionsAll = readLog(L.decisions);
  const eventsAll = readLog(L.events);
  const jobs = {};
  for (const id of jobIds(root)) {
    const p = L.job(id);
    const state = readJson(p.state, null);
    const lock = readJson(p.lock, null);
    const ledgerLines = readLog(p.ledger);
    // Grounded intent (clarify's research record), sealed like state.json; absent before 0.3.0.
    const intent = readJson(p.intent, null);
    // Clarify v3's ledger of items (clarify.json), sealed the same way.
    const clarify = readJson(p.clarify, null);
    const decisions = decisionsAll.filter((d) => d.rec && d.rec.job === id);
    const events = eventsAll.filter((e) => e.rec && e.rec.job === id);
    jobs[id] = {
      id,
      root, // for the outcome rules' read-only git (R23, R24)
      dir: p.dir,
      plan: readJson(p.plan, null),
      state,
      lock,
      stateSealed: state ? sealOk(state) !== false : false,
      lockSealed: lock ? sealOk(lock) !== false : false,
      intent,
      intentSealed: intent ? sealOk(intent) !== false : true,
      clarify,
      clarifySealed: clarify ? sealOk(clarify) !== false : true,
      ledgerLines,
      ledgerTorn: ledgerLines.filter((l) => l.torn).map((l) => l.line),
      ledger: ledgerLines.filter((l) => l.sealed && l.rec && l.rec.job === id).map((l) => l.rec),
      decisionLines: decisions,
      decisions: decisions.filter((d) => d.sealed).map((d) => d.rec),
      events: events.filter((e) => e.sealed).map((e) => normEvent(e.rec)),
      eventLines: events,
    };
  }
  return {
    root,
    jobs,
    decisions: decisionsAll.filter((d) => d.sealed && d.rec).map((d) => d.rec),
    events: eventsAll.filter((e) => e.sealed && e.rec).map((e) => normEvent(e.rec)),
    unsealed: {
      decisions: decisionsAll.filter((d) => !d.sealed && !d.torn).map((d) => ({ line: d.line, job: d.rec && d.rec.job })),
      events: eventsAll.filter((e) => !e.sealed && !e.torn).map((e) => ({ line: e.line, job: e.rec && e.rec.job })),
    },
    // Lines that aren't JSON at all: a crashed or concurrent writer, or a hand edit.
    torn: {
      events: eventsAll.filter((e) => e.torn).map((e) => e.line),
      decisions: decisionsAll.filter((d) => d.torn).map((d) => d.line),
    },
    sealsChecked: Boolean(secret()),
    inspectorHookErrors: readLog(L.hookErrors).filter((l) => l.rec).map((l) => l.rec),
  };
}

const isRouting = (d) => d && d.action && !String(d.action).startsWith('human.');

module.exports = { observe, jobIds, isRouting, normEvent, openAgents };
