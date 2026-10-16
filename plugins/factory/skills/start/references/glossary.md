# Factory glossary

Read this when a factory output or skill uses a term you don't know. Each term is defined here once; the skills use these meanings.

- **Job**: one request on its way to a merged change, with an id like `J-0003`. An **epic** is a job split into slice jobs, each with its own PR.
- **Recipe**: the fixed list of steps a job runs, picked from its work type and risk (for example `bug@low`, `standard@medium`). The user edits recipes; the factory never changes its own.
- **Floor**: a check that must hold before a step counts or the job ships (for example "evidence is current", "CI re-verified the merge"). `policy/floors.json` lists them; only the user can waive one (`waive <floor> <reason>`).
- **Contract**: `.factory/jobs/<job>/contract.md`, the outcome the job promises: Intent, Goal, acceptance criteria (`AC-n`), allowed paths and verify commands. Approved at gate H1.
- **Gate**: a stop where only the user's reply moves the job on (`approve` / `deny <what must change>`). Each approval is bound to the **hash** of the documents shown; if they change, the gate comes back.
- **God Eye**: the factory's independent critic agent. It reads the contract, design or plan cold, as someone who has never seen the conversation, and returns `approve` or `revise`.
- **Dependency source** (`.factory/deps/<job>/`): the pinned versions of the packages a job relies on, downloaded by `factory deps fetch` without running them and unpacked read-only, so researchers and critics read the library instead of remembering it. A download that fails is a **gap**, shown to the agents and at the design gate; it never stops the job.
- **API ledger** (`api-ledger.json`, entries `L-n`): facts quoted from the dependency source (symbol, file:line, the exact text, the version), each checked by the CLI against the file. The ADR's "External API usage" table cites them.
- **API-conformance critic**: the design critic beside God Eye that checks every external call the design makes against the dependency source; every serious finding cites a file:line or a probe's output, and a finding verifier checks it before it costs a revise.
- **Plan probe** (`factory plan probe`): the CLI lints every verify command and dry-runs it in a scratch worktree inside the build environment the plan proposes, before anyone approves the plan.
- **Combined gate**: at medium risk, H3 approves the design, the plan and the build environment in one reply; approving it also confirms that environment.
- **Workflow**: a fixed fan-out of agents (`clarify`, `ground`, `fanout-judge`, `decompose`, `realize`, `reconcile`) that `factory run <workflow>` starts, one `copilot -p` process per agent.
- **Brief**: the instructions `factory run` builds for each agent of a workflow. You never write one.
- **Envelope**: the JSON result a workflow returns, which `factory run` passes to `factory record` to be checked and sealed. You never write one.
- **Seal**: a signature on every factory record; a record changed by hand fails its seal and is refused.
- **Park**: the factory stopping a job instead of guessing (a cap, a budget, no progress). Only the user's reply (`resume`, `cancel job`, `abandon job`) moves it.
- **Clarify ledger**: clarify v3's record of items (`I-n`), kept by the CLI in the job's sealed `clarify.json`. Each item has a kind (intent, scope, fact, decision, instruction, version pin), a status, a source (the user's words `W-n`, a finding `E-n`, a sheet answer) and a strength: **you** > **evidence** > **accepted** (you took the recommendation) > **assumption**. The user can always reopen an item; an agent overturns one only with stronger evidence, and a conflict with the user's own words goes on the sheet. `factory clarify status` prints it.
- **Read-back**: clarify's first screen: what the factory understood (intent, scope), the user's facts quoted, the versions research will use (from a repo file or the user's own words) and the research plan. The user replies ok or says what to change.
- **Decision sheet**: one screen with at most five decisions (options, evidence, a recommendation) and the facts clarify will assume. One reply answers it, in plain words or structured (`ok, but 2 b`).
- **Design may choose**: an implementation detail clarify hands to ground and decide instead of asking; it never blocks H1.
- **Research gap**: something research could not settle (no source for the confirmed version, the web down, a timeout). It is listed on the sheet, in the contract's `## Research gaps` and at H1; never hidden.
- **Redirect**: the user's change of direction (a denial at H1, or `factory clarify redirect`), read back as tracked items and reported done or not done at the next H1.
- **Lesson** (`L-n`): a scoped rule distilled from a merged job; it applies to later jobs only after the user replies `accept lesson Ln`.
- **Project brief** (`.factory/project.md`): the repository's shared memory across jobs (conventions, module map, test and lint commands, environment, earlier ADRs, accepted lessons). Every agent brief carries it; the user may edit it; distill proposes edits (P<n>) that apply only when the user replies `accept brief Pn`. Never edit it yourself.
