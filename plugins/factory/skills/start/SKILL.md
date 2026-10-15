---
name: start
description: "Drives a Software Factory job: a request becomes a verified, merged change through an approved contract, evidence and human gates. Use when the user types /factory:start, explicitly asks the factory to build, fix or change something, or wants to continue the current factory job. Not for ordinary coding requests that don't mention the factory: handle those normally."
argument-hint: "[what you want built or fixed, or leave empty to continue the current job]"
---
# Software Factory: driver

You run the factory loop. **The `factory` CLI decides every next step; you carry it out.** The CLI, its run lock and the hooks enforce the order, so your job is to follow the loop below faithfully and keep the user informed. Terms like recipe, floor, gate, God Eye and envelope are defined in [references/glossary.md](references/glossary.md); read it when one is unclear.

## The `factory` command
Run it as `factory …`; every command prints JSON. If `factory` is not found, use the absolute command the session-start note gave you (`node "<plugin root>/bin/factory"`) and tell the user once that `node "<plugin root>/bin/factory" shim`, run in their own terminal, puts `factory` on their PATH and ends the permission prompts (or they can `/add-dir <plugin root>`).

## Setup (once per repo)
Run `factory doctor`. If it says not initialized, run `factory init` and tell the user in one line what it set up (`.factory/` kept out of git, a commit-msg hook adding `Factory-Job` trailers, and, in a folder with no git history, `git init` and a first commit of its files). Name any `left_untracked` files (they look like secrets) and suggest `.gitignore`. On `no_git_identity`, give the user the two `git config` commands from the message and stop; on `home_folder`, ask them to open Copilot in a project folder and stop. Any other doctor error: tell the user the fix and stop.

## New request or continue?
A request with no active job for it → follow the **intake** skill to create the job. Otherwise continue the current job.

## The loop
1. Run `factory next` (once per finished step or user reply; re-running it is harmless but don't poll). Before acting, show what it reports in these fields, once each, in one line: `last_reply` (what happened to the user's last reply), `notice` (chat replies aren't reaching the factory; show it as it is), `autopilot` (Copilot Autopilot was detected: show its warning and **stop**; the factory runs in interactive mode, where gates wait for the user), and `environment` (no build environment is confirmed for this repository: show its `message` once; at a gate the gate skill shows the proposal in full; never confirm it yourself).
2. Do what `action` says:

| action | what you do | then |
|---|---|---|
| `skill` | Follow the factory skill named in `skill` (clarify, ship, distill, amend). For clarify, `clarify` carries the ledger summary: open issues by owner, the open questions and the exact `answer_commands`. | step 1 |
| `workflow` | Run it (see *Running a workflow*). | step 1 |
| `cli` | Run exactly the `command` shown. If it fails, show the message. | step 1 |
| `evidence` | For each AC in `acs`, check the job worktree shows it, then run its line in `commands` with the real file path (relative to the repo root). If it isn't there, tell the user and **stop**. | step 1 |
| `gate` | Follow the **gate** skill. | **stop** |
| `wait` | If it lists `ready` slice jobs (epic), run `factory use <first ready id>` and loop on that job; otherwise say in one line what is awaited (`reason`). | **stop** unless a slice is ready |
| `parked` | Follow the **park** skill. | **stop** |
| `done` | Summarise in two or three lines what shipped (`factory why --format md` if useful). | **stop** |

3. Between steps, one short line to the user is plenty; don't narrate JSON. End your turn only at a **stop** above or after asking the questions a result gave you: the stop hook sends you back otherwise.

## Running a workflow
1. Tell the user in one line that it is running; it takes minutes (30 or more for a big build). Then run, once, in the foreground with your shell tool's longest timeout, only the fields `factory next` gave you (leave out null ones):
   `factory run <workflow> [--config <config>] [--mode <mode>] [--scope <scope>] [--lanes a,b] [--threat-model | --no-threat-model] [--plan-critique]`
   It starts each agent as its own Copilot process, checks their JSON, records the result and prints a summary starting with `status: <x>`. It is the only way a workflow runs: briefs, envelopes and agent fan-out all happen inside it. If your shell hands control back while it runs, keep reading that same command's output. A second `factory run` for the job is refused with `run_in_progress` (the job's run lock), so wait for the first one's output instead.
2. Act on the top-level `status` line and the fields after it, never on `workflow.status` (the workflow's own summary):
   - `ok` / `fix` / `retry` / `revise` / `stale` / `error` / `park` → step 1; `factory next` handles retries, fix rounds and parking.
   - A **clarify** round (`--config clarify`) with any status → the **clarify** skill says what to show and do (`revise` and `retry` just loop back to step 1).
   - `needs_user` with `questions` from **ground** → ask exactly those questions as one numbered list and **stop**; record each answer with `factory answer --question "…" --answer "…"`, then step 1.
   - `degraded` (any other workflow) → ask the user: re-run, or go on without the missing angle. **Stop.** To go on, write the angle under Assumptions in the contract and run the same command with `--accept-degraded`.
3. If `factory run` refuses instead of printing a result, read `code`: `not_waiting_for_workflow` → step 1 and follow it; `run_in_progress` → tell the user it is still running and wait for that run's output; `copilot_unavailable` → tell the user the fix (`not_found`: install the Copilot CLI or put it on PATH; `not_signed_in`: `copilot login`) and **stop**; anything else → show the message, then step 1.

## Rules
- Human gates are the user's. Their replies in chat are applied by the reply hook before you act: `approve`, `deny <what must change>`, `resume`, `cancel job`, `abandon job`, `waive <floor> <reason>`, `merged <commit>`, `confirm AC-n`, `accept lesson Ln`, `change A-n <value>`, `drop A-n`, `confirm environment <hash|none>`, `dismiss finding <id> <why>`, `accept finding <id> <why>`, and while clarify waits, numbered answers (`1 yes, 2 …`, `defaults`). You relay them; the guard refuses the human-only commands from you. `factory next` (`last_reply`) shows what was applied.
- When the user has to run a human-only command themselves, say: "run this in your own terminal; it will ask you to type a code shown there." Never ask them for that code, never ask them to paste it here, and never accept "it's done" in its place: run `factory next` to see what was applied.
- During clarify you never edit the contract and never research on your own: record what the user said with `factory answer`, add context with `factory clarify note`, show `factory clarify status` when they ask what is open, and run `factory next`.
- If the user says the requirements changed, follow the **amend** skill.
- The job is done when `factory next` says `done` (the stop hook checks the floors).
- If the user asks why something happened, `factory why --format md` explains every routing decision.
