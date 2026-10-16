'use strict';
// factory inbox — everything waiting on the human, across jobs (P3.2). Read-only: it routes
// nothing and writes nothing, so it is safe to run any time, from a terminal or the console.
// For each item: what waits (a gate, a clarify turn, a park, a merge …), what to reply in chat,
// and the terminal command; a human-only command asks for a code shown on that terminal only
// (never paste it into a chat, and no agent may ask for it).

const path = require('path');
const job = require('./job');
const decisions = require('./decisions');
const { readJson, readJsonl } = require('../lib/util');
const { jobPaths, project } = require('../lib/paths');

const GATE_WHAT = {
  H1: 'the contract', EH1: 'the epic contract', H2: 'the design', EH2: 'the epic design and frozen contracts', HF: 'the spike findings',
  H3: 'the plan', EH3: 'the epic slices', HS: 'the ship sign-off', A: 'the amendment',
};

// plain: read the files as they are, checking no seal (the console reads this way, and must
// never create a factory key on a machine that has none).
function clarifyWait(root, state, plain) {
  try {
    const C = require('./clarify');
    const data = plain ? readJson(path.join(jobPaths(root, state.id).dir, 'clarify.json'), null) : C.load(root, state.id);
    if (!data || data.tampered || !C.WAITS.has(data.stage)) return null;
    const screen = data.stage === 'readback_wait' ? C.readbackScreen(state, data) : data.stage === 'sheet_wait' ? C.sheetScreen(state, data) : C.redirectScreen(state, data);
    return { stage: data.stage, screen };
  } catch {
    return null;
  }
}

function lastRouting(root, jobId, plain) {
  const all = plain ? readJsonl(project(root).decisionsFile).filter((r) => r && r.job === jobId) : decisions.forJob(root, jobId);
  const rows = all.filter((d) => d.id && !String(d.action || '').startsWith('human.'));
  return rows[rows.length - 1] || null;
}

