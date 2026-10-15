'use strict';
// Autopilot detection. Copilot's Autopilot answers questions and permission prompts by
// itself and keeps working past the factory's stop points, and every gate here is the
// user's. The CLI can't see the session mode, but the prompt hook sees Autopilot's own
// continuation prompt ("You have not yet marked the task as complete using the
// task_complete tool…", verified on CLI 1.0.97), which only Autopilot sends. The hook
// records it in .factory/autopilot.json; `factory next` and `factory doctor` warn while
// the sighting is recent.
//
// Limits: a session in Autopilot that never stops early sends no continuation, so it is
// not seen; plan-then-autopilot is caught only through COPILOT_PLAN_THEN_AUTOPILOT
// (doctor). Gate replies are safe either way: Autopilot's text is never a factory reply.

const fs = require('fs');
const path = require('path');

const WINDOW_MS = 6 * 3600 * 1000;
const file = (root) => path.join(root, '.factory', 'autopilot.json');

function record(root, { session = null, at = new Date().toISOString() } = {}) {
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(file(root), 'utf8'));
  } catch {
    prev = null;
  }
  const rec = { first_at: prev && prev.session === session ? prev.first_at : at, last_at: at, session, count: prev && prev.session === session ? (prev.count || 0) + 1 : 1 };
  fs.writeFileSync(file(root), JSON.stringify(rec, null, 2) + '\n');
  return rec;
}

// The recent sighting, or null.
function recent(root, now = Date.now()) {
  try {
    const r = JSON.parse(fs.readFileSync(file(root), 'utf8'));
    return now - Date.parse(r.last_at) <= WINDOW_MS ? r : null;
  } catch {
    return null;
  }
}

function warning(r) {
  return `Copilot Autopilot was detected in this project (last continuation ${r.last_at}). Autopilot answers prompts by itself and keeps going past the factory's stops, and the gates are the user's: tell the user to switch back to interactive mode (Shift+Tab, or /autopilot off) and stop here.`;
}

module.exports = { record, recent, warning, WINDOW_MS };
