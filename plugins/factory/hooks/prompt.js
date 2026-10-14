'use strict';
// userPromptSubmitted: your own reply ("approve", "deny …", "resume", "accept lesson L4", "merged <sha>", …)
// is applied by the CLI as a side effect, before the model acts on it. A short message that
// only looks like a reply ("aprove", "approve the plan please") is never applied; the agent
// is told so, with the exact forms.
//
// Copilot may drop this hook's output: the reference says command-hook output is dropped,
// the changelog (1.0.65) says additionalContext reaches the model (hooks.md §5.3). So the
// outcome is ALSO written to .factory/last-reply.json, which `factory next` shows until the
// next routing decision. A new prompt also starts a new turn: the stop gate's block counter
// is reset here.

const fs = require('fs');
const path = require('path');
const { safe, context, findRoot } = require('./lib');

function writeLastReply(root, rec) {
  try {
    const f = path.join(root, '.factory', 'last-reply.json');
    fs.writeFileSync(`${f}.tmp-${process.pid}`, JSON.stringify(rec, null, 2) + '\n');
    fs.renameSync(`${f}.tmp-${process.pid}`, f);
  } catch {
    /* the side effect already happened; this is only the receipt */
  }
}

safe((input) => {
  const root0 = findRoot(input.cwd);
  if (root0) {
    try {
      fs.rmSync(path.join(root0, '.factory', 'stop-blocks.json'), { force: true });
    } catch {
      /* best effort */
    }
  }
  const human = require('../cli/core/human');
  const parsed = human.parseReply(input.prompt);
  const miss = parsed ? null : human.nearMiss(input.prompt);
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
  context(msg);
});
