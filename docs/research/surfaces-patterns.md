# Porting the Software Factory to GitHub Copilot: surfaces, SDK, patterns, gaps

Date: 2026-10-14. Source snapshot: Copilot CLI changelog up to **1.0.97 (2026-10-13)**.

**Path conventions.** Paths are relative to the research directory
`/tmp/claude-0/-home-user-claude-factory/1a25c527-314a-531a-a215-9c600594b7f2/scratchpad/research/`:

- `GH/` = `gh-docs/content/copilot/`
- `VS/` = `vscode-docs/docs/`
- `CL` = `copilot-cli/changelog.md` (cited by version)
- `AC/` = `awesome-copilot/`
- `F/` = `/home/user/claude-factory/plugins/factory/`

**What is being ported** (from `/home/user/claude-factory/README.md` and `F/docs/ARCHITECTURE.md`):

- The driver skill `start` loops on `factory next`.
- Five Workflow-tool scripts (`F/workflows/*.js`) fan out 19 agents with `agent(prompt, {schema, agentType, model})` and `pipeline()`.
- Seven hook events (`F/hooks/hooks.json`):
  - UserPromptSubmit applies approve/deny.
  - PreToolUse runs the guard.
  - Post/SubagentStart/Stop write the activity log.
  - Stop refuses "done".
  - SessionStart injects context.
- A separate inspector plugin audits `.factory/`.

---

## 0. Key finding up front

Copilot's surfaces are no longer separate products. They share one runtime:

- **The CLI is the runtime.** The GitHub Copilot app "is built on Copilot CLI" (`GH/concepts/copilot-surfaces/github-copilot-app.md` §Introduction).
- **VS Code's Copilot harness uses the same runtime.** It "uses the Copilot SDK… runs in the Agent Host" and "uses the same SDK hook implementation as Copilot CLI" (`VS/agents/concepts/agent-harnesses.md` §Harness and host; `VS/agent-customization/hooks.md` §Choose the hook implementation).
- **The SDK drives the CLI.** It "is a transport layer — it sends your prompt to the Copilot CLI over JSON-RPC" (`GH/how-tos/copilot-sdk/features/agent-loop.md` §Architecture).

So a port that works in the **CLI** also lights up in the **app** and in **VS Code (Copilot harness)**.

The CLI also reads Claude Code plugin artifacts almost directly:

- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (`GH/reference/copilot-cli-reference/cli-plugin-reference.md` §File locations).
- Claude-style nested `matcher/hooks` groups (CL 1.0.6).
- PascalCase event names with Claude tool names in matchers and payloads (CL 1.0.62; `GH/reference/hooks-reference.md` §"Claude-format matchers").
- The `CLAUDE_PLUGIN_ROOT` env var in plugin hooks (CL 1.0.26).
- Plain `.md` agent files (`GH/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli.md` L135).

The single biggest missing piece is Claude Code's **Workflow tool**. Copilot has two candidate replacements:

1. **Dynamic workflows**: code-defined, deterministic, parallel, with limits and pause/resume. They are public preview, behind `--experimental`, and their authoring API is not in the local docs.
2. **A Copilot SDK runner**: generally available, documented, deterministic if you orchestrate in code.

---

## 1. Surface comparison

