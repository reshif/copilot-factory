'use strict';
// Builds the brief a workflow runs from. Workflow scripts can't read files or run
// commands, so everything they need — which factory agent runs each item, the run
// context, schemas, limits, the input hash — arrives here, assembled by the CLI.

const path = require('path');
const { readText, readJson, writeText, sha256, stableStringify, fail } = require('../lib/util');
const { pluginPath, jobPaths, taskWorktree, PLUGIN_ROOT } = require('../lib/paths');
const git = require('../lib/git');
const job = require('./job');
const steps = require('./steps');
const ledger = require('./ledger');
const contractMod = require('./contract');
const lessons = require('./lessons');
const review = require('./review');
const budgets = require('./budgets');
const invalidation = require('./invalidation');
const questions = require('./questions');
const docs = require('./doc');
const intent = require('./intent');

// The self-check an agent runs on a doc it wrote before returning.
function docCheck(root, state, file) {
  return `Before returning, run \`${cli(root)} doc check ${file} --job ${state.id}\` and fix every problem it lists (missing or out-of-order sections, front matter, placeholders, tables, uncovered criteria, malformed or missing Mermaid). \`factory record\` runs the same check and rejects the design otherwise.`;
}

function roleBody(role) {
  const t = readText(pluginPath('agents', `${role}.agent.md`), null) ?? readText(pluginPath('agents', `${role}.md`), null);
  if (t === null) fail(`Agent definition agents/${role}.agent.md is missing`, 'plugin_broken');
  return t.replace(/^---[\s\S]*?\n---\n/, '').trim();
}

function schema(name) {
  return readJson(pluginPath('schemas', 'agent-outputs', `${name}.json`));
}

function cli(root) {
  return `node "${path.join(PLUGIN_ROOT, 'bin', 'factory')}" --root "${root}"`;
}

// The role's tools: the `tools:` list in agents/<role>.agent.md, the same list `factory run`
// starts the agent with. The brief names only these, by the names the Copilot CLI shows.
function roleTools(role) {
  const t = readText(pluginPath('agents', `${role}.agent.md`), null);
  const m = t && /^tools:\s*(\[.*\])\s*$/m.exec(t.split(/\n---\n/)[0]);
  if (!m) fail(`agents/${role}.agent.md has no tools: list`, 'plugin_broken');
  const list = JSON.parse(m[1]);
  const has = (...names) => names.some((n) => list.includes(n));
  return { read: has('read'), grep: has('grep', 'search'), glob: has('glob', 'search'), edit: has('edit'), shell: has('execute'), web: has('web_fetch', 'web') };
}

// "Working with files": role- and tool-aware, so a read-only or shell-less role is never
// told to change files or run commands.
function workingText(role) {
  const t = roleTools(role);
  const tools = [
    t.read && '`view` (read a file)',
    t.grep && '`rg` (search text)',
    t.glob && '`glob` (find files)',
    t.edit && '`edit` and `create` (change or write a file)',
    t.shell && 'the shell (`bash`, or `powershell` on Windows)',
    t.web && '`web_fetch` (fetch a public URL)',
  ].filter(Boolean);
  const list = tools.length > 1 ? `${tools.slice(0, -1).join(', ')} and ${tools[tools.length - 1]}` : tools[0];
  return [
    `- Your tools are ${list}. Use them to read any file, the job folder included.`,
    t.edit
      ? '- Change only the files this run tells you to. If `edit` cannot match a long passage, rewrite the whole file with `create`.'
      : `- You change no files${t.shell ? ', not even through the shell' : ''}.`,
    t.shell
      ? '- Use the shell for the project\'s own commands and the factory CLI shown above. Never run python, node or other interpreter scripts against the job folder or the factory\'s own files, not even to pretty-print JSON or replace a section: the guard blocks it and the attempt is logged.'
      : '- You have no shell: run no commands. Everything you need is in files you can read.',
  ].join('\n');
}

// Full instructions go to a file under .factory/scratch/briefs/; the brief carries a short
// pointer to it, so the workflow args stay small. `tail` holds the per-call parts the
// workflow fills in ({{attempt}}, {{failures}}, {{swept}}, {{finding}}) or appends (INPUTS).
let RUN = null;

// One owner per rule: the role's rules and its final-message recipe live in
// agents/<role>.agent.md (the agent's system prompt, started as factory:<role>), the reply
// format and its schema in the runner's strict reply block. The brief carries only this
// run's context. Inline briefs (no files) still carry the role text.
function fullText(role, context, withRole = false) {
  return [
    ...(withRole ? [roleBody(role), '', '---'] : [`# Factory ${role} — this run`, '']),
    '## This run',
    context.trim(),
    '',
    '## Working with files',
    workingText(role),
  ].join('\n');
}

function prompt(role, context, tail = '') {
  if (!RUN) {
    const text = fullText(role, context, true);
    return tail ? `${text}\n\n${tail}` : text;
  }
  const text = fullText(role, context);
  RUN.n += 1;
  const file = path.join(RUN.dir, `${String(RUN.n).padStart(2, '0')}-${role}.md`);
  writeText(file, text);
  return [
    `You are running as the Software Factory's ${role} (your role instructions are your system prompt). Before doing anything else, read this run's context from this file:`,
    `  ${file}`,
    'Follow your role and that context exactly, and end with the final message your role describes.',
    tail ? `\n${tail}` : '',
  ].join('\n').trim();
}

