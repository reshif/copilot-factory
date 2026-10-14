# Claude Code → GitHub Copilot CLI: component mapping

How each part of [claude-factory](https://github.com/reshif/claude-factory) maps onto the GitHub Copilot CLI in copilot-factory. The decisions are in [`DESIGN-COPILOT.md`](DESIGN-COPILOT.md). The evidence is in the research reports, which cite the official docs file by file:

- [plugins-cli.md](research/plugins-cli.md): plugins, marketplaces, CLI commands, caches, permissions, programmatic mode.
- [agents-skills.md](research/agents-skills.md): custom agents, subagents, skills, instructions, dynamic workflows.
- [hooks.md](research/hooks.md): hook events, payloads and outputs.
- [surfaces-patterns.md](research/surfaces-patterns.md): surfaces (CLI, app, VS Code, cloud agent, SDK), patterns, gaps.

"Verify" marks a point that the docs leave open and that needs a real Copilot CLI to confirm. The README's **Status** section collects all of them.

## 1. Distribution

| Claude Code (claude-factory) | Copilot CLI (copilot-factory) | Source |
|---|---|---|
| `.claude-plugin/marketplace.json`, marketplace `software-factory` | `.github/plugin/marketplace.json`, marketplace `copilot-factory`, plugins `factory` and `factory-inspector` with `./plugins/<name>` sources, a `version` per entry, `metadata.version` | plugins-cli §5 (fields, lookup order: root, `.plugin/`, `.github/plugin/`, `.claude-plugin/`) |
| `plugins/<p>/.claude-plugin/plugin.json` | `plugins/<p>/.github/plugin/plugin.json`, **legacy** format: no Agent Plugins `$schema`, so `agents/`, `skills/` and `hooks/hooks.json` load from their default places. Fields used: `name`, `description`, `version`, `author`, `homepage`, `repository`, `license`, `keywords` (all documented legacy fields) | plugins-cli §1, §2a, §3 |
| Versions 0.10.0 / 0.2.0 | 0.1.0 for both plugins (a new product line). `plugin.json`, `package.json` and the marketplace entry carry the same version; `tests/packaging.test.js` checks it | — |
| `claude plugin marketplace add reshif/claude-factory` · `claude plugin install factory@software-factory` | `copilot plugin marketplace add reshif/copilot-factory` · `copilot plugin install factory@copilot-factory` | plugins-cli §6 |
| `claude plugin marketplace update` · `claude plugin update …` | `copilot plugin marketplace update copilot-factory` · `copilot plugin update factory` (or `--all`) | plugins-cli §6 |
| `~/.claude/plugins/installed_plugins.json`, `~/.claude/plugins/cache/…` | `copilot plugin list --json`; installed copies in `~/.copilot/installed-plugins/copilot-factory/<plugin>/`; marketplace cache in `~/.cache/copilot/marketplaces/` (macOS `~/Library/Caches/copilot/marketplaces/`); metadata in `~/.copilot/config.json`; `COPILOT_HOME` and `COPILOT_CACHE_HOME` move them | plugins-cli §6, §7 |
| `claude plugin validate plugins/factory` | No validator command is documented. `tests/packaging.test.js` checks the manifests and frontmatter against the documented field lists; `copilot --plugin-dir plugins/factory` loads a working copy (repeatable, per process) | plugins-cli §6 |
| `/plugin` in Claude Code | `/plugin` (dashboard: Installed / Online / Marketplace), `/skills`, `/agent`, `/env` | plugins-cli §8 |
| No post-install step | Same: files are copied as they are. `bin/` has no npm dependencies | plugins-cli §3 |

## 2. Skills

All 11 factory skills and the inspector's `inspect` skill keep their names, directories and roles. `SKILL.md` frontmatter uses only documented fields: `name` (equal to the directory, which VS Code requires), `description` (≤ 1024 characters, written as a quoted YAML string), `argument-hint`, and `user-invocable: false` on the internal skills. Source: agents-skills §3.1.

| Claude Code | Copilot CLI | Source |
|---|---|---|
| `/factory:start`, `/factory:why`, `/factory:console`, `/factory:review`, `/factory-inspector:inspect` | The same names: Copilot lists plugin skills as `/<plugin>:<skill>` (verified on CLI 1.0.95). The seven step skills stay hidden (`user-invocable: false`) in both. |
| `user-invocable: false` (amend, clarify, distill, gate, intake, park, ship) | Same field and meaning: hidden from `/`, still loaded when relevant | agents-skills §3.1, §3.3 |
| `$ARGUMENTS` | Not substituted in Copilot skills; the text after the command is simply in context. Skills now say "the text the user typed after the command" | agents-skills §3.3 |
| `start` step "Start the workflow `factory:<wf>` with the **Workflow tool**", envelope written to `.factory/scratch/envelope.json`, `factory record --file …` | `factory run <workflow> [--config …] [--mode …] [--scope …] [--lanes …] [--threat-model \| --no-threat-model] [--plan-critique] [--accept-degraded]`. It builds the brief, runs the agents, records the result and prints the record result. The skill never writes a brief or an envelope and never fans out itself | DESIGN-COPILOT "Workflows"; surfaces-patterns §4 #2 |
| "No Workflow tool? Run the same brief by hand with the **Agent tool**" | Removed. `factory run` works on every plan, so there is no model-driven fallback | agents-skills §9.3 |
| The hook's `[factory] Applied…` note after a reply | `factory next` returns `last_reply` (from `.factory/last-reply.json`, written by the reply hook). `start`, `gate`, `park` and `ship` read it, because a prompt hook's added context may not reach the model | hooks §5.3, §8 #2 |
| `factory` on the PATH from the plugin's `bin/` | Plugin `bin/` is not on the PATH in Copilot. Skills use `factory`, fall back to the absolute `node "<root>/bin/factory"` that the session-start hook provides, and point the user at `factory shim` | plugins-cli §0, §9.4 |
| `distill` starts `factory:lesson-writer` with the Agent tool | One subagent through Copilot's `task` tool, agent type `factory:lesson-writer` | agents-skills §2.1 |
| `console`: `factory console --serve` with the Bash tool's `run_in_background` | "Run it as a background shell command" (the CLI's shell tools include `read_bash` and `stop_bash` for long-running commands) | agents-skills §1.3 |
| Claude Code's Stop hook refuses a false "done" | A stop gate based on job state (see §4); the skills say to stop only at gate / wait / parked / done or after asking questions | hooks §8 #7 |
| — | `start` forbids Autopilot (it auto-answers questions and permission prompts) | surfaces-patterns §4 #9 |