| Capability | **Copilot CLI** | **VS Code agent mode** | **Cloud agent** (github.com, async → PR) | **Copilot SDK** | **GitHub Copilot app** (desktop) |
|---|---|---|---|---|---|
| **Custom agents** | Yes. `.agent.md` or `.md` in `~/.copilot/agents`, `.github/agents`, `.claude/agents`, plugin `agents/` (`GH/reference/copilot-cli-reference/cli-plugin-reference.md` loading diagram). Frontmatter per `GH/reference/custom-agents-configuration.md`: `tools`, `model`, `disable-model-invocation`, `user-invocable`, `mcp-servers`. Agent-scoped `hooks` in frontmatter since CL 1.0.97 (`GH/reference/hooks-reference.md` §Agent-scoped hooks). | Yes, per harness. Copilot harness reuses CLI locations. Local harness adds `agents`, `handoffs`, `hooks` (Local-only) (`VS/agent-customization/custom-agents.md` frontmatter table). Claude `.md` format and Claude tool names are mapped (same file, §Claude agent format). | Yes. `.github/agents`. `mcp-servers` and `metadata` are cloud/CLI-only fields (`GH/reference/custom-agents-configuration.md`). | Yes. `customAgents: [{name, prompt, tools, model, infer, …}]`. Per-agent skills and MCP (`GH/how-tos/copilot-sdk/features/custom-agents.md` §Configuration reference). | Yes. Agent picker and `/agent` (`GH/how-tos/github-copilot-app/customize-github-copilot-app.md` §Using custom agents). |
| **Subagents & parallelism** | Built-in `task` tool. Built-in agents explore/task/general-purpose/code-review/research/rubber-duck/security-review run "in parallel where appropriate" (`GH/concepts/agents/copilot-cli/about-custom-agents.md`). `/fleet` and `--fleet` have the LLM decompose and run subagents in parallel (`GH/concepts/agents/copilot-cli/fleet.md`). `subagents.maxConcurrency` cap 32 and `maxDepth` are honored only on usage-based billing (`GH/reference/copilot-cli-reference/cli-config-dir-reference.md` L525-526). **Dynamic workflows** give deterministic code-defined fan-out (`GH/concepts/agents/dynamic-workflows.md`). | Copilot harness: same as CLI (`VS/agents/run/subagents.md` §Subagents by harness). Local harness: the `runSubagent` tool. Nesting is off by default (`chat.subagents.allowInvocationsFromSubagents`), max depth 5 (same file L187). | Single agent per job. Custom agents can be selected or inferred. No documented user-visible fan-out. | `session.rpc.fleet.start()` is experimental and LLM-decomposed (`GH/how-tos/copilot-sdk/features/fleet-mode.md`). Real determinism comes from **your code** creating many sessions ("A single CLI server can handle many concurrent sessions", `GH/how-tos/copilot-sdk/setup/scaling.md` §Vertical scaling). Subagent lifecycle events exist (`subagent.started/completed/failed`, `custom-agents.md` §Event types). | "Run multiple isolated agent sessions simultaneously, each with a dedicated git worktree" (`GH/concepts/copilot-surfaces/github-copilot-app.md`). `/orchestrate` and `/pr-stack` create child sessions (`GH/reference/github-copilot-app-reference/built-in-skills.md`). Dynamic workflows and the Workflows button (`GH/how-tos/use-copilot-agents/use-dynamic-workflows.md`). |
| **Skills** | Yes. `SKILL.md` in `.github/skills`, `.agents/skills`, `.claude/skills`, `~/.copilot/skills`, plugin `skills/`. `.claude/commands/` also works (`cli-plugin-reference.md` loading diagram). | Yes (`VS/agent-customization/agent-skills.md`). | Yes, via repo config and plugins (`GH/concepts/agents/about-plugins.md`). | `skillDirectories`, `disabledSkills` (`GH/how-tos/copilot-sdk/troubleshooting/compatibility.md`). | Yes. "Any skills configured for your repositories or Copilot CLI are automatically available" (`customize-github-copilot-app.md`). |
| **Hooks (events honoured)** | All of them: `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `userPromptTransformed`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `permissionRequest`, `agentStop`, `subagentStart`, `subagentStop`, `preCompact` (notify-only), `errorOccurred`, `notification` (`GH/reference/hooks-reference.md` §Hook events). Hook types are command, http, and prompt (sessionStart only). | Copilot harness: CLI implementation, but "verify that the event is available in the selected VS Code version" (`VS/agent-customization/hooks.md`). Local harness: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact` (`VS/agents/reference/hooks-reference.md` headings). Claude hook files need `chat.useClaudeHooks`, which is off by default. | A subset only (`hooks-reference.md` "Cloud agent" column). `notification` does not fire. `permissionRequest` is a no-op. `preCompact` fires on auto only. `userPromptSubmitted` fires once. `preToolUse` "ask" becomes deny. Only `.github/hooks/*.json` loads. | Programmatic: `onPreToolUse`, `onPostToolUse`, `onPostToolUseFailure`, `onUserPromptSubmitted` (can `modifiedPrompt`, `additionalContext`, `suppressOutput`), `onUserPromptTransformed`, `onSessionStart/End`, `onErrorOccurred`, `onAgentStop` (`GH/how-tos/copilot-sdk/hooks/hooks-overview.md`; `…/user-prompt-submitted.md` L93-95). Plugin `hooks.json` loaded via `--plugin-dir` "fires alongside" (`…/features/plugin-directories.md` L216). | Not enumerated in app docs. Built on CLI and installs plugins with hooks (`customize-github-copilot-app.md` §Adding plugins), so assume CLI behavior. **Ambiguity:** unverified. |
| **Interactive human approval** | Yes. Permission prompts, the `ask_user` tool, elicitation forms, and preToolUse `"ask"`. Autopilot "auto-handles elicitation, ask_user, sampling, and permission prompts" (CL 1.0.64) and denies `"ask"` (CL 1.0.97). | Yes (`VS/agents/run/approvals.md`). Same autopilot caveat for the Copilot harness. | **No.** "Fully non-interactive… all tool permissions pre-granted" (`hooks-reference.md` §Cloud agent execution environment). The human loop is PR review and comments only. | Yes, app-defined: `onPermissionRequest`, `onUserInputRequest` (ask_user), `elicitation.requested` with JSON schema (`compatibility.md`; `features/streaming-events.md` L653). Budget-exhausted prompt via `session_limits_exhausted.requested` (`features/session-limits.md`). | Yes. Interactive, Plan, and Autopilot modes (`github-copilot-app.md`). |
| **MCP** | Yes, stdio and http/sse. Last-wins precedence. Plugin `.mcp.json`. Per-agent `mcp-servers` (`cli-plugin-reference.md`). | Yes (`VS/agent-customization/mcp-servers.md`). | Yes, but tools only, used "autonomously". The default GitHub MCP is read-only and repo-scoped (`GH/concepts/agents/cloud-agent/mcp-and-cloud-agent.md`). | `mcpServers` config, per-agent MCP (`custom-agents.md` §Attaching MCP servers). | Yes. Inherits CLI and repo MCP (`customize-github-copilot-app.md`). |
| **Plugins** | Yes. Legacy format (incl. `.claude-plugin/plugin.json`) and Agent Plugins 1.0 (`com.github.copilot/` namespace). Marketplaces include `.claude-plugin/marketplace.json` (`cli-plugin-reference.md`). Plugins can ship **extensions** (CL 1.0.79; legacy `extensions` field). | Yes. Formats auto-detected: Agent Plugins, Copilot, and Claude (`.claude-plugin/plugin.json`, `${CLAUDE_PLUGIN_ROOT}`, `hooks/hooks.json`) (`VS/agent-customization/agent-plugins.md` §Plugin formats). | Declarative, via `enabledPlugins` in `.github/copilot/settings.json` (`GH/concepts/agents/about-plugins.md`). **Ambiguity:** `hooks-reference.md` says the cloud sandbox "does not ship with… installed plugins", and that only `.github/hooks/*.json` hooks load. | `pluginDirectories` / `--plugin-dir` (`features/plugin-directories.md`). | Yes. Customize → Plugins, including canvas extensions. |
| **Programmatic control** | `-p` prompt mode, `--output-format json`, `--agent`, `--allow-tool/--deny-tool/--available-tools`, ACP server (`GH/reference/copilot-cli-reference/cli-programmatic-reference.md`; `…/acp-server.md`). `copilot workflow run NAME --args @f --result-file` with exit codes 0/2 (`cli-programmatic-reference.md` §Running dynamic workflows). Extensions via `joinSession()` (`GH/tutorials/create-an-extension.md`). | Limited to settings, agent files, and extension APIs. The Copilot harness is driven by the Agent Host. | REST/issue assignment and `/delegate` from the CLI (`GH/how-tos/copilot-cli/use-copilot-cli/delegate-tasks-to-cca.md`). | Full: TS/Python/Go/.NET/Rust (Java partial). Sessions, models, events, hooks, tools, fleet, compaction, history (`compatibility.md`; `fleet-mode.md` "verified in Node.js/TypeScript, Python, Go, .NET, and Rust"). | Deep links (`GH/how-tos/github-copilot-app/open-with-deep-links.md`). `.github/github-app.yml` scripts on `session.create/archive` (`GH/reference/github-copilot-app-reference/repository-configuration.md`). Automations. |