// Your "deny <reason>" at a gate reaches the agents who redo that work.
function denialNotes(state, gates) {
  const notes = [];
  for (const g of gates) {
    const approvedAt = state.approvals && state.approvals[g] ? state.approvals[g].at : '';
    for (const d of state.denials || []) if (d.gate === g && d.at > approvedAt) notes.push(`  - At ${g} the human said: ${d.reason || '(no reason given)'}`);
  }
  return notes.length ? `- The human denied the previous version. Address every point:\n${notes.join('\n')}` : '';
}

function jobContext(root, state, gates = []) {
  const jp = jobPaths(root, state.id);
  const parsed = contractMod.parse(contractMod.read(root, state.id));
  return [
    `- Project root: ${root}`,
    `- Job: ${state.id} — ${state.title}`,
    `- Work type: ${state.work_type} · Risk: ${state.risk} · Recipe: ${state.recipe.id}`,
    `- Job folder: ${jp.dir}`,
    `- Contract: ${jp.contract}`,
    `- Factory CLI: \`${cli(root)}\``,
    parsed.intent && parsed.intent.present
      ? `- Intent:\n${contractMod.INTENT_FIELDS.map((f) => `  - ${f.label}: ${parsed.intent[f.key] && !contractMod.isPlaceholder(parsed.intent[f.key]) ? parsed.intent[f.key] : '(not settled yet)'}`).join('\n')}`
      : '- Intent: (no Intent section yet)',
    `- Goal: ${parsed.goal || '(not written yet)'}`,
    parsed.acs.length ? `- Acceptance criteria:\n${parsed.acs.map((a) => `  - ${a.id}: ${a.text} (evidence: ${a.evidence.join(', ')})`).join('\n')}` : '- Acceptance criteria: (none yet)',
    denialNotes(state, gates),
  ]
    .filter(Boolean)
    .join('\n');
}

// Which factory agent runs an item, and on which model (policy.agents.models, optional).
function agentSpec(state, role) {
  const a = (state.policy && state.policy.agents) || {};
  const model = (a.models || {})[role] || null;
  return { role, agent_type: `factory:${role}`, ...(model ? { model } : {}) };
}

function inputHash(parts) {
  return sha256(stableStringify(parts));
}

function base(root, state, workflow, extra = {}) {
  return {
    workflow,
    job: state.id,
    root,
    plugin_root: PLUGIN_ROOT,
    cli: cli(root),
    budgets: budgets.snapshot(root, state),
    ...extra,
  };
}

// ---------------------------------------------------------------- fanout-judge: clarify
// Clarify v2 (docs/DESIGN-CLARIFY-v2.md): every brief carries the issue ledger (settled: do
// not re-raise; open: the only things to ask about), what is new since the last round and
// which contract sections changed; the contract editor gets what was settled but is not in
// the contract text yet.
function ledgerState(root, state, round) {
  const clarify = require('./clarify');
  const raw = intent.load(root, state.id);
  if (!raw || raw.tampered) return null;
  const data = clarify.ensure(root, state, raw);
  clarify.acceptDefaults(data, state, round);
  return data;
}

