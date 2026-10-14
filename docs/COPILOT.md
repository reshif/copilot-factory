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
| Versions 0.10.0 / 0.2.0 | A new version line starting at 0.1.0 (now factory 0.1.2, inspector 0.1.1). `plugin.json`, `package.json` and the marketplace entry carry the same version; `tests/packaging.test.js` checks it | — |
| `claude plugin marketplace add reshif/claude-factory` · `claude plugin install factory@software-factory` | `copilot plugin marketplace add reshif/copilot-factory` · `copilot plugin install factory@copilot-factory` | plugins-cli §6 |
| `claude plugin marketplace update` · `claude plugin update …` | `copilot plugin marketplace update copilot-factory` · `copilot plugin update factory` (or `--all`) | plugins-cli §6 |
| `~/.claude/plugins/installed_plugins.json`, `~/.claude/plugins/cache/…` | `copilot plugin list --json` (`source`: `installed`, or `live` with `installedFrom`). A GitHub install copies each plugin to `~/.copilot/installed-plugins/copilot-factory/<plugin>/`; a marketplace added from a local folder is loaded live from that folder and nothing is copied (verified on 1.0.97). Marketplace cache in `~/.cache/copilot/marketplaces/` (macOS `~/Library/Caches/copilot/marketplaces/`); metadata, including each installed plugin's `cache_path`, in `~/.copilot/config.json`. `COPILOT_HOME` moves all of these (the cache to `$COPILOT_HOME/.cache/…`); `COPILOT_CACHE_HOME` moves only the cache | plugins-cli §6, §7 |
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
| `start` step "Start the workflow `factory:<wf>` with the **Workflow tool**", envelope written to `.factory/scratch/envelope.json`, `factory record --file …` | `factory run <workflow> [--config …] [--mode …] [--scope …] [--lanes …] [--threat-model \| --no-threat-model] [--plan-critique] [--accept-degraded]`. It builds the brief, runs the agents, records the result and prints a short text summary of the recorded result, starting with `status: <x>`, which the skill acts on (`--json` for the same as JSON; the workflow's own status is under `workflow`). The skill runs it once in the foreground and never starts a second one; refusals carry a `code` (`not_waiting_for_workflow`, `run_in_progress`, `copilot_unavailable`). The skill never writes a brief or an envelope and never fans out itself | DESIGN-COPILOT "Workflows"; surfaces-patterns §4 #2 |
| "No Workflow tool? Run the same brief by hand with the **Agent tool**" | Removed. `factory run` works on every plan, so there is no model-driven fallback | agents-skills §9.3 |
| The hook's `[factory] Applied…` note after a reply | `factory next` returns `last_reply` (from `.factory/last-reply.json`, written by the reply hook). `start`, `gate`, `park` and `ship` read it. On CLI 1.0.97 the prompt hook's added context does reach the model (verified against a mock model), but the docs say it is dropped, so the skills don't rely on it | hooks §5.3, §8 #2 |
| `factory` on the PATH from the plugin's `bin/` | Plugin `bin/` is not on the PATH in Copilot. Skills use `factory`, fall back to the absolute `node "<root>/bin/factory"` that the session-start hook provides, and point the user at `factory shim` | plugins-cli §0, §9.4 |
| `distill` starts `factory:lesson-writer` with the Agent tool | One subagent through Copilot's `task` tool, agent type `factory:lesson-writer` | agents-skills §2.1 |
| `console`: `factory console --serve` with the Bash tool's `run_in_background` | "Run it as a background shell command" (the CLI's shell tools include `read_bash` and `stop_bash` for long-running commands) | agents-skills §1.3 |
| Claude Code's Stop hook refuses a false "done" | A stop gate based on job state (see §5); the skills say to stop only at gate / wait / parked / done or after asking questions | hooks §8 #7 |
| — | `start` forbids Autopilot (it auto-answers questions and permission prompts) | surfaces-patterns §4 #9 |

## 3. Agents