### Recommendation: primary target = **Copilot CLI plugin + one CLI extension**, with an SDK runner as the deterministic backbone

1. **One port, three surfaces.**
   - The app is built on the CLI (`github-copilot-app.md`).
   - The VS Code Copilot harness shares the hook implementation (`VS/agent-customization/hooks.md`).
   - The CLI is the only surface where every event the factory relies on is documented as honored: UserPromptSubmit, PreToolUse with deny, Post, SubagentStart/Stop, and Stop with block (`hooks-reference.md`).
2. **Lowest translation cost.**
   - The CLI already loads `.claude-plugin/plugin.json`, Claude-format hooks, `CLAUDE_PLUGIN_ROOT`, and `.md` agents with Claude tool names.
   - Tool aliases cover `Read`, `Edit`, `Write`, `Grep`, `Glob`, `Bash`, and `Task` (`GH/reference/custom-agents-configuration.md` §Tool aliases).
3. **Human gates need an interactive surface.**
   - The cloud agent cannot host H1–H4 gates (non-interactive; `ask` is denied).
   - Use it at most for isolated builder tasks (`/delegate`) or CI.
4. **Deterministic fan-out options:**
   - Dynamic workflows are the native analogue of the Workflow tool, available in CLI, app, and SDK (`GH/concepts/agents/dynamic-workflows.md` §Availability). They are preview and experimental.
   - **Hedge with an SDK runner.** The `factory` CLI can spawn it, so fan-out stays code-defined even if dynamic workflows change.
