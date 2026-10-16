'use strict';
// userPromptSubmitted: your own reply ("approve", "deny …", "resume", "accept lesson L4", "merged <sha>", …)
// is applied by the CLI as a side effect, before the model acts on it. A short message that
// only looks like a reply ("aprove", "approve the plan please") is never applied; the agent
// is told so, with the exact forms.
//
// Copilot may drop this hook's output: the reference says command-hook output is dropped,
// the changelog (1.0.65) says additionalContext reaches the model (hooks.md §5.3). So the
// outcome is ALSO written to .factory/last-reply.json, which `factory next` shows until the
// next routing decision. A new prompt from the human also starts a new turn: it is stamped in
// .factory/turn.json ({ at, factory }) so the stop gate can tell factory work (/factory:…,
// a factory reply) from a turn that only answers the user. Continuation prompts (stop-gate
// block reasons Copilot feeds back, Autopilot's own text) are not a new turn: no stamp.
// The stop gate's record of decisions it already blocked (.factory/stop-blocks.json) is
// never reset here: it blocks at most once per routing decision, across turns.
// In an agent process `factory run` started there is no human and no stop gate: nothing to do.
// Clarify v3: while the current job waits on a clarify screen, an unmistakable reply (ok on the
// read-back or a redirect, a numbered sheet reply such as "ok, but 2 b") is recorded through
// the same path as `factory clarify reply`; other words are left for the main session.

const fs = require('fs');
const path = require('path');
const { safe, context, findRoot, runnerAgent, isContinuation, isAutopilot, isScheduled, unscheduled } = require('./lib');

function writeLastReply(root, rec) {
  try {
    const f = path.join(root, '.factory', 'last-reply.json');
    fs.writeFileSync(`${f}.tmp-${process.pid}`, JSON.stringify(rec, null, 2) + '\n');
    fs.renameSync(`${f}.tmp-${process.pid}`, f);
  } catch {
    /* the side effect already happened; this is only the receipt */
  }
}

// The human asked for factory work: a factory slash command or skill (/factory:start,
// /factory:gate, "use the factory:start skill"), or `factory …` typed as a command.
function isFactoryPrompt(prompt) {
  const p = String(prompt || '').trim();
  return /^\/factory[:\s-]/i.test(p) || /(^|\s)factory:(start|gate|ship|review|park|amend|clarify|intake|why|distill|console)\b/i.test(p) || /^factory\s+\w/i.test(p);
}

function writeTurn(root, rec) {
  try {
    fs.writeFileSync(path.join(root, '.factory', 'turn.json'), JSON.stringify(rec) + '\n');
  } catch {
    /* best effort: without it the stop gate treats the turn as not factory work */
  }
}

// A reply to clarify's current screen (an ok on the read-back or a redirect, a numbered sheet
// reply), recorded through factory clarify reply; anything else is left for the main session.
function clarifyReply(root, input) {
  const events = require('../cli/core/events');
  const ctx = events.context(root, null);
  const text = String(input.prompt).trim().slice(0, 200);
  let r;
  try {
    r = require('../cli/core/clarify').chatReply(root, input.prompt, { jobId: ctx.job || undefined });
  } catch (e) {
    events.append(root, { event: 'reply_refused', reply: 'clarify', code: e.code || null, reason: e.message.slice(0, 200), ...ctx });
    writeLastReply(root, { at: new Date().toISOString(), text, status: 'refused', reply: 'clarify', code: e.code || null, job: ctx.job, decision_id: ctx.decision_id, message: e.message.slice(0, 300) });
    context(`[factory] Your reply was NOT recorded: ${e.message}`, `[factory] Your reply was NOT recorded: ${e.message.slice(0, 200)}`);
    return true;
  }
  if (!r) return false;
  events.append(root, { event: 'reply_applied', reply: 'clarify', stage: r.stage || null, ...ctx });
  writeLastReply(root, { at: new Date().toISOString(), text, status: 'applied', reply: 'clarify', job: r.job, decision_id: ctx.decision_id, message: r.message });
  context(`[factory] Recorded your reply for clarify: ${r.message} Continue with \`factory next\` (skill factory:start); do not record it again.`, `[factory] Recorded your reply: ${String(r.message).slice(0, 200)}`);
  return true;
}

