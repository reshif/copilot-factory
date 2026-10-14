# Copilot Factory: port design

Port of claude-factory (github.com/reshif/claude-factory @ main) to the **GitHub Copilot CLI**
(also covers the GitHub Copilot app and VS Code's "Copilot" harness, which share its runtime).
The research behind every decision is in [`docs/research/`](research/) — each claim cites the official doc file.

## Decisions

| Area | Decision | Why (report) |
|---|---|---|
| Target | Copilot CLI, interactive sessions. Never Autopilot (it auto-answers human gates). Cloud agent out of scope (non-interactive, "ask" = deny). | surfaces-patterns §1 |
| Marketplace | `.github/plugin/marketplace.json`, name `copilot-factory`; plugins `factory`, `factory-inspector`. Install: `copilot plugin marketplace add reshif/copilot-factory` → `copilot plugin install factory@copilot-factory`. | plugins-cli §0, §5 |
| Plugin manifest | `plugins/<p>/.github/plugin/plugin.json`, legacy format (no Agent Plugins `$schema`) so `agents/`, `skills/`, `hooks/hooks.json` load from their default places. | plugins-cli §0, §2 |
| Hooks | Native Copilot format: `{ "version": 1, "hooks": { "<camelEvent>": [ { "type": "command", "bash": "node \"$PLUGIN_ROOT/hooks/x.js\"", "timeoutSec": N } ] } }`. Every hook script reads input through one normaliser (camelCase `toolName`/`toolArgs` or snake_case `tool_name`/`tool_input`; `path` or `file_path`; parse `apply_patch` bodies). | hooks §1–§4 |
| Hook outputs | Flat Copilot shapes. Deny = stdout `{"permissionDecision":"deny","permissionDecisionReason":…}` **and** exit code 2 with the reason on stderr. Context = top-level `additionalContext`. Stop block = top-level `{"decision":"block","reason":…}` (max 8 in a row; honour `stop_hook_active`). | hooks §3 |
| Replies (`approve` …) | `userPromptSubmitted` hook applies them through the CLI as a side effect (works whatever happens to output). Also emits `additionalContext` (honoured since CLI 1.0.65 per changelog; docs say dropped) — skills must not rely on it: the `start` skill always runs `factory next`, which shows the applied state. | hooks §2 |
| Stop gate | Copilot's stop payload has no last message. New rule: block when the current job is `active`, the agent is not legitimately waiting (no pending gate, not parked, no open questions to the user, last `factory next` action not `wait`/`done`), and floors are unmet. Uses `stop_hook_active` + an in-file counter to stay under the 8-block cap. | hooks §2.6 |
| Guard timeouts | Timeouts fail **open** in Copilot. Guard must be fast (no heavy requires on the hot path), timeoutSec 10. | hooks §5 |
| CLI on PATH | Plugins' `bin/` is not put on PATH. `sessionStart` hook injects the absolute command (`node "<root>/bin/factory"`) as additionalContext; skills say "run `factory …` (use the command from session start if `factory` isn't found)". `factory shim` (human-run) links `~/.local/bin/factory` and `factory-inspect`. | plugins-cli §3 |
| Workflows | No Workflow tool in Copilot. New `factory run <workflow> [--config c] [--mode m] [--scope s] [--lanes …] [--accept-degraded]`: runs the **same** `workflows/*.js` scripts in a Node runtime that emulates the Workflow API (as tests/helpers/workflow-harness.js does), where `agent(prompt,{agentType,schema,model,cwd})` spawns `copilot -p <prompt> --agent factory:<role> --model <id> --output-format json --allow-all-tools`-style subprocesses (exact flags per plugins-cli §6), cwd = task worktree for builders, bounded concurrency (`policy.limits.max_parallel_agents`, default 4), JSON extracted from the reply, validated against the schema, one corrective retry, then the envelope goes to `factory record` in-process. Binary from `COPILOT_BIN` (default `copilot`) so tests use a fake. | agents-skills §7, surfaces-patterns §2 |
| Models | `policy.agents.models` keeps role → alias; new `policy.agents.model_ids` maps aliases to Copilot ids (defaults: opus → `claude-opus-4.5`… set from the docs' supported-models list; overridable). | agents-skills §5 |
| Agents | Same 19 agents, `.agent.md`, frontmatter `name`, `description`, `tools` (Copilot aliases: read, search, edit, execute, web), optional `model`. | agents-skills §2 |
| Skills | Same 11 skills (`SKILL.md` is compatible). Rewritten where they mention Claude Code tools (Workflow, Agent, Task) to use `factory run`. | agents-skills §3 |
| Inspector | Same rules. Reads both camelCase and snake_case event fields; tool names normalised (bash/edit/create/view → Bash/Edit/Write/Read). | hooks §4 |
| Unchanged | CLI core (router, floors, record, seals, ledger, recipes, policy, worktrees, verify, ship, docs, console + `--serve`). | — |

## Verify on a real Copilot CLI (can't be done in CI here)
See the "verify" lists at the end of each research report; collected in README "Status".