function clarify(root, state, ctx, acceptDegraded) {
  const cfg = readJson(pluginPath('config', 'workflows', 'clarify.json'));
  const clarifyMod = require('./clarify');
  const round = state.counters.clarify_rounds + 1;
  const CL = clarifyMod.limits(state);
  const L = { ...state.policy.limits, max_intent_rounds: CL.ceiling };
  const maxQ = questions.budget(cfg, CL.counted + 1, L);
  const jp = jobPaths(root, state.id);
  const answers = readJson(jp.answers, []);
  const asked = questions.askedList(state, answers);
  const jc = jobContext(root, state, ['H1', 'EH1']);
  const data = ledgerState(root, state, round);
  const lastRound = data && (data.rounds || []).length ? data.rounds[data.rounds.length - 1] : null;
  const since = lastRound ? lastRound.at : '';
  // What changed since the last recorded round: contract sections, answers, notes.
  const text = contractMod.read(root, state.id);
  const hashes = contractMod.sectionHashes(text);
  const before = (data && data.sections) || null;
  const changed = before ? Object.keys(hashes).filter((k) => hashes[k] !== before[k]) : null;
  const settledSections = before ? Object.keys(hashes).filter((k) => hashes[k] === before[k]) : [];
  const newAnswers = answers.filter((a) => !since || String(a.at || '') > since).map((a) => ({ ...(a.id ? { question: a.id } : {}), ...(a.issue ? { issue: a.issue } : {}), text: String(a.question || '').slice(0, 200), answer: String(a.answer || '').slice(0, 300) }));
  const issues = data ? data.unknowns : [];
  const newNotes = [...issues.flatMap((u) => (u.notes || []).filter((n) => String(n.at || '') > since && /^user/.test(n.actor || '')).map((n) => ({ issue: u.id, text: n.text }))), ...((data && data.notes) || []).filter((n) => n.ref === 'contract' && !n.applied && String(n.at || '') > since).map((n) => ({ issue: null, text: n.text }))];
  const defaultsTaken = issues.filter((u) => u.status === 'settled' && u.settled_by === 'assumption_accepted' && u.answered && u.answered.via === 'default' && (u.history || []).some((h) => h.round === round && /^settled/.test(h.event))).map((u) => ({ issue: u.id, default: u.answer }));
  const newEvidence = ((data && data.evidence) || []).filter((e) => e.round && lastRound && e.round === lastRound.round).map((e) => ({ id: e.id, issue: e.unknown, verdict: e.verdict }));
  const pending = issues.filter((u) => u.owner === 'research' && ['open', 'researching'].includes(u.status));
  const nothingNew = Boolean(data && lastRound && !(lastRound.ledger && lastRound.ledger.degraded) && changed && !changed.length && !newAnswers.length && !newNotes.length && !defaultsTaken.length && !pending.length);
  const ledgerBrief = data ? {
    round,
    new_since: { answers: newAnswers, defaults_taken: defaultsTaken, notes: newNotes, evidence: newEvidence },
    changed_sections: changed,
    settled_sections: settledSections,
    nothing_new: nothingNew,
  } : { round, new_since: { answers: newAnswers }, changed_sections: null, settled_sections: [], nothing_new: false };
  const review = changed === null ? '- Review the whole contract (first round with a ledger).' : changed.length ? `- Contract sections changed since the last round (review ONLY these; the others are settled and not re-reviewed): ${changed.join(', ')}.${settledSections.length ? ` Settled: ${settledSections.join(', ')}.` : ''}` : `- No contract section changed since the last round (settled: ${settledSections.join(', ') || 'all'}): review only the new answers, notes and evidence under CLARIFY LEDGER.`;
  const askedText = asked.map((q) => `  - ${q}`).join('\n') || '  - (none)';
  const answersText = answers.map((a) => `  - Q: ${a.question}\n    A: ${a.answer}`).join('\n') || '  - (none)';
  const protocol = `- Question protocol: categories in priority order ${cfg.priority.join(' > ')}. While any intent question is open, only intent questions are asked; the rest wait.\n- Identity: every question you raise names its issue: \`same_as\` an existing U-n from CLARIFY LEDGER, or "new" with a short \`subject\` key (e.g. "sync.trunk-ports"). Never raise a settled issue again.`;
  const fanout = cfg.fanout.map((f) => ({
    id: `${f.role}:${f.focus}`,
    ...agentSpec(state, f.role),
    category: f.category || questions.FOCUS_CATEGORY[f.focus] || 'scope',
    gate: Boolean(f.gate),
    label: `analyst · ${f.focus}`,
    prompt: prompt(f.role, `${jc}\n- Your focus: **${f.focus}** (category: ${f.category || 'scope'}) — ${f.brief}${f.gate ? '\n- You are the intent gate this round (see "If your focus is intent" in your role).' : ''}\n${protocol}\n${review}\n- Round ${round}. Questions already asked (never repeat them):\n${askedText}\n- Answers given earlier:\n${answersText}`),
    schema: schema('analyst'),
  }));
  const judge = {
    ...agentSpec(state, 'judge'),
    prompt: prompt(
      'judge',
      `${jc}\n- Mode: clarify, round ${round} (clarify parks after ${CL.no_progress} rounds in a row that settle nothing, or at ${CL.ceiling} rounds).\n- Ask at most ${maxQ} questions this round${maxQ === 0 ? ' (question budget spent: return none, record assumptions instead)' : ''}.\n${protocol}\n${review}\n- Never re-ask any of these:\n${askedText}\n- Answers given earlier:\n${answersText}\n- The analysts' outputs follow under INPUTS.`,
    ),
    schema: schema('judge'),
  };
  const critique = {
    ...agentSpec(state, 'god-eye'),
    prompt: prompt('god-eye', `${jc}\n- Focus: **intent**. The document is the contract: ${jp.contract}.\n- INTENT EVIDENCE (below your pointer) lists the research and the evidence-backed assumptions (A-n) the CLI writes into the contract's "## Assumptions (evidence-backed)" section when it records this round; CLARIFY LEDGER lists every issue, how the settled ones were settled (the CLI writes user answers into "## Clarifications (settled)") and what was deferred to design. Judge the contract as if those sections were there.\n${review}`),
    schema: schema(cfg.critique.schema || 'critique'),
    max_rounds: 1,
    when: 'no_questions',
  };
  // The contract editor: what was settled but is not in the contract text yet, the user's
  // notes, the contract's own problems, and a gate denial reason.
  const parsed = contractMod.parse(text);
  const problems = clarifyMod.inClarify(state) ? contractMod.problems(parsed) : [];
  const todo = [];
  for (const u of issues) {
    if (u.status === 'settled' && ['user', 'assumption_accepted'].includes(u.settled_by) && u.answer && !u.applied_round && (u.edit_attempts || 0) < 2) {
      todo.push({ from: 'ledger', ref: u.id, issue: String(u.text).slice(0, 300), settled: String(u.answer).slice(0, 300), how: u.settled_by === 'user' ? 'answered by the user' : 'default accepted' });
    }
  }
  for (const n of newNotes) todo.push({ from: 'user note', ref: n.issue || 'contract', note: n.text });
  if (clarifyMod.inClarify(state)) for (const pr of problems) todo.push({ from: 'contract check', problem: pr });
  // a gate denial goes to the editor once: in the first round after it (God Eye and the
  // analysts keep seeing it in the job context until the gate is approved)
  const denial = denialNotes(state, ['H1', 'EH1']);
  const denialNew = (state.denials || []).some((x) => ['H1', 'EH1'].includes(x.gate) && (!since || String(x.at || '') > since));
  if (denial && denialNew && clarifyMod.inClarify(state)) todo.push({ from: 'gate denial', note: denial.replace(/^- /, '') });
  const ed = cfg.editor ? {
    ...agentSpec(state, cfg.editor.role),
    label: 'contract editor',
    prompt: prompt(cfg.editor.role, `${jc}\n- The contract to revise: ${jp.contract}. Return its full revised text; the CLI writes it when it records this round. Change only what CHANGES TO APPLY (after your pointer) asks for.\n- Never change the CLI-owned sections (## Assumptions (evidence-backed), ## Clarifications (settled), ## Deferred to design): return them as they are.`),
    schema: schema(cfg.editor.schema),
    todo: clarifyMod.inClarify(state) ? todo : [],
  } : null;
  return base(root, state, 'fanout-judge', {
    config: 'clarify',
    mode: state.epic ? 'epic' : null,
    input_hash: inputHash({ contract: ctx.b.contract, round }),
    accept_degraded: Boolean(acceptDegraded),
    round,
    limits: { max_questions: maxQ, priority: cfg.priority },
    asked,
    fanout,
    judge,
    critique,
    editor: ed,
    ledger: ledgerBrief,
    verifier: null,
    scout: scoutBrief(root, state, cfg, jc, round, answersText, data),
  });
}

