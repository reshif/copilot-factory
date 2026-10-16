---
name: intake
description: "Turns a new factory request into a job with a confirmed one-line intent, work type and risk. Use when the start skill has a new request and no active job for it. Not for continuing an existing job."
user-invocable: false
---
# Intake

1. **Read the repo quickly**: top-level layout, README, the files the request clearly touches, their tests, CODEOWNERS, CI config. Don't over-read.
2. **Classify the work type**: feature · bug · hotfix · refactor · migration · dependency · docs · spike · greenfield.
3. **Propose a risk** (low / medium / high) with one-line reasons. Raise it for: security/auth/payments/data, public APIs, migrations, broad blast radius, weak tests. Policy floors hotfix and migration at high — the CLI will raise them anyway.
4. **Job or epic?** It's an epic if any of these hold: more than one PR, more than one subsystem, a migration plus its consumers, a public API plus its callers, a staged rollout, or more than ~3 days of work.
5. **Restate the intent in one line**: who has what problem, and what is true for them when it's done — in the user's terms, not the code's. E.g. "Shoppers with a discount code see the wrong cart total; after this the total matches the checkout price."
6. **Ask one question** confirming the restatement and all three choices, e.g.:
   > So: **shoppers with a discount code see the wrong cart total; after this it matches checkout.** I'd run it as a **bug** fix at **low** risk, as a single job (it touches only `src/cart/`). Right, or correct any of those?
   Stop and wait. If the user corrects the intent, restate once more in the same one-question form; if it still isn't clear, create the job anyway and leave the unclear Intent lines as placeholders — clarify asks about them first.
7. On confirmation run:
   `factory job new --title "<short title>" --type <type> --risk <risk> --request "<the user's request, word for word>" [--epic]`
   `--request` keeps the user's own words: clarify's read-back quotes them, and version pins may come only from them or from a repo file. Tell the user the job id and the recipe the CLI chose (one line). If `risk_raised_by_policy` is true, say so. Write the confirmed restatement into the contract's **Intent** section (Problem, Who, Outcome) straight away.
   Write only what the user said and what you read in the repo: facts about libraries, vendors or standards are researched by clarify, with sources, for the versions the user confirms.
8. Return to the start skill loop (`factory drive`).
