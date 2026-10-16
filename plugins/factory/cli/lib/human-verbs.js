'use strict';
// The factory verbs that are the human's alone: a gate, a park, a waiver, a merge, a check of a
// criterion, a lesson, a CI install, a confirmed environment. One list for every layer that
// refuses them: the guard hook (hooks/guard-rules.js reads commands by it) and factory drive
// (it never runs one, whatever `factory next` names). The CLI's own check is the human channel
// (cli/core/human.js requireHumanChannel: a real terminal and a typed code, or a chat reply).

const HUMAN_ONLY = new Set(['approve', 'deny', 'resume', 'proceed', 'cancel', 'abandon', 'waive', 'merged', 'confirm', 'reseal', 'assumption', 'finding']);

function isHumanOnly(a, b) {
  return HUMAN_ONLY.has(a) || (a === 'lessons' && ['accept', 'reject', 'promote'].includes(b)) || (a === 'ci' && b === 'install') || (a === 'env' && b === 'set');
}

// 0.11 machine-aware environments: commands a factory agent may not run, by flag. The machine
// scan (factory doctor --machine) and every check of the confirmed environment (factory env check
// without --proposed: it runs the human's environment with their shell; with --job or --repair it
// records the result the repair loop and the seal read; factory drive runs it) are the main
// session's steps. An agent may check a proposal (factory env check --proposed), sandboxed.
// `has(name)`: whether the command carries --name; `computed`: a flag the guard cannot read (built
// at run time: $(…), `…`, an unknown variable) counts against the agent (review m-2, m-8). One rule
// for the guard hook (by command text) and the CLI (by parsed options, while an agent is at work).
function agentFlagRefusal(a, b, has, { computed = false } = {}) {
  if (a === 'doctor' && (computed || has('machine'))) return { code: 'agent_not_allowed', message: '"factory doctor --machine" scans this machine\'s tools; it is the main session\'s step, never a factory agent\'s (a flag computed at run time counts as one). Read the machine summary your brief carries.' };
  if (a === 'env' && b === 'check' && (computed || !has('proposed'))) return { code: 'agent_not_allowed', message: '"factory env check" without --proposed runs the sealed build environment with the user\'s own shell (with --job or --repair it records the result the repair loop and the seal read; factory drive runs it); a factory agent may only check a proposal (factory env check --proposed).' };
  return null;
}
// The same steps inside inline code (node -e, python -c …) or a script's text (review m-2).
const MACHINE_STEP_TEXT = /\bfactory\b[^\n;|&]*?\b(doctor\b[^\n;|&]*--machine|env\s+check\b(?![^\n;|&]*--proposed))/;
function machineStepInText(text) {
  return MACHINE_STEP_TEXT.test(String(text || '')) ? 'Code or a script that runs "factory doctor --machine" or "factory env check" (other than --proposed) is not allowed for factory agents: those are the main session\'s steps (factory drive runs them).' : null;
}

module.exports = { HUMAN_ONLY, isHumanOnly, agentFlagRefusal, machineStepInText };