// ---------------------------------------------------------------- clarify: scout phase
// Research first: the intent mapper lists the unknowns, repo and web scouts (the
// researcher role) research the research-owned ones within policy.intent_research's budget
// for the job's risk, and the verifier re-checks high-impact and web findings. Later
// rounds reuse the ledger (jobs/<J>/intent-evidence.json): nothing settled is researched
// again; only research-owned issues still open (or due a retry) are.
function scoutBrief(root, state, cfg, jc, round, answersText, data) {
  const sc = cfg.scout;
  if (!sc) return null;
  const set = intent.settings(root, state);
  const prior = data || null;
  const mapped = Boolean(prior && (prior.rounds || []).some((r) => r.mapped && r.map_ok));
  const today = new Date().toISOString().slice(0, 10);
  const B = set.budget;
  const known = prior ? intent.briefText(prior) : '';
  const web = { enabled: set.web, reason: set.web ? null : 'policy (intent_research.web is false)', search_mcp: set.search_mcp };
  const searchText = set.search_mcp
    ? `- Search: use the MCP tool ${set.search_mcp} (configured in this repository's policy) for searches, then fetch and quote the pages themselves.`
    : '- There is no web search tool: find documentation URLs from the package registry and the vendor\'s documentation root (see "Web mode" in your role).';
  const settledList = prior ? prior.unknowns.filter((u) => ['settled', 'dropped', 'deferred_to_design'].includes(u.status)).map((u) => `  - ${u.id} (${u.subject}) ${String(u.text).slice(0, 120)} → ${u.status}${u.settled_by ? ` by ${u.settled_by}` : ''}`) : [];
  const mapper = {
    ...agentSpec(state, sc.mapper.role),
    label: 'intent map',
    prompt: prompt(sc.mapper.role, `${jc}\n- Clarify round ${round}: map the unknowns in the contract file above.\n- At most ${B.max_unknowns} unknowns.\n- Answers the user already gave (not unknowns any more):\n${answersText}${known ? `\n${known}` : ''}${settledList.length ? `\n- Issues already in the ledger (use same_as with their id instead of listing them again):\n${settledList.join('\n')}` : ''}`),
    schema: schema(sc.mapper.schema),
  };
  const scoutPrompt = (mode) => prompt(sc[mode].role, `${jc}\n- Mode: **${mode}** — you are a clarify scout (see "Scout mode" in your role).\n- Today: ${today}. Time budget: about ${Math.round(B.time_sec / 60)} minute(s) (a retry gets twice that); return what you have before it runs out.${mode === 'web' ? `\n${searchText}\n- A source listed under do_not_fetch_again failed before: do not fetch it again; report each source that fails now under failed_sources.` : ''}\n- The unknowns to research are given below your pointer to this file.`, 'Unknowns to research (JSON):\n{{unknowns}}');
  const verifier = {
    ...agentSpec(state, sc.verifier.role),
    label: 'verify evidence',
    prompt_template: prompt(sc.verifier.role, `${jc}\n- Today: ${today}.${B.strict_second_source ? '\n- This job is high risk: a high-impact (scope-changing) finding is confirmed only with a second independent source.' : '\n- A high-impact (scope-changing) finding needs a second independent source to be confirmed.'}\n- The findings to verify, and the versions this repository uses, are given below your pointer to this file.`, 'Findings to verify (JSON):\n{{findings}}'),
    schema: schema(sc.verifier.schema),
  };
  const ids = prior ? intent.nextIds(prior) : { U: 0, E: 0, A: 0 };
  const slim = (d) => ({
    unknowns: d.unknowns.map((u) => ({ id: u.id, subject: u.subject, subject_explicit: Boolean(u.subject_explicit), text: u.text, kind: u.kind, impact: u.impact, owner: u.owner, status: u.status, settled_by: u.settled_by || null, draft: u.draft, ...(u.options ? { options: u.options } : {}), default: u.default || null, reason: u.reason || null, research: u.research, ...(u.search ? { search: u.search } : {}), evidence: u.evidence, assumption: u.assumption, question_id: u.question_id, answer: u.answer, note: u.note, researched: u.researched, aliases: u.aliases || [], attempts: u.attempts || 0, failed_sources: u.failed_sources || [], applied_round: u.applied_round || null, history: (u.history || []).slice(-8), notes: (u.notes || []).slice(-5), source: u.source, round: u.round })),
    evidence: d.evidence,
    assumptions: d.assumptions.filter((a) => !a.withdrawn).map((a) => ({ id: a.id, unknown: a.unknown, statement: a.overridden ? a.override.value : a.statement, evidence: a.evidence, overridden: Boolean(a.overridden), dropped: Boolean(a.dropped) })),
    versions: d.versions || [],
  });
  return {
    round,
    risk: state.risk,
    web,
    budget: B,
    map_needed: !mapped,
    prior: prior ? slim(prior) : { unknowns: [], evidence: [], assumptions: [], versions: [] },
    pending: prior ? prior.unknowns.filter((u) => u.owner === 'research' && ['open', 'researching'].includes(u.status)).map((u) => u.id) : [],
    next_ids: ids,
    mapper,
    repo_scout: { ...agentSpec(state, sc.repo.role), label: 'scout · repo', mode: 'repo', prompt_template: scoutPrompt('repo'), schema: schema(sc.repo.schema) },
    web_scout: { ...agentSpec(state, sc.web.role), label: 'scout · web', mode: 'web', prompt_template: scoutPrompt('web'), schema: schema(sc.web.schema) },
    verifier,
  };
}