5. **Secondary target: VS Code with the Copilot harness.** This should be free once the CLI port works. Do **not** target the Local harness: its hook payloads differ and Claude hooks are off by default.

---

## 2. Copilot SDK deep-dive

**Languages and packages.**

| Language | Package |
|---|---|
| Node/TS | `@github/copilot-sdk` |
| Python | `github-copilot-sdk` |
| Go | `github.com/github/copilot-sdk/go` |
| .NET | `GitHub.Copilot.SDK` |
| Rust | `github-copilot-sdk` |

Java exists but has gaps (no fleet binding). Sources: `GH/how-tos/copilot-sdk/setup/azure-managed-identity.md` L48-106; `features/fleet-mode.md`.

**Architecture.**

- The SDK speaks JSON-RPC to a Copilot CLI process. The CLI runs the tool loop; "the SDK… does not control the loop" (`features/agent-loop.md`).
- Setup modes are local CLI, bundled CLI, in-process runtime, and backend services (`setup/*.md`).
- **CLI extensions** use the same SDK through `@github/copilot-sdk/extension` → `joinSession({tools, hooks, canvases})`. They must be **JavaScript only** (`GH/concepts/agents/copilot-cli/about-cli-extensions.md`).

**Defining tools.**

- `defineTool(name, {description, parameters: zod|JSONSchema, handler, defer, skipPermission, isTerminal})` (`features/context-management.md` example; `GH/tutorials/create-an-extension.md` §How the tool works).
- `isTerminal: true` ends the turn on success. "A failure, denial, rejection, timeout, or input-validation error remains visible to the model so it can recover or retry" (`context-management.md` §Terminal-tool behavior).

**Running sessions.**

- `client.createSession({model, reasoningEffort, customAgents, agent, tools, hooks, mcpServers, skillDirectories, workingDirectory, additionalDirectories, onPermissionRequest, onUserInputRequest, infiniteSessions, systemMessage})`.
- `session.sendAndWait()` blocks until `session.idle`.
- `session.task_complete` is best-effort (`features/agent-loop.md`).
- Sessions support resume, fork, compaction (`session.rpc.history.compact()`), and `clearContext` (`compatibility.md`).
- Budgets: `sessionLimits.maxAiCredits` (`features/session-limits.md`).
- Observability via OTel (`observability/opentelemetry.md`).

**Subagents.**

- Through `customAgents` and the runtime's `task` tool. Selection is **LLM-driven** (`infer`).
- `defaultAgent` can hide tools from the main agent to force delegation (`custom-agents.md` §Agent-exclusive tools).
- Fleet mode is LLM-decomposed, with SQL todos as shared state (`fleet-mode.md` §How sub-agents coordinate).

**Hooks.** See the table above. `onAgentStop` can request another turn (`hooks/session-lifecycle.md` L454). `onUserPromptSubmitted` can modify the prompt or add context, and since CL 1.0.44 can "handle requests directly, bypassing the LLM".

**Structured output.**

- There is **no native response-schema / structured-output option** in the SDK docs. A grep for structured output, responseFormat, or outputSchema finds nothing under `GH/how-tos/copilot-sdk/`.
- The only schema-validated channels are tool parameters and elicitation `requestedSchema`.
- Dynamic workflows say "A workflow can ask agents to return results in a specified format… Copilot can ask an agent to correct the format if needed" (`GH/concepts/agents/dynamic-workflows.md`). That is the closest native equivalent of `agent(…, {schema})`.

