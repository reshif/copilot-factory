---
name: start
description: "Drives a Software Factory job: a request becomes a verified, merged change through an approved contract, evidence and human gates. Use when the user types /factory:start, explicitly asks the factory to build, fix or change something, or wants to continue the current factory job. Not for ordinary coding requests that don't mention the factory: handle those normally."
argument-hint: "[what you want built or fixed, or leave empty to continue the current job]"
---
# Software Factory: driver

You run the factory. **The `factory` CLI decides every next step, and `factory drive` carries the mechanical ones out.** Your job is to start it, relay each stop to the user faithfully, and pass their replies back. Terms like recipe, floor, gate, God Eye and envelope are defined in [references/glossary.md](references/glossary.md); read it when one is unclear.

## The `factory` command
Run it as `factory …`; every command prints JSON. If `factory` is not found, use the absolute command the session-start note gave you (`node "<plugin root>/bin/factory"`) and tell the user once that `node "<plugin root>/bin/factory" shim`, run in their own terminal, puts `factory` on their PATH and ends the permission prompts (or they can `/add-dir <plugin root>`).

## Setup (once per repo)
Run `factory doctor`. If it says not initialized, run `factory init` and tell the user in one line what it set up (`.factory/` kept out of git, a commit-msg hook adding `Factory-Job` trailers, and, in a folder with no git history, `git init` and a first commit of its files). Name any `left_untracked` files (they look like secrets) and suggest `.gitignore`. On `no_git_identity`, give the user the two `git config` commands from the message and stop; on `home_folder`, ask them to open Copilot in a project folder and stop. Any other doctor error: tell the user the fix and stop.

## New request or continue?
A request with no active job for it → follow the **intake** skill to create the job. Otherwise continue the current job.

