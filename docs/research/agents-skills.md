# GitHub Copilot: custom agents, subagents, skills, instructions, prompt files

Research for porting the Claude Code plugin "Software Factory" (`plugins/factory`) to GitHub Copilot.
Sources are local snapshots of the official docs, last updated 2026-10-14. CLI changelog head: 1.0.97 (2026-10-13).

**Path abbreviations used in citations**

| Abbrev. | Path (under `.../scratchpad/research/`) |
|---|---|
| `GH/` | `gh-docs/content/copilot/` |
| `RU/` | `gh-docs/data/reusables/copilot/` |
| `CLIREF` | `GH/reference/copilot-cli-reference/cli-command-reference.md` |
| `PLUGREF` | `GH/reference/copilot-cli-reference/cli-plugin-reference.md` |
| `CFGREF` | `GH/reference/copilot-cli-reference/cli-config-dir-reference.md` |
| `AGREF` | `GH/reference/custom-agents-configuration.md` |
| `HOOKREF` | `GH/reference/hooks-reference.md` |
| `VS/` | `vscode-docs/docs/` |
| `CL:n` | `copilot-cli/changelog.md`, line n |
| `AC/` | `awesome-copilot/` |

"⚠" marks an ambiguity or a contradiction between sources.

---

## 0. TL;DR

* **Custom agents.** An agent is a Markdown file with YAML frontmatter, named `*.agent.md` or `*.md`. Only `description` is required. The CLI loads agents from `~/.copilot/agents/`, `.github/agents/`, `.claude/agents/`, a plugin's `agents/` directory, and org or enterprise repos. Our `agents/*.md` files, with `name`, `description` and a comma-separated `tools` list of Claude tool names, are **accepted as is**: `Read`, `Grep`, `Glob`, `Bash`, `Write`, `Edit`, `WebFetch`, `WebSearch` and `Task` are documented aliases (`AGREF` "Tool aliases").
* **Subagents (CLI).** The main agent dispatches a custom agent through the built-in **`task`** tool, written `task(agent_type="<id>")`. Each subagent gets **its own context window**.
  * Subagents **can run in parallel**. Concurrency is capped per plan: Pro 4, Business 16, Enterprise 32.
  * The nesting depth limit is 4 or 6 depending on the source ⚠.
  * A subagent returns **free text only**. There is no JSON-schema parameter. A `subagentStop` hook can inspect the text and force a retry or rewrite it.
  * The model can be set per agent (`model` / `models` / `modelPolicy` / `reasoningEffort`), per call, or per user setting.
* **Skills.** A skill is `skills/<name>/SKILL.md` with `name` and `description`, plus optional `argument-hint`, `allowed-tools`, `user-invocable`, `disable-model-invocation` and `license`. Copilot loads a skill automatically when its description matches, or the user invokes it with `/<name>`. The fields match Claude Code's, so our 11 skills port almost 1:1.
* **Closest equivalent to Claude Code's Workflow tool: "dynamic workflows".** They are JavaScript programs in a CLI *extension*. They run agents sequentially or in parallel and pass structured results between steps. They support phases and progress, limits, pause and resume, `/workflows`, and `copilot workflow run NAME --args JSON --result-file`.
  * They are experimental and in public preview, and need `--experimental`.
  * Their authoring API is **not documented** in the docs snapshot. Copilot itself supplies the "built-in authoring guidance".
* **Recommendation:**
  1. Port the 5 workflows to dynamic workflows shipped in the plugin, keeping the same brief and envelope contract.
  2. Keep a skill-driven fallback that fans out with the `task` tool and validates JSON in `factory record`.
  3. For CI, run `copilot workflow run`, with permissions granted up front.

  Details are in §9.

---

## 1. Custom agents: file format

### 1.1 File and identity
* **Extension.** Use `.agent.md`. The CLI also accepts `.md`. The ID is the file name without `.agent.md` or `.md`. (`GH/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli.md` "Programmatically"; `CLIREF` "Custom agents reference")
* **Subdirectories.** A file in a subdirectory of `agents/` gets an ID that joins the path with `--`. For example, `agents/team/reviewer.agent.md` has the ID `team--reviewer`. (`CLIREF` "Custom agents reference")
* **Deduplication.** `name` is a display name only. It does **not** affect deduplication: two agents with the same `name` but different IDs both load. `--agent` accepts an ID or a quoted `name`. (`create-custom-agents-for-cli.md`; `CLIREF` "Custom agent locations")
* **Recommended name style.** For programmatic use, "it's recommended that you choose a name consisting only of lowercase letters and hyphens". (`create-custom-agents-for-cli.md`)
* **Characters allowed on GitHub.com.** File names may only contain `.`, `-`, `_`, `a-z`, `A-Z` and `0-9`. (`GH/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/create-custom-agents.md`)
* **Prompt length.** The Markdown body is the system prompt, and can be at most **30,000 characters**. (`AGREF`)
* **VS Code (Local harness).** Any `.md` file in `.github/agents` counts as an agent. Selecting an agent prepends its body to the user's prompt. (`VS/agent-customization/custom-agents.md` "Custom agent file structure", "Body")
* **Relative links.** Relative links in an agent body resolve from the agent file's location. (`CL:626`)
* **Chat modes.** `.chatmode.md` is the old VS Code name. Rename these files to `.agent.md`. (`VS/agent-customization/custom-agents.md` FAQ)

### 1.2 Frontmatter fields: the complete union across surfaces