function itemFor(root, state, driveStop, plain = false) {
  const J = state.id;
  const base = { job: J, title: state.title, status: state.status, since: null };
  const pg = state.pending_gate;
  // a submitted amendment pre-empts a park (approving it resumes the job)
  // Approvable only once presented: until factory next (or the drive) has shown gate A, a chat
  // "approve" is refused (no_gate), so the inbox says what presents it instead.
  if (state.amendment && state.amendment.status === 'submitted' && !(pg && pg.id === 'A')) {
    return { ...base, kind: 'amend', since: state.amendment.submitted_at || null, what: `an amendment waits to be presented for your approval${state.status === 'parked' ? ' (approving it will also resume the parked job)' : ''}`, reply: ['continue (Copilot runs factory drive, which presents gate A)'], command: 'factory drive', human_only: false };
  }
  if (state.amendment && state.amendment.status === 'submitted') {
    return { ...base, kind: 'gate', gate: 'A', hash: state.amendment.hash, docs: [state.amendment.file], since: state.amendment.submitted_at || null, what: `approve ${GATE_WHAT.A}${state.status === 'parked' ? ' (approving it also resumes the parked job)' : ''}`, reply: ['approve', 'deny <what must change>'], command: `factory approve --job ${J}`, human_only: true };
  }
  if (state.status === 'parked') {
    const p = state.park || {};
    let kind = p.kind;
    let next = p.next;
    if (!kind) {
      const dt = require('./decision-table');
      kind = dt.parkKind(p.reason, p.from);
      next = dt.parkNext(kind);
    }
    return { ...base, kind: 'park', park_kind: kind, reason: p.reason || null, next: next || null, since: p.at || null, what: `parked (${kind})`, reply: ['resume', 'cancel job', 'abandon job', 'or say what to change'], command: `factory resume --job ${J}`, human_only: true };
  }
  if (state.status !== 'active') return null;
  if (pg && pg.id && pg.id !== 'P') {
    // a combined gate (0.10.0) approves more than its document: say what, in one line
    let what = GATE_WHAT[pg.id] || `gate ${pg.id}`;
    try {
      const steps = require('./steps');
      const list = steps.combinedOf(steps.context(root, state, job.load), pg.id);
      if (list) what = `${list.map((x) => ({ design: 'the design', plan: 'the plan', environment: 'the build environment' })[x]).join(', ').replace(/, ([^,]*)$/, ' and $1')} (one approval${list.includes('environment') ? '; the build environment is set for this repository: other jobs build in it too' : ''})`;
    } catch {
      /* the plain label */
    }
    // 0.11: at the design or plan gate, what / how / where in one place (cli/core/design.js)
    let design = null;
    if (['H2', 'EH2', 'H3'].includes(pg.id)) {
      try {
        const v = require('./design').view(root, state);
        if (v) design = { summary: v.summary, decisions: v.decisions.map((d) => ({ id: d.id, title: d.title, chosen: d.chosen })), markdown: require('./design').markdown(v) };
      } catch {
        design = null;
      }
    }
    return { ...base, kind: 'gate', gate: pg.id, hash: pg.hash, docs: pg.docs || [], since: pg.at || null, what: `approve ${what}`, ...(design ? { design } : {}), reply: ['approve', 'deny <what must change>'], command: pg.id === 'A' ? `factory approve --job ${J}` : `factory approve ${pg.id} --job ${J}`, human_only: true };
  }
  const cw = clarifyWait(root, state, plain);
  if (cw) {
    const what = { readback_wait: 'clarify read-back: is this what you want?', sheet_wait: 'clarify decision sheet: your answers', redirect_wait: 'clarify: confirm how your redirect was read' }[cw.stage];
    return { ...base, kind: 'clarify', stage: cw.stage, what, screen: cw.screen, reply: cw.stage === 'sheet_wait' ? ['ok (take every recommendation)', 'your answers, e.g. "1 a, 2: <your words>"'] : ['ok', 'or what to change, in your words'], command: `factory clarify reply "<your words>" --job ${J}`, human_only: false };
  }
  const d = lastRouting(root, J, plain);
  if (d && d.action === 'wait') {
    if (/merged/.test(d.reason || '') && state.pr && state.pr.merged) return null;
    if (/merged/.test(d.reason || '')) return { ...base, kind: 'merge', since: d.ts, what: 'merge the job branch yourself, then tell the factory', reason: d.reason, reply: ['merged', 'merged <commit>'], command: `factory next --job ${J}`, human_only: false };
    if (d.rule === 'row5.human_confirm') return { ...base, kind: 'confirm', since: d.ts, what: 'check criteria on the build yourself', reason: d.reason, reply: ['confirm AC-n'], command: `factory confirm <AC-n> --job ${J}`, human_only: true };
    // the one ship review: the human's checks, the unsettled findings, the push approval, in one reply
    // a build waiting for its environment (0.10.0): only the human's "confirm environment"
    if (d.rule === 'env.unconfirmed') return { ...base, kind: 'environment', since: d.ts, what: 'confirm the build environment before the build starts', reason: d.reason, reply: ['confirm environment <hash>', 'confirm environment none'], command: `factory env set --job ${J}`, human_only: true };
    if (d.rule === 'ship.review') return { ...base, kind: 'ship_review', since: d.ts, what: 'the ship review: one reply settles it', reason: d.reason, screen: d.reason, reply: ['confirm AC-n; dismiss finding <id> <why>; approve ship (any of them, in one message)'], command: `factory next --job ${J}`, human_only: true };
    return { ...base, kind: 'wait', since: d.ts, what: d.reason || 'waiting on you', reason: d.reason, reply: ['continue'], command: null, human_only: false };
  }
  // a drive stop that waits on the main session or on you (questions, a degraded run, an amendment)
  if (driveStop && driveStop.job === J && ['questions', 'degraded', 'amend', 'evidence', 'skill', 'error', 'copilot_unavailable', 'transient', 'step_too_long'].includes(driveStop.kind)) {
    return { ...base, kind: `drive_${driveStop.kind}`, since: driveStop.at, what: driveStop.summary, ...(driveStop.questions ? { questions: driveStop.questions } : {}), reply: driveStop.kind === 'questions' ? ['your answers'] : ['tell Copilot how to go on'], command: driveStop.kind === 'questions' ? `factory answer --job ${J} --question "<question>" --answer "<answer>"` : 'factory drive', human_only: false };
  }
  return null;
}

