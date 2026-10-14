'use strict';
// UserPromptSubmit: your own reply ("approve", "deny …", "resume", "accept lesson L4", "merged <sha>", …)
// is applied by the CLI before the model sees it. Subagent prompts never pass through here.
// A short message that only looks like a reply ("aprove", "approve the plan please") is
// never applied; Claude is told so, with the exact forms.

const { safe, emit, findRoot } = require('./lib');

safe((input) => {
  const human = require('../cli/core/human');
  const parsed = human.parseReply(input.prompt);
  const miss = parsed ? null : human.nearMiss(input.prompt);
  if (!parsed && !miss) return;
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return;
  const events = require('../cli/core/events');
  let msg;
  if (miss) {
    msg = `[factory] "${String(input.prompt).trim().slice(0, 80)}" looks like a factory reply but is not one, so NOTHING was applied (no approval, denial or resume was recorded). Replies must be the whole message, exactly one of: ${miss.forms.map((x) => `\`${x}\``).join(', ')}. Tell the user this in one line and ask them to resend the exact form if that is what they meant; do not act as if it was applied.`;
    events.append(root, { event: 'reply_unparsed', word: miss.word.slice(0, 30), verb: miss.verb, ...events.context(root, null) });
  } else {
    try {
      const r = human.applyReply(root, parsed, 'chat');
      msg = `[factory] Applied your reply: ${r.message || JSON.stringify(r)} Continue with \`factory next\` (skill factory:start).`;
    } catch (e) {
      msg = `[factory] Your reply "${String(input.prompt).trim()}" was NOT applied: ${e.message}`;
      events.append(root, { event: 'reply_refused', reply: parsed.cmd, gate: parsed.gate || null, code: e.code || null, reason: e.message.slice(0, 200), ...events.context(root, parsed.jobId) });
    }
  }
  emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: msg } });
});
