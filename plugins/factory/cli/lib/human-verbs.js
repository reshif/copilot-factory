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

module.exports = { HUMAN_ONLY, isHumanOnly };