| Field | Type | Surfaces | Semantics | Source |
|---|---|---|---|---|
| `description` | string, **required** | all | Purpose and capabilities. The main agent uses it to decide when to delegate, and it is shown in the agent list and the `task` tool. | `AGREF`; `CLIREF` "Custom agent frontmatter fields" |
| `name` | string | all | Display name. Defaults to the file name or ID. `--agent "Name"` also works. VS Code: the name is case-sensitive when you request it as a subagent. | `AGREF`; `CLIREF`; `VS/agents/run/subagents.md` |
| `tools` | list or comma-separated string | all | Omitted or `["*"]` means all tools. `[]` means no tools. `*` anywhere in the list means all tools. `server/tool` or `server/*` selects MCP tools. Unknown names are **ignored**. | `AGREF` "Tools"; `CLIREF` |
| `model` | string (VS Code and CLI also accept an array) | CLI, IDEs, (cloud ⚠) | The agent's model. If unset, the agent inherits the outer agent's model. If the session model is **Auto**, subagents always inherit the resolved session model and ignore this field. VS Code: a list is tried in order. | `CLIREF`; `VS/agent-customization/custom-agents.md`; `CL:371`, `CL:1964` (accepts VS Code display names such as "Claude Sonnet 4.5", "GPT-5.4 (copilot)") |
| `models` | string[] | CLI | Authored models in priority order. The first model the plan allows is used. If none resolves, the session model is used. Overrides `model`. | `CLIREF` |
| `modelPolicy` | `"preferred"` (default) or `"required"` | CLI | `required` locks dispatch to the authored models. Overrides are refused, and dispatch is refused rather than substituting a model. | `CLIREF`; ⚠ `CL:371` spells it `model-policy` |
| `reasoningEffort` | string (`low`, `medium`, `high`, …) | CLI, SDK | Default reasoning effort. If unset, it is inherited. | `CLIREF`; ⚠ `CL:194` spells it `reasoning-effort` |
| `include-custom-instructions` | bool, default false | CLI | When the agent runs as a **subagent**, it also loads the repository's `copilot-instructions.md`, `AGENTS.md` and `CLAUDE.md`. | `CLIREF` "Repository custom instructions for subagents" |
| `disable-model-invocation` | bool, default false | GitHub.com, CLI, VS Code | `true` means the agent cannot be auto-selected or invoked as a subagent, so it must be chosen manually. Equivalent to `infer: false`, and takes precedence over it. | `AGREF`; `VS/agent-customization/custom-agents.md` |
| `user-invocable` | bool, default true | GitHub.com, CLI, VS Code | `false` hides the agent from the picker, so it is reachable only programmatically or as a subagent. | `AGREF`; `VS/agents/run/subagents.md` |
| `infer` | bool, default true | — | **Retired** in `AGREF`. Still listed in `CLIREF` ("Allow auto-delegation by the main agent") ⚠. | `AGREF`; `CLIREF` |
| `target` | `vscode` or `github-copilot` | GitHub.com, VS Code | Restricts the agent to one environment. Defaults to both. | `AGREF` |
| `mcp-servers` | object | GitHub.com, CLI (**not** VS Code or IDEs) | MCP servers scoped to this agent. Same schema as `mcp-config.json`, written in YAML. `stdio` maps to `local`. Supports `${{ secrets.X }}` and `${{ vars.X }}`. In a plugin agent, `${PLUGIN_ROOT}` expands. | `AGREF`; `CLIREF`; `PLUGREF` "Plugin-shipped agent MCP servers" |
| `metadata` | map of string to string | GitHub.com (not IDEs) | Annotations. | `AGREF` |
| `hooks` | event map | CLI (since 1.0.97), VS Code Local (preview) | Hooks that run only while this agent is active. A subagent's `Stop` hooks run at `SubagentStop`. Remote (org-hosted) agents do not run them. | `HOOKREF` "Agent-scoped hooks"; `CL:3`; `VS/agent-customization/custom-agents.md` |
| `skills` | string[] | CLI, SDK | **Eagerly preloads** the full content of the named skills into the agent's context. Subagents do **not** inherit skills from the parent. | `CL:1991`; `GH/how-tos/copilot-sdk/features/custom-agents.md` "Per-agent skills". ⚠ Missing from the `CLIREF` table. |
| `deferred-tool-loading` | (bool?) | CLI | Opt into loading tools on demand through tool search, for agents with large tool lists. | `CL:1527`, `CL:499`, `CL:1129`. ⚠ Not in the reference docs. |
| `sidekick` | object (`triggers`, `behavior`, `maxSendsPerTurn`) | CLI | Makes the agent a background "sidekick". It runs on `user.message` or `session.context_changed` events and publishes to the session inbox. | `CLIREF` "Sidekick agents" |
| `agents` | string[] | VS Code | The agents this agent may call as subagents. `*` or omitted means all. `[]` means none. Listing an agent here overrides its `disable-model-invocation: true`. Requires the `agent` tool. | `VS/agent-customization/custom-agents.md`; `VS/agents/run/subagents.md` |
| `argument-hint` | string | VS Code (ignored on GitHub.com) | Placeholder hint shown in the chat input. | `VS/...custom-agents.md`; `AGREF` note |
| `handoffs[]` | `label`, `agent`, `prompt`, `send`, `model` | VS Code only (ignored on GitHub.com) | Buttons shown after a response that switch to another agent with a pre-filled prompt. `send: true` submits the prompt automatically. | `VS/agent-customization/custom-agents.md` "Handoffs"; `AGREF` note |
| `disallowedTools` | comma-separated string | VS Code, `.claude/agents` format only | Tools to block. | `VS/agent-customization/custom-agents.md` "Claude agent format" |

How fields are used in practice (`AC/agents/*.md`, 222 files):

| Field | Files using it |
|---|---|
| `name` | 222 |
| `description` | 221 |
| `tools` | 160 |
| `model` | 81 |
| `argument-hint` | 23 |
| `user-invocable` | 22 |
| `mcp-servers` | 20 |
| `disable-model-invocation` | 13 |
| `agents` | 3 |
| `handoffs` | 1 |

### 1.3 Tool aliases for `tools:` (`AGREF` "Tool aliases"; all are case-insensitive)

| Primary alias | Compatible aliases (note: Claude Code names) | Cloud-agent mapping | Purpose |
|---|---|---|---|
| `execute` | `shell`, `Bash`, `powershell` | `bash` / `powershell` | Run a shell command. |
| `read` | `Read`, `NotebookRead` | `view` | Read files. |
| `edit` | `Edit`, `MultiEdit`, `Write`, `NotebookEdit` | `str_replace`, `str_replace_editor` | Edit files. |
| `search` | `Grep`, `Glob` | `search` | Search files and text. |
| `agent` | `custom-agent`, `Task` | custom-agent tools | Invoke another custom agent (subagents). |
| `web` | `WebSearch`, `WebFetch` | n/a on the cloud agent | Fetch a URL and search the web. |
| `todo` | `TodoWrite` | n/a on the cloud agent | Task lists (VS Code). |

Notes:
* If an agent requests a shell tool by alias, it also receives the matching read, list and stop shell tools. (`CL:702`)
* Agents that use the `task` or `agent` alias keep the companion tools. (`CL:1128`)

Built-in CLI tool names, used by `--available-tools` and `--excluded-tools`, and also valid in `tools:` (`CLIREF` "Tool availability values"):

| Area | Tool names |
|---|---|
| Shell | `bash`/`powershell`, `list_bash`, `read_bash`, `stop_bash`, `write_bash` |
| Files | `view`, `create`, `edit`, `apply_patch` |
| Delegation | `task` ("Run subagents"), `list_agents`, `read_agent` ("Check background agent status"), `write_agent` ("Send a message to a running agent") |
| Other | `ask_user`, `glob`, `grep`/`rg`, `skill` ("Invoke custom skills"), `web_fetch` |

⚠ No built-in *web search* tool appears in the CLI tool list. The built-in `research` agent uses "GitHub search/exploration tools, web fetch/search". (`GH/concepts/agents/copilot-cli/about-custom-agents.md`) A `WebSearch` alias may therefore resolve to nothing in the CLI, and unknown names are silently ignored.

VS Code tool names are different (`VS/agents/reference/tools-reference.md`):

| Kind | Names |
|---|---|
| Tool sets | `read`, `search`, `edit`, `execute`, `web`, `agent`, `browser` |
| Individual tools | `agent/runSubagent`, `search/codebase`, `edit/editFiles`, `execute/runInTerminal`, `web/fetch`, `todos`, `vscode/askQuestions` |

The alias table makes the generic names portable across surfaces.

