# Architecture (as built, v0.8.0)

This is the shipped implementation of [`DESIGN-v2.md`](DESIGN-v2.md). Where the build differs from the earlier file plan, the reason is in [§9](#9-differences-from-the-file-plan).

## 1. Who does what

| Part | Role | Can write state? |
|---|---|---|
| **`factory` CLI** (`bin/factory`, `cli/`) | Decides the next step, validates everything, runs verify commands, writes state, ledger and decision log | **Only writer** |
| **Driver skill** (`skills/start`) | Main session: runs `factory next`, executes what it says, talks to you | No (through the CLI only) |
| **Workflows** (`workflows/*.js`) | Fan agents out and in; return a result envelope | No (no fs, no shell) |
| **Agents** (`agents/*.md`) | One role each; propose; builders commit only on their task branch | No |
| **Hooks** (`hooks/`) | Guard every tool call; apply your replies; refuse false "done" | Your replies only, via the CLI |
| **You** | Approve gates, merge, accept lessons, edit recipes/floors/policy | Through chat replies or your terminal |

## 2. The loop

```text
factory next ──▶ action
  skill    → follow factory:<skill>  (clarify · ship · distill · amend)
  workflow → factory wfargs <wf> …  ─▶ Workflow factory:<wf> (args = brief) ─▶ envelope
             └─ write envelope → factory record --file … (validate · stale check · re-check · ledger)
  cli      → run the command (plan from-contract · verify run · epic spawn · epic gate · pr sync · close)
  gate     → present docs + hash; stop; your reply is applied by the prompt hook
  wait     → tell you what's awaited (merge, slice jobs); stop
  parked   → explain; stop
  done
```

## 3. Routing: alignment vector + decision table (`cli/core/alignment.js`, `decision-table.js`)

The first failing check decides; if none fails, the recipe's first undone step runs.

| # | Check | Fails when | Goes to | Rule id |
|---|---|---|---|---|
| 1 | `contract_approved` | H1/EH1 never approved | clarify, then the gate | `row1.contract_not_approved` |
| 2 | `no_drift` | approved contract changed · approved plan changed after building started | factory:amend → gate A | `row2.drift_contract` / `row2.drift_plan` |
| | | files outside allowed paths or inside protected paths on the job branch | park | `row2.drift_scope` |
| 3 | `floors_satisfied_so_far` | a pre-build floor step undone once building started · a pre-merge floor step undone once shipped | that step | `row3.floor_missing` |
| 4 | `no_confirmed_serious` | confirmed blocker/major on the current build (not yet scheduled) | realize, scope `fix` (owning tasks only) | `row4.confirmed_serious` |
| 5 | `acs_proven` | latest proof on this build failed (not yet scheduled) | realize, scope `verifyFix` | `row5.acs_unproven` |
| 6 | `no_stale_evidence` | proof exists only for an older build | prove | `row6.stale_evidence` |
| — | all pass | | recipe's next undone step | `order.next_step` |

Caps (all park, all explained by `factory why`): `cap.review_rounds`, `cap.verify_fix_rounds`, `cap.clarify_rounds`, `cap.decompose_rounds`, `cap.budget` (agent runs per job and per tree), `cap.repeat_guard` (same step from the same state more than twice). `resume` grants exactly one more round (budget: +50%).

## 4. Bindings and freshness (`invalidation.js`, `steps.js`)

| Binding | Hash of | A step recorded against it is stale when… |
|---|---|---|
| contract | contract.md + work type + risk + epic flag | the contract changes (risk is locked by H1) |
| findings | findings.md | findings change |
| design | ADR(s) + no-adr + recommendation + threat model + epic contracts | any design file changes |
| plan | plan.json (slices.json for epics) | the plan changes |
| fingerprint | top-level git tree of the job branch, excluding `.factory-ship/` | anything built changes |
| children | every slice job's status and merge commit | a slice merges or re-merges |

Each recipe step has a deterministic "done" predicate over these (e.g. *realize* = every task's latest evidence passed on the exact tree its branch has now; *prove* = a passing proof bound to the current fingerprint). Gate approvals store the hash they approved and a copy of what was approved (`jobs/<id>/approved/`), which amendments diff against.

## 5. Workflows and the brief/envelope contract

Every brief item names the factory agent that runs it: `agent_type: factory:<role>`, plus an optional `model` from `policy.agents.models`. Workflows pass it to `agent()` as `agentType`, so `agents/<role>.md` is that agent's system prompt and its `tools:` limits and `model:` apply. Researchers, reviewers, testers, verifiers and judges can't write; only builders, the integrator, the architect, the planner, the slicer and the threat modeler can. `factory wfargs` writes each item's run context and JSON output schema, not the role text, to `.factory/scratch/briefs/<job>/<run>/NN-<role>.md`. The brief's prompt points at that file. Builders can step up to a stronger model on retries (`policy.agents.builder_escalation`). A brief item without a factory agent type makes the workflow fail rather than run a generic agent.

| Workflow | Fan-out | Then | Returns `data` |
|---|---|---|---|
| `ground` | researcher × topic (codebase, interfaces, history, external; hotfix: failing path, blast radius) | retry failed once | `topics`, `degraded` |
| `fanout-judge` · clarify | intent-analyst · intent (the gate, alone) → × {ambiguity, constraints, testability} only once intent has no blocking question | judge (intent > scope > constraint > acceptance, budget, no repeats) → God Eye (intent: restatement + `intent_confirmed`) if no questions (and no missing angle, unless `--accept-degraded`) | `analysts`, `judge`, `critique`, `intent_open`, `held_back` |
| `fanout-judge` · decide | option-generator × 3 priors ∥ threat-modeler (high risk) | architect decides → God Eye (design) ⇄ architect revises, ≤ `max_design_critique_rounds` | `options`, `judge`, `critiques` |
| `fanout-judge` · challenge | reviewer × required lane | finding-verifier × blocker/major | `lanes`, `verifications` |
| `decompose` | — | planner/slicer ⇄ `factory plan validate` ≤ rounds; optional God Eye plan critique | `planner`, `critique` |
| `realize` | per wave: builder × task (≤ `max_parallel_tasks`), then tester × task | retry to `retry_limit`; blocked/exhausted → dependents `skipped_dependency` | `tasks` |
| `reconcile` | — | integrator runs `factory reconcile run/continue/abort` | `integrator` |

Every workflow also returns `agents`: a roster with one entry per `agent()` call. Each entry holds `label`, `agent_type`, `model`, `retry` and `outcome`. `factory record` seals the roster into the job's ledger as `kind: agents`, with the workflow, config, mode, status, the run count and the routing `decision_id`. It does this before any other check, so failed runs are covered too. The repeat guard ignores these entries, so a run that keeps failing is still detected.

`factory record` checks: envelope schema · job matches · job active · input hash still current (else `stale`, nothing recorded) · then per workflow: clarify re-applies the question protocol (below) and needs God Eye approve with the intent confirmed + no contract problems; decide needs the design files inside the job folder, a threat model when required, and critique approval unless a human gate will show it; decompose re-runs plan validation itself; realize re-checks each task's evidence; reconcile checks every task branch is merged; challenge goes through `review.record`, where **the CLI decides lane verdicts** (a lane passes only with no blocker/major left confirmed or unverified) and applies convergence rules.

### Clarify question protocol

The contract opens with an **Intent** section (`- Problem:`, `- Who:`, `- Outcome:`, `- Why now:` optional, `- Success signal:`). `factory contract check` fails while any line is missing or still `<…>`, and on a contract with no Intent section at all (amend and `plan from-contract` accept that, for contracts approved before the section existed). Intake confirms a one-line restatement of it with the user in its single question.

| Rule | Where it's enforced |
|---|---|
| The intent analyst runs first and alone; with a blocking intent question the other angles are not run (`held_back`) | `fanout-judge.js` |
| Order intent > scope > constraint > acceptance; while an intent question is open only intent questions are asked | judge prompt, `fanout-judge.js`, `record` (`cli/core/questions.js`) |
| Budget: round 1 ≤ `early_questions` (5), later rounds ≤ `later_questions` (3), round `max_intent_rounds` (4) none, so ≤ 11 per job; extra questions are dropped | `config/workflows/clarify.json` limits, judge schema (`maxItems` 5), workflow, `record` |
| Form: `id` (Q-n, assigned by the CLI), `category`, `why`, `default`, optional `options` | judge schema; `record` fills a missing default (intent: "will not guess") |
| Never re-ask: anything in `asked_questions` or `answers.json` is dropped; answers are passed to every analyst | workflow + `record`; `factory answer --id Q-n` |
| Intent never defaults: still open after `intent_rounds` (2) rounds of intent questions, or when no budget is left, the job parks (from `clarify`); `resume` grants one more intent round with a budget | `record`, `human.resume` |
| God Eye (intent) restates problem/who/outcome/success; approve without `intent_confirmed` is not approval | `intent-critique` schema, workflow, `record` |

Every asked question is kept in `state.question_log` (id, round, category, question, default).

## 6. Hooks

| Hook | Script | Does |
|---|---|---|
| SessionStart | `session-start.js` | Tells Claude about an active job and how to continue |
| UserPromptSubmit | `prompt.js` | Applies an exact reply (`approve`, `deny …`, `resume`, …; trailing punctuation/emoji and case ignored) via the CLI's human channel; adds `[factory] Applied …` or `NOT applied …`. A short message that looks like a reply but doesn't parse (`aprove`, `approve the plan please`) is not applied; Claude is told so, with the accepted forms |
| PreToolUse (Write, Edit, MultiEdit, NotebookEdit, Bash, Read, Grep, Glob, NotebookRead) | `guard.js` + `guard-rules.js` | Denies state edits, plugin edits, writes outside a task's allowed paths, protected paths, secret reads (real path; Grep's `glob` filter; Grep/Glob over the seal secret's folder), force-push in any spelling, `--no-verify`/`commit -n`, hook redirects, `.git/hooks`/`.git/config`, moving a job branch, human-only CLI commands; prose in `--reason`/`-m`/quoted heredocs is data |
| PostToolUse (Bash, Write, Edit, MultiEdit, NotebookEdit, Task, Agent, WebFetch, WebSearch), SubagentStart | `activity.js` | One line per event in `.factory/log/events.jsonl` (job found by explicit `--job`, worktree, or pointer). Read/Grep/Glob are not logged: they change nothing, and logging each cost a Node process |
| SubagentStop | `subagent-stop.js` | Logs each factory agent finishing. It doesn't block: workflow agents return through a schema the runtime enforces, and `factory record` re-checks every artifact before it counts. |
| Stop | `stop.js` | Blocks a "done / ready to merge / shipped / I've finished the task" claim (not questions, negations or conditionals) while the owed floors fail — for the current job, the job of the worktree it runs in, and every `J-####` the message names |
| (all) | `lib.js` `safe` | A hook never breaks Claude Code; when one fails it appends a sealed `hook_error` event (hook, message, job) so the inspector can report it |

## 6a. Seals and the trust boundary

Everything the floors trust is sealed with an HMAC keyed by a per-user secret outside the repository (`~/.config/software-factory/secret`, mode 0600): each job's `state.json` (verified on every load — a hand-edited file is refused until you run `factory reseal` from your terminal), every ledger line and decision record (unsealed lines are ignored), and the critique files. The guard additionally blocks agents from the secret, from human-only CLI subcommands (argv parsed the way the CLI parses it), from commands run through variables, from terminal emulators (`script`, `unbuffer`, `expect`, …), from inline interpreter code or written source files that reach into `.factory/` state or `cli/core`, and from shell writes into state.

This is defence in depth, not a sandbox: agents run as you, so a determined process can still read your files. The final backstops are outside the agent's reach: CI re-verifies on the merge result, and only you merge.

## 6b. Observations for auditing

The factory records what it does, so the separate `factory-inspector` plugin can audit it without reading any factory code:

- **`recipe.lock.json`.** A sealed snapshot of each job's rulebook, taken at creation. It holds the full recipe and its hash, the floors, the selection rules and the inputs that chose the recipe, the limits, and a hash of the plugin's skills, agents and workflows.
- **Decision ids.** Every routing decision has an id (`J-0001-D0007`) plus the step, workflow, config, command, skill and gate hash it chose. Human actions record which decision they happened `during`.
- **`events.jsonl`.** One sealed line per `factory` command: its arguments (long prose truncated), the job, and the decision id in force. For `wfargs` and `record` lines it also holds the workflow and config. The log also records guard denials, refused chat replies, Stop blocks, hook failures (`hook_error`), agent starts and stops, and tool activity for tools that change things (Bash, edits, Task/Agent, web fetches).

## 6c. The console (`cli/core/console.js`, `console/console.html`)

`factory console` reads `.factory/` as plain files and writes one self-contained page, by default `.factory/console.html`. It changes nothing else and is not logged.

- **Steps.** Each job's steps come from its sealed `recipe.lock.json`, plus a `request` step. Each step is mapped to one of the eight stages.
- **Timeline.** The timeline merges:
  - the job's router decisions
  - human actions, placed on their gate, or on H4 for a merge
  - ledger step results, with findings and acceptance criteria
  - `agents` rosters, placed on the step of their decision, with timings from the SubagentStart/SubagentStop hook events
  - errors, guard denials, refused replies, and park and stop records
  - parks and amendments from the event log; amendment re-binds collapse into one event
  - follow-up jobs
  - the inspector's findings from `.factory/inspect/register.json`, anchored to the decision or moment they cite
- **Seals.** They are checked only when this machine already has the key; the result is `verified`, `tampered` or `not_checked`. The console never creates a key (`seal.secret()` would).
- **The page.** It folds the timeline into a state per event, groups events into rows, and draws a flow canvas:
  - stage columns with a lane per step, and time running downward
  - a row for each visit, park, resume, amendment or stop
  - forward moves to the right, return trips to the left, repeats straight down
  - on each row, the agents, results, replies, guard blocks and inspector findings that belong to it
- **Rendering.** Everything is a pure function of one playhead time, so Replay, scrubbing and stepping always agree.
- **Data slot.** The data goes into the template's `/*__FACTORY_DATA__*/null` slot, with `<`, U+2028 and U+2029 escaped.
- **Sample.** `console/dev/make-sample.js` uses `console/dev/clock.js`, a simulated clock, to build a realistic `.factory/`: nine jobs over about three days, run through the real CLI, workflows, hooks and inspector with scripted agents.

## 6d. Documents (`cli/core/doc.js`, `templates/docs/`)

Every job document follows a versioned template (front matter, fixed sections, rules in the template itself). `factory record` rejects a decide result whose design record breaks its template — an ADR needs a Mermaid architecture diagram, a threat model a data-flow diagram with trust boundaries, both full AC/threat coverage — and the CLI renders findings, the completion report (PR body), the per-job docs index and the lessons register to their templates. See [DOCS.md](DOCS.md).

## 7. Files

**Plugin** (`plugins/factory/`): `.claude-plugin/plugin.json` · `bin/factory` · `cli/main.js`, `cli/lib/*`, `cli/core/*` (alignment, amend, budgets, console, contract, decision-table, decisions, doc, epic, floors, human, invalidation, job, ledger, lessons, lifecycle, plan, policy, questions, recipes, reconcile, record, review, setup, ship, steps, tasks, telemetry, verify, wfargs) · `workflows/*.js` (5) · `config/workflows/{clarify,decide,challenge}.json` · `agents/*.md` (19) · `skills/*/SKILL.md` (11) · `console/console.html` (+ `console/dev/make-sample.js`) · `hooks/` · `recipes/` (7 + `_selection.json`) · `policy/{floors,default-policy}.json` · `schemas/` · `templates/{git/commit-msg,github/factory-gate.yml,docs/*.md}` (doc templates: [DOCS.md](DOCS.md)) · `tests/` · `docs/`.

**Per repo** (`.factory/`, out of git): `project.json` · `policy.json` (yours) · `current` · `jobs/<J>/` (`state.json`, `contract.md`, `findings.md`, design files, `plan.json`/`slices.json`, `critiques/`, `reviews/round-N/`, `evidence/`, `approved/`, `amendments/`, `ledger.jsonl`, `answers.json`, `recipe.lock.json`, `completion-report.md`, `docs-index.md`) · `log/{events,decisions}.jsonl` · `lessons/lessons.{json,md}` · `telemetry/<yyyy-mm>.json` · `worktrees/<J>` (integration) and `worktrees/<J>-<T>` (tasks) · `scratch/` (briefs, envelopes).

**On the job branch**: `.factory-ship/<J>.json` — the verify manifest CI re-runs on the merge result (excluded from the build fingerprint).

## 8. CLI reference

`factory help` prints it. Groups: setup (`init`, `doctor`, `ci install`) · jobs (`job new|show|list`, `use`) · routing (`next`, `why`, `finalize`) · contract (`contract show|check`, `answer`) · workflows (`wfargs`, `record`) · plan (`plan validate|from-contract`) · tasks (`task start|show|verify|state`) · build (`reconcile run|continue|abort`, `verify run`, `evidence add`) · ship (`report`, `ship`, `pr sync`, `ci verify`, `close`) · change (`amend start|submit`, `park`, `followup`) · epic (`epic spawn|gate`) · docs (`doc list|template|check|index`, see [DOCS.md](DOCS.md)) · learning (`distill context|done`, `lessons …`, `telemetry report`, `recipe list|show|check|select`) · human-only (`approve`, `deny`, `resume`, `cancel`, `abandon`, `waive`, `merged`, `confirm`, `lessons accept|reject|promote` — a real terminal, or your chat reply).

## 9. Differences from the file plan

| Plan | Built | Why |
|---|---|---|
| `commands/factory.md`, `factory-why.md`, `factory-review.md` | skills `start`, `why`, `review` → `/factory:start`, `/factory:why`, `/factory:review` | Claude Code now recommends skills over commands; plugin skills are namespaced by plugin name |
| `workflows/lib/envelope.js` shared helper | helpers inlined in each workflow | Workflow scripts can't import; every `workflows/*.js` is discovered as a workflow |
| `workflows/configs/*.json` | `config/workflows/*.json`, delivered inside the brief | Workflows can't read files |
| `cli/commands/*` one file per command | `cli/main.js` dispatcher + `cli/core/*` | Less indirection; same responsibilities |
| `skills/factory-*` names | `skills/<name>` | Avoids `/factory:factory-…` |
| `stages/` folded | n/a | Standalone build; nothing to fold |
| Equivalence suite vs v0.7.5 | route tests per recipe | Standalone build; no v0.7.5 source to compare against |