function list(root, { plain = false } = {}) {
  const drive = require('./drive');
  const st = drive.readState(root);
  const stop = st && st.status !== 'running' ? st.last : null;
  const items = [];
  for (const id of job.listJobIds(root)) {
    let state;
    try {
      state = plain ? readJson(jobPaths(root, id).state, null) : job.load(root, id);
    } catch {
      continue;
    }
    if (!state) continue;
    const it = itemFor(root, state, stop, plain);
    if (it) items.push(it);
  }
  // project brief changes distill proposed: they wait for the user like a gate (human-only)
  try {
    for (const p of require('./project-brief').proposals(root, { status: 'proposed' })) {
      items.push({ job: p.job || 'project', title: 'Project brief (.factory/project.md)', kind: 'brief', proposal: p.id, since: p.created_at || null, what: `accept or reject project brief change ${p.id}${p.why ? ` (${String(p.why).slice(0, 120)})` : ''}: ${p.edits.map((e) => `${e.section}: ${[...(e.add || []).map((a) => `+ ${a}`), ...(e.remove || []).map((r) => `- ${r}`)].join(' ')}`).join('; ').slice(0, 400)}`, reply: [`accept brief ${p.id}`, `reject brief ${p.id} <why>`], command: `factory lessons accept ${p.id}`, human_only: true });
    }
  } catch {
    /* no proposals file */
  }
  // lessons distill proposed: the end-of-job digest, next to the brief proposals (human-only; one
  // reply may settle several: "accept lesson L4; reject lesson L5 too broad; accept brief P1")
  try {
    const doc = readJson(project(root).lessonsFile, null);
    for (const l of ((doc && doc.lessons) || []).filter((x) => x.status === 'proposed')) {
      items.push({ job: l.source_job || 'project', title: 'Lessons register (.factory/lessons.json)', kind: 'lesson', lesson: l.id, since: l.created_at || null, what: `accept or reject lesson ${l.id} (${(l.scope || []).join(', ')}): ${String(l.text).slice(0, 300)}`, reply: [`accept lesson ${l.id}`, `reject lesson ${l.id} <why>`], command: `factory lessons accept ${l.id}`, human_only: true });
    }
  } catch {
    /* no lessons file */
  }
  items.sort((a, b) => String(a.since || '').localeCompare(String(b.since || '')));
  const live = drive.liveFor(root);
  return {
    items,
    count: items.length,
    drive: live ? { running: true, pid: live.pid, job: live.job, step: live.step || null } : st ? { running: false, status: st.status === 'running' ? 'crashed' : st.status, job: st.job, last: st.last ? st.last.summary : null } : null,
    message: items.length
      ? `${items.length} item(s) wait on you. Reply in chat, or run the command in your own terminal: a human-only command asks you to type a code shown there (type it there; never paste it into a chat).`
      : 'Nothing waits on you.',
  };
}

function markdown(r) {
  const L = ['# Factory inbox', ''];
  if (r.drive) L.push(r.drive.running ? `factory drive is running ${r.drive.job}${r.drive.step ? ` (${r.drive.step})` : ''}.` : `factory drive: ${r.drive.status}${r.drive.last ? ` — ${r.drive.last}` : ''}`, '');
  if (!r.items.length) {
    L.push('Nothing waits on you.');
    return L.join('\n');
  }
  r.items.forEach((it, i) => {
    L.push(`## ${i + 1}. ${it.job} — ${it.what}`, '', `${it.title}${it.since ? ` · since ${String(it.since).replace('T', ' ').slice(0, 16)}` : ''}`);
    if (it.gate) L.push(`- Gate **${it.gate}** · hash \`${String(it.hash || '').slice(0, 12)}\`${(it.docs || []).length ? ` · documents: ${it.docs.join(', ')}` : ''}`);
    if (it.reason) L.push(`- Why: ${String(it.reason).split('\n')[0]}`);
    if (it.next) L.push(`- Suggested next: ${it.next}`);
    if (it.questions) it.questions.forEach((q, n) => L.push(`  ${n + 1}. ${q}`));
    L.push(`- Reply in chat: ${it.reply.map((x) => `\`${x}\``).join(' · ')}`);
    if (it.command) L.push(`- Or in your terminal: \`${it.command}\`${it.human_only ? ' (it asks you to type a code shown on that terminal)' : ''}`);
    if (it.screen) L.push('', '```text', it.screen.trim(), '```');
    if (it.design && it.design.markdown) L.push('', it.design.markdown.trim());
    L.push('');
  });
  L.push(r.message);
  return L.join('\n');
}

module.exports = { list, markdown, itemFor };