### Can it replace Claude Code's Workflow tool?

**Partly. Two viable designs.**

**A. Dynamic workflow extension** (closest 1:1). Put `extension.mjs` in the plugin, or under `.github/extensions/`.

Pros:
- Code-defined steps, sequential and parallel.
- Limits: `maxConcurrentSubagents`, `maxTotalSubagents`, `timeoutSeconds`, `maxAiCredits`.
- Pause/resume with saved step results.
- `/workflows` monitor and an OTel `invoke_workflow` span.
- Headless `copilot workflow run … --args @brief.json --result-file envelope.json`, which maps exactly onto `factory wfargs` → `factory record --file`.
- Subagents inherit session permissions, and their prompts surface in the interactive session.

Sources: `GH/concepts/agents/dynamic-workflows.md`; `GH/how-tos/use-copilot-agents/use-dynamic-workflows.md`; `cli-command-reference.md` §Using `copilot workflow run`.

Cons and risks:
- **Public preview, requires `--experimental`.**
- Not available to legacy annual Pro/Pro+ users.
- The **authoring API is not documented locally**. You get it via "Show me the guidance for writing dynamic workflows". It is not mentioned anywhere in the 1.0.x changelog.
- `workflow run` shows no permission prompts, so permissions must be pre-granted with `--allow-tool`.
- Extensions must be JS.

**B. SDK runner owned by the factory CLI** (GA and documented). Add `factory run <wf> --brief … --out envelope.json`, which uses `@github/copilot-sdk` (Node, matching the existing Node CLI).

How it works:
- For each brief item it creates **one session per agent**, with:
  - `customAgents` built from `agents/<role>.md`;
  - `model` from policy;
  - `workingDirectory` set to the task worktree;
  - `onPreToolUse` reusing `F/hooks/guard-rules.js` in-process.
- It runs items with bounded `Promise.all`, preserving `max_parallel_tasks`, wave order, retry, and escalation exactly as `F/workflows/realize.js` does.
- Each session gets a **terminal `submit_result` tool** whose zod/JSON schema is the item's `schema`. A validation error loops back to the model, which is a real schema-enforced return.
- The roster is built from the code, not from hooks.

Cons:
- The bash tool call that launches the runner may be long-running, so use a background shell or run it from the user's terminal.
- Each session is billed separately.
- Nested permission prompts are not visible, so the runner must decide via `onPermissionRequest` plus its own guard.
- SubagentStart/Stop hooks will not fire, because these are separate sessions.

**Recommendation:** implement **B first**, as the reference engine and test harness (the repo already emulates the Workflow runtime in tests). Then wrap the same JS as a dynamic workflow (**A**) once the API stabilizes, so users get `/workflows` monitoring and pause/resume in the CLI and app.

---

## 3. Patterns from awesome-copilot worth copying

1. **Typed handoff contracts + waves + bounded concurrency + capped retries**: `AC/agents/gem-orchestrator.agent.md`.
   - Phase 0–4 routing. "Run up to `orchestrator.max_concurrent_agents` (default: 2) in parallel" (L90).
   - `needs_retry` up to 3 (L94, L241). `needs_replan` preserves completed waves (L243).
   - **Prompt-cache-aware payload ordering**: plan-constant fields first, per-attempt fields last (L189-190). The factory's `wfargs` briefs should adopt this to cut AI-credit cost across fan-outs.
   - Shipped as Agent Plugins 1.0 with 13 agents under the `com.github.awesome-copilot` extension namespace (`AC/plugins/gem-team/plugin.json`).
   - Caveat: all control is prompt-enforced ("No improvisation"). The factory's CLI-decides model is strictly stronger; copy the contract shapes, not the trust model.
2. **Pure orchestrator + worker/validator pair**: `AC/agents/rug-orchestrator.agent.md`.
   - Uses `agents: ['SWE','QA']` and forbids the orchestrator any tool but `runSubagent`/todo (L14-24).
   - Every work subagent is followed by a validation subagent, then a final integration validation (L35-39).
   - `AC/plugins/rug-agentic-workflow/plugin.json` packages it.
   - Useful for the factory's fallback path (no workflows): restrict the driver skill's agent to `tools: [execute, read, agent]` via a dedicated `factory-driver.agent.md`.
