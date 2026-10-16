# factory-inspector

An independent auditor for the Software Factory, packaged as a GitHub Copilot CLI plugin (`factory-inspector@copilot-factory`). It answers two questions about every job:

1. **Was the intended recipe the one used?**
2. **Did the factory behave the way that recipe says?** That covers the order of steps, gates, the evidence chain and caps, and whether the Copilot agent did what `factory next` told it to.

It also finds **ambiguities**: places where the rules left room and someone had to improvise. And it watches the factory's **health**: every issue the factory reports about itself — hooks that failed, guard denials, blocked stops, refused replies, CLI failures and crashes, stale or degraded workflow results, agent failures, retries and escalations, agents that never stopped, parks, idle jobs, slow gates, and clarify parks, research gaps and God Eye objections you proceeded past. Each finding goes into a register for you to decide on.

It never blocks, approves or changes a job, a recipe or a policy.

## Why it is independent

The inspector does not import any factory code. It reads two things:

- **The rulebook each job declared.** `recipe.lock.json` is a sealed snapshot taken when the job was created. It holds the full recipe, the floors, the selection rules and the inputs that chose the recipe, plus a hash of the factory's skills, agents and workflows.
- **What happened.** That is the job's sealed state, ledger, decision log and observation log (`events.jsonl`). The observation log has every `factory` command (with `ok` and the error code), tied to the routing decision in force at the time, plus guard denials, refused and look-alike replies, stop blocks, hook failures (`hook_error`) and agent starts and stops. The ledger adds the agent roster of every workflow (retries, models, outcomes), workflow errors and degraded steps.

The inspector has its own implementations of three things: seal verification, recipe selection, and the allowed-path model. A bug in the factory's router can't hide itself, because the inspector never asks the router what should have happened.

## What it checks

