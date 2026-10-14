---
name: start
description: "Run the Software Factory: turn a request into a verified, merged change through an approved contract, evidence and human gates. Use when the user types /factory:start, asks the factory to build, fix or change something, or wants to continue the current factory job."
argument-hint: "[what you want built or fixed, or leave empty to continue the current job]"
---
# Software Factory: driver

You run the factory loop. **The `factory` CLI decides every next step; you carry it out.** Never pick the next step yourself, never skip one, and never write factory state by hand (the guard hook blocks it anyway).

## The `factory` command
- Run it as `factory …`. Every command prints JSON.
- If `factory` is not found, use the absolute command the factory gave you at session start (it looks like `node "<plugin root>/bin/factory"`) wherever these skills say `factory …`. Tell the user once that running that command with `shim` (for example `node "<plugin root>/bin/factory" shim`) in their own terminal puts `factory` and `factory-inspect` on their PATH.
- Never run the factory in **Autopilot** mode, and never suggest it: Autopilot answers questions and permission prompts by itself, and every gate here belongs to the user. If the session is in Autopilot, tell the user to switch back to interactive mode and stop.

## 0. Setup (once per repo)
- Run `factory doctor`. If it says not initialized, run `factory init` and tell the user in one line what it set up (`.factory/` kept out of git, a commit-msg hook that adds `Factory-Job` trailers, and — when the folder had no git history yet — `git init` if needed and a first commit of the folder's files, leaving anything that looks like a secret untracked). If it fails with `no_git_identity`, give the user the two `git config` commands from the message and stop; if it refuses the home folder, ask them to open Copilot in a project folder.
- If doctor reports errors (for example no git identity), tell the user how to fix them and stop.

## 1. New request or continue?
- If the user gave a request (the text after `/factory:start`, or their message) and there is no active job for it: follow the **intake** skill to create the job.
- Otherwise continue the current job.

## 2. The loop
Repeat until you reach a stop point:

1. Run `factory next` **once** for this step. Don't run it again just to check where things stand: every call is a routing decision, and repeated calls from the same state count as no progress and can park the job. If its output has `last_reply`, first tell the user in one line what happened to their last reply (applied, or not applied and why), using its message. Then read `action`:

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
   It builds the brief, starts each agent of the workflow as its own Copilot process (`copilot -p --agent factory:<role>`), checks every agent's JSON against its schema, records the result with `factory record`, and prints a short summary of the recorded result (`--json` prints the full record; you rarely need it). **Never** write a brief or an envelope yourself, never start the factory's agents yourself, and never fan the work out with subagents or `/fleet`: `factory run` is the only way a workflow runs.
2. **It takes a long time** — several minutes, and 30 or more for a big build. Tell the user in one line that it is running. Run it **once**, in the foreground, with the longest timeout your shell tool allows. Don't poll it, don't run other factory commands while it runs, and **never start a second `factory run`**. If the shell tool hands control back while the command is still running, keep waiting for that same command's output in the same shell session; don't start it again.
3. Act on the printed top-level `status`. It is the status of the **recorded** result, which is what counts (the workflow's own summary is nested under `workflow`; don't act on that):
   - `ok` / `fix` / `retry` / `stale` / `error` / `park` → go back to the loop. Nothing for the user here: `factory next` handles retries, fix rounds and parking.
   - `needs_user` with `questions` → ask the user exactly those questions, in that order, as one numbered list (for clarify: id, options and default on each line; intent questions come alone, first), then **stop**. Never add, reword into several, or re-ask questions. When they answer: for clarify, record each with `factory answer --id Q-n --answer "…"` and put the answers into the contract (the **clarify** skill); for ground, record each with `factory answer --question "…" --answer "…"`. Then continue the loop.
   - `needs_user` with `critique` or `problems` (clarify) → follow the **clarify** skill.
   - `degraded` → ask the user: re-run, or go on without the missing angle. Stop. If they choose to go on, write the missing angle under Assumptions in the contract and run the same `factory run` command again with `--accept-degraded` added.
4. If `factory run` refuses or fails instead of printing a result, read its `code`:
   - `not_waiting_for_workflow` → the job isn't waiting for this workflow (a gate is pending, it is parked, or the route moved on). Run `factory next` once and follow it.
   - `run_in_progress` → another `factory run` is already going for this job. Don't start a second one: tell the user it's still running and wait for it to finish, then run `factory next`.
   - `copilot_unavailable` → the `copilot` command is missing or not signed in, so no agent can start. Tell the user, with the fix from the message (install the Copilot CLI, or sign in with `copilot login`), and **stop**.
   - Anything else → show the user the message and run `factory next`.
   Never do the workflow's work by hand.

## Rules
- Human gates are the user's. Never approve, deny, resume, waive or confirm on their behalf, and never run those commands (the guard blocks them). The user replies in chat: `approve`, `deny <what must change>`, `resume`, `cancel job`, `abandon job`, `waive <floor> <reason>`, `merged <commit>`, `confirm AC-n`, `accept lesson Ln`. The reply hook applies the reply before you act on it; `factory next` (and its `last_reply`) shows what was applied.
- If the user says the requirements changed, follow the **amend** skill.
- Don't claim the job is done until `factory next` says `done` (the stop hook checks floors).
- `factory why --format md` explains every routing decision if the user asks why something happened.