Permission patterns are a separate system from `tools:`. They take the form `shell(git:*)`, `write(path)`, `read`, `url(host)`, `memory` and `MyMCP(tool)`. (`CLIREF` "Tool permission patterns")

### 1.4 Locations and precedence

**CLI** (`CLIREF` "Custom agent locations"; `PLUGREF` diagram). The first agent loaded wins, deduplicated by ID:

1. User: `~/.copilot/agents/`. This overrides a project agent with the same ID. (`CFGREF` "agents/")
2. Project: `.github/agents/`, searched from the current working directory upward to the Git root. The deepest directory wins.
3. Project: `.claude/agents/`, also searched upward.
4. Added root: `.github/agents/` under a directory added with `--add-dir`.
5. Plugin: `<plugin>/agents/`. The location can be overridden by the manifest's `agents` field.
6. Remote: org or enterprise agents.

Further notes:
* A plugin **cannot override** a project or personal agent. (`PLUGREF` "Loading order")
* Built-in agents cannot be overridden by user components. (`PLUGREF`)
* `~/.claude/agents` is **not** loaded by the CLI. (`CL:1782`, `CL:1816`)
* Discovery is recursive. (`CL:1454`)
* New agents need a restart. In the `/agent` "create" flow, the docs say "Restart the CLI to load your new custom agent". (`create-custom-agents-for-cli.md`)
* Plugin agent IDs are addressed as `<plugin>:<agent>`, for example `--agent <plugin>:<agent>`. (`CL:443`) This matches our `agent_type: 'factory:researcher'` convention. ⚠ The only source is the changelog.

**GitHub.com / cloud agent.**
* Repository agents live in `.github/agents/NAME.md`. Org agents live in `/agents/NAME.md` in the org's `.github` or `.github-private` repo. Enterprise agents live in the `.github-private` repo of a designated org. (`RU/copilot-cli/custom-agents-about-details.md`)
* For name conflicts, the lowest level wins: repo beats org, and org beats enterprise. (`AGREF` "Custom agents names")
* Agents are versioned by the Git SHA of the profile file. (`AGREF` "Versioning")

**VS Code.**

| Scope | Location |
|---|---|
| Workspace | `.github/agents` |
| Workspace (Claude format) | `.claude/agents` |
| User (Copilot harness) | `~/.copilot/agents` |
| User (Claude harness) | `~/.claude/agents` |

Org agents appear when `github.copilot.chat.organizationCustomAgents.enabled` is on. (`VS/agent-customization/custom-agents.md`)

### 1.5 How a user selects an agent (CLI)
(`create-custom-agents-for-cli.md`, `GH/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents.md`)

* **`/agent` picker.** Built-in agents are not listed.
* **Explicit instruction.** For example, "Use the security-auditor agent on …".
* **Inference from `description`.** Only for agents where inference is allowed.
* **Command line.** `copilot --agent <id> --prompt "…"`, or `-p`. This works headlessly for plugin agents. (`CL:443`)
* **In `/fleet` prompts.** Write `@CUSTOM-AGENT-NAME`. (`GH/concepts/agents/copilot-cli/fleet.md`)
* **Custom instructions.** A *selected* agent, whether chosen with `--agent`, `/agent` or by inference, follows the repository's custom instructions. A *subagent* does not, unless it sets `include-custom-instructions: true`. (`create-custom-agents-for-cli.md`)

### 1.6 Built-in CLI agents (`CLIREF` "Built-in agents"; `GH/concepts/agents/copilot-cli/about-custom-agents.md`)

| Agent | Default model | Behaviour |
|---|---|---|
| `explore` | gpt-5.4-mini | Read-only. Answers in under 300 words. "Safe to run in parallel". |
| `task` | gpt-5.6-luna, falling back to gpt-5.4-mini, then claude-haiku-4.5 | Runs commands. Returns a brief summary on success and full output on failure. |
| `general-purpose` | claude-sonnet-4.6 | Full toolset, separate context. ⚠ `CL:1534` says it uses GPT-5.4 or GPT-5.5 when available. |
| `code-review` | claude-sonnet-4.6 | Never modifies code. |
| `security-review` | claude-sonnet-4.6 | Only reports findings with more than 80% confidence of exploitability. |
| `research` | claude-haiku-4.5 | Also invoked by `/research`. |
| `rubber-duck` | a complementary model from the opposite family | Critic. |

Built-ins can be disabled through `subagents.disabledSubagents`. (`CFGREF`; `CL:1164`)

---

## 2. Subagents

### 2.1 CLI: how the main agent invokes a subagent
* **Tool.** The main agent calls the built-in **`task`** tool ("Run subagents"). (`CLIREF` "Agent and task delegation tools")
  * The documented call form is **`task(agent_type="<agent id>")`**. (`GH/how-tos/copilot-sdk/features/fleet-mode.md` "Plugin sub-agents"; `GH/how-tos/copilot-sdk/features/plugin-directories.md`; `CL:1603`)
  * The custom agent's `description` "is shown in … the `task` tool". (`CLIREF`)
  * ⚠ The **full argument schema of `task` is not documented**. Only `agent_type` is named. A prompt or description argument is implied.
  * Model and effort precedence lists "an explicit per-call value" first. (`CLIREF`) This implies the main agent can pass a model per call. ⚠ The parameter name is undocumented.
* **Other entry points.**
  * The SDK's `session.startSubagent`. (`CLIREF`) ⚠ Not documented further.
  * `copilot --agent X -p …`, which starts a top-level session rather than a subagent.
* **Background agents.**
  * `read_agent` checks a background agent's status and turn history. It accepts `since_turn`. (`CLIREF`; `CL:428`, `CL:985`)
  * `write_agent` sends follow-up or steering messages. Multi-turn subagents are always enabled. (`CL:670`, `CL:108`)
  * `list_agents(scope="siblings"|"children"|"all")` and `write_agent(scope="siblings"|"children", message=…)` let agents coordinate. (`CLIREF` "Agent communication")
* **Sync versus background.** The SDK fleet docs advise:
  * "Use background sub-agents for truly parallel work."
  * "Use synchronous sub-agent calls for serialized steps or validation gates."
  * "Do not dispatch a single background sub-agent."

  (`fleet-mode.md` "Best practices") ⚠ The exact parameter that selects background mode is not documented.
* **Monitoring.** `/tasks` lists subagents and shell tasks. You can view, kill (`x`) or remove (`r`) them. (`GH/how-tos/copilot-cli/use-copilot-cli/speed-up-task-completion.md`)
* **Exit behaviour of `-p`.** A `-p` run waits up to `COPILOT_TASK_WAIT_TIMEOUT_SECONDS` (default 600) for background agents. (`CLIREF` env vars)

### 2.2 Parallelism
* **Yes, subagents run in parallel.**
  * "Where appropriate, tasks performed by subagents can be run in parallel." (`GH/concepts/agents/copilot-cli/about-custom-agents.md`)
  * `explore` "can be called in parallel to other subagents". (same file)
  * `general-purpose` can be run "in parallel when appropriate". (same file)
