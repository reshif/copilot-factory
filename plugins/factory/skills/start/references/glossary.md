# Factory glossary

Read this when a factory output or skill uses a term you don't know. Each term is defined here once; the skills use these meanings.

- **Job**: one request on its way to a merged change, with an id like `J-0003`. An **epic** is a job split into slice jobs, each with its own PR.
- **Recipe**: the fixed list of steps a job runs, picked from its work type and risk (for example `bug@low`, `standard@medium`). The user edits recipes; the factory never changes its own.
- **Floor**: a check that must hold before a step counts or the job ships (for example "evidence is current", "CI re-verified the merge"). `policy/floors.json` lists them; only the user can waive one (`waive <floor> <reason>`).
- **Contract**: `.factory/jobs/<job>/contract.md`, the outcome the job promises: Intent, Goal, acceptance criteria (`AC-n`), allowed paths and verify commands. Approved at gate H1.
- **Gate**: a stop where only the user's reply moves the job on (`approve` / `deny <what must change>`). Each approval is bound to the **hash** of the documents shown; if they change, the gate comes back.
- **God Eye**: the factory's independent critic agent. It reads the contract, design or plan cold, as someone who has never seen the conversation, and returns `approve` or `revise`.
- **Workflow**: a fixed fan-out of agents (`ground`, `fanout-judge`, `decompose`, `realize`, `reconcile`) that `factory run <workflow>` starts, one `copilot -p` process per agent.
- **Brief**: the instructions `factory run` builds for each agent of a workflow. You never write one.
- **Envelope**: the JSON result a workflow returns, which `factory run` passes to `factory record` to be checked and sealed. You never write one.
- **Seal**: a signature on every factory record; a record changed by hand fails its seal and is refused.
- **Park**: the factory stopping a job instead of guessing (a cap, a budget, no progress). Only the user's reply (`resume`, `cancel job`, `abandon job`) moves it.
- **Clarify ledger**: the one list of clarify's issues (`U-n`), kept by the CLI in the job's `intent-evidence.json`. Each has a subject, an owner (research, the user, or design), a status (open, researching, proposed, settled, deferred to design, dropped) and how it was settled. `factory clarify status` prints it. Settled is final: an agent that raises it again only adds a note.
- **Deferred to design**: an implementation detail (exact field names, line ranges, command syntax, parser behaviour) clarify hands to ground and decide instead of asking; it never blocks H1.
- **Evidence-backed assumption** (`A-n`): a fact research confirmed, with evidence ids (`E-n`), stated in the contract instead of asked. The user overrides one with `change A-n <value>` or `drop A-n`.
- **Lesson** (`L-n`): a scoped rule distilled from a merged job; it applies to later jobs only after the user replies `accept lesson Ln`.
