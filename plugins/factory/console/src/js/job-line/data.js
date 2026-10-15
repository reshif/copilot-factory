// `factory console` writes the jobs into the slot below. Everything on the line is
// a pure function of (job, playhead time): scrubbing back and forth always agrees.
let DATA = /*__FACTORY_DATA__*/null;

const ORDER = ['request', 'contract', 'design', 'plan', 'build', 'verify', 'ship', 'learn'];
const STAGE_NAME = { request: 'Request', contract: 'Contract', design: 'Ground & design', plan: 'Plan', build: 'Build', verify: 'Prove & challenge', ship: 'Ship', learn: 'Learn & close' };
const STEP_INFO = {
  request: ['Request', 'You asked; the CLI opened the job and chose the recipe by rule.'],
  clarify: ['Clarify', 'Copilot drafts the contract; scouts research the repo and the docs first; analysts ask only what research can\'t answer; God Eye reads it cold.'],
  H1: ['H1 · contract', 'You approve the outcome contract. The approval is bound to its hash.'],
  EH1: ['EH1 · contracts', 'You approve the epic\'s contract.'],
  ground: ['Ground', 'Researchers in parallel; every claim cited or marked UNVERIFIED.'],
  decide: ['Decide', 'Option generators, the architect\'s ADR, God Eye\'s critique.'],
  H2: ['H2 · design', 'You approve the design (when there is a real decision, or always at high risk).'],
  EH2: ['EH2 · design', 'You approve the frozen interface contracts.'],
  HF: ['HF · findings', 'You accept the spike\'s findings and recommendation.'],
  decompose: ['Plan', 'Task contracts the CLI validates, in waves.'],
  H3: ['H3 · plan', 'You approve the plan, or God Eye does at low risk.'],
  EH3: ['EH3 · slices', 'You approve the slices.'],
  realize: ['Build', 'Builders and independent testers, task by task, each in its own worktree.'],
  reconcile: ['Integrate', 'Task branches merged into the job branch; the build gets a fingerprint.'],
  children: ['Slices', 'Each slice runs as its own job.'],
  prove: ['Prove', 'Every acceptance criterion proven on this exact build.'],
  challenge: ['Challenge', 'One reviewer per lane; serious findings verified independently.'],
  epic_gate: ['Epic gate', 'All slices merged; the epic branch passes its checks.'],
  HS: ['HS · ship', 'You sign off before anything leaves.'],
  ship: ['Ship', 'Floors checked, completion report written, PR opened or a local merge prepared.'],
  H4: ['H4 · merge', 'Only you merge: on GitHub, or locally and reply merged <commit>. The merge commit is recorded.'],
  post_merge_challenge: ['Post-merge', 'A fresh review of what actually landed.'],
  distill: ['Learn', 'Confirmed problems become scoped lessons you accept.'],
  close: ['Close', 'Every floor met on the final build; worktrees removed.'],
};
const RULES = {
  'row1.contract_not_approved': 'The contract isn\'t approved yet',
  'row2.drift_scope': 'Work drifted outside the contract\'s paths',
  'row2.epic_replan': 'The epic needs a new plan',
  'row3.floor_missing': 'A floor for this risk isn\'t met yet',
  'row4.confirmed_serious': 'A confirmed serious finding: back to Build for a fix round',
  'row5.acs_unproven': 'A criterion isn\'t proven: back to Build for a verify-fix round',
  'row6.stale_evidence': 'The build changed, so the old proof is stale: prove again',
  'order.next_step': 'Every check passes: the recipe\'s next step',
  'order.complete': 'The recipe is complete',
  'cap.budget': 'Agent budget reached: parked',
  'cap.review_rounds': 'Review rounds used up: parked',
  'cap.verify_fix_rounds': 'Verify-fix rounds used up: parked',
  'cap.clarify_rounds': 'Clarify rounds used up: parked',
  'cap.decompose_rounds': 'The plan still fails validation: parked',
  'cap.repeat_guard': 'Same decision twice with no progress: parked',
};
const CHECKS = [['contract_approved', 'contract approved'], ['no_drift', 'no drift'], ['floors_satisfied_so_far', 'floors so far'], ['no_confirmed_serious', 'no confirmed finding'], ['acs_proven', 'criteria proven'], ['no_stale_evidence', 'no stale proof']];
const WORD = { done: 'Clear', auto: 'Auto-approved', running: 'Running', waiting: 'Your turn', failed: 'Stopped', blocked: 'Blocked', pending: 'Ahead', again: 'Runs again', skipped: 'Not needed', none: 'Not in recipe' };
const KIND_LABEL = { start: 'you · request', skill: 'skill', workflow: 'workflow', cli: 'factory cli', gate: 'gate · you', merge: 'merge · you' };
// An agent's outcome: the roster's (workflows/*.js: the reply's status, pass/fail or verdict) or
// runner.js's own (ok, timeout, failed, invalid, copilot_unavailable, error). Bad: it did not do its
// job. Warn: it did, and the answer holds the job up (God Eye's revise, a verifier that could not
// settle a finding). Good: a positive verdict. Anything else (ok, confirmed, refuted) stays neutral.
const BAD_OUTCOME = new Set(['fail', 'no_result', 'blocked', 'failed', 'exhausted', 'error', 'timeout', 'invalid', 'copilot_unavailable']);
const WARN_OUTCOME = new Set(['unverifiable', 'revise', 'changes', 'needs_user', 'skipped_dependency']);
const GOOD_OUTCOME = new Set(['pass', 'done', 'approve', 'merged', 'ready']);
const outcomeClass = (o) => (BAD_OUTCOME.has(o) ? 'bad' : WARN_OUTCOME.has(o) ? 'warn' : GOOD_OUTCOME.has(o) ? 'good' : '');
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const stepName = (id) => (STEP_INFO[id] ? STEP_INFO[id][0] : id || '—');
const modelFamily = (m) => (!m ? 'none' : /opus/i.test(m) ? 'opus' : /sonnet/i.test(m) ? 'sonnet' : /haiku/i.test(m) ? 'haiku' : 'other');
const modelLetter = (m) => (!m ? '·' : { opus: 'O', sonnet: 'S', haiku: 'H' }[modelFamily(m)] || String(m)[0].toUpperCase());
const fmtClock = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); };
const fmtDate = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
function fmtDur(ms) {
  if (!(ms >= 0)) return '—';
  if (ms > 0 && ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!(ms >= 0)) return '';
  return ms < 60000 ? 'just now' : `${fmtDur(ms).split(' ')[0]} ago`;
}

// ---------- fold: the job's state after each timeline item