* **`/fleet` and `--fleet`.** These ask the main agent to split the work and orchestrate subagents in parallel. The *model* decides how to split it. (`GH/concepts/agents/copilot-cli/fleet.md`)
  * In the SDK, fleet is started with `session.rpc.fleet.start({prompt})`. Coordination uses the SQL `todos` and `todo_deps` tables. (`fleet-mode.md`)
* **Concurrency limit.** This counts subagents across the whole session tree. New requests are **rejected** until a slot frees. (`CLIREF` "Subagent limits")
  * Defaults by plan: Free/Education 2, Pro/Pro+ 4, Max 8, Business 16, Enterprise 32, usage-based billing 32.
  * Only usage-based-billing users can override it, through `subagents.maxConcurrency` (capped at 32) and `subagents.maxDepth` (capped at 256).
  * ⚠ The env var `COPILOT_SUBAGENT_MAX_CONCURRENT` says "default 32, range 1–256". (`CLIREF` env vars) This contradicts the plan-based table.

### 2.3 Depth limits
* ⚠ The sources conflict:

  | Source | Default depth | Max depth |
  |---|---|---|
  | `CLIREF` "Subagent limits" | 6 | 256 |
  | `CFGREF` `subagents.maxDepth` | 6 | 256 |
  | `CLIREF` env `COPILOT_SUBAGENT_MAX_DEPTH` | 4 | 128 |
  | `CL:746` | 4 ("lowered … from 6 to 4") | 128 |

  The changelog is the most recent, so **the probable default is 4.**
* **Behaviour at the limit.** "When the depth limit is reached, the innermost agent cannot spawn further subagents." (`CLIREF`) Nesting is therefore allowed in the CLI.
* **Tool filters.** Custom agents keep their tool filters in nested subagents. (`CL:928`) Subagent sessions keep the parent's tool restrictions. (`CL:934`)
* **VS Code Local harness.** Subagents **cannot** nest by default. Enable `chat.subagents.allowInvocationsFromSubagents` to allow it, with a maximum depth of 5. (`VS/agents/run/subagents.md` "Nested subagents")
* **IDE reusable text.** It says subagents "use the same tools and AI model as the main session, but they cannot create other subagents". (`RU/subagent-intro.md`, used by `GH/how-tos/copilot-in-your-ide/use-copilot-agents/use-subagents.md`) ⚠ This is outdated or IDE-specific, and contradicts the CLI and newer VS Code docs on models.

### 2.4 Context, instructions, memory
* **Separate context window.** "The subagent has its own context window … the main agent can then focus on higher-level planning." (`create-custom-agents-for-cli.md`)
* **No shared memory.** "Sub-agents are stateless across calls", so give each one complete context. (`fleet-mode.md`) VS Code: "A Local subagent doesn't inherit the main conversation history." (`VS/agents/run/subagents.md`)
* **Repository instructions.**

  | Agent | Receives repo instructions |
  |---|---|
  | Session agent | Yes |
  | `general-purpose` | Yes |
  | `explore`, `task`, `code-review` | No |
  | Custom agent run as a subagent | Only with `include-custom-instructions: true` |

  `--no-custom-instructions` wins over everything. (`CLIREF` "Repository custom instructions for subagents")
* **Skills.** Subagents do not inherit skills. Preload them with the agent's `skills` field. (`GH/how-tos/copilot-sdk/features/skills.md`)
* **Memory.** Only the root agent can `store_memory` or `vote_memory`. Subagents can only read. (`CLIREF` "Built-in agents")

### 2.5 Return value: text only
* **Free text.** The subagent's final message is returned to the parent as free text. The SDK: "The sub-agent's output is incorporated into the parent agent's response." (`GH/how-tos/copilot-sdk/features/custom-agents.md`)
* **`subagentStop` hook payload.** It carries `response: string // Full final subagent response text` (VS Code variant: `last_assistant_message`). (`HOOKREF` "subagentStop")
* **No output schema.** **No output-schema or structured-output parameter** is documented for `task`, `runSubagent`, `startSubagent` or SDK custom agents. A search of all of `gh-docs` for `outputSchema` or `structured output` found nothing relevant.
* **Enforcing JSON with a hook.** A `subagentStop` hook can return:
  * `{"decision":"block","reason":"<prompt>"}` to force another subagent turn, for example "your output did not match schema X; reply with JSON only". There is a runaway guard of 8 consecutive blocks.
  * `{"modifiedResponse": "…"}` to rewrite what the parent receives.

  (`HOOKREF` "agentStop / subagentStop decision control") The hook can be scoped with `matcher` on agent name for `subagentStart`. ⚠ The matcher is documented for `subagentStart`. `subagentStop` input includes `agentName` and `agentType`.
* **Injecting context.** `subagentStart` can return `additionalContext`, which is prepended to the subagent's first message. (`HOOKREF`)
* **Dynamic workflows** (§5) are the only documented place where structured results are supported. "A workflow can ask agents to return results in a specified format … Copilot can ask an agent to correct the format if needed." (`GH/concepts/agents/dynamic-workflows.md`)

### 2.6 Model per subagent
* **Precedence, highest first** (`CLIREF`):
  1. An explicit per-call value.
  2. `subagents.agents.<name>.model` / `modelPolicy` / `effortLevel` / `contextTier` in `~/.copilot/settings.json` or the `/subagents` picker. (`CFGREF`)
  3. The agent's `model`, `models` or `reasoningEffort`.
  4. The parent session's value.
* **Auto mode.** If the session model is Auto, subagents always inherit the resolved model. (`CLIREF`; `CL:1848`)
* **Fallback.** A model or effort that cannot be honoured falls back to the session value, unless `modelPolicy: "required"` is set, in which case dispatch is refused. (`CLIREF`)
* **Fleet.** "By default, subagents use a low-cost AI model", unless the custom agent profile specifies one or the prompt names a model. (`fleet.md`)
* **VS Code Local harness.** Precedence is: explicit `runSubagent` model parameter, then the agent's `model`, then Auto (if `chat.subagents.defaultToAuto` is on), then the main model. A model **above the main model's cost tier is refused**. (`VS/agents/run/subagents.md` "Select the model for a subagent")
* **CLI model IDs.** Examples: `claude-opus-5.5`, `claude-sonnet-5.5` (the default), `claude-haiku-5.5`, `gpt-5.4`, `gpt-5.3-codex`, `gemini-3.8-flash`. (`CLIREF` "Supported models") Our policy uses the aliases `opus`, `sonnet` and `haiku` (`policy/default-policy.json`, `tests/units.test.js:598`), so **they need a mapping table**.

### 2.7 Tool restrictions
* **`tools:` filters built-in and MCP tools for the agent.** `[]` means no tools. An omitted list means all tools. (`AGREF` "Tools processing")
* **Inheritance.** Subagents keep the parent's restrictions. (`CL:934`)
* **Permissions.** Subagents inherit the session's permission grants. A request that isn't already allowed surfaces as a normal prompt in the interactive session. (`GH/concepts/agents/dynamic-workflows.md` "Permissions"; `RU/...` "task" agent "with the same permissions granted or denied")
* **SDK.** `defaultAgent.excludedTools` hides tools from the main agent so that only subagents can use them. (`GH/how-tos/copilot-sdk/features/custom-agents.md` "Agent-exclusive tools")