3. **Guardrail hooks with modes, kill-switch and JSONL audit**:
   - `AC/hooks/tool-guardian/{hooks.json,guard-tool.sh}`: `GUARD_MODE=warn|block`, `SKIP_TOOL_GUARD`, `TOOL_GUARD_ALLOWLIST`, structured log.
   - `AC/hooks/governance-audit/` uses sessionStart/sessionEnd/userPromptSubmitted with `GOVERNANCE_LEVEL` and `BLOCK_ON_THREAT`.
   - Copy the env-configured mode and allowlist pattern.
   - **Warning:** these examples drift from the reference. `guard-tool.sh` L41 reads `.toolInput`, but the camelCase payload field is `toolArgs` (a JSON *string*, per `GH/tutorials/copilot-cli-hooks.md` L395). Copilot hooks fail silently when field names are wrong, so test against real payloads.
4. **Extensions combining tools, hooks, canvas, and persisted state**:
   - `AC/extensions/repo-actions-hub/extension.mjs` uses `joinSession({hooks:{onSessionStart,onUserPromptSubmitted,onPreToolUse}, canvases:[createCanvas({actions:[{name, inputSchema, handler}]})]})`. Every action has strict `inputSchema` with `additionalProperties:false`.
   - `AC/extensions/modernization-workflow/{extension.mjs,lib/state.mjs}` persists workflow step state to JSON on disk.
   - This is the template for porting the **factory console** to a canvas in the app and VS Code, and for exposing `factory next`/`record` as first-class tools instead of Bash strings.
   - Canvases are "available only on desktop in supported local Copilot Agent Host sessions" (`VS/agents/run/agent-harnesses.md` L229).
5. **Skill-only lightweight orchestration**: `AC/plugins/structured-autonomy/plugin.json` (plan/generate/implement skills, "Premium planning, thrifty implementation") and `AC/plugins/ai-team-orchestration/plugin.json`.
   - These show the model-tiering idea (expensive planner, cheap implementers) that maps onto `policy.agents.models` and `builder_escalation`.

---

## 4. Gaps and risks per factory capability

