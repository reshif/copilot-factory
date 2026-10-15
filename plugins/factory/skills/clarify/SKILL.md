---
name: clarify
description: "Writes and settles a factory job's outcome contract, asking the user only what research can't answer. Use when `factory next` returns skill clarify, or a clarify round's result needs handling. Not for requirement questions outside a factory job."
user-invocable: false
---
# Clarify: write the outcome contract

Terms such as God Eye, envelope and evidence-backed assumption are defined in the start skill's [glossary](../start/references/glossary.md).

The contract lives at `.factory/jobs/<job>/contract.md` (`factory job show` prints the job; the path is in the job folder). It has fixed sections the CLI parses: **Intent, Goal, Non-goals, Acceptance criteria, Constraints, Allowed paths, Verify commands, Assumptions (evidence-backed), Clarifications (settled), Deferred to design, Assumptions**. The CLI writes the last three CLI-owned sections from the clarify ledger; never edit them yourself.

## Draft (before the first round only)
You write the contract once, before clarify's first round. After that, during clarify, the contract has **one writer**: the clarify workflow's contract editor, through `factory record`. The guard refuses your edits to `contract.md` until H1 is approved; don't work around it.
Write the **Intent** first, then the rest. If the intent isn't clear, nothing below it makes sense.
- **Intent**, one line each: `Problem` (what is wrong or missing today), `Who` (who has it, who asked), `Outcome` (what is true for them when done), `Why now` (optional), `Success signal` (how we'd know it worked, observably). Use the user's words and the intake restatement they confirmed.
- **Goal**: the outcome in one or two sentences — what is true when done, not how. It must agree with the Intent.
- **Acceptance criteria**: one per line, `- AC-1: <observable behaviour> (evidence: test)`. Evidence types: `test`, `run` (a command whose success proves it), `diff`, `doc`, `human` (the user confirms it). Prefer `test`. Epics use `E-AC-1`.
- **Allowed paths**: globs the change may touch, as narrow as you can (`src/cart/**`, `tests/cart/**`).
- **Verify commands**: commands from the repo root that exit non-zero on failure, with the ACs they prove: ``- `npm test -- cart` (AC-1, AC-2)``.
- Non-goals, constraints and assumptions from the request and what you read in the repo.
Answer everything the repo can answer yourself. Don't state facts about the outside world (library behaviour, vendor limits, standards) from memory, and don't settle how it will be built (exact field names, command syntax, line ranges): the scouts research the first, design settles the second. In Intent and Constraints, cite an `E-n` only when `factory intent show` lists it as confirmed. Then run `factory contract check` and fix every problem it lists. (For the `bug@low` recipe, also `factory contract check --plan-fields`.)

## The clarify ledger
Clarify keeps one list of issues (`U-n`), owned by the CLI: each has a subject, an owner (research, the user, design), a status and how it was settled. `factory clarify status` prints it (id, subject, status, owner, next action, and what each round opened and settled); it is read-only and safe to run any time. Show it to the user whenever they ask what is open, or when a result is hard to explain.
- **Research first.** Each clarify round starts with the scout phase: the intent mapper lists the issues, scouts research the research-owned ones within the risk budget (one attempt, one retry with a longer budget), the verifier re-checks findings. Confirmed findings become evidence-backed assumptions (`A-n`). A source that can't be reached, an unverified finding or a verifier timeout becomes **one** question with a proposed default; it is not researched again.
- **Settled is final.** A settled issue is never asked again, in any wording; agents that raise it again only add a note. If the user says two different issues were folded into one (an alias in `factory clarify status`), ask them to run `factory clarify split U-n <alias>` in their own terminal; it is human-only.
- **Design's, not yours.** Implementation details are deferred to design (`## Deferred to design`) and never block H1. Don't ask the user about them.
- **Never improvise research or edits.** Don't fetch pages, don't edit the contract, don't answer for the user. If something looks wrong, add context with `factory clarify note <U-n|contract> "…"` and run `factory next`.

## The question protocol (the CLI enforces it)
- **Order**: intent → scope → constraint → acceptance. While any intent question is open, only intent questions are asked.
- **How many**: round 1 at most **5**, later rounds at most **3**; extra ones wait for the next round.
- **Form**: each question has an id (`Q-3`), the issue it is for (`U-n`), why it matters, options when possible, and the default the factory uses if it stays unanswered: evidence-backed (`E-n`) or the user's call.
- **Defaults**: a question the user skips takes its default next round; an intent question has none (the factory never guesses the why).
- **Progress, not rounds**: clarify parks when rounds stop settling anything (`limits.clarify_no_progress_rounds`) or at its ceiling (`limits.max_intent_rounds`). `resume` gives it more room.

## Round
1. Run the round with `factory run fanout-judge --config clarify`, as the start skill's *Running a workflow* says (once, in the foreground; it handles refusal codes).
2. This skill owns what a clarify result means. Act on the top-level `status` line and the fields after it, never on `workflow.status`:
   - `needs_user` with `questions`: show **one screen**, in this order, then **stop**:
     1. **What I found** — the `findings` lines (3–8): claim, source (file:line or URL), date, verdict and confidence. Only a `confirmed` finding (or `unchecked` repo evidence) is stated as fact; say "unverified" or "sources disagree" for the others.
     2. **What I'm assuming** — the `assumptions` lines: `A-n: statement (evidence: E-…)`. Tell the user once: reply `change A-n <value>` to override one, or `drop A-n` to remove it.
     3. **Questions** — as **one numbered list**, in the order given, each on one line: id, question, why it matters, options (if any), and the default: `(default: … — evidence E-n)` or `(default: … — your call)`. For a researchable question, add why research couldn't settle it (from `researchable, asked because: …`, e.g. "source unreachable: HTTP 404", "the verifier failed or ran out of time"). If `intent_first` is true, say in one line that other questions wait until the intent is settled. Questions marked `waiting` were asked before and still need an answer.
     Then say how to answer, once: a numbered reply (`1 yes, 2 …`), or `defaults` to accept every default. The reply hook records a numbered reply itself; `last_reply` in `factory next` confirms it.
     When the user answers in their own words instead, record each answer with `factory answer Q-n "<answer>"` (or `factory answer U-n "…"`; `factory answer Q-n --default` accepts the default). Never record an answer the user didn't give. If `factory answer --question "…"` says `no_match`, use the id it lists. Don't edit the contract: run `factory next` — clarify runs again with the answers and its contract editor writes them in.
   - Whatever the status, when the result carries `research_incomplete` (the intent mapper failed, the web was unavailable), say it first, as given: it names the items that rest on an agent's own knowledge.
   - `revise`: the contract still has problems or open items with nothing to ask; don't fix it by hand. Say in one line that clarify runs again, then `factory next`.
   - `retry`: agents failed in this round; it doesn't count and runs again once by itself. Say so in one line, then `factory next`.
   - `park`: clarify stopped (no progress, the intent is still unclear, or agents failed in two rounds in a row: the reason names them). Follow the park skill; `factory clarify status` shows what is open. When agents failed, the user chooses: `resume` to try again, or go on without that angle (after `resume`, run `factory run fanout-judge --config clarify --accept-degraded`).
   - `ok`: God Eye approved and confirmed the intent (`notes` are its approve-with-notes remarks). With `approved: false` and `god_eye_objects`, God Eye did **not** approve: say so and list its objections; H1 shows them for the user to approve over or deny. Tell the user its one-line restatement (problem → outcome), then return to the loop; `factory next` will present gate H1.
   - `warnings` (low risk): grounding advice that doesn't block; mention it in one line.

## Example screen
A `needs_user` round with one finding, one assumption and two questions:

> **What I found**
> - E-1 · `add` lives in `src/add.js` and subtracts (`src/add.js:1`, today, confirmed)
> - E-2 · ECMAScript `+` on two numbers is numeric addition (tc39.es/ecma262, 2026-10-14, unverified: HTTP 404)
>
> **What I'm assuming**
> - A-1: the fix belongs in `src/add.js` (evidence: E-1). Reply `change A-1 <value>` or `drop A-1` to override.
>
> **Questions** (research couldn't reach the spec, so your answer counts)
> 1. Q-2 · Should `add` also accept numeric strings? Why: callers in `src/cart/` pass form values. Options: yes / no. (default: no — your call)
> 2. Q-3 · Is `+` on two numbers numeric addition here? Why: research got HTTP 404 on the spec. (default: yes — research could not confirm it)
>
> Reply with the numbers (`1 no, 2 yes`) or `defaults`.
