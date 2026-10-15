---
name: inspect
description: "Audits the Software Factory: whether jobs followed their declared rules, and the factory's own health, and walks the user through open findings. Use when the user types /factory-inspector:inspect or asks if the factory is behaving. Not for reviewing code."
argument-hint: "[job id | all | active | health | status]"
---
# Inspect the factory

The inspector is an independent auditor. It reads the factory's sealed records and each job's **declared rulebook** (`recipe.lock.json`: the recipe, floors and selection rules the job promised to follow) and checks what happened against it. It never blocks, approves or changes anything.

## Run
Run it as `factory-inspect …`. If it is not found, use the `[inspector] Inspector CLI:` command the inspector gave you at session start (it looks like `node "<plugin root>/bin/factory-inspect"`). Only if you have no such note, find the plugin's folder with `copilot plugin list --json`: for `"source": "installed"` it is `~/.copilot/installed-plugins/copilot-factory/factory-inspector/` (with `COPILOT_HOME` set, that folder replaces `~/.copilot`); for `"source": "live"` (a marketplace added from a local folder) it is `<installedFrom>/plugins/factory-inspector/`. Tell the user once that `factory shim` in their own terminal puts `factory-inspect` on their PATH.

The argument is the text the user typed after the command:
- No argument after the command → `factory-inspect run` (closed jobs not yet inspected).
- A job id → `factory-inspect run --job <id>`; also show `factory-inspect trace --job <id>` if the user wants the timeline.
- `all` → `factory-inspect run --all`.
- `active` → `factory-inspect run --active` (closed jobs not yet inspected, plus every active or parked job as it stands now). Use it when the user asks how a running job is going, or reports trouble mid-job.
- `health` → `factory-inspect health --format md` only.
- `status` → `factory-inspect status` only (modes, clean streaks, suggestions).

Then show `factory-inspect report --format md` (open findings, then a **Factory health** section).

## Explain the findings
Group them by class, highest severity first, in plain words:
- **deviation** — the factory did something its declared rulebook doesn't allow (wrong recipe, skipped step, approval for a document that wasn't presented, review on an unproven build, the agent doing something other than what `factory next` said, records written outside the CLI).
- **ambiguity** — the rules left room and someone improvised (same situation routed differently, caps you keep resuming past, guard denials agents keep hitting, the same step repeating).
- **gap** — something the audit needs is missing or broken (no rulebook snapshot, a recipe edited without a version bump, a hook that failed and so enforced nothing, torn log lines, a CLI crash, agents that never stopped, a job left idle).

For health findings (hook errors, guard denials, refused replies, CLI failures, stale or degraded steps, agent failures, parks), intent parks and grounded-intent findings, read [references/rules.md](references/rules.md) first: it says how to read each and what to tell the user.

For each, give the evidence (decision ids, job) and the inspector's question. Say what you think the likely cause is when the records support it, and what would fix it (a skill wording, a recipe version bump, a cap change) — but **don't change recipes, floors, policy or skills**; those are the user's.

## The user decides
They reply, and the inspector's hook applies it:
- `ack finding F3` — seen, being dealt with
- `fixed finding F3` — fixed; if it's seen again it reopens automatically
- `wontfix finding F3 <why>` — accepted as is
- `inspect mode <recipe|all> on|off|sample <N>` — how often to inspect

Thresholds (`limits`) and switched-off rules (`rules_off`) are the user's to edit in `.factory/inspect/config.json`; suggest a change, don't make it.

Never run `factory-inspect mark` or `factory-inspect mode` yourself (they're human-only, and blocked).

## Settling down
`factory-inspect status` lists recipes with long clean streaks and suggests sampling (e.g. 1 in 10) and later off. Mention a suggestion once; the user chooses. If a recipe's rules change (recipe, floors, selection, or the factory's skills/agents/workflows), the inspector re-arms itself and inspects every job of that recipe again. To turn the inspector off entirely, the user disables the `factory-inspector` plugin; the factory keeps logging, so they can inspect past jobs later.
