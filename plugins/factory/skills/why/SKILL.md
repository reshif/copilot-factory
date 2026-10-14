---
name: why
description: Show why a factory job took the path it did — every routing decision, the rule behind it, and the first failing check. Use when the user types /factory:why or asks why the factory did something.
argument-hint: "[job id, e.g. J-0003 — defaults to the current job]"
---
# Why did the factory do that?

Run `factory why --format md` (add `--job $ARGUMENTS` if a job id was given) and show the table.

Then answer the user's actual question in two or three sentences, pointing at the rows that matter: the rule (e.g. `row4.confirmed_serious` = a confirmed blocker/major finding opened a fix round; `row3.floor_missing` = a required step was missing; `cap.*` = a limit parked the job; `order.next_step` = the recipe's next step) and the first failing alignment check.
