# Copilot Factory: the Software Factory for the GitHub Copilot CLI

Turns a request into a verified, merged change. Copilot does the work through specialist custom agents, but **a CLI decides every next step by fixed rules**, every result is **checked and sealed** before it counts, evidence is **bound to the exact build**, and **you approve** the contract, the design, the plan and the merge. A second plugin, the **inspector**, audits all of it from the outside.

This is a port of [claude-factory](https://github.com/reshif/claude-factory) (the Claude Code plugin "Software Factory") to the GitHub Copilot CLI. The CLI core is the same: router, floors, record, seals, ledger, recipes, policy, worktrees, verify, ship, document templates and console. What changed is the shell around it: Copilot skills and custom agents, Copilot-format hooks, and a `factory run` command that runs the workflows by starting one `copilot -p` process per agent, because Copilot has no Workflow tool. The full component mapping is in [`docs/COPILOT.md`](docs/COPILOT.md); the design decisions are in [`docs/DESIGN-COPILOT.md`](docs/DESIGN-COPILOT.md).

| Plugin | Version | What it is |
|---|---|---|
| `factory` | 0.1.2 | The orchestrator: skills, hooks, the `factory` CLI with `factory run`, workflows, 19 custom agents, recipes, templates and the console |
| `factory-inspector` | 0.1.1 | An independent auditor: checks each job against the rulebook it declared and the factory's health (rules R1–R19) |

The version line started again at 0.1.0 for Copilot. It is separate from claude-factory's (0.10.0 / 0.2.0 at the time of the port).

## How it fits together

```mermaid
---
config:
  flowchart:
    curve: linear
    nodeSpacing: 36
    rankSpacing: 46
    wrappingWidth: 520
---
flowchart TB
  you(["<b>You</b> · /factory:start &lt;request&gt; in the Copilot CLI · then reply approve · deny · resume · merged"]):::human

  skills["<b>Skills</b> · Copilot follows them<br/>start drives the loop · intake · clarify · gate · ship · distill"]
  hooks["<b>Hooks</b> · run by the Copilot CLI<br/>reply hook applies your replies · guard · stop gate · activity log"]

  router["<b>factory next</b> · the CLI picks the next step, never an LLM<br/>checks in order: contract approved · no drift · floors so far ·<br/>no confirmed serious finding · criteria proven · evidence current<br/>the first failing check routes the job, otherwise the recipe's next step"]:::cli

  subgraph line[" "]
    direction LR
    s1["<b>Contract</b><br/>clarify<br/>intent first<br/>gate H1"]
    s2["<b>Design</b><br/>ground · decide<br/>ADR + Mermaid<br/>gate H2"]
    s3["<b>Plan</b><br/>decompose<br/>task waves<br/>gate H3"]
    s4["<b>Build</b><br/>realize<br/>reconcile<br/>worktree per task"]
    s5["<b>Verify</b><br/>prove<br/>challenge<br/>on the exact build"]
    s6["<b>Ship</b><br/>report · PR<br/>gate H4<br/>you merge"]
    s7["<b>Learn</b><br/>distill<br/>close"]
    s1 --> s2 --> s3 --> s4 --> s5 --> s6 --> s7
  end

  run["<b>factory run &lt;workflow&gt;</b> · ground · fanout-judge · decompose · realize · reconcile<br/>one copilot -p --agent factory:&lt;role&gt; process per agent, bounded in parallel<br/>analysts · architect · planner · builders · testers · reviewers · JSON checked against its schema"]

  record["<b>factory record</b><br/>validates the result · rejects stale ones · checks docs against templates<br/>seals it into the ledger · then back to factory next"]:::cli

  store[/"<b>.factory/</b> in your repo · contract · ADRs · plan · ledger · decisions · events · lessons"/]:::art

  console["<b>Console</b><br/>factory console --serve<br/>live board · wire · line map · story"]
  inspector["<b>Inspector</b><br/>plugin factory-inspector<br/>rules R1–R19 · runs when a job ends"]

  you --> skills
  you --> hooks
  skills --> router
  hooks --> router
  router -->|"runs the job line · the recipe for work type + risk picks the steps"| line
  line --> run
  run --> record
  record --> store
  store --> console
  store --> inspector

  classDef human fill:#fff3bf,stroke:#f08c00,color:#000
  classDef cli fill:#e7f5ff,stroke:#1c7ed6,color:#000
  classDef art fill:#f1f3f5,stroke:#868e96,color:#000
  style line fill:#f8f9fa,stroke:#adb5bd
```

**The one rule that holds it together:** agents *propose*, the CLI *decides*. Copilot never chooses the next step. The `start` skill runs `factory next` and does exactly what it returns: a skill, a gate, a CLI command, or a workflow. A workflow always goes through `factory run <workflow>`, which starts the agents, checks their JSON, records the result and prints it. Then the skill asks `factory next` again. The skill never writes a brief or an envelope and never fans work out itself. Hooks enforce the parts Copilot could get wrong: your replies are applied by the CLI before the model acts on them, the guard blocks edits to protected files, and the stop gate sends Copilot back to work while the job has steps left and nothing is waiting on you.

## Install

Requirements:
- GitHub Copilot CLI, with a Copilot plan. Use 1.0.81 or later, because installed-plugin agents only load in `copilot -p` from that version. 1.0.97 or later is recommended for the hook fixes.
- Node 18 or later, and git.
- Optional: the GitHub CLI (`gh`), logged in, for automatic PRs.

```bash
copilot plugin marketplace add reshif/copilot-factory
copilot plugin install factory@copilot-factory
copilot plugin install factory-inspector@copilot-factory   # optional, recommended
```

Run `/plugin` (or `copilot plugin list`) to check that both are listed with the versions above. The docs say plugin agents and skills are available as soon as they are installed. If they don't show up, restart the CLI (`/restart`).

**Put `factory` and `factory-inspect` on your PATH.** Copilot does not put a plugin's `bin/` on the PATH. Inside a session, each plugin's session-start hook gives Copilot the absolute command (`node "<plugin root>/bin/factory"`, `node "<plugin root>/bin/factory-inspect"`), so the skills work without it. For your own terminal (`factory console --serve`, `factory-inspect report`, and the human-only commands), run this once:

```bash
node "${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/copilot-factory/factory/bin/factory" shim
```

**Where the plugins live.** That path is right for the install above, from GitHub: Copilot copies each plugin to `installed-plugins/copilot-factory/<plugin>/` under `~/.copilot`, or under `COPILOT_HOME` when that is set. A marketplace added from a local folder (`copilot plugin marketplace add <your clone>`) is different: Copilot loads it live from that folder and copies nothing, so use `node <your clone>/plugins/factory/bin/factory shim` instead. To see which case you have, run `copilot plugin list --json`. `"source": "installed"` means the copied folder; `"source": "live"` means the plugin runs from `<installedFrom>/plugins/<plugin>/`.

`factory shim` links both commands into `~/.local/bin` (`--dir <folder>` for another place; `--force` replaces old links, e.g. from claude-factory). The inspector link needs the `factory-inspector` plugin installed. If `~/.local/bin` is not on your PATH yet, add it and open a new terminal:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc    # or ~/.zshrc
```

Or link them by hand (for a local-folder install, set `P=<your clone>/plugins` instead):

```bash
P="${COPILOT_HOME:-$HOME/.copilot}/installed-plugins/copilot-factory"
mkdir -p ~/.local/bin
ln -sf "$P/factory/bin/factory" ~/.local/bin/factory
ln -sf "$P/factory-inspector/bin/factory-inspect" ~/.local/bin/factory-inspect
```

Check: `factory help | head -1` and `factory-inspect help | head -1` each print a line, and `readlink -f "$(command -v factory-inspect)"` points into the plugin folder.

**First run in a folder.** `/factory:start` (the first time, via `factory init`) sets up the folder. If the folder has no git history yet, it runs `git init` if needed and makes a first commit of the folder's files, leaving anything that looks like a secret untracked. It also keeps `.factory/` out of git and adds a commit-msg hook. It refuses your home folder itself, so open Copilot in a project folder. If git doesn't know your name and email yet, it tells you the two `git config --global` commands to run first.

**Trust the repository.** When the Copilot CLI asks whether to trust the folder, say yes. Hooks, skills and agents need it.

**Never use Autopilot with the factory.** Autopilot answers questions and permission prompts by itself, and every gate here is yours. It can't approve a gate (only your own typed reply does), but it pushes the agent on past the points where the factory waits for you. Run the factory in an interactive session. The cloud agent is out of scope: it is non-interactive and turns "ask" into "deny".

### Update

```bash
copilot plugin marketplace update copilot-factory
copilot plugin update factory
copilot plugin update factory-inspector
```

`copilot plugin update --all` updates everything. In a session, `/plugin` shows when an update is available.

### Check what you have installed

```bash
copilot plugin list --json                                  # name, marketplace, version, enabled, source (installed / live + installedFrom)
ls ~/.copilot/installed-plugins/copilot-factory/            # the installed copies: factory/, factory-inspector/ (GitHub installs only)
ls ~/.cache/copilot/marketplaces/                           # marketplace cache (macOS: ~/Library/Caches/copilot/marketplaces/)
readlink -f "$(command -v factory)"                         # the factory on your PATH (after factory shim)
```

`COPILOT_HOME` moves `~/.copilot`, and the marketplace cache moves under it too (`$COPILOT_HOME/.cache/copilot/marketplaces/`). `COPILOT_CACHE_HOME` moves the cache on its own. Install metadata, including each installed plugin's folder (`installedPlugins[].cache_path`), is in `~/.copilot/config.json`. A marketplace added from a local folder is loaded live from that folder, so it has no copy under `installed-plugins/`.

## Use

In any project folder (the first run makes it a git repository and commits its files if needed), inside the Copilot CLI:

| You type | What happens |
|---|---|
| `/factory:start <what you want>` | Intake: Copilot reads the repo, restates your intent in one line, proposes work type, risk and job-vs-epic, and asks you **one** question to confirm all of it. The CLI creates the job and picks the recipe; then the loop runs until it needs you. |
| `/factory:start` | Continue the current job. |
| `/factory:why [job]` | Every routing decision for the job and the rule behind it. |
| `/factory:console [job]` | The console (below). |
| `/factory:review` | Monthly 30-minute telemetry review. (Copilot's built-in `/review` is its own code reviewer, a different command.) |
| `/factory-inspector:inspect [job\|all\|active\|status\|health]` | Run the inspector and walk through its findings. |

Copilot lists plugin skills under the plugin's name: `/factory:start`, `/factory:why`, `/factory:console`, `/factory:review` and `/factory-inspector:inspect` (verified on CLI 1.0.95, and on 1.0.97 against a mock model). The other seven skills (intake, clarify, gate, ship, distill, amend, park) are steps the start skill runs for you, so they are hidden from the menu, as in claude-factory. A project or personal skill with the same name as one of these hides the factory's (see [Troubleshooting](#troubleshooting)).

The first run initialises the repo (`factory init`): a `.factory/` folder kept out of git via `.git/info/exclude`, and a `commit-msg` hook that adds `Factory-Job` / `Factory-Task` trailers on factory branches. Each job gets a branch `factory/J-0001` and each task its own git worktree under `.factory/worktrees/`.

### Your replies

The reply hook (`userPromptSubmitted`) applies these through the CLI **as soon as you send them**. Nothing else counts as approval. Case and trailing punctuation or emoji don't matter (`Approve!`, `approve 👍`), but the reply must be the whole message. Something that only looks like a reply (`aprove`, `approve the plan please`) is **not applied**.

The hook also writes the outcome to `.factory/last-reply.json`. The next `factory next` shows it as `last_reply`, and the `start` skill tells you in one line whether your reply was applied, and why not if it wasn't. (On CLI 1.0.97 the prompt hook's added text does reach the model, but Copilot's docs say it is dropped, so the factory doesn't depend on it.) Add a job id to target one job: `approve J-0007`.

| Reply | Effect |
|---|---|
| `approve` | Approve the waiting gate. Bound to the document's hash: if it changed since you saw it, the approval is refused. |
| `deny <what must change>` | Send it back with your reason. |
| `resume` | Un-park; the cap that stopped it gets one more round. |
| `cancel job` · `abandon job` | Stop for good; files are kept. |
| `merged <commit>` | Record a local merge (when there's no GitHub PR). |
| `confirm AC-3` | Confirm a criterion whose evidence type is `human`. |
| `waive ci_reverify <reason>` · `waive ship_size <reason>` | The only waivable floors. |
| `accept lesson L4` · `reject lesson L4 <why>` | Decide on a proposed lesson. |
| `ack finding F3` · `fixed finding F3` · `wontfix finding F3 <why>` | Settle an inspector finding. |
| `inspect mode <recipe\|all> on\|off\|sample <N>` | How often the inspector runs. |

From your own terminal you can run the human-only commands directly: `factory approve`, `factory resume`, `factory reseal`, `factory-inspect mark …`. Agents are blocked from running them.

### Gates you may see

| Gate | When |
|---|---|
| **H1** contract | Every job |
| **H2** design | Medium risk when there is an ADR; always at high risk |
| **H3** plan | Medium and high; at low risk (`feature@low`) God Eye's plan critique can approve it for you |
| **HS** ship sign-off | High risk, before shipping |
| **H4** merge | Every change: you merge |
| **HF** spike findings · **EH1–EH3** epic contract, architecture, slices · **A** amendment · **P** parked | As they come up |

### Questions you may get (clarify)

The contract starts with an **Intent** section: problem, who, outcome, why now, success signal. An intent analyst reads it first, alone. Until the intent is settled you get **only intent questions**; then scope, constraint and acceptance questions follow, in that order. **At most 5 questions in round 1 and 3 in later rounds**, as one numbered list. Each has an id (`Q-3`), why it matters, the default the factory will use if you skip it, and options where possible. Nothing is asked twice. If the intent is still unclear after two rounds the job **parks rather than guessing**; reply `resume` for one more round. God Eye must restate and confirm the intent before H1.

## How a job runs

**Recipes.** The CLI picks one by rule from work type and risk ([`recipes/_selection.json`](plugins/factory/recipes/_selection.json)) and locks it into the job (`recipe.lock.json`). Recipes are human-authored and versioned; agents can't edit them.

| Recipe | Picked for | Steps |
|---|---|---|
| `bug@low` | bug, docs, dependency at low risk | clarify → H1 → ground → decompose (one task from the contract) → realize → reconcile → prove → challenge(code) → ship → H4 → distill → close |
| `feature@low` | other work at low risk | as above, with a planned task graph, God Eye plan critique → H3, challenge(code, tests) |
| `standard@medium` | any medium-risk work | clarify → H1 → ground → decide → H2 (if ADR) → decompose → H3 → realize → reconcile → prove → challenge(code, tests, security) → ship → H4 → distill → close |
| `full@high` | any high-risk work; migrations are floored here | as medium, plus a threat model, H2 always, every lane, **HS** before ship |
| `hotfix@high` | hotfix | as `full@high`, grounding scoped to the failing path, plus a post-merge review; confirmed problems open a linked follow-up job |
| `spike` | spike | clarify → H1 → ground → decide (recommendation) → HF → close |
| `epic` | `--epic` | contracts freeze first, then each slice runs as its own job with its own recipe |

**Routing.** `factory next` checks, in order: contract approved → no drift from what you approved → floors met so far → no confirmed serious finding → every criterion proven → evidence still matches the build. The first that fails decides (clarify, amendment, the missing floor step, a fix round, a verify-fix round, prove again); if all pass, the recipe's next undone step runs. Loops are capped and **park** for you when a cap is hit. Every decision is a line in `.factory/log/decisions.jsonl`; `/factory:why` shows them.

**Workflows.** When `factory next` says `workflow`, the skill runs `factory run <workflow>` with the fields it was given (`--config`, `--mode`, `--scope`, `--lanes`, `--threat-model`/`--no-threat-model`, `--plan-critique`, and `--accept-degraded` when you chose to go on without a failed analyst). `factory run` executes the same workflow scripts as claude-factory (`workflows/*.js`) in a Node runtime that provides their agent API. Each agent call becomes one non-interactive Copilot process: `copilot -p <prompt> --agent factory:<role> --model <id> …`. Builders run in their task's worktree. Calls run in parallel up to `limits.max_parallel_agents`. Each agent must return one JSON object; the runner validates it against the agent's schema and asks once for a correction. The result goes through `factory record`, and `factory run` prints a short summary of the recorded result (`--json` for all of it). A run can take many minutes; only one runs per job at a time. `factory run --dry-run` shows what would run without starting Copilot.

**Floors** are the steps no recipe may skip at a risk level. Examples: contract approval, isolated builds, proof and code review everywhere; grounding, a design record, a validated plan and three review lanes from medium; a threat model, H2/H3, every lane and ship sign-off at high. They are enforced when a recipe loads, and again by `factory ship`, `factory close`, the stop gate and CI. See [`FLOORS.md`](plugins/factory/docs/FLOORS.md).

**Evidence.** Builders work in per-task worktrees; only `factory task verify` produces task evidence, and only `factory verify run` proves criteria on the integrated build. Every proof and review is bound to that build's fingerprint, so a later change makes it stale.

### Models and cost

By default no role has a model (`policy.agents.models` is empty), so every agent runs on your Copilot default model (`COPILOT_MODEL` or `model` in `~/.copilot/settings.json`). To pick one per role, set `policy.agents.models` to an alias (`opus`, `sonnet`, `haiku`); `policy.agents.model_ids` turns the alias into a Copilot model id, passed as `--model`. The agent files set no `model`, so this choice always wins. Run `/model` in a session to see the model ids your plan offers.

Every agent is its own Copilot session, so a job uses many requests. A `standard@medium` job typically starts dozens of agents (analysts, researchers, option generators, builders, testers, reviewers, verifiers). Copilot bills these against your plan: AI Credits on token-based plans, premium requests on the older request-based plans. Model multipliers apply, so roles you put on an `opus`-class model cost more. To keep cost down, use cheaper models for the read-only roles (researcher, analysts, reviewers), keep `builder_escalation` short, and lower `limits.max_agent_runs_per_job`. The factory counts agent runs and wall time, not credits.

## Documents

Every document the factory keeps follows a versioned template in [`templates/docs/`](plugins/factory/templates/docs): ADR, no-ADR note, spike recommendation, threat model, epic contracts, findings, ship report (also the PR body), lessons, and a per-job docs index. Each has the same front matter, fixed sections in a fixed order, and guidance comments.

- **ADRs must include a Mermaid architecture diagram**: a C4-style view of the system after the change, with the changed parts highlighted. A sequence diagram for the key flow is optional. A threat model needs a STRIDE table and a data-flow diagram with each trust boundary drawn as a box.
- **Enforced when the design is recorded:** `factory record` checks the design record against its template. Problems go back to the architect, and three failures in a row park the job.
- **Traceability:** `factory doc index` writes a table tracing each acceptance criterion through the design and the task to its proof.

```bash
factory doc list                  # types, template versions, sections
factory doc template adr          # print a template
factory doc check --job J-0007    # check every templated doc of a job
factory doc index --job J-0007    # (re)write the docs index
```

Details: [`DOCS.md`](plugins/factory/docs/DOCS.md).

## The console: watch the factory work

Run `factory console`, or `/factory:console` in the Copilot CLI, then open `.factory/console.html`. Or run `factory console --serve` and open the URL it prints: the same page, kept current as the agents work. Either way it reads `.factory/` and writes only the page. It checks seals only when this machine already has the factory key, and never creates one.

![The board: every job as a dense row, grouped by what needs you](plugins/factory/console/dev/screenshots/board-dark.png)

- **The floor.** The header has the project, a **LED** (`live` when served, `reconnecting` if the server went away, `snapshot` for a written file), the time of the last update, the seal check, any open factory-health findings from the inspector, and a filter box.
  - **Five tiles**: your turn, running, parked, stopped, done. Each is a count and a one-click filter (keys `1`–`5`). The tab title shows how many jobs wait for you, e.g. `(2) Factory Console`.
  - **Filters** on the left, with counts: status, recipe, risk, the gate a job waits at, inspector findings, epic or slice, and how recently it changed.
  - **The filter box** takes words and tokens: `is:waiting` `risk:high` `recipe:bug@low` `gate:H2` `has:finding` `has:rework` `agent:builder` `since:2d`; `-` excludes. Words match ids, titles and what happened.
- **Board.** One dense row per job, grouped by attention: your turn, then stopped, running, parked, and done (collapsed). Each row has a beacon (flashing amber on your turn), the recipe and risk, the eight stage lights, the current step or the gate and how long it has waited, the agents running now (coloured by model; `?` for one that started and never reported back), the task bar, return trips `↺`, retries `↻`, inspector findings `⚑`, a three-day activity sparkline and the age of the last change. A blue dot marks a job that changed since you last opened it. Group by status, recipe, risk, stage, epic or day; sort by urgency, updated, created or id. Slices sit under their epic.
- **Line map.** Every job as a transit line on one time axis. A line steps down one track per stage, with 45° bends. Gates are double rings, a dashed amber stretch is time waiting on you, dotted violet is parked, red marks a return trip, a buffer stop ends a cancelled or abandoned job, and a dotted transfer leads to a follow-up. Quiet hours are squeezed by default (switch to linear); zoom with `+`/`−`/Fit or ctrl-scroll, drag to pan, hover a station for the router's reason, the agents and the result.

  ![The line map](plugins/factory/console/dev/screenshots/lines-dark.png)
- **The wire.** On the right, everything that happened across all jobs, newest first: routes, results, agent runs, your replies, guard blocks, parks, hook errors, stop-gate blocks and inspector findings. Pause it while you read; narrow it to the selected job; click a line to open the job at that moment.
- **A job.** Click a row (or `Enter`). The list stays on the left so `j`/`k` still switch jobs; `Esc` goes back.
  - **Line**: the flow canvas. Stages are columns and time runs downward; each visit to a step is a row. Moving on is a blue line right; going back is a red line left, labelled with why (a fix round, a verify-fix round, re-proving, your denial); a repeated step drops straight down. Parks, resumes, amendments, cancels and abandons have their own rows. Each row shows the router's reason, every agent with its model (O/S/H), runs, retries `↻`, failures `✕` and escalation `↑`, the result and findings, your replies with how long each took, and guard blocks. A crew band shows who worked in each stage, inspector findings sit in a column beside the row they cite, and **Replay** drives the job down the canvas with the router's six checks at each decision.
  - **Story**: the same job as prose, one paragraph per step visit, with return trips on a red rule and inspector findings as margin notes. A pinned **Now** card says what the job waits on and the exact reply to type, with a copy button (e.g. `approve J-0004 H3`).
  - **Tasks**, **Events** (a filterable table of every event) and **Lessons**.

  ![A job's story](plugins/factory/console/dev/screenshots/job-story.png)
- **Live.** With `--serve`, the page gets each change over server-sent events. Only the rows whose job changed are redrawn, with a short highlight, and a row that changes group slides there. A new gate brings a toast with the reply to copy, and, if you turn on the bell, a desktop notification. On an open job, new steps play in if you are watching the latest moment, and your place is kept if you are scrubbing back. The server listens on this machine only (`http://127.0.0.1:4477/`, `--port 0` for any free port), refuses foreign `Host` headers and is read-only.
- **Keys.** `j`/`k` move, `Enter` opens, `Esc` goes back, `/` filters, `⌘K` (or ctrl-K) opens a palette to jump to any job or view, `1`–`5` toggle the tiles, `g w` opens the next job waiting for you, `?` lists them all. The view, filters and open job are in the URL, so a link brings you back to the same place.
- **Recipe map and Crew.** *Recipe map* is the whole factory as a floor plan for any recipe; *Crew* lists the 19 agents and how often each ran.
- **Where the data comes from.** Each workflow returns a roster of every agent it started, and `factory record` seals it into the ledger as an `agents` entry tied to the routing decision. Hooks add timings. Parks, amendments, follow-ups, hook errors and stop-gate blocks come from the event log and the job's own records. An agent that started but never stopped counts as running for two hours at most, and only while its job is active; after that it shows as stale.
- **Options.** `--job J-0003` makes the page for one job, `--out file.html` writes it elsewhere, `--label "…"` adds a banner, and `--data file.json` also writes the data as JSON. Dark is the default look when your system is dark; the half-moon button switches theme.
- **Sample.** `node plugins/factory/console/dev/make-sample.js <dir>` builds a realistic sample: nine jobs over about three days on a simulated clock. They run through the real CLI, workflows, hooks and inspector, with scripted agents. More screenshots are in [`plugins/factory/console/dev/screenshots/`](plugins/factory/console/dev/screenshots/).

## The inspector

`factory-inspector` audits the factory from the outside. It imports none of the factory's code: it reads `.factory/` directly, with its own seal check, so a bug in the factory can't hide itself. It never blocks or changes a job; its findings are questions for you, kept in `.factory/inspect/register.json`.

- **Per job (R1–R9):** forged records, the wrong recipe, steps out of order, gates approved without being shown, review on an unproven build, loops past caps, the agent not doing what `factory next` said, the same situation routed differently, recurring friction.
- **Factory health (R10–R19):** hook failures, torn log lines, repeated guard denials / stop-gate blocks / refused replies, CLI failures and crashes, degraded workflows and agent retries, agents that never stopped, repeated parks, idle jobs, slow gate replies, and clarify parking on an unclear intent or overrunning its question budget. Thresholds live in `.factory/inspect/config.json` (`limits`, `rules_off`).
- **When it runs:** whenever a job ends (closed, cancelled or abandoned), however it ended: right after Copilot runs the command, at the end of the turn if you ended it with a chat reply (its one-line summary then shows at the next session start, because an `agentStop` hook can't show you text), or at the next session start if you ended it from your terminal. On demand with `/factory-inspector:inspect` (`active` also covers running jobs). Once a recipe has a long clean streak it suggests sampling, then off.

Rule table and CLI: [`plugins/factory-inspector/README.md`](plugins/factory-inspector/README.md).

## Hooks

Both plugins ship hooks in Copilot's own format (`hooks/hooks.json`, `{ "version": 1, "hooks": { "<event>": [ … ] } }`, camelCase events). Every script reads its input through one normaliser that accepts Copilot's camelCase payloads (`toolName`, `toolArgs`) and the snake_case ones (`tool_name`, `tool_input`).

| Plugin | Event | Script | What it does |
|---|---|---|---|
| factory | `sessionStart` | `session-start.js` | Tells Copilot about the current job and what's waiting, and gives it the absolute `node "<root>/bin/factory"` command |
| factory | `userPromptSubmitted` | `prompt.js` | Applies your replies through the CLI and writes the outcome to `.factory/last-reply.json` (shown by `factory next` as `last_reply`); flags look-alikes as not applied |
| factory | `preToolUse` (shell, file reads and edits, search) | `guard.js` | Blocks writes to protected paths, recipes and policy, and reads of secrets (`.env`, keys, the seal key); keeps builders inside their task's allowed paths. Denies with `permissionDecision: "deny"` and exit code 2 |
| factory | `postToolUse`, `subagentStart` | `activity.js` | Appends a sealed line per event to `.factory/log/events.jsonl` |
| factory | `subagentStop` | `subagent-stop.js` | Records that an agent finished |
| factory | `agentStop` | `stop.js` | The stop gate: sends Copilot back to work while the current job is active, nothing waits on you (no gate, not parked, no open questions, last `factory next` not `wait` or `done`) and floors are unmet. Honours `stop_hook_active` and stays under Copilot's limit of 8 blocks in a row |
| inspector | `postToolUse` (shell) | `after-close.js` | Inspects right after `factory close / cancel / abandon` |
| inspector | `agentStop` · `sessionStart` | `catch-up.js` · `session-start.js` | Inspects jobs that ended any other way |
| inspector | `userPromptSubmitted` · `preToolUse` | `prompt.js` · `guard.js` | Applies your finding replies; keeps marking and modes human-only |

A hook that fails never breaks the Copilot CLI, but it leaves a `hook_error` event, which the inspector reports. Copilot treats a hook that **times out** as allowing the action (fail open), so the guard is kept fast.

## CI re-verify (recommended)

From your own terminal, once per repo: `factory ci install` (human-only). It copies a self-contained CLI to `.github/factory-cli/` and adds `.github/workflows/factory-gate.yml`, which re-runs every shipped job's verify commands on the PR's merge result. Add your project's setup steps, commit both on your base branch, and make `factory-gate` a required check. Without GitHub, `factory ci verify` re-verifies a local merge.

## Configure

Project overrides go in `.factory/policy.json` (you edit it; agents can't). Defaults: [`policy/default-policy.json`](plugins/factory/policy/default-policy.json).

```json
{
  "base_branch": "main",
  "checks": [{ "cmd": "npm run lint" }],
  "agents": {
    "models": { "researcher": "haiku", "builder": "sonnet" },
    "model_ids": { "opus": "claude-opus-5.5", "sonnet": "claude-sonnet-5.5", "haiku": "claude-haiku-5.5" },
    "builder_escalation": ["opus"]
  },
  "copilot": { "flags": ["--reasoning-effort", "medium"] },
  "protected_paths": [".factory/**", ".git/**", ".github/workflows/**", "migrations/**"],
  "limits": { "max_review_rounds": 3, "max_parallel_tasks": 4, "max_parallel_agents": 4, "max_agent_runs_per_job": 400 }
}
```

- `agents.models` sets a model alias per role. `agents.builder_escalation` moves a builder to a stronger model from its second attempt.
- `agents.model_ids` maps each alias to a Copilot model id. The ids above are examples from the Copilot CLI's supported-models list; the defaults are in `default-policy.json`. Any id your plan offers works, including non-Claude models.
- `limits.max_parallel_agents` caps how many `copilot -p` processes `factory run` runs at once (default 4). Keep it at or below what your plan allows for concurrent sessions.
- `copilot.flags` adds flags to every `copilot -p` call the runner makes, for example `--reasoning-effort` or extra `--deny-tool` patterns (see `factory run --dry-run` for the full command line).
- `COPILOT_BIN` (environment) points `factory run` at a different `copilot` binary. The tests use it to run a fake.

Every workflow agent runs as its real factory custom agent (`agents/<role>.agent.md`), so each role's tool list applies. The read-only roles (researcher, analysts, option generators, reviewers, verifier, tester, God Eye, judge, lesson-writer) have no file-edit tool, but all of them except the judge have a shell (`execute`), and `factory run` pre-approves tools, so a shell command could still write files. What actually limits them: their tool list, the guard (no writes to protected paths, factory state, the plugin or secrets; builders stay inside their task's allowed paths), the task worktree a builder or tester works in, and `factory record`, which re-checks every result before it counts.

## Start over in a repo

To clear old jobs (for example ones made by an older version) and initialise again:

```bash
cd your-repo
tar czf ~/factory-backup.tgz .factory                     # keep a copy
git worktree list | grep '.factory/worktrees' | awk '{print $1}' | xargs -r -n1 git worktree remove --force
git worktree prune
git branch --list 'factory/*' | xargs -r git branch -D    # review the list first
rm -rf .factory
```

Then `/factory:start <request>` initialises the repo again. Keep `~/.config/software-factory/secret` (the seal key) unless you want old seals to stop verifying.

## Repository layout

```text
.github/plugin/marketplace.json     the marketplace: copilot-factory
docs/                               DESIGN-COPILOT.md (port decisions) · COPILOT.md (Claude → Copilot mapping) · research/
plugins/factory/
  .github/plugin/plugin.json        plugin manifest (legacy format; version)
  skills/                           start · intake · clarify · gate · ship · distill · amend · park · why · console · review
  agents/                           19 custom agents (<role>.agent.md): intent-analyst, judge, god-eye, researcher,
                                    option-generator, threat-modeler, architect, planner, slicer, builder, tester, integrator,
                                    code/test/security/ux-reviewer, finding-verifier, epic-reviewer, lesson-writer
  hooks/                            hooks.json (Copilot format) + the scripts in the table above
  cli/                              the factory CLI: main.js, core/ (router, record, floors, run, ship, console, doc …), lib/
  workflows/                        ground · fanout-judge · decompose · realize · reconcile (run by factory run)
  config/workflows/                 fan-out configs: clarify · decide · challenge
  recipes/                          the recipes and _selection.json
  policy/                           default-policy.json · floors.json
  schemas/                          envelope, contract, plan, ledger and agent-output schemas
  templates/                        docs/ (document templates) · git/commit-msg · github/factory-gate.yml
  console/                          console.html (the page) · dev/ (sample builder, screenshots)
  docs/                             ARCHITECTURE · RECIPES · FLOORS · DOCS · DESIGN-v2 (Claude-era design history)
  tests/                            end-to-end, unit and packaging tests
plugins/factory-inspector/
  .github/plugin/plugin.json        plugin manifest
  inspector/                        observe · rules (R1–R19) · register · config · io
  hooks/ · skills/inspect/ · bin/factory-inspect · tests/
```

## Develop / test

```bash
cd plugins/factory && npm test             # end-to-end jobs, routing, caps, guard, seals, hooks, workflows, schemas, console, docs, packaging
cd plugins/factory-inspector && npm test   # the inspector's rules, hooks and independence
node plugins/factory/console/dev/make-sample.js /tmp/sample   # a realistic nine-job sample to look at
```

The tests drive the real CLI against throwaway git repos and play the agents and the human. They run the workflow scripts in a harness, and `factory run` against a fake `copilot` (`COPILOT_BIN`). `tests/packaging.test.js` checks the marketplace and plugin manifests, every agent's and skill's frontmatter, and that every `factory:<role>` the workflows start has an agent file.

To try a working copy in the real CLI without installing it:

```bash
copilot --plugin-dir plugins/factory --plugin-dir plugins/factory-inspector
```

Then check `/skills` (11 factory skills plus `inspect`), `/agent` (19 factory agents) and `/env` (hooks loaded). The agents `factory run` starts are new `copilot -p` processes and don't inherit `--plugin-dir`; to make them load the working copy too, set `"copilot": { "flags": ["--plugin-dir", "{plugin_root}"] }` in the test repo's `.factory/policy.json` (`{plugin_root}` becomes the factory plugin's folder). Bump the version in `plugin.json`, `package.json` and the marketplace entry with every change you ship, so installs can tell versions apart.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `factory: command not found` in a session | The skills fall back to the absolute command from the session-start note. In your terminal, run `factory shim` from the plugin folder (see [Where the plugins live](#install)) and make sure `~/.local/bin` is on your PATH |
| `factory-inspect: command not found` in a session | The inspect skill falls back to the `[inspector] Inspector CLI:` command from session start. If there is none, check that `factory-inspector` is installed and enabled (`copilot plugin list`), then `/restart`. For your terminal, `factory shim` links it too |
| `node …/bin/factory shim` fails with "Cannot find module" | The plugin isn't where the command looks. A marketplace added from a local folder runs from that folder (use `node <your clone>/plugins/factory/bin/factory shim`), and with `COPILOT_HOME` set the copies are under `$COPILOT_HOME/installed-plugins/`. `copilot plugin list --json` shows `source` and, for local installs, `installedFrom` |
| `/factory:start` isn't in the `/` menu | Restart the CLI after installing (`/restart`), and check `copilot skill list` shows the factory's skills |
| `/factory:start` (or `/factory:why`, `/factory:console`, `/factory:review`, `/factory-inspector:inspect`) runs some other skill, or a factory skill is missing from `copilot skill list` | Copilot keeps only one skill per `name`, and a project skill (`.github/skills/<name>/`) or a personal skill wins over a plugin's, which is dropped without a warning. A skill of yours named `start`, `why`, `console`, `review` or `inspect` (or one of the step skills: `intake`, `clarify`, `gate`, `ship`, `distill`, `amend`, `park`) hides the factory's. `copilot skill list --json` shows which one won. Rename or remove yours, then `/restart` |
| `factory init` stops with `no_git_identity` | git doesn't know your name and email yet. Run the two `git config --global` commands from the message, then `/factory:start` again |
| `/plugin` shows an old version | `copilot plugin marketplace update copilot-factory`, then `copilot plugin update factory` (and the inspector), then `/restart` |
| `factory run` fails to start agents | Check that `copilot` is on the PATH (or set `COPILOT_BIN`), that you are logged in (`copilot login`), and that `copilot -p "hi" --agent factory:researcher` works in the repo. `factory run --dry-run` shows the commands |
| Agents stall, or every tool call they make is denied | `factory run` pre-approves the agents' tools with `--allow-all-tools`, and `permissions.disableBypassPermissionsMode` (`"disable"` or `"allow-auto-only"`) in `~/.copilot/settings.json` suppresses that flag, so headless agents can't get past permission checks. `factory doctor` warns about it. Remove the setting while you use the factory |
| An agent fails because its model is rejected (`--model`) | The id isn't on your plan. Set `policy.agents.model_ids` in `.factory/policy.json` to ids that `/model` lists, or remove the role from `policy.agents.models` so it uses your default model |
| An agent's result is rejected | The runner asks once for a correction, then records the agent as failed. The workflow goes on degraded or retries per its rules; `/factory:why` and the console show which agent and why |
| Your `approve` was ignored | It must be the whole message. `factory next` shows `last_reply` with the reason and the accepted forms |
| Copilot keeps going when you wanted it to stop | That is the stop gate: the job has steps left and nothing waits on you. Say what you want instead, or `cancel job` |
| A job is parked | `/factory:why` shows why; reply `resume` for one more round, or `deny` / `cancel job` |
| Hooks don't seem to run | Trust the folder, check `/env`, and check `disableAllHooks` isn't set in `~/.copilot/settings.json`, `.github/copilot/settings(.local).json` or `.claude/settings(.local).json` |
| The console doesn't update | Use `factory console --serve` (a written file is a snapshot); the LED shows live / reconnecting / snapshot |

## Status: verified here vs. needs checking on a real Copilot CLI

**Verified in this repository** (automated tests, no Copilot needed): the CLI core, routing, floors, seals, record, console and inspector (unchanged from claude-factory); the workflow scripts under the harness; `factory run` against a fake `copilot`; the manifests and every agent and skill frontmatter against the field lists in Copilot's docs (`tests/packaging.test.js`).

**Verified on the real Copilot CLI 1.0.97** (installed from npm `@github/copilot`, not signed in):
- [x] `copilot plugin marketplace add <this repo>` finds `.github/plugin/marketplace.json`; `copilot plugin install factory@copilot-factory` and `factory-inspector@copilot-factory` install both plugins at the versions in the table above (`copilot plugin list --json`). From GitHub the copies land in `installed-plugins/copilot-factory/<plugin>/`; from a local folder the plugins are loaded live from it and nothing is copied.
- [x] `copilot skill list` shows all 11 factory skills and `inspect`, with their descriptions.
- [x] Every flag `factory run` passes exists in `copilot --help`: `-p`, `-s`, `--agent`, `--model`, `--output-format json` (JSONL), `--no-ask-user`, `--allow-all-tools`, `--add-dir`, `--session-id`, `--plugin-dir`, `-C`. Reasoning effort is `--reasoning-effort` (the `--effort` alias in the docs is not in this build's help).
- [x] The default `model_ids` (`claude-opus-5.5`, `claude-sonnet-5.5`, `claude-haiku-5.5`) are in `copilot help config`'s model list.

**Verified with the real CLI 1.0.97 against a local mock model** (real `copilot -p` sessions in which an OpenAI-compatible mock server plays the model and makes scripted tool calls, so no sign-in is needed; the CLI ran in bring-your-own-key mode):
- [x] All 19 agents load as `factory:<role>`, and `--agent factory:<role>` loads the plugin's agent in `-p` even when the project has its own agent of the same name.
- [x] Slash commands are `/factory:start`, `/factory:why`, `/factory:console`, `/factory:review` and `/factory-inspector:inspect`; the seven step skills are not user-invocable.
- [x] These hooks fire in `-p`, without trusting the folder: `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `agentStop`, `sessionEnd`, `subagentStart` and `subagentStop` (subagent events carry `agentName`).
- [x] The guard's deny (`permissionDecision: "deny"` plus exit 2) works: `factory approve` and `echo … > .factory/policy.json` were refused.
- [x] `sessionStart`'s `additionalContext` reaches the model, and so does `userPromptSubmitted`'s (inside a system reminder), although Copilot's reference says the latter is dropped. The factory still doesn't rely on it: `factory next` shows `last_reply`.
- [x] An `agentStop` block (`decision: "block"`) forces another turn. The block reason comes back as a new prompt, so it also fires `userPromptSubmitted`. `stop_hook_active` is `false` on the first stop and `true` after that, and the CLI's own cap of 8 blocks in a row ends the loop.
- [x] `-s` with `--output-format json` still prints JSONL with a top-level `assistant.message` event, which is what `factory run` reads.
- [x] Retry by resume works: reusing a `--session-id` resumes that session.
- [x] `factory run --dry-run` prints the right commands, with no `--model` by default.
- [x] Builders and testers in a task worktree under `.factory/worktrees/` with `--add-dir <root>` can write there, and the guard keeps them inside their task's allowed paths.
- [x] **Autopilot cannot approve gates.** Gates are applied only from your typed replies. Autopilot's and the stop gate's continuation prompts do pass through the reply hook, but their text never parses as a reply, and agents that run `factory approve` are refused. Hooks can't see the session mode (`sessionStart` carries no mode), but Autopilot's continuation prompt has a fixed text a hook can recognise.
- [x] Found: a headless agent's call to the factory CLI (`node "<plugin root>/bin/factory" …`) is denied unless the plugin folder is an allowed path (`--add-dir <plugin root>`), because `-p` can't ask.
- [x] Found: the `search` and `web` tool aliases are ignored by 1.0.97, although the docs list them. `grep`, `glob` and `web_fetch` work. `read`, `edit`, `execute`/`shell` and `agent` resolve as documented.
- [x] Found: skills are deduplicated by `name`, so a project or personal skill with the same name hides the factory's (see Troubleshooting). Agents are namespaced and aren't affected.

**Verified signed in, on Copilot CLI 1.0.95** (`scripts/verify-copilot.sh` on a user's machine):
- [x] `copilot -p … --agent factory:researcher` runs headless (plugin agent ids are `factory:<role>`).
- [x] `--output-format json` carries `assistant.message` events, which is what `factory run` reads, and the agent's final JSON object comes through.
- [x] Plugin hooks fire inside `copilot -p` processes (`postToolUse` activity logged), with no hook errors.
- [x] `/factory:start` runs the factory's start skill in an interactive session.
- [x] `sessionStart` `additionalContext` reaches the model: in a session Copilot ran the factory by the absolute `node "…/installed-plugins/copilot-factory/factory/bin/factory"` command that only the hook provides.

**Still to check while signed in.** Run `bash scripts/verify-copilot.sh` (it makes two short headless calls in a throwaway repo — a few premium requests — and writes `copilot-verify-*/report.md`): its guard probe uses the builder agent, so the protected write is really attempted. The rest come from the research reports in [`docs/research/`](docs/research/):

Packaging and invocation ([plugins-cli](docs/research/plugins-cli.md), [agents-skills](docs/research/agents-skills.md)):
- [ ] A full job end to end on a real Copilot model (the mock checks above script the model's tool calls).
- [ ] The model ids in `model_ids` are accepted by `--model` on your plan, and Auto mode doesn't override them.
- [ ] The tool restrictions above with a real Copilot model rather than bring-your-own-key mode (tool aliases are resolved by the client, so they shouldn't differ).
- [ ] Plan limits on concurrent sessions and rate limits at `max_parallel_agents` processes.

Hooks ([hooks](docs/research/hooks.md)):
- [ ] The exact `toolArgs` / `tool_input` keys for `create`, `edit`, `str_replace_editor`, `apply_patch` and `view` (path and content fields) from a real model's tool calls.

Surfaces ([surfaces-patterns](docs/research/surfaces-patterns.md)):
- [ ] The GitHub Copilot app and VS Code's Copilot harness behave like the CLI (they share its runtime per the docs; hook coverage in the app is not documented).
- [ ] Subagent depth and concurrency defaults (4 vs 6; plan-based caps), which matter only for the `distill` skill's single lesson-writer subagent.
- [ ] Windows: an npm-installed `copilot` is a `.cmd` file, which Node can't start without a shell; the WinGet `copilot.exe` is expected to work.

## Known limits

- Young on Copilot: install, skills, headless agents and hooks are verified on a real CLI (see Status), but no full job has been run end to end on a real Copilot model yet. Try a `bug@low` job first.
- The guard and seals are defence in depth, not a sandbox: agents run as your OS user, and `factory run` pre-approves the agents' tools because `-p` processes can't ask you. CI re-verify and your own merge are the hard backstops (ARCHITECTURE.md §6a).
- Every agent is a separate Copilot session: more start-up time and more requests than in-session subagents, and the agents don't appear in `/tasks`.
- Budgets count agent runs and wall time, not AI Credits or premium requests.
- Interactive CLI only. Not for Autopilot, `/fleet` or the cloud agent.
- Not included in this build: standards packs (`python@1`, `typescript@1`); project checks go in `policy.checks`.

More: [`COPILOT.md`](docs/COPILOT.md) · [`DESIGN-COPILOT.md`](docs/DESIGN-COPILOT.md) · [`ARCHITECTURE.md`](plugins/factory/docs/ARCHITECTURE.md) · [`RECIPES.md`](plugins/factory/docs/RECIPES.md) · [`FLOORS.md`](plugins/factory/docs/FLOORS.md) · [`DOCS.md`](plugins/factory/docs/DOCS.md) · [`DESIGN-v2.md`](plugins/factory/docs/DESIGN-v2.md) (the original Claude Code-era design, kept as history)
