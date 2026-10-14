# factory-inspector

An independent auditor for the Software Factory. It answers two questions about every job:

1. **Was the intended recipe the one used?**
2. **Did the factory behave the way that recipe says?** That covers the order of steps, gates, the evidence chain and caps, and whether Claude did what `factory next` told it to.

It also finds **ambiguities**: places where the rules left room and someone had to improvise. And it watches the factory's **health**: every issue the factory reports about itself — hooks that failed, guard denials, blocked "done" claims, refused replies, CLI failures and crashes, stale or degraded workflow results, agent failures, retries and escalations, agents that never stopped, parks, idle jobs, slow gates. Each finding goes into a register for you to decide on.

It never blocks, approves or changes a job, a recipe or a policy.

## Why it is independent

The inspector does not import any factory code. It reads two things:

- **The rulebook each job declared.** `recipe.lock.json` is a sealed snapshot taken when the job was created. It holds the full recipe, the floors, the selection rules and the inputs that chose the recipe, plus a hash of the factory's skills, agents and workflows.
- **What happened.** That is the job's sealed state, ledger, decision log and observation log (`events.jsonl`). The observation log has every `factory` command (with `ok` and the error code), tied to the routing decision in force at the time, plus guard denials, refused and look-alike replies, stop blocks, hook failures (`hook_error`) and agent starts and stops. The ledger adds the agent roster of every workflow (retries, models, outcomes), workflow errors and degraded steps.

The inspector has its own implementations of three things: seal verification, recipe selection, and the allowed-path model. A bug in the factory's router can't hide itself, because the inspector never asks the router what should have happened.

## What it checks

| Rule | Class | Checks |
|---|---|---|
| R1 seals | deviation | Records written outside the factory CLI (state, lock, ledger, decision log, event log) |
| R2 intended recipe | deviation / gap | Replays the selection rules from the job's inputs. Checks the risk floor, the lock hash, and the recipe version every decision used. Flags a recipe file edited without a version bump |
| R3 conformance | deviation / ambiguity | Steps outside the recipe; steps reached before earlier ones completed; closed without a step; moving backwards with no recorded cause |
| R4 gates | deviation | Approvals that were never presented, or presented for a different document hash; automatic approvals the recipe doesn't allow |
| R5 evidence chain | deviation | Review on a build with no passing proof; proof on a build never integrated; shipping without both on the same build |
| R6 loops | deviation | Fix or clarify rounds beyond their caps plus your resumes |
| R7 driver fidelity | deviation | Claude didn't run what `factory next` asked for, ran something else, or changed things while waiting at a gate |
| R8 consistency | ambiguity / deviation | The same failing check routed by different rules under the same rulebook; identical inputs picking different recipes |
| R9 friction | ambiguity | Repeated patterns across jobs (3+ by default): the same guard denial, refused replies, refused workflow results, caps you nearly always resume past, the same floor waived, denials clustering at one gate, a step repeating with no progress |
| R10 hook errors | gap | A factory hook failed (`hook_error`; high for the guard, Stop and prompt hooks, which enforce nothing while failing); the inspector's own hooks failed (`.factory/inspect/hook-errors.jsonl`) |
| R11 log integrity | gap | Lines in `events.jsonl`, `decisions.jsonl` or a ledger that aren't JSON at all (a crashed or concurrent write) |
| R12 hook pushback | ambiguity | Per job, over a limit: guard denials, blocked "done" claims, refused replies, look-alike replies that weren't applied |
| R13 CLI failures | gap / ambiguity | A `factory` command crashed (internal error, factory-wide); the same command failing with the same code again and again in a job; workflow results thrown away as stale |
| R14 workflows and agents | ambiguity | Workflow errors; steps that went on degraded (agents with no result after a retry); agent retries, failures and model escalations over a limit; the same step recorded as failed again and again |
| R15 orphaned agents | gap | Agents that started and never reported stopping (after the job ended, or after a time limit) |
| R16 parks and resumes | ambiguity | A job parked, or resumed past its caps, more than a limit |
| R17 idle job | gap | Active, not waiting for you, and nothing has happened for a long time |
| R18 slow reply | ambiguity | A gate that waited longer than a limit for your reply |
| R19 clarify | ambiguity | A job parked because its intent was still unclear after the intent rounds; clarify proposing questions over the round budget or already asked (dropped by the CLI) beyond a limit |

## Use

| | |
|---|---|
| `/factory-inspector:inspect` | Inspect closed jobs not yet inspected, then walk through open findings |
| `/factory-inspector:inspect J-0007` | One job, plus its timeline |
| `/factory-inspector:inspect status` | Modes, clean streaks, suggestions |
| `/factory-inspector:inspect active` | Also inspect the jobs still running, as they stand now (issues happen mid-job) |
| `/factory-inspector:inspect health` | The factory-wide health summary |

It also runs on its own whenever a job ends (closed, cancelled or abandoned) and adds one line to the conversation: right after Claude runs `factory close`/`cancel`/`abandon`; at the end of the turn when the job ended some other way (a `cancel job` reply, a command in your own terminal); and at session start for anything that ended while no session was open, after which it says how many findings are open. The end-of-turn check reads only each job's `state.json`, so it costs nothing when nothing is pending.

**Your replies:** `ack finding F3` · `fixed finding F3` · `wontfix finding F3 <why>` · `inspect mode <recipe|all> on|off|sample <N>`

A finding marked fixed that is seen again reopens automatically (marked ↺).

A finding from the health rules (R10–R19) is tied to its newest evidence: once marked fixed, it reopens only when something new happens, not because the old log lines are still there.

**CLI** (`factory-inspect`, on the PATH): `run [--job J | --all | --active]` · `report [--format md]` (findings plus a **Factory health** section) · `health [--format md]` · `status` · `show F3` · `trace --job J`. The commands `mark` and `mode` are human-only: use them from your own terminal, or reply in chat.

## Turning it down and off

- **Per recipe:** `on` inspects every closed job. `sample N` inspects one job in N. `off` inspects none.
- **Suggestions:** after 20 clean jobs in a row on the current rules (configurable), it suggests sampling. After 60 while sampling, it suggests off. It never changes the mode itself.
- **Re-arming:** when a recipe's rules change (the recipe, floors, selection, or the factory's skills, agents or workflows), it resets that recipe's streak and inspects every job again.
- **Off entirely:** disable the `factory-inspector` plugin. The factory keeps logging, so you can install it again later and run `factory-inspect run --all` over past jobs.

Settings live in `.factory/inspect/config.json`: `mode`, `sample_every`, `settle_after`, `threshold` (R9), per-recipe overrides, and:

- `limits` — the thresholds of R10–R19, e.g. `{ "guard_denials_per_job": 5, "stop_blocks_per_job": 2, "cli_failures": 3, "agent_retries_per_job": 4, "orphan_agent_minutes": 120, "idle_hours": 72, "reply_hours": 48 }` (full list and defaults: `factory-inspect status`).
- `rules_off` — rules or families you don't want, e.g. `["R18", "R14.agent_retries"]`.

The register is `.factory/inspect/register.json`.

## Test

```bash
npm test   # 14 tests: a clean job has no findings; forged records, gate-window actions, skipped work,
           # synthetic deviations, cross-job ambiguity, friction, job and factory health (R10–R19: hook errors, torn lines, intent parks,
           # crashes, --active, health report), limits/rules_off, marks/regressions/modes/re-arming, hooks, jobs ending outside Bash, independence
```