| # | Factory capability | Copilot mapping | Gap / risk | Mitigation |
|---|---|---|---|---|
| 1 | **Plugin packaging & install** (`.claude-plugin/marketplace.json`, `plugin.json`) | CLI legacy plugins read `.claude-plugin/` (`cli-plugin-reference.md` §File locations). `copilot plugin marketplace add reshif/claude-factory`. | Agent Plugins 1.0 would ignore `agents/` and `hooks/` outside `com.github.copilot/`. Plugin agents load **after** project and user agents (first-found-wins), so a repo `.github/agents/builder.md` would shadow `factory:builder`. Namespacing of plugin agent IDs (`factory:<role>`) is **not documented** for Copilot. | Stay on the legacy format. Give agents unique filenames (e.g. `factory-builder.md`). Have `wfargs` emit the Copilot agent ID. Test `--agent` resolution. |
| 2 | **Driver skill loop** (`skills/start`) | Skills are portable (`SKILL.md`). | The skill says "Start the workflow with the Workflow tool" (`F/skills/start/SKILL.md` L41). That tool does not exist. The Agent-tool fallback (L49) becomes the `task` tool, where parallel launch is model-discretionary. | Rewrite step 2 to run `factory run <wf>` (SDK runner) or "run the `factory-<wf>` dynamic workflow". Keep the `task` fallback as a last resort. |
| 3 | **Workflows: deterministic fan-out + schema returns** | Dynamic workflows (preview) or SDK runner (§2). | No native structured output. Dynamic workflows are experimental with an undocumented API. Subagent concurrency caps are plan-based (`cli-config-dir-reference.md` L525). | Use a terminal `submit_result` tool with the schema in the SDK runner. In the `task` fallback, add a **`SubagentStop` hook that validates JSON against the schema and returns `decision:"block", reason:<fix-format>`** (`hooks-reference.md` §agentStop/subagentStop decision control; at most 8 blocks). `factory record` still re-validates. |
| 4 | **19 agents with tool limits and models** | `.md` agents with Claude `tools:` strings map to aliases (`custom-agents-configuration.md` §Tool aliases). | `model: haiku/sonnet/opus` aliases and `policy.agents.models` are Claude names. Copilot needs IDs such as Claude Haiku 5.5, Sonnet 5, Opus 5.5 (CL 1.0.94, 1.0.67, 1.0.89) or GPT models. **Ambiguity:** whether bare `sonnet` resolves. `Bash` still allows writes for "read-only" roles, same as Claude Code. | Add a model-ID map in `policy`. Pin with `modelPolicy: "required"` via `subagents.agents` (`cli-config-dir-reference.md` L522). Keep the guard as the enforcement point. |
| 5 | **UserPromptSubmit: exact-reply approvals** | `UserPromptSubmit` (PascalCase) fires in CLI, VS Code and app. In the cloud agent it fires only once. | The **side effect works** (`prompt.js` calls the CLI). The **context injection is uncertain**: the reference says config-file `userPromptSubmitted` output "is dropped", with only SDK `modifiedPrompt` honored (`hooks-reference.md` L402-409). CL 1.0.65 says `additionalContext` is now included in the model-facing prompt. **Ambiguity.** | Do not depend on the injected "[factory] Applied…" text. The driver skill should re-read state with `factory next`, which is already the design. Under the SDK, use `onUserPromptSubmitted` with `additionalContext` / handle-directly (CL 1.0.44). |
| 6 | **PreToolUse guard** (`guard.js`) | PascalCase `PreToolUse` gives Claude tool names and `tool_input` (`hooks-reference.md` §Claude-format matchers). | (a) Output shape: the guard emits `hookSpecificOutput.permissionDecision` (`F/hooks/guard-rules.js` L18). The CLI documents a **top-level** `permissionDecision`. Whether it unwraps `hookSpecificOutput` is **not documented**. (b) **Timeouts fail open**, even for preToolUse (`hooks-reference.md` §Exit codes). (c) Arg names are Copilot runtime names (`path`, `command` per `…/sdk/hooks/pre-tool-use.md` L274 and `tutorials/copilot-cli-hooks.md` L506). The content fields for `create`/`edit` are undocumented, so `checkContent` (`ti.content/new_string`) may silently see nothing. (d) Only listed tools map to Claude names. `apply_patch` maps to `Edit`, but patch arg shapes differ. | Emit **both** shapes and **exit 2** on deny, which the CLI treats as deny regardless (`hooks-reference.md` §Exit codes). Keep runtime well under `timeoutSec`. Log raw payloads in a first run to learn arg names. Add `--deny-tool='shell(git push --force)'`-style rules as a second layer (`GH/how-tos/copilot-cli/use-copilot-cli/allowing-tools.md` L80-86). Policy hooks in `/etc/github-copilot/policy.d` cannot be disabled, for shared machines (`hooks-reference.md` §Policy hooks). |
| 7 | **Activity log** (Post/SubagentStart) | `postToolUse` and `subagentStart` exist. `Task\|Agent` matches `task`. | The `general-purpose` agent emits no subagentStart/Stop (`hooks-reference.md` §subagentStart note). Hooks of subagents only fire since CL 1.0.49. postToolUse matchers were dropped before CL 1.0.63. | Require CLI ≥ 1.0.97 (`factory doctor` check). Never delegate factory work to `general-purpose`. |
| 8 | **Stop hook** refusing false "done" | `agentStop`/`Stop` with `decision:"block", reason`. Fires in the cloud agent too. | Hard cap of 8 consecutive blocks, then the turn ends anyway (CL 1.0.72). In prompt mode a single `sessionEnd` fires after Stop continuations (CL 1.0.92). | Use the `stop_hook_active` input to self-limit. Rely on floors in `factory ship/close` and CI as the hard backstop (already the design, `ARCHITECTURE.md` §6a). |
| 9 | **Human gates H1–H4, deny/resume** | CLI, app and VS Code are interactive. | Autopilot auto-answers ask_user and elicitations (CL 1.0.64). The cloud agent has no user. Fleet and autopilot plan exit (`autopilot_fleet`) bypass interactive steering. | Document "never run the factory in Autopilot". The `SessionStart` hook can warn when the mode is autopilot (**ambiguity:** whether the mode is exposed in the payload). Gates remain typed replies through the hook. Optionally add an elicitation form in an extension (`session.ui.elicitation`, CL 1.0.10) for structured approve/deny bound to the doc hash. |
| 10 | **Per-task worktrees & isolation** | Git as before. The app already runs worktree-per-session. | The local sandbox (`/sandbox`, CL 1.0.93) runs **hooks inside the sandbox** (`hooks-reference.md` §Sandboxed sessions). The guard and seal code need `~/.config/software-factory/secret` and `.factory/worktrees`. | Add the paths to `sandbox.userPolicy`, or use plugin data dir `$COPILOT_PLUGIN_DATA` / `CLAUDE_PLUGIN_DATA` for the key (`cli-plugin-reference.md` L170). |
| 11 | **Seals / trust boundary** | Unchanged. | Cloud agent: ephemeral FS, `HOME=/root`, no secret persistence (`hooks-reference.md` §Cloud agent execution environment). | Do not run gated jobs in the cloud agent. Use CI re-verify (`factory ci install`) as before. |
| 12 | **Budgets** (agent runs, wall time) | Copilot bills in **AI Credits**, token-based (`GH/concepts/billing-and-usage/individuals/billing.md`). Dynamic workflows have `maxAiCredits`. The SDK has `sessionLimits.maxAiCredits`. | Each fan-out session costs credits. `/fleet` "may cause more AI Credits to be consumed" (`fleet.md`). Rate limits are unspecified and temporary (`…/usage-limits.md`). | Add `max_ai_credits_per_job` to policy and pass it to workflow limits or SDK session limits. Handle `session_limits_exhausted` by parking the job. Add retry with backoff for rate-limit errors in the runner. |
| 13 | **Context/compaction** | Auto-compaction at about 80%, pausing at about 95%. Checkpoints are kept (`GH/concepts/agents/copilot-cli/context-management.md` L67). `preCompact` is notify-only. | The driver may lose loop instructions after compaction. | State lives in `.factory/`, so on resume `sessionStart` (source `resume`) re-injects the job pointer. Keep the driver skill short. Optionally run `/compact` with focus instructions (CL 1.0.52). |
| 14 | **Console** | `factory console --serve` works unchanged. | — | Optional: a canvas extension (pattern 4) for app/VS Code desktop. |
| 15 | **Inspector plugin** | Separate plugin. Hooks from all sources merge and all run (`hooks-reference.md` §Hooks locations). | Hooks from plugins disabled in config came back after `--resume` until CL 1.0.97. Hook enable/disable toggles were temporarily removed (CL 1.0.81). `allowManagedHooksOnly` enterprise policy blocks non-managed plugin hooks (`VS/agent-customization/agent-plugins.md` L328). | Require CLI ≥ 1.0.97. In enterprises, ship both plugins as managed (`enabledPlugins` force-enable). |
| 16 | **Headless / CI use** | `-p` gates repo hooks behind `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS` (CL 1.0.40). Plugin agents, skills and MCP load in `-p` (CL 1.0.81). `GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS` covers extensions (`cli-programmatic-reference.md`). | Permission prompts are absent, so anything not pre-allowed is denied. | Ship a documented `--allow-tool` set for `factory` and git. Use `permissionRequest` hooks for programmatic approvals in `-p` (`hooks-reference.md` §permissionRequest). |

