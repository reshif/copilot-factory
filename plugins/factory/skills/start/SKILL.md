---
name: start
description: "Run the Software Factory: turn a request into a verified, merged change through an approved contract, evidence and human gates. Use when the user types /factory:start, asks the factory to build, fix or change something, or wants to continue the current factory job."
argument-hint: "[what you want built or fixed, or leave empty to continue the current job]"
---
# Software Factory: driver

You run the factory loop. **The `factory` CLI decides every next step; you carry it out.** Never pick the next step yourself, never skip one, and never write factory state by hand (the guard hook blocks it anyway).

## The `factory` command
- Run it as `factory …`. Every command prints JSON.
- If `factory` is not found, use the absolute command the factory gave you at session start (it looks like `node "<plugin root>/bin/factory"`) wherever these skills say `factory …`. Copilot asks the user to approve each of those (the plugin folder is outside the workspace). Tell the user once: running that command with `shim` (for example `node "<plugin root>/bin/factory" shim`) in their own terminal puts `factory` and `factory-inspect` on their PATH, which ends the prompts; or they can allow the folder with `/add-dir <plugin root>`.
- Never run the factory in **Autopilot** mode, and never suggest it: Autopilot answers questions and permission prompts by itself, and every gate here belongs to the user. If the session is in Autopilot, tell the user to switch back to interactive mode and stop.