// ---------------------------------------------------------------- fanout-judge: decide
function decide(root, state, ctx, action) {
  const cfg = readJson(pluginPath('config', 'workflows', 'decide.json'));
  const jp = jobPaths(root, state.id);
  const mode = action.mode || (state.epic ? 'contracts' : null);
  const threat = action.threat_model === true || (action.threat_model === undefined && state.risk === 'high');
  const lastCritique = readJson(path.join(jp.critiquesDir, 'design.json'), null);
  const priorDesign = invalidation.designFiles(root, state.id);
  const docProblems = priorDesign.length ? docs.designProblems(root, state) : [];
  const history = [
    priorDesign.length ? `- This is not the first design round. Current design files (read them with \`view\`): ${priorDesign.join(', ')}` : '',
    docProblems.length ? `- The current design record breaks the doc templates; \`factory record\` rejects it until these are fixed:\n${docProblems.slice(0, 20).map((p) => `  - ${p}`).join('\n')}` : '',
    lastCritique && Array.isArray(lastCritique.items) && lastCritique.items.length
      ? `- God Eye's last design critique (${lastCritique.verdict}):\n${lastCritique.items.slice(0, 12).map((it) => `  - ${typeof it === 'string' ? it : [it.severity, it.issue || it.summary || JSON.stringify(it)].filter(Boolean).join(': ')}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');
  const idataD = intent.load(root, state.id);
  const deferredD = idataD && !idataD.tampered ? require('./clarify').deferredText(require('./clarify').ensure(root, state, idataD)) : '';
  const jc = `${jobContext(root, state, ['H2', 'EH2', 'HF'])}\n- Findings (cited): ${jp.findings}${deferredD ? `\n${deferredD}` : ''}${history ? `\n${history}` : ''}`;
  const existingAdrs = priorDesign.filter((f) => /adr-\d+/.test(f));
  const nextAdr = existingAdrs.length
    ? `${existingAdrs[existingAdrs.length - 1]} (revise it in place — keep this path — unless the decision itself is new)`
    : path.join(jp.dir, 'adr-001-<short-title>.md');
  const fanout = cfg.fanout
    .filter((f) => !(f.when === 'threat_model' && !threat))
    .filter((f) => !(mode === 'recommendation' && f.role === 'threat-modeler'))
    .map((f, i) => {
      if (f.role === 'threat-modeler') {
        return { id: 'threat-modeler', ...agentSpec(state, 'threat-modeler'), label: 'threat model', prompt: prompt('threat-modeler', `${jc}\n- Write the threat model to ${jp.threatModel}, following ${docs.templatePath('threat-model')}.\n- ${docCheck(root, state, jp.threatModel)}`), schema: schema('threat') };
      }
      return {
        id: `option-${i + 1}`,
        ...agentSpec(state, 'option-generator'),
        label: `option · ${f.prior}`,
        prompt: prompt('option-generator', `${jc}\n- Your prior: optimise for **${f.prior}**. Other generators optimise for other things; do not hedge toward them.${mode === 'contracts' ? '\n- This is an epic: list in freeze_first the interfaces and contracts your option freezes first.' : ''}${mode === 'recommendation' ? '\n- This is a spike: the option is a candidate answer to the research question.' : ''}`),
        schema: schema('option'),
      };
    });
  const tpl = (t) => docs.templatePath(t);
  const what =
    mode === 'recommendation'
      ? `Write the recommendation to ${jp.recommendation} following ${tpl('recommendation')} (question, options weighed, recommendation, confidence, what would change it, evidence). kind = "recommendation".`
      : mode === 'contracts'
        ? `Write the decision as an ADR (${nextAdr}) following ${tpl('adr')}, the human-readable contracts to ${jp.contractsMd} following ${tpl('contracts')}, and the machine-readable interface list to ${jp.contractsJson}. kind = "contracts".`
        : `If there is a real decision (two or more viable options with different consequences), write an ADR to ${nextAdr} following ${tpl('adr')} (kind "adr"). Otherwise write ${jp.noAdr} following ${tpl('no-adr')} (kind "no-adr").`;
  const rules = [
    threat && mode !== 'recommendation' ? '- A threat model was written for this change: map every threat id (TH-n) in the ADR\'s "Threat mitigations".' : '',
    `- ${docCheck(root, state, '<file>')}`,
  ].filter(Boolean).join('\n');
  const judge = {
    ...agentSpec(state, 'architect'),
    prompt: prompt('architect', `${jc}\n- ${what}\n${rules}\n- The option generators' outputs${threat ? ' and the threat model' : ''} follow under INPUTS.`),
    schema: schema('architect'),
  };
  const maxRounds = state.policy.limits.max_design_critique_rounds;
  const critique = {
    ...agentSpec(state, 'god-eye'),
    prompt: prompt('god-eye', `${jc}\n- Focus: **design**. The document is the design record (paths under INPUTS).${threat ? ` The threat model it must address: ${jp.threatModel}.` : ''}`),
    schema: schema('critique'),
    max_rounds: maxRounds,
    revise: { ...agentSpec(state, 'architect'), prompt: prompt('architect', `${jc}\n- Revise the design record you wrote to address the critique under INPUTS. Keep the same file paths.\n${rules}`), schema: schema('architect') },
  };
  return base(root, state, 'fanout-judge', { config: 'decide', mode, input_hash: inputHash({ contract: ctx.b.contract, findings: ctx.b.findings }), fanout, judge, critique, verifier: null, threat_model: threat });
}

// ---------------------------------------------------------------- fanout-judge: challenge
function challenge(root, state, ctx, action) {
  const cfg = readJson(pluginPath('config', 'workflows', 'challenge.json'));
  const mode = action.mode || null;
  const jp = jobPaths(root, state.id);
  let lanes;
  let diffCmd;
  let extra = '';
  if (mode === 'conformance') {
    lanes = ['conformance'];
    const kids = (state.children || []).map((c) => job.load(root, c));
    diffCmd = `git -C "${root}" log --oneline ${state.base_commit}..${state.base_branch}`;
    extra = `- Contracts: ${jp.contractsMd} and ${jp.contractsJson}\n- Slice jobs and merge commits:\n${kids.map((k) => `  - ${k.id} (${k.slice_id}): ${(k.pr && k.pr.merge_commit) || 'not merged'}`).join('\n')}`;
  } else if (mode === 'post_merge') {
    lanes = action.lanes || ['code', 'security'];
    const m = state.pr && state.pr.merge_commit;
    if (!m) fail('Post-merge review needs the merge commit.', 'not_merged');
    diffCmd = `git -C "${root}" diff ${m}^1 ${m} -- . ':(exclude).factory-ship'`;
    extra = '- This is a post-merge review: a fresh round 1 on what actually landed.';
  } else {
    lanes = review.requiredLanes(ctx, action.lanes);
    diffCmd = `git -C "${root}" diff ${state.base_commit} ${state.branch} -- . ':(exclude).factory-ship'`;
    const prev = ledger.lastStep(root, state.id, 'challenge');
    const round = prev && prev.bound && prev.bound.fingerprint !== ctx.b.fingerprint ? (prev.detail.round || 1) + 1 : (prev && prev.detail.round) || 1;
    const changedSince = prev && prev.detail && prev.detail.commit ? git.changedFiles(root, prev.detail.commit, state.branch) : null;
    extra = [
      `- Review round ${round} of ${state.policy.limits.max_review_rounds}.`,
      prev ? `- Previous serious findings:\n${(prev.detail.findings || []).filter((f) => f.severity !== 'minor').map((f) => `  - ${f.id} [${f.severity}/${f.status}] ${f.file || ''} ${f.summary}`).join('\n') || '  - (none)'}` : '',
      changedSince ? `- Files changed since the last round: ${changedSince.join(', ') || '(none)'}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const changed = mode === 'conformance' ? [] : (() => {
    try {
      return git.changedFiles(root, state.base_commit, state.branch).filter((f) => !f.startsWith('.factory-ship/'));
    } catch {
      return [];
    }
  })();
  const ls = lessons.inScope(root, changed);
  const jc = jobContext(root, state);
  const fanout = lanes.map((lane) => {
    const role = cfg.lanes[lane];
    if (!role) fail(`No reviewer configured for lane "${lane}"`, 'plugin_broken');
    return {
      id: lane,
      ...agentSpec(state, role),
      label: `review · ${lane}`,
      prompt: prompt(
        role,
        `${jc}\n- Lane: **${lane}**\n- See the change with: \`${diffCmd}\`\n- Changed files: ${changed.join(', ') || '(see diff)'}\n${extra}\n- Accepted lessons to check (a broken lesson is a finding with rule "lesson:<id>"):\n${ls.map((l) => `  - ${l.id}: ${l.text}`).join('\n') || '  - (none)'}\n- Finding ids start with "${lane}-".`,
      ),
      schema: schema('reviewer'),
    };
  });
  const verifier = {
    ...agentSpec(state, 'finding-verifier'),
    prompt_template: prompt('finding-verifier', `${jc}\n- See the change with: \`${diffCmd}\`\n- The finding to verify is given below your pointer to this file.`, 'The finding to verify:\n{{finding}}'),
    schema: schema('verifier'),
    severities: cfg.verifier.severities,
  };
  return base(root, state, 'fanout-judge', {
    config: 'challenge',
    mode,
    lanes_requested: action.lanes || null,
    fingerprint: ctx.b.fingerprint,
    input_hash: inputHash({ fingerprint: ctx.b.fingerprint, children: ctx.b.children, mode }),
    fanout,
    judge: null,
    critique: null,
    verifier,
  });
}