## The loop: `factory drive`
`factory drive` steps the job for you: every workflow (`factory run`, clarify's agent stages included), every CLI step, ship, distill and the evidence records it can check. It stops only where a person is needed, and sends the user a desktop notification at each stop. You don't step `factory next` yourself, and you never run `factory next` or `factory run` while a drive runs (they answer `driving` or refuse with `drive_in_progress`).

1. Tell the user in one line that the factory is working (it can take minutes, 30 or more for a big build). Start it in the background: `factory drive --detach`. Then run `factory drive status --wait 240` (less than your shell tool's time limit), again while its `status` is `running`; between waits, one short line to the user is plenty. When `status` is `stopped`, its `last` is the stop: `kind`, a one-line `summary`, and `next` (the `factory next` output at that stop, which the gate, park and clarify skills read their fields from). `drive_in_progress` means one is already running: wait for it the same way. `status` `crashed` (the drive died without a stop): start it again with `factory drive --detach`; a record that still blocks you is cleared by `factory drive stop`. (Don't run `factory drive` in the foreground: a shell tool's time limit would stop it, and the build it is running with it.)
2. Show what the stop carries, once each, in one line: `last_reply` (what happened to the user's last reply), `notice` (chat replies aren't reaching the factory; show it as it is), `autopilot` (Copilot Autopilot was detected: show its warning and **stop**; gates must wait for the user), and `environment` (no build environment is confirmed: show its `message` once; at a gate the gate skill shows the proposal in full; never confirm it yourself).
3. Act on `kind`:

| kind | what you do | then |
|---|---|---|
| `gate` | Follow the **gate** skill with the stop's `next`. | **stop** |
| `clarify` | Show the stop's `screen` **as it is** (the **clarify** skill says how to record what the user says). | **stop** |
| `questions` | Ask exactly the `questions` as one numbered list. Record each answer with `factory answer --question "…" --answer "…"`. | **stop**, then `factory drive --detach` |
| `degraded` | Ask the user: re-run, or go on without the missing angle. To go on, write the angle under Assumptions in the contract and run the workflow from `next` with `--accept-degraded`. | **stop**, then `factory drive --detach` |
| `parked` | Follow the **park** skill: `next.reason`, `park.kind`, `park.question` with its options and recommendation, and `park.next`. | **stop** |
| `wait` | With `ship_review`: show its `screen` as it is (the **ship** skill: one reply settles it). A merge: the **ship** skill's commands; the factory notices the merge itself. A build that waits for its environment (`rule` `env.unconfirmed`): show `next.environment` and the `confirm environment <hash>` reply from `next.reason`; never confirm it yourself. Otherwise say in one line what is awaited (`summary`). | **stop** |
| `amend` | Follow the **amend** skill. | `factory drive --detach` |
| `evidence` | For each AC in `acs`, check the job worktree shows it, then run its line in `commands` with the real path. If it isn't there, tell the user and **stop**. | `factory drive --detach` |
| `skill` | Follow the factory skill named in `next.skill`. | `factory drive --detach` |
| `ship` | `policy.drive.stop_before_ship` is on: every floor is met and the push, PR or local merge waits for the user. Run `factory report` and show its summary; when the user says to ship, follow the **ship** skill (`factory ship`). | **stop**, then `factory drive --detach` |
| `done` | Summarise in two or three lines what shipped (`factory why --format md` if useful); show the end-of-job digest: the `lessons` and brief proposals, with `digest.reply` as the one reply that accepts them all (the **distill** skill). | **stop** |
| `copilot_unavailable` | Tell the user the fix (`not_found`: install the Copilot CLI or put it on PATH; `not_signed_in`: `copilot login`). | **stop** |
| `transient` | Copilot kept failing with rate limits or network errors: tell the user to wait a few minutes, then run `factory drive --detach` again (after a few runs in a row the job parks, kind `transient`). | **stop** |
| `interrupted` | The drive was stopped (a closed terminal, `factory drive stop`): start it again with `factory drive --detach`; it continues from where the job is. | step 1 |
| `superseded` | Another drive took over this one: wait for that one with `factory drive status --wait 240`. | step 1 |
| `step_too_long` | Drives were killed twice in a row in the same step (`in_step`): show the `summary`. Start it again only with `factory drive --detach`, never in the foreground. | **stop** |
| `error`, `limit` | Show the `summary`. `factory why --format md` explains the last decisions. | **stop** |

4. After the user replies to a stop (the reply hook applies `approve`, `ok`, `resume`, …), start it again (`factory drive --detach`, then step 1's wait): it continues from where the job is, and its stop's `last_reply` says whether the reply was applied. Between steps, one short line to the user is plenty; don't narrate JSON. End your turn only at a **stop** above: the stop hook sends you back otherwise.

**`factory inbox`** lists everything waiting on the user across jobs, each with the chat reply and the terminal command. Suggest it when the user asks what is waiting, or when several jobs are open.

## Without `factory drive`
Use this only when `factory drive` can't run here (a host that can neither keep a long command running nor background one). Run `factory next` once per finished step or user reply, show its `last_reply`, `notice`, `autopilot` and `environment` as in step 2, and do what `action` says: `skill` (the factory skill named), `workflow` (run `factory run <workflow>` with only the fields `factory next` gave: `--config`, `--mode`, `--scope`, `--lanes a,b`, `--threat-model` or `--no-threat-model`, `--plan-critique`; act on its top-level `status` line: `needs_user` from ground means ask its questions, `degraded` means ask as above, anything else goes back to `factory next`), `cli` (run exactly the `command`), `evidence` (as above), `gate` (the gate skill, **stop**), `wait` (say what is awaited, **stop**; with `ready` slice jobs run `factory use <first ready id>` and loop on it), `parked` (the park skill, **stop**), `done` (summarise, **stop**). A second `factory run` for the job is refused with `run_in_progress`: wait for the first one's output.

## Rules
- Human gates are the user's. Their replies in chat are applied by the reply hook before you act: `approve`, `approve ship`, `deny <what must change>`, `resume` (a budget park: `resume +50%`), `cancel job`, `abandon job`, `waive <floor> <reason>`, `merged <commit>`, `confirm AC-n`, `accept lesson Ln`, `accept brief Pn`, `proceed` (an older job's clarify cap), `confirm environment <hash|none>`, `dismiss finding <id> <why>`, `accept finding <id> <why>`, several of them in one message separated by `;` (the ship review, the digest), and while clarify waits, `ok` or a structured sheet answer (`ok, but 2 b`, `fact 1: …`). While the job is parked, any message of theirs that is not a question to you is their answer to the park: the hook resumes the job with their words. You relay them; the guard refuses the human-only commands from you. `factory next` (`last_reply`) shows what was applied.
- When the user has to run a human-only command themselves, say: "run this in your own terminal; it will ask you to type a code shown there." Never ask them for that code, never ask them to paste it here, and never accept "it's done" in its place: run `factory next` to see what was applied.
- During clarify you never research on your own and never answer for the user: record what they said, verbatim, with `factory clarify reply "…"` (or `factory clarify redirect "…"` when they change direction), show `factory clarify status` when they ask what is open, and run `factory next`. The user may edit `contract.md` themselves; the CLI checks it again.
- If the user says the requirements changed, follow the **amend** skill.
- The job is done when `factory next` says `done` (the stop hook checks the floors).
- If the user asks why something happened, `factory why --format md` explains every routing decision and every park (its kind and suggested next step).
- Never answer a gate, a clarify turn or a park for the user, and never type their replies (`approve`, `ok`, `resume`, `proceed`) yourself: `factory drive` stops there so the user can answer.