### 2.8 SDK
* **Defining agents.** `createSession({ customAgents: [...] })` accepts `name` (required), `displayName`, `description`, `tools` (or null), `prompt` (required), `mcpServers`, `infer`, `skills`, `model` and `reasoningEffort`. `agent:` preselects an agent. (`GH/how-tos/copilot-sdk/features/custom-agents.md`)
* **Events.**

  | Event | Data |
  |---|---|
  | `subagent.selected` | — |
  | `subagent.started` | `toolCallId`, `agentName`, `model?` |
  | `subagent.completed` | `durationMs`, `totalTokens`, `totalToolCalls` |
  | `subagent.failed` | `error` |
  | `subagent.deselected` | — |

  Envelopes carry `agentId`. (same file) **No result payload is shown in the `completed` event.** ⚠
* **Plugins.** `--plugin-dir` registers plugin agents as `task(agent_type=...)` types. `COPILOT_PLUGIN_DIR_ONLY=true` makes the plugin set deterministic. (`GH/how-tos/copilot-sdk/features/plugin-directories.md`)

---

## 3. Agent skills

### 3.1 SKILL.md format

**CLI frontmatter** (`CLIREF` "Skill frontmatter fields"):

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Must start with a letter or number. May contain letters, numbers, `-`, `_`, `.`, `:` and spaces. Max 64 characters. Colons allow namespacing, as in `my-plugin:search`. |
| `description` | yes | Max 1024 characters. Used for auto-selection. |
| `argument-hint` | no | Shown in the picker, for example `"[target] [mode]"`. (`CL:1095`) |
| `allowed-tools` | no | A string or array of tools auto-approved **while the skill is active**. `"*"` means all. This is pre-approval of permissions, not a restriction. (`RU/creating-adding-skills.md`) |
| `user-invocable` | no, default true | Whether the skill can be invoked as `/NAME`. |
| `disable-model-invocation` | no, default false | Stops the agent from auto-invoking the skill. Fully honoured since `CL:615`. |
| `license` | no | `RU/creating-adding-skills.md` |

**VS Code differences** (`VS/agent-customization/agent-skills.md` "Header"):
* `name` may contain only lowercase letters, digits and hyphens, and **must match the directory name**. Invalid names cause the skill to "silently fail to load". Do **not** add namespace prefixes; plugin skills are auto-prefixed as `/plugin:skill`.
* `context: fork` is behind a feature flag and needs `github.copilot.chat.skillTool.enabled`. It runs the skill in a dedicated subagent and returns only its result. This is VS Code-only. The CLI changelog has no equivalent.

⚠ **Portability rule.** Use lowercase-hyphen names equal to the directory name. All 11 of our skills already comply.

Other notes:
* **Body.** Copilot injects the body when the skill is used, without the frontmatter. (`CL:1622`) Files in the skill directory are made available, and the skill can reference scripts relative to itself. (`RU/creating-adding-skills.md`)
* **VS Code resources.** In VS Code, only files referenced from `SKILL.md` are loaded. (`VS/...agent-skills.md`)
* **Extra fields in practice.** awesome-copilot skills also use `license`, `metadata` and `compatibility`, from the agentskills.io spec. (`AC/skills/*/SKILL.md` key counts: name 429, description 429, license 57, metadata 49, compatibility 32, argument-hint 12, allowed-tools 11)

### 3.2 Discovery locations

**CLI** (`CLIREF` "Skill locations"). The first source found wins for duplicate names:

1. Project: `.github/skills/`, then `.agents/skills/`, then `.claude/skills/`, then a parent `.github/skills/` (for monorepos).
2. Personal: `~/.copilot/skills/`, then `~/.agents/skills/`.
3. Plugin `skills/` directories.
4. `COPILOT_SKILLS_DIRS`, `skillDirectories` and `--add-dir <path>/.github/skills/`.
5. Bundled CLI skills, at the lowest priority.
6. Remote org or enterprise skills.

⚠ `CL:1482` says `--plugin-dir` skills rank **above** personal skills ("project > plugin-dir > personal > custom").

Other discovery notes:
* **Plugin name clashes.** Two plugins can provide a skill with the same name. Both remain available as `/plugin-a/search` and `/plugin-b/search`; the bare name goes to the higher-priority plugin. (`CLIREF`)
* **Plugin root skill.** It is displayed as `/plugin`. (`CL:718`)
* **Commands.** `.claude/commands/*.md` files are treated as **commands**, an alternative skill format. They support `argument-hint`, `description`, `allowed-tools` and `disable-model-invocation`, and rank below skills. (`CLIREF` "Commands")

**GitHub.com, cloud agent, VS Code.**

| Scope | Locations |
|---|---|
| Project | `.github/skills`, `.claude/skills`, `.agents/skills` |
| Personal | `~/.copilot/skills`, `~/.agents/skills` (VS Code also `~/.claude/skills`) |

(`GH/concepts/agents/about-agent-skills.md`; `VS/...agent-skills.md`)

### 3.3 Invocation
* **Automatic.** Copilot uses a skill when the prompt matches its description, and injects `SKILL.md` into context. (`RU/skills-using.md`) In the CLI this goes through the `skill` tool. (`GH/concepts/agents/copilot-cli/comparing-cli-features.md`)
* **Manual.** Type `/SKILL-NAME [args]` or "Use the /frontend-design skill to …". (`GH/how-tos/copilot-cli/customize-copilot/add-skills.md`; `CLIREF`)
  * Several skills can be used in one message. (`CL:1652`)
  * `-i "/skill-name …"` works as the initial prompt. (`CL:1798`)
  * Skills work as slash commands in ACP clients. (`CL:1732`)
* **Visibility matrix** (`VS/...agent-skills.md` "Use skills as slash commands"):

  | Setting | Slash command | Auto-loaded |
  |---|---|---|
  | default | yes | yes |
  | `user-invocable: false` | no | yes |
  | `disable-model-invocation: true` | yes | no |
  | both | no | no (disabled) |

* **Management commands.**
  * Interactive: `/skills`, `/skills list|info|add|remove|reload`.
  * Command line: `copilot skill list [--json] | add <src> [--project] | remove | enable | disable`.
  * Settings: `disabledSkills`, `ignoredSkillsLocations`, `dynamicRetrieval.skills`, which controls embeddings-based retrieval of skills. (`CLIREF`; `CFGREF`; `CL:1018`)
  * GitHub CLI: `gh skill search|preview|install`. (`GH/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills.md`)
* **Preloading into an agent.** Set the agent's `skills: [...]` field (§1.2).
* **Arguments.** ⚠ No `$ARGUMENTS`-style substitution is documented for skills. Text after `/skill` is simply added to the context. (`VS/...agent-skills.md`: "You can add extra context after the slash command")