// ---------------------------------------------------------------- ground
function ground(root, state, ctx, action) {
  const jp = jobPaths(root, state.id);
  const answers = readJson(jp.answers, []);
  const hotfix = action.mode === 'hotfix';
  const topics = hotfix
    ? [
        ['failing path', 'Reproduce or locate the failure: the code path, the inputs, the recent commits that touched it.'],
        ['blast radius', 'Who calls this path, which tests cover it, and what else would break with a fix.'],
      ]
    : [
        ['codebase', 'Where the change lands: the files, existing patterns to follow, the tests that cover it.'],
        ['interfaces', 'Libraries, APIs, data shapes and versions involved; what callers depend on.'],
        ['history', `Prior decisions and lessons: ADRs in the repo, ${path.join(root, '.factory', 'lessons', 'lessons.json')}, recent commits in these areas.`],
        ['external', 'Only if the contract depends on something outside the repo that clarify\'s intent research did not already settle: official docs, cited by URL. Otherwise return no claims.'],
      ];
  const cap = state.policy.limits.max_parallel_research;
  const idata = intent.load(root, state.id);
  const reuse = idata && !idata.tampered ? intent.briefText(require('./clarify').ensure(root, state, idata), { forGround: true }) : '';
  const jc = `${jobContext(root, state)}${reuse ? `\n- Intent research from clarify (${intent.files(root, state.id).md}) — reuse it, don't redo it; extend only on design topics:\n${reuse.split('\n').map((l) => `  ${l}`).join('\n')}` : ''}`;
  const probes = topics.slice(0, Math.max(1, cap)).map(([t, brief]) => ({
    id: t,
    ...agentSpec(state, 'researcher'),
    label: `ground · ${t}`,
    prompt: prompt('researcher', `${jc}\n- Topic: **${t}** — ${brief}\n- Answers the human already gave:\n${answers.map((a) => `  - Q: ${a.question}\n    A: ${a.answer}`).join('\n') || '  - (none)'}`),
    schema: schema('researcher'),
  }));
  return base(root, state, 'ground', { mode: action.mode || null, input_hash: inputHash({ contract: ctx.b.contract, answers: answers.length }), probes });
}

