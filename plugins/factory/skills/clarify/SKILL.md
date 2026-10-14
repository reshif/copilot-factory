---
name: clarify
description: Factory clarify — draft the outcome contract intent first, run the clarify fan-out (intent gate, then three analysts, a judge, then God Eye), ask the user only what the repo can't answer, in a fixed order and budget, and loop until God Eye approves. Used by factory:start when `factory next` returns skill clarify.
user-invocable: false
---
# Clarify: write the outcome contract

The contract lives at `.factory/jobs/<job>/contract.md` (`factory job show` prints the job; the path is in the job folder). It has fixed sections the CLI parses: **Intent, Goal, Non-goals, Acceptance criteria, Constraints, Allowed paths, Verify commands, Assumptions**.

## Draft (first round)
Write the **Intent** first, then the rest. If the intent isn't clear, nothing below it makes sense.
- **Intent**, one line each: `Problem` (what is wrong or missing today), `Who` (who has it, who asked), `Outcome` (what is true for them when done), `Why now` (optional), `Success signal` (how we'd know it worked, observably). Use the user's words and the intake restatement they confirmed.
- **Goal**: the outcome in one or two sentences — what is true when done, not how. It must agree with the Intent.
- **Acceptance criteria**: one per line, `- AC-1: <observable behaviour> (evidence: test)`. Evidence types: `test`, `run` (a command whose success proves it), `diff`, `doc`, `human` (the user confirms it). Prefer `test`. Epics use `E-AC-1`.
- **Allowed paths**: globs the change may touch, as narrow as you can (`src/cart/**`, `tests/cart/**`).
- **Verify commands**: commands from the repo root that exit non-zero on failure, with the ACs they prove: ``- `npm test -- cart` (AC-1, AC-2)``.
- Non-goals, constraints and assumptions from the request and what you read in the repo.
Answer everything the repo can answer yourself. Then run `factory contract check` and fix every problem it lists (an Intent line still `<…>` is a problem). (For the `bug@low` recipe, also `factory contract check --plan-fields`: it builds straight from the contract, so allowed paths and verify commands are required.)

## The question protocol (the CLI enforces it)
- **Order**: intent → scope → constraint → acceptance. The intent analyst runs first and alone; while any intent question is open, only intent questions are asked and the other angles wait.
- **How many**: round 1 at most **5**, later rounds at most **3**, the last round (`max_intent_rounds`, default 4) none — what's left becomes an Assumption. At most 11 questions per job; the CLI caps rounds and parks a contract that isn't converging.
- **Form**: each question has an id (`Q-3`), a category, why it matters, options when possible, and the default the factory uses if it stays unanswered.
- **Never re-asked**: every asked question and every recorded answer is passed to the analysts and judge, and the CLI drops repeats.
- **Intent never defaults**: still unclear after 2 rounds of intent questions, the job parks for you instead of guessing. `resume` gives one more intent round.

## Round
1. Run the clarify fan-out as described in factory:start section 3:
   `factory wfargs fanout-judge --config clarify` → Workflow `factory:fanout-judge` → write the envelope → `factory record --file .factory/scratch/envelope.json`.
2. Read the result:
   - `needs_user` with `questions`: ask them as **one numbered list**, in the order given, each on one line: id, question, options (if any) and `(default: …)`. If `intent_first` is true, say in one line that other questions wait until the intent is settled. **Stop.** When they answer: record each with `factory answer --id Q-n --answer "…"`; for any they skip, write the default under Assumptions; update the contract (only the contract), run `factory contract check`, and run `factory next` again — it routes back here for the next round.
   - `needs_user` with `critique`: God Eye asked for revisions, or could not confirm the intent (compare its `restatement` with your Intent section). Fix what you can from the repo; ask the user only what you can't (intent: one question); then `factory next`.
   - `needs_user` with `problems`: fix the contract, then `factory next`.
   - `degraded`: an analyst failed twice — ask: re-run, or go on without that angle. To go on, add the missing angle under Assumptions and run the round again with `factory wfargs fanout-judge --config clarify --accept-degraded`.
   - `ok`: God Eye approved and confirmed the intent. Tell the user its one-line restatement (problem → outcome), then return to the loop; `factory next` will present gate H1.