| Claude Code | Copilot CLI | Source |
|---|---|---|
| `agents/<role>.md` | `agents/<role>.agent.md`. The plugin reference says `agents/` holds `.agent.md` files; the agent reference strips `.agent.md` or `.md`. `.agent.md` is the safe choice | plugins-cli §3; agents-skills §1.1 |
| Agent type `factory:<role>` | Same id: plugin agents are addressed as `<plugin>:<agent>`. Verified on 1.0.95 (signed in) and 1.0.97 (mock model): all 19 load as `factory:<role>`, and `--agent factory:<role>` picks the plugin's agent even when the project has one of the same name | agents-skills §1.4 |
| `name`, `description` | Same fields. `name` equals the file name; descriptions are quoted YAML strings | agents-skills §1.2 |
| `tools: Read, Grep, Glob, Bash, Write, Edit, WebFetch, WebSearch` | Primary aliases as a YAML list: `Read` → `read`, `Grep`/`Glob` → `search`, `Write`/`Edit` → `edit`, `Bash` → `execute`, `WebFetch`/`WebSearch` → `web`. Read-only roles keep no `edit`, but all except the judge keep a shell (`execute`), so the guard and `factory record`'s re-checks, not the tool list alone, keep them from changing the project. CLI 1.0.97 ignores `search` and `web` (verified against a mock model; it resolves `grep`, `glob` and `web_fetch`), so the agents list both: `["read", "search", "grep", "glob", "execute"]`, and the researcher also `"web", "web_fetch"`. Unknown names are ignored, so the aliases stay for other surfaces | `custom-agents-configuration.md` "Tool aliases"; agents-skills §1.3 |
| No `model` in the agent files; the Workflow tool passed `model` per call | Still no `model`: frontmatter `model` would beat `--model`, so the runner's `--model <id>` (from `policy.agents.model_ids`) applies | agents-skills §2.6; plugins-cli §8 (precedence: agent frontmatter, then `--model`) |
| Claude Code subagents read `CLAUDE.md` | `include-custom-instructions: true` on the agents that edit or review code (builder, integrator, code/test/security/ux/epic reviewers) and the lesson-writer. It applies when an agent runs as a subagent; an agent started with `--agent` follows repository instructions anyway | `cli-command-reference.md` "Repository custom instructions for subagents"; agents-skills §1.5, §2.4 |
| `schema` on each `agent()` call (structured output) | No structured output in Copilot. Each agent body ends with "Your final message is exactly one JSON object that matches the output schema…"; the runner validates it and asks once for a correction | agents-skills §2.5 |
| Agents offered to the main session for auto-delegation (Claude Code: by description) | `disable-model-invocation: true` on every factory role except the lesson-writer (which the `distill` skill starts through the `task` tool), so the main session isn't offered them for unrelated requests. `--agent factory:<role>` still selects them | `cli-command-reference.md` "Custom agent frontmatter fields" |
| Body text | Unchanged apart from that final section. The bodies had no Claude Code-specific wording; `tests/packaging.test.js` keeps it that way | — |

## 4. Workflows and the agent runtime

| Claude Code | Copilot CLI | Source |
|---|---|---|
| Workflow tool runs `workflows/*.js` with `agent`, `pipeline`, `phase`, `log` | `factory run` runs the same scripts in Node with the same API (as `tests/helpers/workflow-harness.js` does) | DESIGN-COPILOT "Workflows"; agents-skills §9.3 |
| `agent(prompt, { agentType, model, schema })` | One `copilot -p <prompt> --agent factory:<role> --model <id> …` process per call; `cwd` is the task worktree for builders. Binary from `COPILOT_BIN` (default `copilot`) | plugins-cli §8 (programmatic mode); agents-skills §8 ("realize builders in git worktrees") |
| `pipeline()` parallel fan-out | Bounded concurrency: `policy.limits.max_parallel_agents` (default 4) | DESIGN-COPILOT |
| Claude model aliases `opus` / `sonnet` / `haiku` in `policy.agents.models` | Kept; `policy.agents.model_ids` maps each alias to a Copilot model id (overridable) | agents-skills §2.6 |
| Envelope → `factory record` | In-process `factory record`; `factory run` prints its result | DESIGN-COPILOT |
| Permission prompts in the session | `-p` processes can't prompt, so the runner pre-approves the agents' tools; `copilot.flags` adds more flags. Path permissions still apply to shell commands: a path outside the working directory and the `--add-dir` folders is denied, so the runner passes `--add-dir` for the project root and the plugin root (agents run the factory CLI from the plugin). Inside an agent the guard and the CLI allow only the factory commands its role is briefed for (`agent_not_allowed` otherwise). The guard hook is the enforcement point; plugin hooks do fire in `-p` (verified on 1.0.95 and 1.0.97) | plugins-cli §4, §7 |
| Dynamic workflows (Copilot preview) | Not used: experimental, undocumented authoring API, not on every plan | agents-skills §5 |
| `/fleet`, Autopilot | Not used: the model would decide decomposition and answer gates | agents-skills §9.4; surfaces-patterns §4 #9 |