### Flagged ambiguities and contradictions (verify with a live CLI before committing)

1. **Subagent depth default.** `cli-config-dir-reference.md` L526 says default 6, cap 256. CL 1.0.71 says the default was lowered from 6 to 4, adjustable to 128.
2. **Cloud agent plugins.** `GH/concepts/agents/about-plugins.md` says plugins install via `enabledPlugins`. `hooks-reference.md` says the sandbox has no installed plugins and only `.github/hooks` hooks.
3. **userPromptSubmitted context.** Command-hook `additionalContext` is said to be dropped (`hooks-reference.md` L409), but included per CL 1.0.65.
4. **Claude `hookSpecificOutput` wrapper.** The VS Code Local harness documents it (`VS/agents/reference/hooks-reference.md` L118). The Copilot CLI reference does not.
5. **Dynamic workflows.** No changelog entry, the authoring API is not in local docs, and the feature is preview/experimental.
6. **App hook coverage.** It is not documented explicitly; the evidence is inferred from "built on Copilot CLI".
7. **Tool argument field names** for `create`/`edit`/`apply_patch` are not documented.

### Suggested porting order

1. Install the existing plugin unchanged in CLI 1.0.97 with `--plugin-dir`. Log raw hook payloads.
2. Fix the guard's output shape and argument names, and add exit-2.
3. Map model IDs.
4. Build the SDK runner `factory run`, and switch the `start` skill to it.
5. Wrap the runner as a dynamic-workflow extension.
6. Optionally build the canvas console.