| Rule | Class | Checks |
|---|---|---|
| R1 seals | deviation | Records written outside the factory CLI (state, lock, ledger, decision log, event log, clarify's `clarify.json` and the older `intent-evidence.json`) |
| R2 intended recipe | deviation / gap | Replays the selection rules from the job's inputs. Checks the risk floor, the lock hash, and the recipe version every decision used. Flags a recipe file edited without a version bump |
| R3 conformance | deviation / ambiguity | Steps outside the recipe; steps reached before earlier ones completed; closed without a step; moving backwards with no recorded cause (a denial, resume, amendment or a `change A-n` / `drop A-n` reply counts as a cause) |
| R4 gates | deviation | Approvals that were never presented, or presented for a different document hash; automatic approvals the recipe doesn't allow. The amendment gate A counts as presented by a successful `factory amend submit` before the approval, when the approved hash is one that submit wrote |
| R5 evidence chain | deviation | Review on a build with no passing proof; proof on a build never integrated; shipping without both on the same build. Outcome integrity: a blocker/major finding a review round left unverified that no later round settled, yet a later round passed or the job shipped (`R5.unverified_finding_lost`); a task counted done although its builder did not finish: a tester passed it after its builder came back with no result or blocked (factory 0.5.3 and earlier, which ran an LLM tester), or the state marks it done with a non-`done` latest builder reply (`R5.done_without_builder`) |
| R6 loops | deviation | Fix rounds beyond their caps plus your resumes; clarify v3 research passes or contract-writer attempts beyond the caps each stage recorded (older jobs: clarify rounds beyond their cap or ceiling) |
| R7 driver fidelity | deviation | The agent didn't run what `factory next` asked for, ran something else, or changed things while waiting at a gate (read-only commands such as `factory clarify status`; `factory clarify reply`/`redirect` while clarify waits on you, and `factory clarify redirect` at H1; and the human-only commands you ran in your own terminal — approve, deny, resume, cancel, abandon, waive, merged, confirm, reseal, assumption change/drop, lessons accept/reject — don't count; an agent's refused attempt at one does). `factory amend start`/`submit` is never a deviation (the park and amend skills send the driver there; the amendment is judged at its gate A). When your human actions in a job all came from the terminal and none from a chat reply, one low-severity note (`R7.terminal_approvals`) says chat replies may not be reaching the factory |
| R8 consistency | ambiguity / deviation | The same failing check routed by different rules under the same rulebook; identical inputs picking different recipes |
| R9 friction | ambiguity | Repeated patterns across jobs (3+ by default): the same guard denial, refused replies, refused workflow results, caps you nearly always resume past, the same floor waived, denials clustering at one gate, a step repeating with no progress |
| R10 hook errors | gap | A factory hook failed (`hook_error`; high for the guard, stop and prompt hooks, which enforce nothing while failing); the inspector's own hooks failed (`.factory/inspect/hook-errors.jsonl`) |
| R11 log integrity | gap | Lines in `events.jsonl`, `decisions.jsonl` or a ledger that aren't JSON at all (a crashed or concurrent write) |
| R12 hook pushback | ambiguity | Per job, over a limit: guard denials, blocked stops (agentStop), refused replies, look-alike replies that weren't applied |
| R13 CLI failures | gap / ambiguity | A `factory` command crashed (internal error, factory-wide); the same command refused with the same code again and again in a job (a check that ran and failed, such as a failing `task verify`, is a verdict, not a failure: the health summary counts those apart); workflow results thrown away as stale |
| R14 workflows and agents | ambiguity | Workflow errors; steps that went on degraded (agents with no result after a retry); agent retries, failures and model escalations over a limit; `factory run` agents that timed out or exited with an error, and a Copilot CLI that could not be started or used (`R14.copilot_unavailable`, high); the same step recorded as failed again and again (a clarify or ground round that stopped to ask you questions is not a failure) |
| R15 orphaned agents | gap | Agents that started and never reported stopping (after the job ended, or after a time limit) |
| R16 parks and resumes | ambiguity | A job parked, or resumed past its caps, more than a limit. Parks are counted from every record that says so (the router's decisions, a workflow result that parked, a park by hand, and any typed park event); the health summary's *Parks* uses the same count |
| R17 idle job | gap | Active, not waiting for you, and nothing has happened for a long time |
| R18 slow reply | ambiguity | A gate that waited longer than a limit for your reply |
| R19 clarify | ambiguity | Clarify v3 parks (a cap reached, or an agent that returned nothing), with their reasons (`R19.clarify_parked`); H1 reached with God Eye's objections still open because you said proceed (`R19.proceeded_past_objections`, low: shown at H1 as objections, never approval). Older jobs: intent parks, questions over budget, stalled v2 rounds, issues raised again |
| R20 grounded intent | ambiguity | Clarify v3 reached H1 with research gaps recorded (`R20.research_gaps`, low; limit `research_gaps_per_job`). Older jobs: clarify asked you questions its research could have answered (repo or world unknowns), with the reason research gave (web off — low severity, a setting to revisit — no web access, sources disagree, budget spent); evidence-backed assumptions you changed or dropped (low severity: a learning signal that the evidence was wrong or the point was yours to decide). From the job's `kind: intent` ledger entries, its `intent-evidence.json` and your `change`/`drop` replies |
| R21 review regression | deviation / ambiguity | A finding confirmed serious in one review round found again in a later round (same file and lane + rule, or a line within ±10, or the same summary): the fix was lost. High when the later round let it through (downgraded, minor, unconfirmed — what older factory versions did); medium when it blocked again. From the job's `challenge` ledger records |
| R22 reconcile drop | deviation | Reconcile's regression guard caught a merge or conflict resolution that dropped lines already-merged tasks or fix rounds had added (high). From the job's failed `reconcile` ledger records |
| R23 work lost | deviation | Outcome integrity: a task's last verified head (its passing `task verify` evidence) or the head the last integration recorded is not in the commit that shipped (high): its work was lost between steps. Read-only git; a commit git no longer has is unknown, not lost |
| R24 export removed | deviation | Outcome integrity: an export one task added (JS/TS `export`, CommonJS `module.exports`/`exports.x`, a re-export such as `...require('./csv')` or `export * from`, top-level Python `def`/`class`, Go exported `func`) is not in what shipped, nothing the job recorded (plan, contract, amendment, design record, builder summary, decision reason) names it with a removal or move word, and no file the job changed still exports it (then it moved). Test files are not interfaces and are skipped. High when a later task's own range removed it (named); medium when no task did (an integration or fix commit, or incomplete evidence) |
| R25 drive stops never surfaced | gap | `factory drive` stopped where you had to act (a gate, a park, a clarify turn, an error …; not `done`, `interrupted` or `superseded`) and nothing reached you: the stop's own record says no notification was sent (`sent`, or `notified: repeat` for one already announced), no `notify` with `sent: true` within 5 s of it (drive.js logs it just before the stop), no `drive_notified` line, nobody ran `factory inbox` or `factory drive status` after it, and no reply of yours (medium). A stop younger than `drive_notify_minutes` (10) on an active job is still in flight; closed, cancelled or abandoned jobs and jobs never driven get nothing |

## Use

Type `/factory-inspector:inspect`, or ask Copilot to run the inspector. Copilot keeps one skill per name, so a project or personal skill of your own called `inspect` hides this one; rename yours if `copilot skill list` doesn't show the inspector's.

| | |
|---|---|
| `/factory-inspector:inspect` | Inspect closed jobs not yet inspected, then walk through open findings |
| `/factory-inspector:inspect J-0007` | One job, plus its timeline |
| `/factory-inspector:inspect status` | Modes, clean streaks, suggestions |
| `/factory-inspector:inspect active` | Also inspect the jobs still running, as they stand now (issues happen mid-job) |
| `/factory-inspector:inspect health` | The factory-wide health summary |

It also runs on its own whenever a job ends (closed, cancelled or abandoned), through its GitHub Copilot CLI hooks (`hooks.json` at the plugin root, native format: camelCase events, no matchers, run through `$PLUGIN_ROOT`; each launcher is named `H=inspector:<hook>` and always exits 0, so a crash never blocks a tool):
- **postToolUse** (shell calls only): right after the agent runs `factory close`/`cancel`/`abandon`, it inspects and adds one line to the tool result (`additionalContext`).
- **agentStop**: at the end of the turn, when a job ended some other way (a `cancel job` reply, a command in your own terminal), it inspects it — in a detached background process, so the hook itself only checks what is pending and returns at once. It never blocks, and Copilot shows nothing from this event except a block, so the result goes to the register and the one-line summary waits for the next prompt (the stop gate's continuation in the same turn, or your next message), the next close report or the next session start, whichever comes first. The check reads only each job's `state.json`.
- **sessionStart**: tells the agent to use `factory-inspect` when it is on PATH (`factory shim`), else the absolute command (a plugin's `bin/` is not on PATH), inspects anything that ended while no session was open, reports the earlier end-of-turn results, and says how many findings are open.
- **userPromptSubmitted** applies your replies below as a side effect and adds any waiting end-of-turn line to the context (`additionalContext`, which Copilot CLI 1.0.97 does pass to the model); **preToolUse** denies agents the human-only commands where they run — the command word, after wrappers (`env`, `sudo`, `xargs`, …), inside `bash -c`, `eval` or `$(…)`, or through a variable, alias or function set to `factory-inspect` — and real writes (redirect, `tee`, `rm`, `mv`, `cp`, `sed -i` targets) into `.factory/inspect/`; quoted prose, grep patterns, commit messages and `2>/dev/null` are not. `write_bash` input is checked as a command (deny = the flat `permissionDecision` JSON on stdout, exit 0).
- **Inside agents `factory run` starts** (`FACTORY_RUNNER=1`), every inspector hook does nothing and the guard also refuses `factory-inspect run`/`health`: inspections belong to the main session.
- If `node` is not on PATH, each hook exits 0 with a warning on stderr instead of failing (a failing `preToolUse` hook would deny every tool).

All hooks read Copilot payloads in either casing (`toolName`/`toolArgs` or `tool_name`/`tool_input`) and Copilot tool names (`bash`, `edit`, `create`, `view`, `apply_patch`…), through their own copy of the factory's input normaliser — the inspector imports no factory code. The inspector reads the factory's activity lines the same way: camelCase event names and Copilot tool names count as their Claude-era equivalents, and since Copilot's `subagentStart` carries no agent id, a start is paired with a stop of the same agent type.

**Your replies:** `ack finding F3` · `fixed finding F3` · `wontfix finding F3 <why>` · `inspect mode <recipe|all> on|off|sample <N>`

A finding marked fixed that is seen again reopens automatically (marked ↺).

A finding from the health rules (R10 and up) is tied to its newest evidence: once marked fixed, it reopens only when something new happens, not because the old log lines are still there.

**CLI** (`factory-inspect`; `factory shim` puts it on your PATH, or run `node <plugin folder>/bin/factory-inspect`: the folder is `~/.copilot/installed-plugins/copilot-factory/factory-inspector` for a GitHub install (under `$COPILOT_HOME` if set), or `<your clone>/plugins/factory-inspector` for a marketplace added from a local folder; `copilot plugin list --json` tells you which): `run [--job J | --all | --active]` · `report [--format md]` (findings plus a **Factory health** section) · `health [--format md]` · `status` · `show F3` · `trace --job J`. The commands `mark` and `mode` are human-only: use them from your own terminal, or reply in chat.

## Turning it down and off

- **Per recipe:** `on` inspects every closed job. `sample N` inspects one job in N. `off` inspects none.
- **Suggestions:** after 20 clean jobs in a row on the current rules (configurable), it suggests sampling. After 60 while sampling, it suggests off. It never changes the mode itself.
- **Re-arming:** when a recipe's rules change (the recipe, floors, selection, or the factory's skills, agents or workflows), it resets that recipe's streak and inspects every job again.
- **Off entirely:** disable the plugin (`copilot plugin disable factory-inspector`). The factory keeps logging, so you can install it again later and run `factory-inspect run --all` over past jobs.

Settings live in `.factory/inspect/config.json`: `mode`, `sample_every`, `settle_after`, `threshold` (R9), per-recipe overrides, and:

- `limits` — the thresholds of the health rules, e.g. `{ "guard_denials_per_job": 5, "stop_blocks_per_job": 2, "cli_failures": 3, "agent_retries_per_job": 4, "orphan_agent_minutes": 120, "idle_hours": 72, "reply_hours": 48, "researchable_asked_per_job": 1, "assumptions_overridden_per_job": 1 }` (full list and defaults: `factory-inspect status`).
- `rules_off` — rules or families you don't want, e.g. `["R18", "R14.agent_retries"]`.

The register is `.factory/inspect/register.json`.

## Test

```bash
npm test   # 21 tests: a clean job has no findings; forged records, gate-window actions, skipped work,
           # synthetic deviations, cross-job ambiguity, friction, job and factory health (health rules: hook errors, torn lines, intent parks,
           # crashes, --active, health report), grounded intent (R20 from a real clarify record and synthetic ones), limits/rules_off, marks/regressions/modes/re-arming, hooks, jobs ending outside Bash, independence
```