## 5. Hooks

Owned by the hooks port; listed here for completeness. The last row is the inspector plugin's. Native Copilot format: `{ "version": 1, "hooks": { "<camelEvent>": [ { "type": "command", "bash": "node \"$PLUGIN_ROOT/hooks/x.js\"", "timeoutSec": N } ] } }`. Source: hooks §2.2, §3; plugins-cli §4.

| Claude Code event | Copilot event | Change | Source |
|---|---|---|---|
| `SessionStart` | `sessionStart` | Flat `additionalContext`; also gives the absolute `node "<root>/bin/factory"` command. Inside a `factory run` agent (a full Copilot session, unlike a Claude Code workflow subagent) only a short role note | hooks §5.2, §8 #1 |
| `UserPromptSubmit` | `userPromptSubmitted` | Applies replies as a side effect; writes `.factory/last-reply.json`, which `factory next` returns as `last_reply`. Ignores the stop gate's block reasons and Autopilot's continuation text, which Copilot sends as prompts too; does nothing inside a `factory run` agent | hooks §5.3, §8 #2 |
| `PreToolUse` (Claude tool names) | `preToolUse` (runtime tool names such as `bash`, `view`, `create`, `edit`, `apply_patch`, `grep`, `glob`) | Flat `permissionDecision: "deny"` plus exit code 2; one input normaliser for camelCase and snake_case payloads; `apply_patch` bodies parsed; timeouts fail open, so the guard stays fast (`timeoutSec` 10) | hooks §5.1, §6, §8 #3 |
| `PostToolUse`, `SubagentStart` | `postToolUse`, `subagentStart` | Tool names normalised in the activity log | hooks §8 #4, #5 |
| `SubagentStop` | `subagentStop` | — | hooks §8 #6 |
| `Stop` (reads `last_assistant_message` for "done" claims) | `agentStop` | Copilot's stop payload has no last message. New rule: block while the job is active, nothing waits on the user, and floors are unmet; also block a "done" claim (when the transcript shows one) while a gate waits on the user. Reasons start with `[factory stop gate]`; at most 3 blocks in a row (Copilot's cap is 8); honour `stop_hook_active` | hooks §5.5, §8 #7 |
| `${CLAUDE_PLUGIN_ROOT}` | `$PLUGIN_ROOT` (also `COPILOT_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`) | — | plugins-cli §0 |
| Inspector `Stop` catch-up (shows a `systemMessage` that turn) | Inspector `agentStop` catch-up | The job is inspected at the end of the turn, but `agentStop` can't show text, so the one-line summary is reported by the inspector's `userPromptSubmitted` hook with your next message (or at the next session start) | hooks §5.5, §5.8 |

## 6. Unchanged

The CLI core: router (`factory next`), floors, `factory record`, seals and the key, the ledger and logs, recipes and selection, policy, worktrees, verify, ship and PRs, CI re-verify, document templates and checks, telemetry, lessons, the console (and `--serve`), and the inspector's rules. Both plugins keep `bin/factory` and `bin/factory-inspect`.

## 7. Surfaces

| Surface | Status | Source |
|---|---|---|
| Copilot CLI, interactive | Target | surfaces-patterns §1 |
| GitHub Copilot app, VS Code Copilot harness | Expected to work: both are built on the CLI runtime. Not yet verified | surfaces-patterns §0 |
| VS Code Local harness | Not targeted: different hook payloads, Claude hooks off by default | surfaces-patterns §1 |
| Cloud agent | Out of scope: non-interactive, "ask" becomes deny, plugin hooks not loaded | surfaces-patterns §1, §4 #9 |
| Autopilot, `/fleet` | Not supported: they answer gates or let the model decompose the work | surfaces-patterns §4 #9 |