// ---------------------------------------------------------------- decompose
function decompose(root, state, ctx, action) {
  const jp = jobPaths(root, state.id);
  const slices = action.mode === 'slices' || state.epic;
  const rounds = Math.max(1, state.policy.limits.max_plan_validate_rounds - state.counters.decompose_rounds);
  const jc = `${jobContext(root, state, ['H3', 'EH3'])}\n- Findings: ${jp.findings}\n- Design record: ${invalidation.designFiles(root, state.id).join(', ') || '(none)'} (templated docs: the ADR's "Decision", "Architecture diagram", "How each acceptance criterion is met" and "Rollback and migration" sections are what tasks implement)`;
  const ls = lessons.inScope(root, []);
  const what = slices
    ? `Write ${jp.slices}: {"slices":[{"id":"S00","goal":"…","criteria_ids":["E-AC-1"],"depends_on":[],"work_type":"feature","risk":"${state.risk}","allowed_paths":["…"]}], "epic_verify_commands":["…"]}. S00 freezes the contracts and adds the feature flag; later slices are vertical and safe to stop after. Every E-AC must be owned by a slice.`
    : `Write ${jp.plan}: {"tasks":[{"id":"T1","objective":"…","allowed_paths":["src/x/**"],"depends_on":[],"criteria_ids":["AC-1"],"verify_commands":[{"cmd":"…","covers":["AC-1"]}],"retry_limit":3,"rollback":"…"}]}. Tasks that can run in parallel must not share allowed paths.`;
  const planner = {
    ...agentSpec(state, slices ? 'slicer' : 'planner'),
    prompt: prompt(
      slices ? 'slicer' : 'planner',
      `${jc}\n- ${what}\n- Then run \`${cli(root)} plan validate --job ${state.id}\` and fix every error before returning.\n- Accepted lessons each relevant task must carry:\n${ls.map((l) => `  - ${l.id} (${l.scope.join(', ')}): ${l.text}`).join('\n') || '  - (none)'}`,
    ),
    schema: schema('planner'),
    max_rounds: rounds,
  };
  const critique = action.plan_critique
    ? { ...agentSpec(state, 'god-eye'), prompt: prompt('god-eye', `${jc}\n- Focus: **plan**. The document is ${jp.plan}.`), schema: schema('critique'), max_rounds: 2 }
    : null;
  return base(root, state, 'decompose', { mode: slices ? 'slices' : 'plan', input_hash: inputHash({ contract: ctx.b.contract, design: ctx.b.design }), planner, critique });
}

// ---------------------------------------------------------------- realize
function realize(root, state, ctx, action) {
  const plan = readJson(jobPaths(root, state.id).plan, null);
  if (!plan) fail(`${state.id} has no plan to build`, 'no_plan');
  const pending = plan.tasks.filter((t) => !steps.taskDone(ctx, t.id));
  const pendingIds = new Set(pending.map((t) => t.id));
  const waves = (plan.waves || [plan.tasks.map((t) => t.id)]).map((w) => w.filter((id) => pendingIds.has(id))).filter((w) => w.length);
  const jc = jobContext(root, state);
  const tasks = {};
  for (const t of pending) {
    const wt = taskWorktree(root, state.id, t.id);
    const fixNote = state.fix && (state.fix.tasks || []).includes(t.id)
      ? state.fix.kind === 'fix'
        ? '- This is a fix round for confirmed review findings (`task show` lists them under fix_findings).'
        : '- This is a verify-fix round: commands failed on the integrated build (`task show` lists them under verify_failures).'
      : t.id && state.tasks[t.id] && state.tasks[t.id].needs_work === 'amendment'
        ? '- The contract or plan was amended; rebuild this task against the amended version.'
        : '';
    tasks[t.id] = {
      id: t.id,
      // Where this task's builder and tester work (`factory run` starts them there).
      worktree: wt,
      // depends_on plus earlier-wave tasks on overlapping paths: a failed one skips this task.
      depends_on: require('./plan').effectiveDeps(plan.tasks, t.id),
      retry_limit: t.retry_limit || state.policy.limits.retry_limit,
      // Builders may move to a stronger model on retries (policy.agents.builder_escalation).
      builder: { ...agentSpec(state, 'builder'), escalate: ((state.policy.agents || {}).builder_escalation || []).slice() },
      tester: agentSpec(state, 'tester'),
      builder_prompt: prompt(
        'builder',
        `${jc}\n- Task: **${t.id}** — ${t.objective}\n- task start: \`${cli(root)} task start ${t.id} --job ${state.id}\`\n- task show: \`${cli(root)} task show ${t.id} --job ${state.id}\`\n- Worktree: ${wt}. Allowed paths: ${t.allowed_paths.join(', ')}.${fixNote ? `\n${fixNote}` : ''}`,
        'Attempt {{attempt}}. Previous tester failures, if any:\n{{failures}}',
      ),
      tester_prompt: prompt(
        'tester',
        `${jc}\n- Task: **${t.id}** — ${t.objective}\n- Verify with: \`${cli(root)} task verify ${t.id} --job ${state.id}\` (it runs in ${wt}).\n- The places the builder says it swept are listed below.`,
        'Places the builder says it swept: {{swept}}',
      ),
    };
  }
  return base(root, state, 'realize', {
    scope: action.scope || 'all',
    input_hash: inputHash({ plan: ctx.b.plan, scope: action.scope || 'all', pending: [...pendingIds].sort() }),
    waves,
    tasks,
    max_parallel_tasks: state.policy.limits.max_parallel_tasks,
    builder_schema: schema('builder'),
    tester_schema: schema('tester'),
  });
}

