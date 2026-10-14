---
name: start
description: Run the Software Factory — turn a request into a verified, merged change through an approved contract, evidence and human gates. Use when the user types /factory:start, asks the factory to build/fix/change something, or wants to continue the current factory job.
argument-hint: "[what you want built or fixed — leave empty to continue the current job]"
---
# Software Factory — driver

You run the factory loop. **The `factory` CLI decides every next step; you carry it out.** Never pick the next step yourself, never skip one, and never write factory state by hand (the guard hook blocks it anyway).

The CLI is on your PATH as `factory` (from this plugin's `bin/`). If it isn't, use `node <plugin root>/bin/factory`. Every command prints JSON.

## 0. Setup (once per repo)
- Run `factory doctor`. If it says not initialized, run `factory init` and tell the user in one line what it set up (`.factory/` kept out of git, a commit-msg hook that adds `Factory-Job` trailers).
- If doctor reports errors (no commits, no git identity), tell the user how to fix them and stop.

## 1. New request or continue?
- If the user gave a request (`$ARGUMENTS` or their message) and there is no active job for it: follow the **factory:intake** skill to create the job.
- Otherwise continue the current job.

## 2. The loop
Repeat until you reach a stop point:

1. Run `factory next` and read `action`:

| action | what you do |
|---|---|
| `skill` | Follow the factory skill named in `skill` (clarify, ship, distill, amend), then go back to step 1. |
| `workflow` | Run the workflow (section 3), record its result, go back to step 1. |
| `cli` | Run exactly the `command` shown. Read its JSON. If it failed, show the user the message and run `factory next` again (the CLI decides whether to retry or park). |
| `gate` | Follow **factory:gate**. **Stop** and wait for the user's reply. |
| `wait` | If it lists `ready` slice jobs (epic), run `factory use <first ready id>` and continue the loop on that job. Otherwise tell the user in one or two lines what is being waited for (`reason`) and **stop**. |
| `parked` | Follow **factory:park**. **Stop.** |
| `done` | Summarise in two or three lines what shipped (`factory why --format md` if useful). **Stop.** |

2. Keep the user informed briefly between steps (one line per step is plenty). Don't narrate JSON.

## 3. Running a workflow
1. Build the brief, passing the fields `factory next` gave you (omit the ones it didn't):
   `factory wfargs <workflow> [--config <config>] [--mode <mode>] [--scope <scope>] [--lanes a,b] [--threat-model | --no-threat-model] [--plan-critique]`
   It prints a compact JSON brief (agent instructions live in files it references).
2. Start the workflow **`factory:<workflow>`** with the Workflow tool, passing that JSON, unchanged, as its args.
3. Write the JSON result the workflow returns, unchanged, to `.factory/scratch/envelope.json` and run `factory record --file .factory/scratch/envelope.json`.
4. Act on the record result's `status`:
   - `ok` / `fix` / `retry` / `stale` / `error` / `park` → go back to the loop. Nothing for the user here: `factory next` handles retries, fix rounds and parking.
   - `needs_user` with `questions` → ask the user exactly those questions, in that order, as one numbered list (for clarify: id, options and default on each line; intent questions come alone, first), then **stop**. Never add, reword into several, or re-ask questions. When they answer: for clarify, record each with `factory answer --id Q-n --answer "…"` and put the answers into the contract (factory:clarify); for ground, record each with `factory answer --question "…" --answer "…"`. Then continue the loop.
   - `needs_user` with `critique` or `problems` (clarify) → follow factory:clarify.
   - `degraded` → ask the user: re-run, or go on without the missing angle. Stop. If they choose to go on, write the missing angle under Assumptions in the contract and run the clarify workflow again with `--accept-degraded` added to `factory wfargs`.

**No Workflow tool?** Run the same brief by hand with the Agent tool: start every item of the fan-out in one message (parallel) with `subagent_type` set to the item's `agent_type` (e.g. `factory:researcher`), its `prompt`, and the item's `model` if it has one, requiring JSON that matches its `schema`; retry a failed item once; then do the judge / critique / verifier / builder-tester steps exactly as the workflow script (`workflows/<name>.js`) does, and build the result envelope with the same fields. Record it the same way.

## Rules
- Human gates are the user's. Never approve, deny, resume, waive or confirm on their behalf, and never run those commands (the guard blocks them). The user replies in chat: `approve`, `deny <what must change>`, `resume`, `cancel job`, `abandon job`, `waive <floor> <reason>`, `merged <commit>`, `confirm AC-n`, `accept lesson Ln`.
- If the user says the requirements changed, follow **factory:amend**.
- Don't claim the job is done until `factory next` says `done` (the Stop hook checks floors).
- `factory why --format md` explains every routing decision if the user asks why something happened.