## 3. Agents

| Claude Code | Copilot CLI | Source |
|---|---|---|
| `agents/<role>.md` | `agents/<role>.agent.md`. The plugin reference says `agents/` holds `.agent.md` files; the agent reference strips `.agent.md` or `.md`. `.agent.md` is the safe choice | plugins-cli §3; agents-skills §1.1 |
| Agent type `factory:<role>` | Same id: plugin agents are addressed as `<plugin>:<agent>`. Verify (only source: changelog 1.0.81) | agents-skills §1.4 |
| `name`, `description` | Same fields. `name` equals the file name; descriptions are quoted YAML strings | agents-skills §1.2 |
| `tools: Read, Grep, Glob, Bash, Write, Edit, WebFetch, WebSearch` | Primary aliases as a YAML list: `Read` → `read`, `Grep`/`Glob` → `search`, `Write`/`Edit` → `edit`, `Bash` → `execute`, `WebFetch`/`WebSearch` → `web`. Read-only roles keep no `edit` | `custom-agents-configuration.md` "Tool aliases"; agents-skills §1.3 |
| No `model` in the agent files; the Workflow tool passed `model` per call | Still no `model`: frontmatter `model` would beat `--model`, so the runner's `--model <id>` (from `policy.agents.model_ids`) applies | agents-skills §2.6; plugins-cli §8 (precedence: agent frontmatter, then `--model`) |
| Claude Code subagents read `CLAUDE.md` | `include-custom-instructions: true` on the agents that edit or review code (builder, integrator, code/test/security/ux/epic reviewers) and the lesson-writer. It applies when an agent runs as a subagent; an agent started with `--agent` follows repository instructions anyway | `cli-command-reference.md` "Repository custom instructions for subagents"; agents-skills §1.5, §2.4 |
| `schema` on each `agent()` call (structured output) | No structured output in Copilot. Each agent body ends with "Your final message is exactly one JSON object that matches the output schema…"; the runner validates it and asks once for a correction | agents-skills §2.5 |
| Body text | Unchanged apart from that final section. The bodies had no Claude Code-specific wording; `tests/packaging.test.js` keeps it that way | — |

## 4. Workflows and the agent runtime

