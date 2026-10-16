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

// 0.11 machine-aware environments: two commands a factory agent may not run, by flag. The machine
// scan (factory doctor --machine) and the sealed environment's check for a job (factory env check
// --job: it runs the human's environment and records the result the repair loop and the seal
// read; factory drive runs it) are the main session's steps. An agent may check a proposal
// (factory env check --proposed). `has(name)`: whether the command carries --name. One rule for
// the guard hook (by command text) and the CLI (by parsed options, while an agent is at work).
function agentFlagRefusal(a, b, has) {
  if (a === 'doctor' && has('machine')) return { code: 'agent_not_allowed', message: '"factory doctor --machine" scans this machine\'s tools; it is the main session\'s step, never a factory agent\'s. Read the machine summary your brief carries.' };
  if (a === 'env' && b === 'check' && has('job') && !has('proposed')) return { code: 'agent_not_allowed', message: '"factory env check --job" checks the sealed build environment for the job and records it (factory drive runs it); a factory agent may only check a proposal (factory env check --proposed).' };
  return null;
}

module.exports = { HUMAN_ONLY, isHumanOnly, agentFlagRefusal };