## 0. Setup (once per repo)
- Run `factory doctor`. If it says not initialized, run `factory init` and tell the user in one line what it set up (`.factory/` kept out of git, a commit-msg hook that adds `Factory-Job` trailers, and — when the folder had no git history yet — `git init` if needed and a first commit of the folder's existing files, respecting `.gitignore`). If its output lists `left_untracked` files (they look like secrets, so they were not committed), name them and suggest the user adds them to `.gitignore`. If it fails with `no_git_identity`, give the user the two `git config` commands from the message and stop; if it fails with `home_folder`, ask them to open Copilot in a project folder and stop.
- If doctor reports errors (for example no git identity), tell the user how to fix them and stop.

## 1. New request or continue?
- If the user gave a request (the text after `/factory:start`, or their message) and there is no active job for it: follow the **intake** skill to create the job.
- Otherwise continue the current job.

## 2. The loop
Repeat until you reach a stop point:

1. Run `factory next` for this step. Running it again from the same state is harmless (it returns the same decision, with `requery: true`), but don't poll it: run it when a step is finished or the user has replied. If its output has `last_reply`, first tell the user in one line what happened to their last reply (applied, or not applied and why), using its message. Then read `action`:

| action | what you do |
|---|---|
| `skill` | Follow the factory skill named in `skill` (clarify, ship, distill, amend), then go back to step 1. |
| `workflow` | Run the workflow with `factory run` (section 3), act on its result, go back to step 1. |
| `cli` | Run exactly the `command` shown. Read its JSON. If it failed, show the user the message and run `factory next` again (the CLI decides whether to retry or park). |
| `evidence` | A criterion needs a doc or diff record, not a code change. For each AC in `acs`, check the build (the job worktree) shows it, then run its line in `commands` yourself with the real file path (relative to the repository root). If it isn't there, tell the user and stop. Then go back to step 1. |
| `gate` | Follow the **gate** skill. **Stop** and wait for the user's reply. |
| `wait` | If it lists `ready` slice jobs (epic), run `factory use <first ready id>` and continue the loop on that job. Otherwise tell the user in one or two lines what is being waited for (`reason`) and **stop**. |
| `parked` | Follow the **park** skill. **Stop.** |
| `done` | Summarise in two or three lines what shipped (`factory why --format md` if useful). **Stop.** |

2. Keep the user informed briefly between steps (one line per step is plenty). Don't narrate JSON.
3. Stop only where the table says stop, or after asking the user the questions a result gave you. Ending your turn anywhere else leaves the job half-done, and the stop hook sends you back.

## 3. Running a workflow
1. Run `factory run <workflow>` with the fields `factory next` gave you (leave out the ones it didn't give, or gave as null):
   `factory run <workflow> [--config <config>] [--mode <mode>] [--scope <scope>] [--lanes a,b] [--threat-model | --no-threat-model] [--plan-critique]`
   It builds the brief, starts each agent of the workflow as its own Copilot process (`copilot -p --agent factory:<role>`), checks every agent's JSON against its schema, records the result with `factory record`, and prints a short text summary of the recorded result, starting with a `status: <x>` line (`--json` prints the same as JSON; you rarely need it). **Never** write a brief or an envelope yourself, never start the factory's agents yourself, and never fan the work out with subagents or `/fleet`: `factory run` is the only way a workflow runs.
2. **It takes a long time** — several minutes, and 30 or more for a big build. Tell the user in one line that it is running. Run it **once**, in the foreground, with the longest timeout your shell tool allows. Don't poll it, don't run other factory commands while it runs, and **never start a second `factory run`**. If the shell tool hands control back while the command is still running, keep waiting for that same command's output in the same shell session and read it when it ends; don't start it again.
3. Act on the `status` line (top-level `status` = the recorded result) and the fields after it (questions, critique, problems, restatement, message) — never on `workflow.status`, which is only the workflow's own summary:
   - `ok` / `fix` / `retry` / `stale` / `error` / `park` → go back to the loop. Nothing for the user here: `factory next` handles retries, fix rounds and parking.
   - `needs_user` with `questions` → ask the user exactly those questions, in that order, as one numbered list (for clarify: id, options and default on each line; intent questions come alone, first), then **stop**. For clarify, show them on one screen after **What I found** (the `findings`: claim, source, date, verdict) and **What I'm assuming** (the `assumptions`, A-n with evidence ids; the user overrides one with `change A-n <value>` or `drop A-n`), and give each question's reason and whether its default rests on evidence or is the user's call — the **clarify** skill has the layout. Never present an unverified or contradicted finding as fact. Never add, reword into several, or re-ask questions. When they answer: for clarify, record each with `factory answer --id Q-n --answer "…"` and put the answers into the contract (the **clarify** skill); for ground, record each with `factory answer --question "…" --answer "…"`. Then continue the loop.
   - `needs_user` with `critique` or `problems` (clarify) → follow the **clarify** skill. If its message says God Eye found questions research can answer, ask the user nothing: run `factory next` (clarify researches them first).
   - `degraded` → ask the user: re-run, or go on without the missing angle. Stop. If they choose to go on, write the missing angle under Assumptions in the contract and run the same `factory run` command again with `--accept-degraded` added (that re-run is allowed under the same routing decision).
4. If `factory run` refuses or fails instead of printing a result, read its `code`:
   - `not_waiting_for_workflow` → the job isn't waiting for this workflow (`details.reason`: `not_asked`, `gate_pending`, `parked` or `already_recorded`). Run `factory next` and follow it.
   - `run_in_progress` → another `factory run` is already going for this job. Never start a second one: tell the user it's still running, wait for it, read its output, then run `factory next`.
   - `copilot_unavailable` → no agent can start (`why`: `not_found` — the Copilot CLI isn't installed or on PATH; `not_signed_in` — sign in with `copilot login`). Tell the user, with the fix, and **stop**.
   - Anything else → show the user the message and run `factory next`.
   Never do the workflow's work by hand.

## Rules
- Human gates are the user's. Never approve, deny, resume, waive or confirm on their behalf, and never run those commands (the guard blocks them). The user replies in chat: `approve`, `deny <what must change>`, `resume`, `cancel job`, `abandon job`, `waive <floor> <reason>`, `merged <commit>`, `confirm AC-n`, `accept lesson Ln`, `change A-n <value>`, `drop A-n` (override an evidence-backed assumption: before H1 clarify runs again; after H1 it is an amendment for their approval). Never run `factory assumption …` yourself (the guard blocks it). The reply hook applies the reply before you act on it; `factory next` (and its `last_reply`) shows what was applied.
- If the user says the requirements changed, follow the **amend** skill.
- Don't claim the job is done until `factory next` says `done` (the stop hook checks floors).
- `factory why --format md` explains every routing decision if the user asks why something happened.