| Claude Code | Copilot CLI | Source |
|---|---|---|
| Workflow tool runs `workflows/*.js` with `agent`, `pipeline`, `phase`, `log` | `factory run` runs the same scripts in Node with the same API (as `tests/helpers/workflow-harness.js` does) | DESIGN-COPILOT "Workflows"; agents-skills §9.3 |
| `agent(prompt, { agentType, model, schema })` | One `copilot -p <prompt> --agent factory:<role> --model <id> …` process per call; `cwd` is the task worktree for builders. Binary from `COPILOT_BIN` (default `copilot`) | plugins-cli §8 (programmatic mode); agents-skills §8 ("realize builders in git worktrees") |
| `pipeline()` parallel fan-out | Bounded concurrency: `policy.limits.max_parallel_agents` (default 4) | DESIGN-COPILOT |
| Claude model aliases `opus` / `sonnet` / `haiku` in `policy.agents.models` | Kept; `policy.agents.model_ids` maps each alias to a Copilot model id (overridable) | agents-skills §2.6 |
| Envelope → `factory record` | In-process `factory record`; `factory run` prints its result | DESIGN-COPILOT |
| Permission prompts in the session | `-p` processes can't prompt, so the runner pre-approves the agents' tools; `copilot.flags` adds more flags. The guard hook is the enforcement point, if plugin hooks fire in `-p` (verify) | plugins-cli §4, §7 |
| Dynamic workflows (Copilot preview) | Not used: experimental, undocumented authoring API, not on every plan | agents-skills §5 |
| `/fleet`, Autopilot | Not used: the model would decide decomposition and answer gates | agents-skills §9.4; surfaces-patterns §4 #9 |

## 5. Hooks

Owned by the hooks port; listed here for completeness. Native Copilot format: `{ "version": 1, "hooks": { "<camelEvent>": [ { "type": "command", "bash": "node \"$PLUGIN_ROOT/hooks/x.js\"", "timeoutSec": N } ] } }`. Source: hooks §2.2, §3; plugins-cli §4.

| Claude Code event | Copilot event | Change | Source |
|---|---|---|---|
| `SessionStart` | `sessionStart` | Flat `additionalContext`; also gives the absolute `node "<root>/bin/factory"` command | hooks §5.2, §8 #1 |
| `UserPromptSubmit` | `userPromptSubmitted` | Applies replies as a side effect; writes `.factory/last-reply.json`, which `factory next` returns as `last_reply` | hooks §5.3, §8 #2 |
| `PreToolUse` (Claude tool names) | `preToolUse` (runtime tool names such as `bash`, `view`, `create`, `edit`, `apply_patch`, `grep`, `glob`) | Flat `permissionDecision: "deny"` plus exit code 2; one input normaliser for camelCase and snake_case payloads; `apply_patch` bodies parsed; timeouts fail open, so the guard stays fast (`timeoutSec` 10) | hooks §5.1, §6, §8 #3 |
| `PostToolUse`, `SubagentStart` | `postToolUse`, `subagentStart` | Tool names normalised in the activity log | hooks §8 #4, #5 |
| `SubagentStop` | `subagentStop` | — | hooks §8 #6 |
| `Stop` (reads `last_assistant_message` for "done" claims) | `agentStop` | Copilot's stop payload has no last message. New rule: block while the job is active, nothing waits on the user, and floors are unmet; honour `stop_hook_active`; stay under 8 blocks in a row | hooks §5.5, §8 #7 |
| `${CLAUDE_PLUGIN_ROOT}` | `$PLUGIN_ROOT` (also `COPILOT_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`) | — | plugins-cli §0 |

## 6. Unchanged

The CLI core: router (`factory next`), floors, `factory record`, seals and the key, the ledger and logs, recipes and selection, policy, worktrees, verify, ship and PRs, CI re-verify, document templates and checks, telemetry, lessons, the console (and `--serve`), and the inspector's rules. Both plugins keep `bin/factory` and `bin/factory-inspect`.

## 7. Surfaces

| Surface | Status | Source |
|---|---|---|
| Copilot CLI, interactive | Target | surfaces-patterns §1 |
| GitHub Copilot app, VS Code Copilot harness | Expected to work: both are built on the CLI runtime. Verify | surfaces-patterns §0 |
| VS Code Local harness | Not targeted: different hook payloads, Claude hooks off by default | surfaces-patterns §1 |
| Cloud agent | Out of scope: non-interactive, "ask" becomes deny, plugin hooks not loaded | surfaces-patterns §1, §4 #9 |
| Autopilot, `/fleet` | Not supported: they answer gates or let the model decompose the work | surfaces-patterns §4 #9 |