safe((input) => {
  if (runnerAgent()) return;
  // Autopilot's own continuation prompt: Autopilot is on. Record it for factory next / doctor.
  if (isAutopilot(input.prompt)) {
    const r = findRoot(input.cwd);
    if (r) {
      const rec = require('../cli/core/autopilot').record(r, { session: input.sessionId || null });
      if (rec.count === 1) require('../cli/core/events').append(r, { event: 'autopilot_seen', session: rec.session });
      context(`[factory] ${require('../cli/core/autopilot').warning(rec)}`);
    }
    return;
  }
  if (isContinuation(input.prompt)) return;
  // A scheduled prompt (/every, /after, /loop) is never a reply: it fires unattended, at
  // whatever gate or clarify turn is open by then. One that reads like a reply is refused and
  // logged; any other is a turn like the user's own (a scheduled "/factory:start" is factory work).
  if (isScheduled(input.prompt)) {
    const r = findRoot(input.cwd);
    if (!r) return;
    const text = unscheduled(input.prompt).trim();
    const human = require('../cli/core/human');
    writeTurn(r, { at: new Date().toISOString(), session: input.sessionId || null, factory: isFactoryPrompt(text), scheduled: true });
    const looks = human.parseReply(text) || human.nearMiss(text) || (text.length <= 200 && /^(ok|okay|yes|accept|reject|approve|deny|resume|proceed)\b/i.test(text));
    if (!looks) return;
    const events = require('../cli/core/events');
    const ctx = events.context(r, null);
    const message = 'A scheduled prompt (/every, /after or /loop) is never applied as your reply: it fires unattended, whatever is waiting by then. Reply yourself in chat, or in your own terminal.';
    events.append(r, { event: 'reply_refused', reply: 'scheduled', code: 'scheduled_prompt', reason: message, ...ctx });
    writeLastReply(r, { at: new Date().toISOString(), text: text.slice(0, 200), status: 'refused', reply: 'scheduled', code: 'scheduled_prompt', job: ctx.job, decision_id: ctx.decision_id, message });
    context(`[factory] This scheduled prompt was NOT applied as a reply (nothing was approved, resumed or recorded): ${message} Tell the user in one line; do not act on it as a reply.`, `[factory] Scheduled prompt NOT applied as a reply: ${message}`);
    return;
  }
  const root0 = findRoot(input.cwd);
  const human = require('../cli/core/human');
  const parsed = human.parseReply(input.prompt);
  const miss = parsed ? null : human.nearMiss(input.prompt);
  const applied = !parsed && !miss && root0 ? clarifyReply(root0, input) : false;
  if (root0) writeTurn(root0, { at: new Date().toISOString(), session: input.sessionId || null, factory: Boolean(parsed || applied || isFactoryPrompt(input.prompt)) });
  if (applied) return;
  if (!parsed && !miss) return;
  const root = root0;
  if (!root) return;
  const events = require('../cli/core/events');
  const text = String(input.prompt).trim().slice(0, 200);
  let msg;
  let rec;
  if (miss) {
    msg = `[factory] "${text.slice(0, 80)}" looks like a factory reply but is not one, so NOTHING was applied (no approval, denial or resume was recorded). Replies must be the whole message, exactly one of: ${miss.forms.map((x) => `\`${x}\``).join(', ')}. Tell the user this in one line and ask them to resend the exact form if that is what they meant; do not act as if it was applied.`;
    const ctx = events.context(root, null);
    events.append(root, { event: 'reply_unparsed', word: miss.word.slice(0, 30), verb: miss.verb, ...ctx });
    rec = { status: 'unparsed', reply: null, job: ctx.job, decision_id: ctx.decision_id, message: `Not a factory reply, nothing applied. Exact forms: ${miss.forms.join(' · ')}` };
  } else {
    const ctx = events.context(root, parsed.jobId);
    try {
      const r = human.applyReply(root, parsed, 'chat');
      const what = r.message || JSON.stringify(r);
      msg = `[factory] Applied your reply: ${what} Continue with \`factory next\` (skill factory:start).`;
      rec = { status: 'applied', reply: parsed.cmd, job: r.job || ctx.job, decision_id: ctx.decision_id, message: what };
    } catch (e) {
      msg = `[factory] Your reply "${text}" was NOT applied: ${e.message}`;
      events.append(root, { event: 'reply_refused', reply: parsed.cmd, gate: parsed.gate || null, code: e.code || null, reason: e.message.slice(0, 200), ...ctx });
      rec = { status: 'refused', reply: parsed.cmd, code: e.code || null, job: ctx.job, decision_id: ctx.decision_id, message: e.message.slice(0, 300) };
    }
  }
  writeLastReply(root, { at: new Date().toISOString(), text, ...rec });
  // VS Code's Local harness can't add context on a prompt: the user sees this line instead.
  const shown = rec.status === 'applied' ? `[factory] Applied your reply: ${rec.message}` : rec.status === 'refused' ? `[factory] Your reply was NOT applied: ${rec.message}` : `[factory] ${rec.message}`;
  context(msg, shown);
});
