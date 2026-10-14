---
name: clarify
description: "Factory clarify — draft the outcome contract intent first, run the clarify fan-out (scout phase that researches the repo and the web first, then the intent gate, three analysts, a judge and God Eye), show what research found and what the factory assumes, ask the user only what research can't answer, in a fixed order and budget, and loop until God Eye approves. Used by the start skill when `factory next` returns skill clarify."
user-invocable: false
---
# Clarify: write the outcome contract

The contract lives at `.factory/jobs/<job>/contract.md` (`factory job show` prints the job; the path is in the job folder). It has fixed sections the CLI parses: **Intent, Goal, Non-goals, Acceptance criteria, Constraints, Allowed paths, Verify commands, Assumptions (evidence-backed), Assumptions**. The CLI writes **Assumptions (evidence-backed)** from the research (`- A-1: <statement> (evidence: E-1, E-2)`); never edit that section yourself — the user changes it with a reply.

## Draft (first round)
Write the **Intent** first, then the rest. If the intent isn't clear, nothing below it makes sense.
- **Intent**, one line each: `Problem` (what is wrong or missing today), `Who` (who has it, who asked), `Outcome` (what is true for them when done), `Why now` (optional), `Success signal` (how we'd know it worked, observably). Use the user's words and the intake restatement they confirmed.
- **Goal**: the outcome in one or two sentences — what is true when done, not how. It must agree with the Intent.
- **Acceptance criteria**: one per line, `- AC-1: <observable behaviour> (evidence: test)`. Evidence types: `test`, `run` (a command whose success proves it), `diff`, `doc`, `human` (the user confirms it). Prefer `test`. Epics use `E-AC-1`.
- **Allowed paths**: globs the change may touch, as narrow as you can (`src/cart/**`, `tests/cart/**`).
- **Verify commands**: commands from the repo root that exit non-zero on failure, with the ACs they prove: ``- `npm test -- cart` (AC-1, AC-2)``.
- Non-goals, constraints and assumptions from the request and what you read in the repo.
Answer everything the repo can answer yourself. Don't state facts about the outside world (library behaviour, vendor limits, standards) from memory: the scout phase researches them with a source and a quote. In Intent and Constraints, cite an `E-n` only when `factory intent show` lists it as confirmed (repo evidence may be unchecked); a world claim with no confirmed evidence stays an open question. Then run `factory contract check` and fix every problem it lists (an Intent line still `<…>` is a problem). (For the `bug@low` recipe, also `factory contract check --plan-fields`: it builds straight from the contract, so allowed paths and verify commands are required.)

## Research first (the scout phase)
Every clarify run starts with research, inside the same `factory run`: the intent mapper lists the unknowns (kind `repo`, `world`, `decision` or `user`; impact high/medium/low), repo scouts answer repo unknowns with file:line quotes, web scouts answer world unknowns from primary sources (the versions the repo actually uses), and a verifier re-opens high-impact and web findings (`confirmed`, `contradicted` or `unverified`). Confirmed findings become evidence-backed assumptions (A-n), stated, not asked. Only user calls, decisions, and what research could not settle become questions. Low-impact unknowns are assumed without research and listed. Budgets depend on the risk (`intent_research` in the policy). `factory intent show` prints all of it (read-only); `intent-findings.md` in the job folder is the readable version.

## The question protocol (the CLI enforces it)
- **Order**: intent → scope → constraint → acceptance. The intent analyst runs first and alone; while any intent question is open, only intent questions are asked and the other angles wait.
- **How many**: round 1 at most **5**, later rounds at most **3**, the last round (`max_intent_rounds`, default 4) none — what's left becomes an Assumption. At most 11 questions per job; the CLI caps rounds and parks a contract that isn't converging.
- **Form**: each question has an id (`Q-3`), a category, why it matters, options when possible, and the default the factory uses if it stays unanswered. The default cites evidence (`evidence: E-n`) or is marked as the user's call — never a guess dressed as a fact.
- **Not researchable**: a question research can answer is not asked (the CLI drops it and states the assumption instead). A repo or world question is asked only when research could not settle it, and the summary says why (`researchable, asked because: …`).
- **Never re-asked**: every asked question and every recorded answer is passed to the analysts and judge, and the CLI drops repeats.
- **Intent never defaults**: still unclear after 2 rounds of intent questions, the job parks for you instead of guessing. `resume` gives one more intent round.

## Round
1. Run the clarify fan-out with `factory run fanout-judge --config clarify` (the start skill, section 3: run it once, wait for it, never start a second one, and handle a refusal `code` as that section says). It runs the analysts, the judge and God Eye as separate Copilot agents, records the result and prints it. Never write the envelope yourself.
2. Act on the `status` line (top-level `status` = the recorded result) and the fields after it (questions, critique, problems, restatement, message) — never on `workflow.status`, which is only the workflow's own summary. The workflow can finish `ok` while the record still needs you (for example God Eye approved but the contract has problems):
   - `needs_user` with `questions`: show **one screen**, in this order, then **stop**:
     1. **What I found** — the `findings` lines (3–8): claim, source (file:line or URL), date, verdict and confidence. Only a `confirmed` finding (or `unchecked` repo evidence, quoted from the file) is stated as fact; say "unverified" or "sources disagree" for the others, never present them as true.
     2. **What I'm assuming** — the `assumptions` lines: `A-n: statement (evidence: E-…)`. Tell the user once: reply `change A-n <value>` to override one, or `drop A-n` to remove it.
     3. **Questions** — as **one numbered list**, in the order given (at most 5), each on one line: id, question, why it matters, options (if any), and the default: `(default: … — evidence E-n)` or `(default: … — your call)`. For a researchable question, add the reason it is still asked (from `researchable, asked because: …`), e.g. "not researched (web off)", "no web access", "sources disagree: E-3 contradicted". Say it plainly: research was off or could not reach the web, so it is the user's answer that counts. If `intent_first` is true, say in one line that other questions wait until the intent is settled.
     If `research:` shows `degraded` or `web unavailable`, say so in one line. Mention `intent_findings` (the file) for the full evidence. When they answer: record each with `factory answer --id Q-n --answer "…"`; for any they skip, write the default under Assumptions; update the contract (only the contract), run `factory contract check`, and run `factory next` again — it routes back here for the next round. A `change A-n …` or `drop A-n` reply is applied by the reply hook (it rewrites the evidence-backed section); don't edit it, just run `factory next` — clarify runs again with the change.
   - `needs_user` whose message says God Eye found questions research can answer: don't ask the user anything. Tell them in one line that those questions go back to the scouts, and run `factory next` (clarify runs again and researches them first).
   - `needs_user` with `critique`: God Eye asked for revisions, or could not confirm the intent (compare its `restatement` with your Intent section). Fix what you can from the repo; ask the user only what you can't (intent: one question); then `factory next`.
   - `needs_user` with `problems`: fix the contract, then `factory next`.
   - `degraded` (shown only as the top-level status): an analyst failed twice — ask: re-run, or go on without that angle. To go on, add the missing angle under Assumptions and run the round again with `factory run fanout-judge --config clarify --accept-degraded`.
   - `ok`: God Eye approved and confirmed the intent. Tell the user its one-line restatement (problem → outcome), then return to the loop; `factory next` will present gate H1 (the gate shows the findings and assumptions with the contract).
   - `warnings` (low risk): grounding advice that doesn't block; mention it in one line.