### 3.4 Skills versus instructions versus agents
* Custom instructions suit short rules that apply to almost every task. Skills suit detailed instructions that are needed only when relevant. (`RU/skills-compared.md`)
* A custom agent is a "persona" with its own tools and context. (`comparing-cli-features.md`)

---

## 4. Custom instructions and prompt files

### 4.1 Repository and user instructions

**CLI** (`GH/how-tos/copilot-cli/customize-copilot/add-custom-instructions.md`; `CLIREF` "Custom instructions locations"). All of these are loaded and **merged**, with no defined precedence:

| File | Where it is read |
|---|---|
| `.github/copilot-instructions.md` | Repo root, cwd, and the directories between them |
| `.github/instructions/**/*.instructions.md` | Path-specific (see below) |
| `AGENTS.md` | Root, cwd, intermediate directories, and directories on the path of files being worked on |
| `CLAUDE.md`, `.claude/CLAUDE.md` | Same as `AGENTS.md` |
| `GEMINI.md` | Same as `AGENTS.md` |
| `.claude/rules/**/*.md` | Path-scoped with `paths:` or `applyTo:` (`CL:151`) |
| `$HOME/.copilot/copilot-instructions.md` | User level |
| `$HOME/.copilot/instructions/**/*.instructions.md` | User level |
| `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` | Extra directories |

* **Imports.** `@path` imports work in `AGENTS.md`, `CLAUDE.md` and `copilot-instructions.md`. They resolve recursively and stay inside the repo. They do not work in `GEMINI.md` or `*.instructions.md`.
* **Controls.** `/instructions` toggles individual files. `--no-custom-instructions` disables them all. `/init` generates `.github/copilot-instructions.md`.

**Path-specific instruction files** (`RU/custom-instructions-path.md`):
* Frontmatter `applyTo: "glob[,glob]"`. In the CLI, `.claude/rules` also accepts `paths:`.
* Optional `excludeAgent: "code-review" | "cloud-agent"`.
* Optional `description`.

They are supported in VS Code, Visual Studio, the cloud agent and code review. (`RU/repository-custom-instructions-types.md`) awesome-copilot instruction files use `applyTo` (187 files), `description` (180) and `excludeAgent` (1).

**`AGENTS.md`.** The nearest `AGENTS.md` in the directory tree takes precedence. (`RU/custom-instructions-agents.md`) A single root `CLAUDE.md` or `GEMINI.md` is accepted on GitHub.com. (`GH/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions.md`)

**Support per surface.** See `GH/reference/custom-instructions-support.md`. For example, path-specific instructions and `AGENTS.md` work for the cloud agent, and VS Code chat supports repository, path and agents instructions.

### 4.2 Prompt files
* **Format.** `.github/prompts/*.prompt.md`, with frontmatter fields `description`, `name`, `argument-hint`, `agent` (`ask` | `agent` | `plan` | a custom agent name), `model` and `tools`. The body can use `#file:`, `#tool:` and `${input:var}`. (`VS/agent-customization/prompt-files.md`)
* **Where they work.** VS Code, Visual Studio and JetBrains only. They are in public preview and are **not supported by the CLI or GitHub.com**. (`RU/prompt-files-available-in-editors.md`; `GH/reference/customization-cheat-sheet.md` matrix)
* **VS Code harnesses.** In VS Code, prompt files work **only in the Local harness**; "for other harnesses, create an agent skill". (`VS/...prompt-files.md`)
* **Tool priority.** Prompt-file `tools` come first, then the referenced agent's `tools`, then the default tools. (`VS/...prompt-files.md`)
* **Consequence for the port.** Use **skills, not prompt files**. Our `/factory:*` commands become skills.

---

## 5. Dynamic workflows (closest equivalent to the Workflow tool)

(`GH/concepts/agents/dynamic-workflows.md`; `GH/how-tos/use-copilot-agents/use-dynamic-workflows.md`; `CLIREF` "Using `copilot workflow run`"; `GH/reference/copilot-cli-reference/cli-programmatic-reference.md` "Running dynamic workflows")

* **What they are.** "A dynamic workflow is a program that defines how a task is carried out … Steps can run one after another, in parallel, or as a mixture of both." Dynamic workflows can:
  * divide work and run tasks in parallel
  * pass results between stages
  * have subagents verify each other's findings
  * combine results
  * ask the user for input
  * pause at checkpoints
* **Structured results.** "A workflow can ask agents to return results in a specified format so that later steps can use them. Copilot can ask an agent to correct the format if needed."
* **Packaging.** Workflows live in CLI **extensions**: `extension.mjs`, `.cjs` or `.js`, written in Node.js only. The extension runs as a separate process and uses `@github/copilot-sdk/extension` `joinSession`. (`GH/concepts/agents/copilot-cli/about-cli-extensions.md`; `GH/tutorials/create-an-extension.md`)

  | Scope | Location |
  |---|---|
  | Session | `~/.copilot/session-state/<id>/extensions/<name>/extension.mjs` |
  | User | `~/.copilot/extensions/<name>/` |
  | Project | `.github/extensions/<name>/` |
  | Plugin | via the plugin manifest's `extensions` field (legacy plugins), or `com.github.copilot/extensions/` (Agent Plugins; `CL:480`) |

* **Running a workflow.**
  * Natural language, for example "Run the X dynamic workflow …". It runs in the background and reports back. The agent runs a workflow only when explicitly asked, **"or when a skill or slash command instructs it to do so"**, so our `start` skill can trigger it.
  * An extension's slash command, tool, hook or canvas.
  * The SDK.
  * Headless: `copilot workflow run NAME --args JSON|@file [--result-file F] [-s] [--output-format json]`.
    * The final JSONL record is `{type:"workflow.result", data:{name, run:{runId, status: completed|halted|paused|cancelled|error, result, pauseInfo, reason, error, failure}, resultFile}}`.
    * **No permission prompts are shown.** Pre-grant tools with `--allow-tool` and `--allow-url`.
    * Cannot be combined with `-p`, `--agent`, `--fleet`, `--autopilot` or `--resume`.
    * `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true` is needed to load project extensions in untrusted folders.
* **Limits.**
  * The limit types are max concurrent agents, max total agents, timeout, and an approximate AI-credit cap.
  * Limits can be set in the prompt, in the workflow code, or in the settings `workflows.defaultLimits.maxConcurrentSubagents`, `maxTotalSubagents`, `timeoutSeconds` and `maxAiCredits`, in that priority order.
  * The concurrency limit queues agents rather than failing.
  * Other limits stop the run, which stays resumable.
* **Observability and resume.**
  * `/workflows` shows the phase, progress messages, active and total subagents, and credits. You can pause (`P`), cancel (`X`) or resume (`R`) a run.
  * Resumed runs reuse saved results from completed steps and subagents.
  * Each run or resume creates an OTel `invoke_workflow` span.
