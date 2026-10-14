---
name: start
description: "Run the Software Factory: turn a request into a verified, merged change through an approved contract, evidence and human gates. Use when the user types /start (or /factory/start), asks the factory to build, fix or change something, or wants to continue the current factory job."
argument-hint: "[what you want built or fixed, or leave empty to continue the current job]"
---
# Software Factory: driver

You run the factory loop. **The `factory` CLI decides every next step; you carry it out.** Never pick the next step yourself, never skip one, and never write factory state by hand (the guard hook blocks it anyway).

## The `factory` command
- Run it as `factory …`. Every command prints JSON.
- If `factory` is not found, use the absolute command the factory gave you at session start (it looks like `node "<plugin root>/bin/factory"`) wherever these skills say `factory …`. Tell the user once that running that command with `shim` (for example `node "<plugin root>/bin/factory" shim`) in their own terminal puts `factory` and `factory-inspect` on their PATH.
- Never run the factory in **Autopilot** mode, and never suggest it: Autopilot answers questions and permission prompts by itself, and every gate here belongs to the user. If the session is in Autopilot, tell the user to switch back to interactive mode and stop.

## 0. Setup (once per repo)
- Run `factory doctor`. If it says not initialized, run `factory init` and tell the user in one line what it set up (`.factory/` kept out of git, a commit-msg hook that adds `Factory-Job` trailers).
- If doctor reports errors (no commits, no git identity), tell the user how to fix them and stop.

## 1. New request or continue?
- If the user gave a request (the text after `/start`, or their message) and there is no active job for it: follow the **intake** skill to create the job.
- Otherwise continue the current job.

## 2. The loop
Repeat until you reach a stop point:

1. Run `factory next`. If its output has `last_reply`, first tell the user in one line what happened to their last reply (applied, or not applied and why), using its message. Then read `action`:

| action | what you do |
|---|---|
| `skill` | Follow the factory skill named in `skill` (clarify, ship, distill, amend), then go back to step 1. |
| `workflow` | Run the workflow with `factory run` (section 3), act on its result, go back to step 1. |
| `cli` | Run exactly the `command` shown. Read its JSON. If it failed, show the user the message and run `factory next` again (the CLI decides whether to retry or park). |
| `gate` | Follow the **gate** skill. **Stop** and wait for the user's reply. |
| `wait` | If it lists `ready` slice jobs (epic), run `factory use <first ready id>` and continue the loop on that job. Otherwise tell the user in one or two lines what is being waited for (`reason`) and **stop**. |
| `parked` | Follow the **park** skill. **Stop.** |
| `done` | Summarise in two or three lines what shipped (`factory why --format md` if useful). **Stop.** |

2. Keep the user informed briefly between steps (one line per step is plenty). Don't narrate JSON.
3. Stop only where the table says stop, or after asking the user the questions a result gave you. Ending your turn anywhere else leaves the job half-done, and the stop hook sends you back.

## 3. Running a workflow
1. Run `factory run <workflow>` with the fields `factory next` gave you (leave out the ones it didn't give, or gave as null):
   `factory run <workflow> [--config <config>] [--mode <mode>] [--scope <scope>] [--lanes a,b] [--threat-model | --no-threat-model] [--plan-critique]`
   It builds the brief, starts each agent of the workflow as its own Copilot process (`copilot -p --agent factory:<role>`), checks every agent's JSON against its schema, records the result with `factory record`, and prints the record result. It can take many minutes; let it finish. **Never** write a brief or an envelope yourself, never start the factory's agents yourself, and never fan the work out with subagents or `/fleet`: `factory run` is the only way a workflow runs.
2. Act on the printed result's `status`:
   - `ok` / `fix` / `retry` / `stale` / `error` / `park` → go back to the loop. Nothing for the user here: `factory next` handles retries, fix rounds and parking.
   - `needs_user` with `questions` → ask the user exactly those questions, in that order, as one numbered list (for clarify: id, options and default on each line; intent questions come alone, first), then **stop**. Never add, reword into several, or re-ask questions. When they answer: for clarify, record each with `factory answer --id Q-n --answer "…"` and put the answers into the contract (the **clarify** skill); for ground, record each with `factory answer --question "…" --answer "…"`. Then continue the loop.
   - `needs_user` with `critique` or `problems` (clarify) → follow the **clarify** skill.
   - `degraded` → ask the user: re-run, or go on without the missing angle. Stop. If they choose to go on, write the missing angle under Assumptions in the contract and run the same `factory run` command again with `--accept-degraded` added.
3. If `factory run` itself fails (it prints an error instead of a record result, for example because `copilot` could not be started), show the user the message and run `factory next`. Don't do the workflow's work by hand.

## Rules
- Human gates are the user's. Never approve, deny, resume, waive or confirm on their behalf, and never run those commands (the guard blocks them). The user replies in chat: `approve`, `deny <what must change>`, `resume`, `cancel job`, `abandon job`, `waive <floor> <reason>`, `merged <commit>`, `confirm AC-n`, `accept lesson Ln`. The reply hook applies the reply before you act on it; `factory next` (and its `last_reply`) shows what was applied.
- If the user says the requirements changed, follow the **amend** skill.
- Don't claim the job is done until `factory next` says `done` (the stop hook checks floors).
- `factory why --format md` explains every routing decision if the user asks why something happened.