// ---------------------------------------------------------------- reconcile
function reconcile(root, state, ctx) {
  const jc = jobContext(root, state);
  return base(root, state, 'reconcile', {
    input_hash: inputHash({ plan: ctx.b.plan }),
    integrator: {
      ...agentSpec(state, 'integrator'),
      prompt: prompt(
        'integrator',
        `${jc}\n- Job worktree: ${jobPaths(root, state.id).worktree}\n- reconcile run: \`${cli(root)} reconcile run --job ${state.id}\`\n- reconcile continue: \`${cli(root)} reconcile continue --job ${state.id}\`\n- reconcile abort: \`${cli(root)} reconcile abort --job ${state.id}\``,
      ),
      schema: schema('integrator'),
    },
  });
}

function build(root, { jobId, workflow, config, mode, scope, lanes, threatModel, planCritique, acceptDegraded, inline = false }) {
  const state = job.resolve(root, jobId);
  RUN = inline ? null : { n: 0, dir: path.join(root, '.factory', 'scratch', 'briefs', state.id, `${workflow}${config ? `-${config}` : ''}-${Date.now()}`) };
  const ctx = steps.context(root, state, job.load);
  const action = { mode, scope, lanes: lanes ? String(lanes).split(',') : null, threat_model: threatModel, plan_critique: planCritique };
  if (!lanes || !action.lanes) {
    const s = ctx.recipe.steps.find((x) => (config === 'challenge' ? x.config === 'challenge' && (x.mode || null) === (mode || null) : false));
    if (s) action.lanes = s.lanes;
  }
  if (config === 'decide' && threatModel === undefined) {
    const s = ctx.recipe.steps.find((x) => x.step === 'decide');
    if (s) action.threat_model = s.threat_model === 'policy' ? state.risk === 'high' : Boolean(s.threat_model);
    if (s && !mode) action.mode = s.mode;
  }
  if (workflow === 'decompose' && planCritique === undefined) {
    const s = ctx.recipe.steps.find((x) => x.step === 'decompose');
    action.plan_critique = Boolean(s && s.plan_critique);
    if (s && !mode) action.mode = s.mode;
  }
  if (workflow === 'ground' && !mode) {
    const s = ctx.recipe.steps.find((x) => x.step === 'ground');
    if (s) action.mode = s.mode;
  }
  switch (workflow) {
    case 'fanout-judge':
      if (config === 'clarify') return clarify(root, state, ctx, acceptDegraded);
      if (config === 'decide') return decide(root, state, ctx, action);
      if (config === 'challenge') return challenge(root, state, ctx, action);
      return fail('fanout-judge needs --config clarify|decide|challenge', 'bad_input');
    case 'ground':
      return ground(root, state, ctx, action);
    case 'decompose':
      return decompose(root, state, ctx, action);
    case 'realize':
      return realize(root, state, ctx, action);
    case 'reconcile':
      return reconcile(root, state, ctx);
    default:
      return fail(`Unknown workflow ${workflow}`, 'bad_input');
  }
}

// Recompute the input hash a brief would have now (used by record to catch stale results).
function currentInputHash(root, state, envelope) {
  const ctx = steps.context(root, state, job.load);
  const answers = readJson(jobPaths(root, state.id).answers, []);
  switch (envelope.workflow) {
    case 'fanout-judge':
      if (envelope.config === 'clarify') return inputHash({ contract: ctx.b.contract, round: state.counters.clarify_rounds + 1 });
      if (envelope.config === 'decide') return inputHash({ contract: ctx.b.contract, findings: ctx.b.findings });
      return inputHash({ fingerprint: ctx.b.fingerprint, children: ctx.b.children, mode: envelope.mode || null });
    case 'ground':
      return inputHash({ contract: ctx.b.contract, answers: answers.length });
    case 'decompose':
      return inputHash({ contract: ctx.b.contract, design: ctx.b.design });
    default:
      return null; // realize and reconcile change the build themselves; the CLI re-checks evidence instead
  }
}

module.exports = { build, currentInputHash, prompt, roleBody, roleTools, workingText, fullText, cli, agentSpec };