* **Permissions.** A workflow's subagents inherit the session's grants. Prompts appear in the interactive session, and a subagent waits for the answer.
* **Requirements.**
  * **Public preview.** Needs `--experimental` or `/experimental on`.
  * Not available on legacy annual Pro/Pro+ plans that use request-based billing.
  * `/workflows` "Requires a token-based-billing plan". (`CLIREF`)
  * Available in the CLI, the GitHub Copilot app and the SDK. **Not** available in VS Code Local or on the cloud agent ⚠ (inferred: those surfaces aren't listed).
* **⚠ Authoring API not documented.** The docs say only "write the extension yourself, using Copilot's built-in authoring guidance". You get that guidance by asking Copilot "Show me the guidance for writing dynamic workflows". awesome-copilot has 10+ extensions but **no dynamic-workflow example** (`AC/extensions/*/extension.mjs`). The JavaScript API for agent calls, parallel map, phase or log, format and schema requests, and limits must therefore be learned from the CLI itself.
* **How they differ from autopilot and fleet.** Fleet lets the *model* decide how to split work. A workflow is *code-defined*. (`dynamic-workflows.md` table)

---

## 6. Differences per surface (summary)

| Capability | Copilot CLI | VS Code | GitHub.com cloud agent | SDK |
|---|---|---|---|---|
| Custom agents | ✓ `.github/agents`, `.claude/agents`, `~/.copilot/agents`, plugins, org/ent | ✓ (Local and Copilot harnesses; `.github/agents`, `.claude/agents`, `~/.copilot/agents`, `~/.claude/agents`) | ✓ repo, org, ent; picked from a dropdown or on issue assignment | `customAgents` in config, or plugin dirs |
| `model` in agent | ✓ (+`models`, `modelPolicy`, `reasoningEffort`) | ✓ string or array | ⚠ `AGREF` says yes, `RU/custom-agents-configuring-profile.md` says IDEs only. Cloud model selection is per task. | ✓ |
| `mcp-servers` in agent | ✓ | ✗ (ignored) | ✓ | `mcpServers` |
| `handoffs`, `argument-hint`, `agents` | ✗ (n/a) | ✓ | ignored | — |
| Subagents | ✓ `task` tool, parallel, nesting to 4 (or 6) | ✓ Local harness `runSubagent`, no nesting by default (max 5); Copilot harness uses CLI semantics | ✗ (cheat sheet: GitHub.com subagents ✗) | ✓ (`fleet.start`, `startSubagent`) |
| Skills | ✓ | ✓ (+`context: fork`) | ✓ | ✓ `skillDirectories` |
| Prompt files | ✗ | ✓ (Local harness only) | ✗ | ✗ |
| Hooks incl. `subagentStop` | ✓ | preview | ✓ (Linux, ephemeral filesystem; `"ask"` is treated as deny) | events only |
| Dynamic workflows | ✓ (experimental) | ✗ | ✗ | ✓ |
| `/fleet` | ✓ | — | — | `session.rpc.fleet.start` |

Sources: `GH/reference/customization-cheat-sheet.md` "IDE and surface support"; `AGREF`; `VS/agents/run/agent-harnesses.md`, where the "Copilot" harness runs the Copilot SDK in an Agent Host and "Local" is VS Code's built-in harness; `HOOKREF` "Cloud agent execution environment".

---

## 7. Plugin packaging (relevant subset)
* **Manifest locations.** A legacy manifest can be at `.plugin/plugin.json`, `plugin.json`, `.github/plugin/plugin.json` or **`.claude-plugin/plugin.json`**, checked in that order. Component fields `agents` (default `agents/`), `skills` (default `skills/`), `commands`, `hooks`, `mcpServers`, `lspServers` and `extensions` are optional. (`PLUGREF` "File locations", "Component path fields")
* **What this means for us.** Our Claude Code layout (`.claude-plugin/plugin.json`, `agents/*.md`, `skills/*/SKILL.md`) should load directly. Test it with `copilot --plugin-dir plugins/factory`.
* **Agent Plugins 1.0** (`$schema` `agent-plugins.org/schemas/1.x`).
  * The manifest is closed. Only `skills/` and `mcp.json` are portable components.
  * Copilot-specific agents, commands, rules, hooks and extensions go under `com.github.copilot/`. (`PLUGREF`)
  * awesome-copilot plugins use this format with the `extensions["com.github.awesome-copilot"]` field. (`AC/plugins/ai-team-orchestration/plugin.json`)
* **Repo-level activation.** `.github/copilot/settings.json` can declare `enabledPlugins` and `extraKnownMarketplaces`, and the cloud agent also reads these. (`CFGREF`)

---

## 8. Mapping: Software Factory → Copilot

| Factory component | Copilot equivalent | Confidence | Notes |
|---|---|---|---|
| `skills/start` (driver loop, user-invocable, `argument-hint`) | Plugin skill `skills/start/SKILL.md`, invoked as `/start` (or `/factory/start` on a name clash). Auto-load is driven by `description`. | **High** | Same frontmatter. Replace the instruction "start the workflow with the Workflow tool" with "run the `factory-<wf>` dynamic workflow with args …" plus the fallback below. |
| 10 skills with `user-invocable: false` (amend, clarify, distill, gate, intake, park, ship) | The same field, with identical semantics: hidden from `/` and still auto-loadable. | **High** | `CLIREF` skill fields. |
| `console`, `review`, `why` (user-invocable, `argument-hint`) | Skills with `argument-hint`. | **High** | — |
| Skill names (`start`, `clarify`, …) | Valid names. In VS Code the plugin prefix is added automatically. | High | Don't add `factory:` to `name`. |
| 19 `agents/*.md` (`name`, `description`, `tools: Read, Grep, Glob, Bash, Write, Edit`) | Plugin agents. `.md` is accepted. The comma-separated tools string uses aliases: Read→read, Grep/Glob→search, Bash→execute, Write/Edit→edit, WebFetch/WebSearch→web. | **High** (format), Medium (`WebSearch` in CLI) | Optionally rename to `.agent.md` and add `user-invocable: false`. Use `include-custom-instructions: true` for the builder and reviewers if repository conventions matter. |
| `agent_type: 'factory:<role>'` | `task(agent_type="factory:<role>")`. Plugin agent ID is `<plugin>:<agent>`. | Medium | The only source is `CL:443`. Verify with `/agent` or `--agent factory:researcher`. |
| Per-call `model` (`opus`/`sonnet`/`haiku`, builder escalation) | Explicit per-call model in `task`, or the `/subagents` settings `subagents.agents.<id>.model`, or agent `model` / `models`. | Medium | Map the aliases to IDs (`claude-opus-5.5`, …). Per-call parameter name is undocumented. Auto mode ignores agent models. Plan entitlements can silently fall back unless `modelPolicy: required` is set. |
| `schema` on each `agent()` call (JSON-schema'd output) | (a) A dynamic workflow's "specified format" with auto-correction. (b) Prompt the agent "reply with JSON matching …", plus a `subagentStop` hook that validates and returns `decision: block` with the reason. (c) Validation in `factory record` / CLI. | Medium (a), High (b)+(c) | `task` returns text only. |
| `pipeline()` parallel fan-out | Dynamic workflow parallel steps, or several `task` calls in one turn (background), or `/fleet`. | Medium–High | Concurrency is capped by plan (Pro 4): extra subagents are rejected in plain `task`, and queued in workflows. |
| Retry once on a missing result | Workflow code, or skill instructions plus `subagent.failed` (SDK) / `read_agent`. | High (workflow), Medium (skill) | — |
| `phase()` / `log()` / roster | Workflow phases and progress messages shown in `/workflows`. OTel `invoke_workflow`. SDK `subagent.*` events with `model`, tokens and duration. | Medium | The workflow API names are undocumented. |
| Budgets (`agent_runs`) | `workflows.defaultLimits.maxTotalSubagents`, `maxConcurrentSubagents`, `timeoutSeconds`, `maxAiCredits`. | High (concept) | — |
| Envelope result → `factory record` | `copilot workflow run … --result-file .factory/scratch/envelope.json`, or the in-session workflow result. | High (headless), Medium (in session) | — |
| Workflows that "cannot read files or run commands" | Copilot extension code **can** run Node code directly. | — | It could call `factory wfargs` and `factory record` itself, which simplifies the protocol. |
| `realize` builders in git worktrees | Subagents share the session cwd. There is no per-subagent cwd parameter. ⚠ | Low–Medium | Builders must `cd` into the worktree path given in the prompt, and permissions must cover those paths. Alternatively spawn `copilot -C <worktree> --agent factory:builder -p … --output-format json` per task from extension code. (`-C DIRECTORY`: "Change working directory before doing anything else", `CLIREF` options). |
| Hooks (`hooks/`) | Plugin `hooks.json`. Event names differ (`preToolUse`, `subagentStop`, …), with VS Code / Claude-compatible variants. | Medium | Out of scope here; see `HOOKREF`. |
| `/factory:*` slash commands | Skills (prompt files are unsupported in the CLI). `.claude/commands` also works in the CLI as "commands". | High | — |

---

## 9. Recommendation: running the 5 workflows on Copilot

### 9.1 Primary: port the workflows to Copilot dynamic workflows in one plugin extension
1. **Package.** Ship `extensions/factory-workflows/extension.mjs` in the plugin, through the legacy manifest's `extensions` field or `com.github.copilot/extensions/` for Agent Plugins. Register 5 workflows: `factory-ground`, `factory-fanout-judge`, `factory-decompose`, `factory-realize`, `factory-reconcile`. Keep the existing brief → envelope contract unchanged, so `factory wfargs` and `factory record` stay the same.
2. **Get the API.** Before writing code, run `copilot --experimental` and ask "Show me the guidance for writing dynamic workflows". Confirm that the agent-call API supports:
   * a custom agent type (`factory:<role>`)
   * a per-call model
   * a result format or schema
   * parallel map
   * phases

   Then map `agent()`, `pipeline()`, `phase()` and `log()` one-to-one. This is the **main open risk**.
3. **Trigger.** The `start` skill tells Copilot to "run the factory-<wf> dynamic workflow with args <brief JSON>". Docs say a skill may instruct this. For CI or scripts, use `copilot workflow run factory-<wf> --args @brief.json --result-file .factory/scratch/envelope.json -s --output-format json --allow-tool=read,write,shell(git:*),shell(node:*)` and grant URLs as needed.
4. **Limits.** Map `brief.budgets.limit` and `max_parallel_tasks` to the workflow limits. Remember the plan concurrency caps (2, 4, 8, 16 or 32).

Fit per workflow:

| Workflow | Fit | Notes |
|---|---|---|
| `ground` | Very good | Parallel read-only probes. The researcher needs `web`; ⚠ the CLI has `web_fetch` but no documented web search. |
| `fanout-judge` | Very good | Gate, parallel analysts, judge, critique, then per-finding verifiers. This is exactly the documented "subagents verify each other's findings" pattern. |
| `decompose` | Good | Mostly sequential rounds: planner → CLI validate → god-eye. |
| `realize` | Good but hardest | Waves × (builder → tester) with retries and model escalation in worktrees. Needs the cwd strategy (prompted `cd`, or child `copilot -C` processes) and generous write permissions. Concurrency caps make waves slower on Pro plans. |
| `reconcile` | Fine | Sequential integrator. Could even be plain extension code plus one agent. |

### 9.2 Fallback A (no experimental or workflow entitlement): in-session `task` fan-out driven by the skill
Rewrite the "No Workflow tool?" section of `skills/start/SKILL.md` for Copilot:
1. Dispatch every fan-out item in one turn with `task(agent_type="factory:<role>")` as background subagents, passing the item's prompt, the model (mapped ID), and "reply with only JSON matching this schema: …".
2. Collect results with `read_agent`.
3. Retry once.
4. Run the judge, critique, verifier and builder/tester steps exactly as `workflows/*.js` does.
5. Build the envelope and validate it in `factory record`.

Add a plugin `subagentStop` hook (matched on `factory:*` agent names) that `JSON.parse`s the response, checks it against the schema, and returns `{"decision":"block","reason":"Return valid JSON for schema …"}` on failure. This gives schema enforcement that the `task` tool lacks.

Expect less determinism, because the model drives the orchestration, and concurrency rejections above the plan cap.

### 9.3 Fallback B (fully deterministic, any plan): let the factory Node CLI orchestrate headless Copilot processes
The `workflows/*.js` logic is plain JavaScript. A `factory run <wf>` command could execute it with an `agent()` implementation that spawns:

```
copilot --agent factory:<role> --model <id> -p "<prompt>" -s --output-format json --allow-tool …
```

using `--plugin-dir` and `COPILOT_PLUGIN_DIR_ONLY=true`. This could also use the SDK's `customAgents` / `startSubagent`.

| | |
|---|---|
| Pros | Exact parity with today's semantics: schema checks, retries, roster, budgets, per-task cwd (`-C <worktree>`), and no experimental flag. |
| Cons | Each call is a separate top-level session, so there is no shared session tree in `/tasks` and more start-up cost. Permissions must be pre-granted. Billing is per session. |

### 9.4 Not recommended
* `/fleet` / `--fleet` as the engine. The model decides decomposition, which breaks the factory's fixed gates, budgets and envelope contract. It is fine only as a user-facing accelerator.
* Prompt files. They don't work in the CLI.
* VS Code `handoffs`. They are UI-only and VS Code-only.

### 9.5 Verification checklist before committing to the port
1. Load test: `copilot --plugin-dir plugins/factory`. Check that `/skills list` shows 11 skills and `/agent` shows 19 agents, and that the agent IDs are `factory:<name>`.
2. Confirm that the `tools: Read, Grep, …` alias mapping works, especially `WebSearch` in the CLI.
3. Get the dynamic-workflow authoring guidance and check its agent-call options (agent type, model, schema or format, parallelism).
4. Pin down the effective `subagents.maxDepth` and `maxConcurrency` for the target plan. The docs disagree (§2.2, §2.3).
5. Decide how models are mapped and whether to set `modelPolicy: required`, given that Auto mode overrides agent models.
