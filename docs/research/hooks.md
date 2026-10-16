# GitHub Copilot hooks: research report (for porting the Software Factory plugin)

Date: 2026-10-14. Sources are local clones. Paths are abbreviated as follows:

- `GH:` = `research/gh-docs/content/copilot/`
- `GHR:` = `research/gh-docs/data/reusables/copilot/`
- `VS:` = `research/vscode-docs/docs/`
- `CL:` = `research/copilot-cli/changelog.md`, cited by version and line (latest entry is 1.0.97, 2026-10-13)
- `AC:` = `research/awesome-copilot/`

The main source is `GH:reference/hooks-reference.md` (931 lines). It replaces the old `cli-hooks-reference` page; its `redirect_from` lists `/copilot/reference/copilot-cli-reference/cli-hooks-reference`, so no separate CLI hooks reference exists. Unless another file is cited, a claim comes from that file.

---

## 1. Surfaces at a glance

| Surface | Who runs hooks | Where config comes from | Notes |
|---|---|---|---|
| **Copilot CLI** | CLI, on the local machine, in the CLI's shell | policy → user → project → plugins, all **combined** (every entry from every source runs) | Supports every event. `GH:reference/hooks-reference.md` §"Hooks locations" |
| **Cloud agent** (formerly coding agent) | Ephemeral Linux sandbox | **Only** `.github/hooks/*.json` in the cloned repo, and only from the **default branch** (`GH:how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/use-hooks.md`). No user files, `settings.json` or installed plugins. | Some events do not fire. Only `bash`/`command` is honoured. `ask` becomes `deny`. |
| **VS Code, "Copilot" harness** (Session Target = Copilot) | Copilot SDK runtime in the Agent Host | Same as the CLI: "Copilot harness sessions use the same SDK hook implementation as Copilot CLI. Use the Copilot CLI sections of the GitHub reference" | `VS:agent-customization/hooks.md` §"Choose the hook implementation" |
| **VS Code, "Local" harness** | VS Code extension host | `.github/hooks/*.json`, `~/.copilot/hooks/*.json`, `.claude/settings*.json` (only with `chat.useClaudeHooks`, default off), agent frontmatter, plugins | A **different** schema in Claude style (`hookSpecificOutput`). **Matchers in Claude format are ignored.** `VS:agents/reference/hooks-reference.md` |
| **VS Code, "Claude" harness** | Claude Agent SDK | Claude's own config | Follows Claude's hooks reference (`VS:agent-customization/hooks.md` table) |
| **Copilot SDK** | Programmatic callbacks (`onPreToolUse` and so on) in your app | Code | Only SDK callbacks honour `modifiedPrompt` (`GH:reference/hooks-reference.md` §userPromptSubmitted note) |

VS Code says plainly that one file working in several harnesses does not make the behaviour the same: "Supported events, event names, matchers, command properties, tool names, payloads, and output decisions can differ" (`VS:agent-customization/hooks.md`).

---

## 2. Config files, locations and format

### 2.1 Locations (CLI) — `GH:reference/hooks-reference.md` §Hooks locations
1. **Policy**: `/etc/github-copilot/policy.d/*.json` (Linux/macOS, must be owned by root and not group- or world-writable), `C:\ProgramData\GitHub\Copilot\policy.d\*.json`, or the registry `HKLM\Software\Policies\GitHub\Copilot`. `disableAllHooks` cannot turn these off. They always run on the host, even when the session is sandboxed.
2. **Repository**: `.github/hooks/*.json` in the repo root.
3. **User**: `~/.copilot/hooks/*.json` (or `$COPILOT_HOME/hooks/`).
4. **Inline repo settings**: the `hooks` key in `.github/copilot/settings.json` or `.github/copilot/settings.local.json`. The CLI **also reads `.claude/settings.json` and `.claude/settings.local.json`** (also stated in `GH:reference/copilot-cli-reference/cli-config-dir-reference.md` L441).
5. **Inline user settings**: the `hooks` key in `~/.copilot/settings.json`. `~/.copilot/config.json` is **no longer read** for hooks.
6. **Plugins**: each plugin's `hooks.json` or `hooks/hooks.json`.
   - Legacy plugin manifests are looked up in this order: `.plugin/plugin.json`, `plugin.json`, `.github/plugin/plugin.json`, `.claude-plugin/plugin.json` (`GH:reference/copilot-cli-reference/cli-plugin-reference.md` L375).
   - The manifest `hooks` field accepts "Path to a hooks configuration file, or an inline hooks object" (same file, L213 and L334).
   - Agent Plugins 1.0 manifests (with `$schema` set to agent-plugins.org 1.0.0 or 1.1.0) read hooks from `com.github.copilot/hooks/hooks.json` instead (same file, L164–176).
7. **Agent-scoped** (CLI only, added in 1.0.97 `CL` L3): a `hooks:` map in a custom agent's frontmatter.
   - It runs only while that agent is selected.
   - `command` is the fallback, with `windows`, `linux` and `osx` overrides. Paths resolve from the repo root.
   - A subagent's scoped `Stop` runs at `SubagentStop`.
   - "Remote or organization-hosted agent definitions do not run scoped hooks."

Trust and loading rules:
- Repository hooks load only after folder trust is confirmed (`CL` 1.0.8, L2216).
- In `-p` (prompt) mode, repository hooks load only when the folder is already trusted, `COPILOT_ALLOW_ALL` is set, or `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true` (`GH:reference/copilot-cli-reference/cli-command-reference.md` L913; `CL` 1.0.40 L1745, 1.0.49 L1585).
- Hook config changes are picked up when the CLI starts (`GHR:cloud-agent/hooks-example-steps.md`).
- `/env` shows the hook count and where each hook came from (`CL` 1.0.60/1.0.61).

### 2.2 File format
```json
{ "version": 1, "disableAllHooks": false, "hooks": { "<event>": [ <entry>, ... ] } }
```
- `version` may be left out (`CL` 1.0.5, L2308).
- PascalCase event names are accepted alongside camelCase. **Claude Code's nested `{ "matcher": "...", "hooks": [ ... ] }` grouping and an optional `type`** are accepted (`CL` 1.0.6 L2264, L2276). Matchers inside nested groups are applied (`CL` 1.0.10 L2195). Inline settings handle nested Claude groups (`CL` 1.0.66 L1007).
- Malformed items in a directory-loaded file are dropped one at a time; the rest of the file still loads. Invalid JSON, a bad `version`, or a non-array event list rejects the **whole file**. Inline `settings.json` hooks are strict: one bad item rejects the whole field (§"Hook configuration format" note; `CL` 1.0.71 L719).

**Command entry** (§Command hooks):

| Field | Meaning |
|---|---|
| `type` | `"command"` (the default) |
| `bash` / `powershell` / `command` | `command` is the cross-platform fallback and is copied into both `bash` and `powershell`. Cloud agent honours only `bash`/`command`. |
| `exec` + `args` | CLI only. Runs the program directly, with no shell. |
| `cwd` | Relative to the repo root, or absolute |
| `env` | Supports variable expansion |
| `timeoutSec` | **Default 30**. `timeout` is accepted as an alias (`timeoutSec` wins if both are present). Claude's `"timeout": N` therefore works (`CL` 1.0.2 L2377). |
| `matcher` | Only on some events; see §6 |

**HTTP entry**: `type: "http"`, `url`, `headers`, `allowedEnvVars`, `timeoutSec`.
- Must be `https`. Localhost over plain `http` is allowed only when `COPILOT_HOOK_ALLOW_LOCALHOST=1`.
- `preToolUse` and `permissionRequest` require `https`.
- HTTP `preToolUse` is **fail-open**.

**Prompt entry**: `type: "prompt"`, `prompt`.
- Only on `sessionStart`.
- Only for new interactive sessions: not on resume and not with `-p`. It "may not fire" in cloud agent.

**Progress lines**: a hook may print `{"type":"progress","message":"...","temporary":true}` on its own line. The CLI removes these before parsing. What remains is parsed with a single `JSON.parse`. **Two final JSON objects means invalid JSON, which is ignored (treated as no output).** Output is capped at 10 MiB.

### 2.3 Environment available to hook commands
- **The JSON payload arrives on stdin.** Any command hook may read it; HTTP hooks receive it as the POST body.
- **Plugin hooks (CLI)** get `PLUGIN_ROOT`, `COPILOT_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`, set to the plugin's install directory (`CL` 1.0.26, L1931). They also get `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_DATA`, and the config templates `{{project_dir}}` and `{{plugin_data_dir}}` (`CL` 1.0.12, L2134). `$COPILOT_PLUGIN_DATA` is the writable data directory (`GH:reference/hooks-reference.md` §Sandboxed sessions).
  - **Gap:** the GitHub docs only document `${PLUGIN_ROOT}` placeholder *expansion* for MCP/LSP configs (`GH:reference/copilot-cli-reference/cli-plugin-reference.md` L162, L220, L274). They say nothing about expansion inside hook command strings. Under `bash`, `"${CLAUDE_PLUGIN_ROOT}"` still works because the **shell** expands the environment variable. Under `powershell` (Windows, where `command` is copied into `powershell`), `${CLAUDE_PLUGIN_ROOT}` is a PowerShell variable, not an environment variable, so it would be empty. **Flag (Windows).**
- **VS Code Local harness**: expands `${CLAUDE_PLUGIN_ROOT}` (Claude-format plugins) or `${PLUGIN_ROOT}` (legacy OpenPlugin) in `command`, `bash`, `powershell`, the per-OS fields and `env`, with shell-quoting. It also sets the matching environment variable (`VS:agent-customization/agent-plugins.md` L400–411). For MCP, VS Code says "Copilot | `${PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_ROOT}`" (L142–145).
- **OpenTelemetry**: payloads include `traceparent`/`tracestate`, and command hooks also get them as environment variables (`CL` 1.0.81, L417).
- **Cloud agent**: `GITHUB_COPILOT_API_TOKEN`, `GITHUB_COPILOT_GIT_TOKEN`, `COPILOT_AGENT_PROMPT`, `HOME=/root`. `GITHUB_TOKEN` is **not** set. Working directory is `/workspace`. The filesystem is ephemeral and the network goes through a firewall (§Cloud agent execution environment).
- `COPILOT_CLI=1` is set for CLI subprocesses ("Git hooks can detect…", `CL` 0.0.421 L2441). Whether hook processes get it is not stated.
- **Working directory**: commands with no explicit `cwd` run in the **project root**, not the session's current directory (`CL` 1.0.88, L199). This reverses part of `CL` 1.0.72 L633 ("Lifecycle and subagent hook commands run in the current session directory after /cd"). **Flag: the two changelog entries contradict each other; 1.0.88 is the later one.**
- **Sandbox** (CLI, when the session sandbox is on): repo, user and plugin hooks run **inside** the sandbox. A plugin hook can read its own directory and write to `$COPILOT_PLUGIN_DATA`. `cwd` and `env` do not widen access. Grant more access with `sandbox.userPolicy` (§Sandboxed sessions). **Relevance to us:** the factory hooks write `.factory/log/events.jsonl` inside the repo, which is presumably inside the workspace grant.

---

## 3. Events: every name and casing

Configure camelCase to get a camelCase payload. Configure PascalCase to get the "VS Code compatible" snake_case payload, which also has `hook_event_name`, `session_id` and an ISO-8601 `timestamp` instead of epoch milliseconds (§"Hook event input payloads"; `CL` 1.0.21, L2010).

| camelCase (native) | PascalCase alias (VS Code/Claude) | SDK callback | Fires when | Output honoured (CLI) | Cloud agent |
|---|---|---|---|---|---|
| `sessionStart` | `SessionStart` | `onSessionStart` | A new or resumed session starts (once per session when interactive, `CL` 1.0.22) | `additionalContext` (injected since `CL` 1.0.11). Several hooks are joined with `\n\n`. | Fires once, as a new session |
| `sessionEnd` | `SessionEnd` | `onSessionEnd` | Session ends; `/clear` → `user_exit`, run detached | No | Fires once |
| `userPromptSubmitted` | `UserPromptSubmit` | `onUserPromptSubmitted` | User submits a prompt | **Contested**, see §5.3 | At most once |
| `userPromptTransformed` | *(none documented)* | `onUserPromptTransformed` | After the runtime builds the model-facing prompt | `modifiedTransformedPrompt` | Fires |
| `preToolUse` | `PreToolUse` | `onPreToolUse` | Before each tool | `permissionDecision` allow/deny/ask, `permissionDecisionReason`, `modifiedArgs` (+ `updatedInput`, `additionalContext` per `CL` 1.0.24) | Fires; `ask` → deny |
| `postToolUse` | `PostToolUse` | `onPostToolUse` | After a tool **succeeds** (since `CL` 1.0.15) | `modifiedResult`, `additionalContext` | Fires |
| `postToolUseFailure` | `PostToolUseFailure` | `onPostToolUseFailure` | After a tool fails | `additionalContext` (exit 2 = stdout used as context) | Fires |
| `agentStop` | **`Stop`** | `onAgentStop` | The main agent finishes a turn (also through `task_complete`, `CL` 1.0.45) | `decision: "block"` + `reason` | Fires; a block counts against the job timeout |
| `subagentStart` | *(PascalCase `SubagentStart` not documented in the GH reference)* | — | A subagent is spawned | `additionalContext`, prepended to the subagent's first user message. **Cannot block.** | Fires |
| `subagentStop` | `SubagentStop` | — | A subagent completes | `decision`/`reason`, `modifiedResponse` | Fires |
| `errorOccurred` | `ErrorOccurred` | `onErrorOccurred` | Error | No (the SDK has `errorHandling: retry/skip/abort`) | Fires |
| `preCompact` | `PreCompact` | — | Before compaction | No | Fires only with `auto` |
| `permissionRequest` | `PermissionRequest` | (`onPermissionRequest` is a separate SDK handler) | Before the permission service runs | `behavior` allow/deny, `message`, `interrupt` | No effect (everything is pre-approved) |
| `notification` | (`hook_event_name: "Notification"`) | — | Asynchronous system notifications | `additionalContext` (injected as a user message) | **Does not fire** |
| `preMcpToolCall` | — | — | "for hook providers to control outgoing MCP request metadata" | — | Only in `CL` 1.0.51 L1547. **Not in the docs; flag.** |

Conceptual docs list fewer events (`GH:concepts/agents/hooks.md`, `GH:concepts/agents/copilot-cli/comparing-cli-features.md` L219). They are older and incomplete.
- `concepts/agents/hooks.md` also says postToolUse runs "whether successful or failed". That is **outdated**: since 1.0.15 failures go to `postToolUseFailure`.
- The VS Code **Local** harness supports only `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `SubagentStart`, `SubagentStop` and `Stop` (`VS:agent-customization/hooks.md` §Local hook lifecycle events).

---

## 4. Input payloads (exact)

Every payload has `sessionId` (snake: `session_id`), `timestamp` (camel: epoch ms number; snake: ISO-8601 string) and `cwd`. PascalCase payloads add `hook_event_name`. Payloads may also carry `traceparent`/`tracestate` (`CL` 1.0.81).

| Event | camelCase fields | PascalCase / snake fields |
|---|---|---|
| sessionStart | `source: "startup"\|"resume"\|"new"`, `initialPrompt?` | `source`, `initial_prompt?` |
| sessionEnd | `reason: "complete"\|"error"\|"abort"\|"timeout"\|"user_exit"` | `reason` |
| userPromptSubmitted | `prompt` | `prompt` |
| userPromptTransformed | `prompt` (after userPromptSubmitted hooks), `transformedPrompt` | — |
| preToolUse | `toolName`, `toolArgs: unknown` | `tool_name` (**Claude name**, e.g. `Bash`), `tool_input` ("parsed from JSON string when possible") |
| postToolUse | `toolName`, `toolArgs`, `toolResult{resultType:"success", textResultForLlm}` | `tool_name`, `tool_input`, `tool_result{result_type, text_result_for_llm}` |
| postToolUseFailure | `toolName`, `toolArgs`, `error: string` | `tool_name`, `tool_input`, `error` |
| agentStop | `transcriptPath`, `stopReason:"end_turn"`, `stop_hook_active` (snake even in camelCase form) | `transcript_path`, `stop_reason`, `stop_hook_active` |
| subagentStart | `transcriptPath`, `agentName`, `agentDisplayName?`, `agentDescription?` | *(not documented)* |
| subagentStop | `transcriptPath`, `agentId`, `agentType`, `agentName`, `agentDisplayName?`, `response` (full text), `stopReason` | `transcript_path`, `agent_id`, `agent_type`, `agent_name`, `agent_display_name?`, **`last_assistant_message`**, `stop_reason` |
| errorOccurred | `error{message,name,stack?}`, `errorContext`, `recoverable` | `error`, `error_context`, `recoverable` |
| preCompact | `transcriptPath`, `trigger`, `customInstructions` | `transcript_path`, `trigger`, `custom_instructions` |
| notification | `hook_event_name:"Notification"`, `message`, `title?`, `notification_type` | — |

**Important for us:**
- **The `agentStop`/`Stop` payload has NO `last_assistant_message`** (only `subagentStop` has it). `stop.js` reads `input.last_assistant_message`, so it would always see an empty string and never block. The final assistant text has to come from `transcript_path`. The transcript format is not documented and not a stable API. VS Code: "The transcript file format is not a stable hook API" (`VS:agents/reference/hooks-reference.md`). The CLI keeps session history as `events.jsonl` under `~/.copilot/session-state/<id>/` (`GH:reference/copilot-cli-reference/cli-config-dir-reference.md` L331). It is not stated whether `transcriptPath` points there.
- **`toolArgs` type is inconsistent across docs (flag):**
  - The reference says `unknown`.
  - The tutorial (`GH:tutorials/copilot-cli-hooks.md` §5) and troubleshooting reusable (`GHR:cloud-agent/troubleshoot-hooks.md`) say `toolArgs` is a **JSON string** (`"toolArgs":"{\"command\":\"ls\"}"`).
  - The PascalCase `tool_input` is "parsed from JSON string when possible".
  - The SDK docs say `object`.
  - Handle both: `typeof x === 'string' ? JSON.parse(x) : x`.
- **Argument shapes of the tools themselves are NOT documented** (for example whether `create`/`edit`/`view` use `path` or something else). SDK examples use `toolArgs.path` (`GH:how-tos/copilot-sdk/hooks/pre-tool-use.md` L272, `GH:how-tos/copilot-sdk/features/hooks.md` L304), but those examples use invented tool names (`read_file`, `write_file`). The CLI does **not** rename args into Claude's shape: only `tool_name` is mapped. Expect `path` rather than `file_path`. Content field names for `edit` and `create` are unknown. Inspect real payloads before relying on them.
- One community example reads `.toolInput` from camelCase input (`AC:hooks/tool-guardian/guard-tool.sh` L42). That **contradicts** the official `toolArgs`. Do not copy it.
- The SDK has `workingDirectory` instead of `cwd` in postToolUse (`GH:how-tos/copilot-sdk/hooks/post-tool-use.md`). That applies only to the SDK.

**VS Code Local harness** common input (`VS:agents/reference/hooks-reference.md`):
- Every event: `timestamp` (ISO), `cwd?`, `session_id?`, `hook_event_name`, `transcript_path?`.
- PreToolUse: `tool_name`, `tool_input`, `tool_use_id`. PostToolUse adds `tool_response`.
- SubagentStart/SubagentStop: `agent_id`, `agent_type`; SubagentStop also has `stop_hook_active`.
- SessionStart: `source` is always `"new"`, and it fires on the first prompt.
- **Local tool names are VS Code's own tool names**, not `bash`/`edit`.

---

## 5. Outputs: what each event can return and whether it is honoured

General rule (CLI and cloud): print **one** JSON object on stdout with exit 0. Field names are **flat**, at the top level. **The GitHub docs never mention Claude's `hookSpecificOutput` envelope.** Whether the CLI unwraps `hookSpecificOutput.permissionDecision` / `.additionalContext` is **undocumented (flag)**.
- Evidence for partial Claude compatibility: `CL` 1.0.24 L1963 says "preToolUse hooks now respect modifiedArgs/**updatedInput**". `updatedInput` is Claude's field name.
- Evidence against relying on it: no doc or changelog line mentions `hookSpecificOutput`.
- The VS Code **Local** harness *does* use `hookSpecificOutput`.

Recommendation: emit flat fields, adding `hookSpecificOutput` as well only if the same JSON object must also serve Claude Code. See §8.

### 5.1 preToolUse (§"preToolUse decision control")
- Fields:
  - `permissionDecision`: `"allow"`, `"deny"` or `"ask"`.
  - `permissionDecisionReason`: required for deny; shown to the agent.
  - `modifiedArgs`: object.
  - Per `CL` 1.0.24: `updatedInput` and `additionalContext`.
  - The SDK also lists `suppressOutput` (`GH:how-tos/copilot-sdk/hooks/pre-tool-use.md`).
- Several hooks: if **any** returns deny, the tool is blocked. VS Code: most restrictive wins, deny > ask > allow (`VS:agent-customization/agent-plugins.md`).
- `allow` suppresses the approval prompt (`CL` 1.0.18).
- `ask`:
  - In autopilot it is denied (`CL` 1.0.97 L8).
  - In cloud agent it becomes deny.
  - With an interactive prompt, user feedback is appended: `Denied by user via preToolUse hook prompt: <reason>. The user provided the following feedback: <feedback>`.
- **Fail semantics (command hooks):**
  - **Exit 2 denies**, even if stdout says allow; stdout JSON is merged with deny.
  - **Any other non-zero exit or crash also denies**, with `"Denied by preToolUse hook (hook errored)"` (fail-closed since `CL` 1.0.57; exit 2 since 1.0.70).
  - **Timeouts are fail-open, always**, even for policy hooks (`CL` 1.0.67).
  - **HTTP preToolUse is fail-open.**
- Before 1.0.36 the `matcher` on preToolUse was ignored (`CL` L1774).
- Before 1.0.62, Claude-format plugin PreToolUse matchers such as `Bash`/`Read`/`*` did not fire correctly (`CL` L1260).

### 5.2 sessionStart
- `{ "additionalContext": "..." }` is the only field used.
- Several hooks are joined with `"\n\n"`. Empty strings do not erase earlier context. The total is capped at 10 MiB (`CL` 1.0.88 L203).
- **Contradiction (flag):** the tutorial `GH:tutorials/copilot-cli-hooks.md` §3 says "Any output from this hook is ignored". That predates 1.0.11 and is outdated.
- The SDK also has `modifiedConfig` (`GH:how-tos/copilot-sdk/hooks/session-lifecycle.md`).

### 5.3 userPromptSubmitted (CONTESTED — key issue for `prompt.js`)
- The reference says only `modifiedPrompt` is an output, and: "**Command and HTTP config-file `userPromptSubmitted` hooks have their output dropped, including `modifiedPrompt`**" (§userPromptSubmitted note). The tutorial and conceptual docs say the same ("The output of this hook is ignored").
- **But:**
  - `CL` 1.0.65 (2026-06-24, L1058) says "Include userPromptSubmitted hook **additionalContext** in the model-facing prompt".
  - `CL` 1.0.44 L1653 says "userPromptSubmitted hooks can now **handle requests directly**, bypassing the LLM" (`handled` + `responseContent`).
  - `CL` 1.0.76 L577 and the same reference note discuss `null additionalContext` handling for this event.
  - The SDK documents `additionalContext` and `suppressOutput` for it (`GH:how-tos/copilot-sdk/hooks/user-prompt-submitted.md`).
- **Most likely reading:** `additionalContext` (and `handled`) work at least for SDK/extension callbacks. Whether **command** hooks' `additionalContext` is honoured is **unresolved; the docs say no**. Test this on the target CLI version.
- **Documented alternative:** `userPromptTransformed` (camelCase only). Its output `modifiedTransformedPrompt` replaces the model-facing content, and the reference marks it "Output processed: Yes", with **no SDK-only caveat**.
  - It runs once per message, including every earlier message in a batched submission.
  - The displayed prompt is unchanged, and the change persists across resume.
  - An empty-string override is rejected.
- VS Code Local harness: `UserPromptSubmit` supports only the common output (`continue`, `stopReason`, `systemMessage`). **No `additionalContext`.**

### 5.4 postToolUse / postToolUseFailure
- postToolUse:
  - `modifiedResult{resultType:"success", textResultForLlm}` is honoured for command and HTTP hooks. A `"failure"` result routes to postToolUseFailure.
  - `additionalContext` is appended to `textResultForLlm`. Several hooks are joined with `\n\n`, capped at **10 KB** (`CL` 1.0.49 L1570, 1.0.51 L1559).
- postToolUseFailure: `additionalContext`. With exit 2, stdout is appended to the failure.
- Both are fine for logging: return `{}` or nothing.

### 5.5 agentStop / subagentStop (§"agentStop / subagentStop decision control")
- `decision: "block"|"allow"`, `reason` (becomes **the prompt for the next turn**). `modifiedResponse` exists for subagentStop only.
- The field names are the same in camelCase and PascalCase configs, and they are **top-level**, like Claude's Stop output.
- **Runaway guard:** after **8 consecutive blocks** the CLI ends the turn anyway (`CL` 1.0.72 L630). Use `stop_hook_active`.
- For agent-scoped subagent Stop hooks, blocks after 8 are ignored.
- The built-in **`general-purpose` agent emits no `subagentStart`/`subagentStop`**. Others do: explore, task, code-review, rubber-duck, research, security-review, and custom agents (§subagentStart note).
- `-p` mode: one `sessionEnd` after Stop-hook continuations (`CL` 1.0.92).
- **VS Code Local (flag):** `Stop` puts `decision`/`reason` **inside `hookSpecificOutput`**, but `SubagentStop` uses top-level `decision`/`reason` (`VS:agents/reference/hooks-reference.md`). Claude Code uses top-level fields for both.

### 5.6 subagentStart
- `additionalContext` is **prepended to the subagent's first user message**. It cannot block.
- Matcher: a regex anchored as `^(?:...)$` against `agentName`. An invalid regex means the hook is skipped.

### 5.7 permissionRequest (CLI only)
- `behavior: allow|deny`, `message`, `interrupt` (stops the agent).
- Exit 2 means deny.
- Does not run for the `read` and `hook` permission kinds.
- `allow` cannot pre-approve sandbox-bypass requests.

### 5.8 Items with no event-wide equivalent in Copilot CLI
- Claude's top-level `continue: false` / `stopReason` / `systemMessage`. Only the VS Code **Local** harness documents these (common output). The GitHub docs do not mention them for CLI or cloud.

---

## 6. Matchers and tool names

### 6.1 Which events accept `matcher`
Matchers are regexes anchored as `^(?:PATTERN)$` (§Matcher filtering):

| Event | Matched against |
|---|---|
| notification | `notification_type` |
| permissionRequest | `toolName` |
| postToolUse | `toolName` |
| preCompact | `trigger` |
| preToolUse | `toolName` |
| subagentStart | `agentName` |

**`subagentStop`, `agentStop`, `sessionStart` and `userPromptSubmitted` have no matcher.**

### 6.2 Claude-format matchers
These apply to **PascalCase `PreToolUse` and `PermissionRequest`** only:
- `*`, `**` or empty matches all tools.
- `A|B` alternation matches if any token equals the runtime name or the Claude name.
- Anything else is a case-sensitive anchored regex tested against the Claude name.
- The payload `tool_name` is the Claude name.

| Runtime tool | Claude name |
|---|---|
| `bash`, `powershell` | Bash |
| `view` | Read |
| `create` | Write |
| `edit`, `str_replace_editor`, `apply_patch` | Edit |
| `grep`, `rg` | Grep |
| `glob` | Glob |
| `web_fetch` | WebFetch |
| `web_search` | WebSearch |
| `ask_user` | AskUserQuestion |
| `update_todo` | TodoWrite |
| `task` | Agent (`Task` also accepted) |

Tools with no Claude equivalent keep their runtime names.

**Ambiguity (flag):** PascalCase **`PostToolUse`** is documented only with the native regex rule against `toolName`. `CL` 1.0.63 L1219 nevertheless says "PostToolUse hook matchers (e.g. `Edit|Write`) are now honored", which implies Claude names work there too. It is also undocumented whether the PascalCase PostToolUse payload carries Claude or runtime tool names. Safe approach: a matcher that lists **both** spellings, plus normalisation inside the script.

### 6.3 Native tool list for matching
`ask_user`, `bash`, `create`, `edit`, `glob`, `grep`, `powershell`, `task`, `view`, `web_fetch` (§"Tool names for hook matching").

The list is incomplete. The Claude-mapping table also has `str_replace_editor`, `apply_patch`, `rg`, `web_search` and `update_todo`. The plugin reference lists built-ins as "bash, view, apply_patch, glob, rg, task, ..." (`GH:reference/copilot-cli-reference/cli-plugin-reference.md` L403).
- **`apply_patch` is used for OpenAI/Codex models** (`CL` L3108). Its arguments are a patch blob, not a path, so a path guard must parse the patch headers. **Flag: high impact for the write guard.**
- MCP tools also appear under their own names.

### 6.4 Matchers in the VS Code Local harness
**The Local harness ignores matcher values in Claude-format files**, so every command for the event runs (`VS:agent-customization/hooks.md`, `VS:agent-customization/agent-plugins.md`). Filter inside the script.

---

## 7. Subagents, timeouts, failure semantics and known issues

- **Do hooks fire inside subagents?** Yes. "Hooks (preToolUse, postToolUse, subagentStart, subagentStop) now fire correctly for sub-agent tool calls" (`CL` 1.0.49 L1602). Hook start/end telemetry inside a subagent is recorded on the subagent's session and re-emitted to the parent (`CL` 1.0.81 L429).
  - Not documented: whether the payload says *which* agent made a tool call. There is no `agent_id` on preToolUse or postToolUse payloads. The VS Code Local harness also has none on tool events.
  - Not documented: whether `userPromptSubmitted` fires for prompts sent to subagents. The reference describes it as firing when "the user submits a prompt".
- **Timeouts:** default 30 s; cloud default also 30 s (`GHR:cloud-agent/troubleshoot-hooks.md`). A timeout is **fail-open for every event**. The log line includes the timed-out command, truncated to 80 characters.
- **Exit codes:**
  - `0`: stdout is parsed.
  - `2`: a warning in general (stderr is shown to the user). It means **deny** for preToolUse and permissionRequest, and context for postToolUseFailure.
  - Other non-zero: logged and execution continues (fail-open), **except preToolUse, which fails closed**.
  - **Contrast with VS Code Local:** exit 2 means "Treat stderr as a blocking error and provide it to the model" for any event, and other codes give a non-blocking warning.
- **Ordering:** hooks run in config order (policy → user → project → plugins). All matching entries run.
- **disableAllHooks:**
  - In a single `.github/hooks/*.json` file, it disables only that file (CLI and cloud).
  - In repo `settings.json`, it disables every non-policy hook (CLI only).
  - Enterprise `allowManagedHooksOnly` also blocks extension callbacks (`CL` 1.0.85 L340). In VS Code that is `ChatAllowManagedHooksOnly`, under which plugin hooks run only for force-enabled managed plugins (`VS:agent-customization/agent-plugins.md` L327).
- **Known changes and bugs, by version (`CL`):**
  - 0.0.396: preToolUse can deny and modify args.
  - 0.0.401: agentStop and subagentStop added.
  - 0.0.402: plugins can provide hooks.
  - 0.0.422: user hooks in `~/.copilot/hooks`; prompt hooks.
  - 1.0.4: `ask`; `disableAllHooks`.
  - 1.0.5: preCompact; `version` optional.
  - 1.0.6: PascalCase names and Claude nested format accepted; hooks fire on resume.
  - 1.0.7: subagentStart.
  - 1.0.8: hooks in `settings.json`; repo hooks only after trust.
  - 1.0.10: repo hooks in `-p`; nested matchers applied.
  - 1.0.11: sessionStart `additionalContext` injected.
  - 1.0.12: `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_DATA` env vars.
  - 1.0.15: postToolUseFailure split out.
  - 1.0.16: PermissionRequest.
  - 1.0.18: notification; `allow` suppresses the prompt.
  - 1.0.21: PascalCase → snake_case payloads.
  - 1.0.22: sessionStart/End once per session.
  - 1.0.24: `updatedInput` and `additionalContext` on preToolUse.
  - 1.0.26: `PLUGIN_ROOT`, `COPILOT_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` env vars.
  - 1.0.35: HTTP hooks.
  - 1.0.36: preToolUse matcher fixed (it was ignored before).
  - 1.0.40: `-p` gates repo hooks.
  - 1.0.44: userPromptSubmitted `handled`.
  - 1.0.45: agentStop on `task_complete`.
  - 1.0.49: hooks in subagents; postToolUse `additionalContext`.
  - 1.0.57: preToolUse errors deny.
  - 1.0.62: Claude-format PreToolUse matchers and Claude tool names.
  - 1.0.63: PostToolUse matchers honoured.
  - 1.0.65: userPromptSubmitted `additionalContext` reaches the model.
  - 1.0.67: timeouts fail-open.
  - 1.0.68: hooks no longer deny every tool when the cwd or worktree has been deleted.
  - 1.0.70: exit 2 denies.
  - 1.0.71: a malformed entry no longer kills the whole file.
  - 1.0.72: Stop cap of 8 plus `stop_hook_active`.
  - 1.0.76: type-safety of prompt-hook output; 10 MiB cap.
  - 1.0.81: `/plugins` hook toggles removed; traceparent.
  - 1.0.85: hooks survive an extension restart (previously "silently stopping and later denying every tool call"); sessionEnd on `/clear`.
  - 1.0.88: default cwd is the project root; start contexts combine.
  - 1.0.92: `-p` gives a single sessionEnd after Stop continuations.
  - 1.0.97: agent-scoped hooks; autopilot denies `ask`; **resumed sessions previously rebuilt plugin hooks from the wrong plugin list** (repo-local marketplace plugin hooks were lost after `--resume`) — now fixed.

---

## 8. Mapping: Software Factory Claude hooks → Copilot

Current Claude config: `/home/user/claude-factory/plugins/factory/hooks/hooks.json`. Its manifest is in `.claude-plugin/plugin.json`, which Copilot CLI already discovers as a legacy plugin, picking up `hooks/hooks.json` (`GH:reference/copilot-cli-reference/cli-plugin-reference.md` L375, L379). So the CLI would load our PascalCase nested Claude-format file **as is**, and `"timeout"` and `${CLAUDE_PLUGIN_ROOT}` (as a bash env var) both work.

The problems are in output shapes and payload fields:

| # | Claude behaviour (file) | Copilot mechanism | Gaps / required changes | Confidence |
|---|---|---|---|---|
| 1 | **SessionStart context injection** (`session-start.js`: emits `hookSpecificOutput.additionalContext`) | `SessionStart`/`sessionStart` → top-level **`{"additionalContext": "..."}`** (CLI, VS Code Copilot harness, cloud). VS Code Local wants `hookSpecificOutput.additionalContext`. | The CLI documents only the flat field. Emit `{additionalContext, hookSpecificOutput:{hookEventName:'SessionStart', additionalContext}}` (one object, both shapes). `input.cwd` is present. Fires on resume too (`source:"resume"`). | High (flat); Low (nested honoured by CLI) |
| 2 | **UserPromptSubmit applies a human reply via the CLI and injects context** (`prompt.js`) | Side effect: `userPromptSubmitted` / `UserPromptSubmit` fires with `prompt` and `cwd`, so applying the reply works. **Context injection:** (a) documented route is `userPromptTransformed` returning `{"modifiedTransformedPrompt": transformedPrompt + "\n\n" + msg}`; (b) undocumented route is `additionalContext` on userPromptSubmitted (`CL` 1.0.65) — the reference says command-hook output is dropped. | Use (a) in a camelCase Copilot-only hooks file (see notes). Make the reply application **idempotent**, because userPromptTransformed runs for each batched message, and do not apply it in both events. Cloud agent: fires once, for the job prompt only, so replies are not useful. VS Code Local: **no context injection at all** for UserPromptSubmit (only `systemMessage` to the user). | Medium (a); Low (b) |
| 3 | **PreToolUse guard DENIES writes/reads of protected paths** (`guard.js`, `guard-rules.js`; emits `hookSpecificOutput.permissionDecision:'deny'`) | `PreToolUse` (PascalCase; Claude-format matcher `Write\|Edit\|…\|Read\|Grep\|Glob`) → `tool_name` is the Claude name (`Write`=create, `Edit`=edit/str_replace_editor/**apply_patch**, `Read`=view, `Bash`=bash/powershell, `Grep`=grep/rg, `Glob`=glob). Output **flat** `{"permissionDecision":"deny","permissionDecisionReason":"..."}`. | (i) Emit flat fields, optionally with nested ones too. Better still, **exit 2 with the reason on stderr and the flat JSON on stdout**: exit 2 denies in Copilot (stdout JSON merged), and exit 2 + stderr blocks in Claude Code. (ii) `tool_input` uses **Copilot's own arg names** (likely `path`, not `file_path`; `guard.js` already falls back to `ti.path`). Edit content fields (`new_string`/`content`) are probably different, so `checkContent` may see nothing. **Verify real payloads.** (iii) `apply_patch` (GPT/Codex models) maps to `Edit` with a patch body: parse `*** Update File:` / `*** Add File:` headers or deny if a path cannot be found. (iv) `MultiEdit`, `NotebookEdit` and `NotebookRead` have no Copilot equivalents; harmless in the matcher. (v) `safe()` exits 0 on internal error (fail-open), so behaviour matches Claude; a non-zero exit would fail closed in Copilot. **Timeouts are always fail-open** (15 s is set). (vi) Fires for subagent tool calls (≥1.0.49). (vii) Cloud agent: `ask` becomes deny; works from `.github/hooks/*.json` only (no plugins). (viii) VS Code Local: matcher ignored, tool names differ (VS Code's own), so the script must filter by itself. | High (deny mechanism and exit 2); Medium (tool_input field names) |
| 4 | **PostToolUse activity logging** (`activity.js` → `activity-log.js`, reads `tool_name`, `tool_input.command/file_path/path`, `agent_id`, `agent_type`) | `PostToolUse` / `postToolUse`, success only. Add `postToolUseFailure` if failures should be logged too (Claude's PostToolUse also fires only on success, so parity holds). Return nothing. | Matcher semantics for PascalCase PostToolUse are ambiguous: use a union matcher such as `Bash\|Write\|Edit\|Task\|Agent\|WebFetch\|WebSearch\|bash\|powershell\|create\|edit\|str_replace_editor\|apply_patch\|task\|web_fetch\|web_search`, or drop the matcher and filter in the script. **No `agent_id`/`agent_type` on tool payloads**, so the per-agent attribution in the log will be null. Normalise the tool name (runtime vs Claude). | High (fires); Medium (matcher/name form) |
| 5 | **SubagentStart logging** (`activity.js`) | `subagentStart` (camelCase is documented: `agentName`, `agentDisplayName`, `agentDescription`, `transcriptPath`). PascalCase `SubagentStart` is accepted as an event alias (`CL` 1.0.6), but its snake payload is **not documented**. | Read `input.agent_type ?? input.agentName ?? input.agent_name`. The `general-purpose` agent emits nothing. Can also inject `additionalContext` into the subagent if wanted. | Medium |
| 6 | **SubagentStop logging** (`subagent-stop.js`, reads `agent_type`) | `SubagentStop` PascalCase payload has `agent_id`, `agent_type`, `agent_name`, `last_assistant_message`. Can also block or rewrite (`modifiedResponse`). | Works as is (no output). `general-purpose` emits nothing. | High |
| 7 | **Stop hook BLOCKS a false "done" claim** (`stop.js`: checks `stop_hook_active`, scans `last_assistant_message` for claims, emits top-level `{decision:'block', reason}`) | `Stop` / `agentStop` → top-level `{"decision":"block","reason":"..."}`. The reason becomes the next-turn prompt. `stop_hook_active` exists in both casings. Hard cap of 8 consecutive blocks. | **Breaking:** the Stop payload has **no `last_assistant_message`** (only `transcript_path`), so `claims()` always sees an empty string and the gate never fires. Fix options: (a) read the last assistant message from `transcript_path` (format undocumented and unstable; parse defensively and fail open); (b) drop the claim heuristic on Copilot and block whenever an active change job has unmet floors and `!stop_hook_active` (stricter, may nag); (c) also add a `subagentStop` check using its `last_assistant_message`. Cloud: a block costs job time. VS Code Local: `Stop` expects `hookSpecificOutput.decision`/`reason` (nested), unlike the CLI. | High (block mechanism); Low (claim detection without changes) |
| 8 | `${CLAUDE_PLUGIN_ROOT}` in the command, `"timeout"` key, nested matcher groups | CLI sets `CLAUDE_PLUGIN_ROOT`, `COPILOT_PLUGIN_ROOT` and `PLUGIN_ROOT` as env vars; `timeout` is an alias; nested groups are accepted. | On Windows the `command` is copied into `powershell`, where `${CLAUDE_PLUGIN_ROOT}` is not an env reference. Add an explicit `powershell` (`node "$env:CLAUDE_PLUGIN_ROOT/..."`) only if Windows matters. Plugin hooks are lost in cloud agent: ship a `.github/hooks/factory.json` in target repos if cloud enforcement is needed. | High (Linux/macOS) |

**Packaging recommendation** (medium confidence; based on the manifest lookup order and the `hooks` manifest field in `GH:reference/copilot-cli-reference/cli-plugin-reference.md` L213 and L375):
- Copilot checks `.plugin/plugin.json` (and `plugin.json`, `.github/plugin/plugin.json`) **before** `.claude-plugin/plugin.json`. Add a Copilot-only manifest such as `.github/plugin/plugin.json` with `"hooks": "hooks/copilot-hooks.json"`.
- That file can use camelCase events: `sessionStart`, `userPromptSubmitted` + `userPromptTransformed`, `preToolUse` (runtime names, regex matcher `bash|powershell|view|create|edit|str_replace_editor|apply_patch|grep|rg|glob`), `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `agentStop`.
- This keeps Claude Code's `hooks/hooks.json` untouched and avoids depending on undocumented PascalCase behaviour.
- The scripts must then handle camelCase payloads (`toolName`/`toolArgs`, which may be a JSON string, `agentName` and so on) or detect the format through `hook_event_name`.
- Runtime detection: `process.env.COPILOT_PLUGIN_ROOT` (set only by Copilot) or the payload shape (Copilot's PascalCase `timestamp` is an ISO string; camelCase has `sessionId`).

---

## 9. Open questions to verify empirically (in order of risk)

1. Is `additionalContext` from a **command** `userPromptSubmitted` hook honoured on the current CLI (≥1.0.65)? The reference says no, the changelog says yes.
2. Does the CLI honour Claude's `hookSpecificOutput` envelope for PreToolUse, SessionStart and UserPromptSubmit? Undocumented.
3. What are the exact `tool_input`/`toolArgs` keys for `create`, `edit`, `str_replace_editor`, `apply_patch` and `view` (path and content fields)? Undocumented.
4. What is the transcript format at `transcript_path` for Stop, and how do you get the last assistant message from it? Undocumented and unstable.
5. What is the PascalCase `SubagentStart` payload, and what tool name form appears in PascalCase `PostToolUse` payloads and matchers?
6. Does `userPromptSubmitted` fire for prompts sent to subagents? Our `prompt.js` assumes "Subagent prompts never pass through here".
7. Are hook command strings expanded for `${...}` placeholders, or only through the shell environment? This matters on Windows.

## 10. Agent-terminal environment markers (for the human-only check)

Researched 2026-10-15 for `cli/core/human.js` (`AGENT_ENV`). A marker only proves an agent's shell when present; its absence proves nothing.

| Variable | Set by | Since | Source |
|---|---|---|---|
| `COPILOT_AGENT=1` | VS Code, every terminal its agent tool creates (`run_in_terminal`) | 1.121 | `src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/toolTerminalCreator.ts` at tag 1.121.0 (absent at 1.118.0); kept for back-compat later |
| `AI_AGENT=github_copilot_vscode_agent` | VS Code agent terminals (and, per its comment, every process an agent session spawns) | 1.124 (Insiders June 2026) | same file on `main`; `src/vs/platform/chat/common/aiAgentEnv.ts`; microsoft/vscode#320127, PR #320129 ("Set AI_AGENT env var for agent terminals") |
| `VSCODE_AGENT_ZSH_FIXUPS=1` | VS Code agent terminals running zsh | 1.121 | toolTerminalCreator.ts |
| `VSCODE_PREVENT_SHELL_HISTORY=1` | VS Code agent terminals, when `chat.tools.terminal.preventShellHistory` is on | ≤ 1.118 | toolTerminalCreator.ts |
| `GIT_PAGER=cat`, `GIT_EDITOR=:`, `DEBIAN_FRONTEND=noninteractive` | VS Code agent terminals | ≤ 1.118 | toolTerminalCreator.ts. **Not used**: users set these too |
| `TERM_PROGRAM=vscode`, `VSCODE_INJECTION` | every VS Code integrated terminal, yours included | — | **Not used**: they don't tell an agent's terminal from yours (microsoft/vscode#311734, #311382) |
| `COPILOT_CLI=1` | Copilot CLI, for the commands it runs | 0.0.421 | §2 above (`CL` 0.0.421) |
| `AI_AGENT=<vendor value>` | the cross-vendor convention: Claude Code sets it too (observed `claude-code_…_agent`) | — | aiAgentEnv.ts comment; observation |
| `CLAUDECODE`, `CODEX_SANDBOX`, `GEMINI_CLI`, `COPILOT_AGENT_PROMPT` | Claude Code, Codex, Gemini CLI, Copilot cloud agent | — | earlier research (§2) |

VS Code's agent terminals are created with `hideFromUser: true` (same file): a human never types in them, so refusing them costs nothing. Before 1.121 an agent terminal carries nothing an agent couldn't also find in your own terminal; there the random confirmation code (shown on the terminal device only) is the remaining bar, and an agent that reads the terminal screen and types into it (VS Code ≥ 1.115 can let it) can pass it. That limit is stated in the README.


## 11. Prompts the user did not type (can an agent schedule a "reply"?)

Researched 2026-10-16 for `hooks/prompt.js`, after the claude-factory review found that Claude Code's `UserPromptSubmit` fires for scheduled tasks (CronCreate, ScheduleWakeup, `/loop`), background-subagent reports and cross-session messages, so a main session could schedule its own `approve`. The question for Copilot: is there a prompt path an **agent** can start that reaches `userPromptSubmitted` / `UserPromptSubmit`?

**Copilot CLI: scheduled prompts exist, but only the user can create one.**
- `/every [INTERVAL] PROMPT` (alias `/loop`) and `/after DELAY PROMPT` schedule a prompt in the current interactive session (experimental since 1.0.58; `CL` 1.0.58 "Experimental schedule prompts with `/every` and `/after`", 1.0.62 slash commands, 1.0.71 "Deliver scheduled prompts as steering messages when the agent is busy"). Docs: `GH:how-tos/copilot-cli/automate-copilot-cli/schedule-prompts.md` (docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/schedule-prompts).
- Who creates them: the CLI command reference says "Schedules can only be added from the prompt input using `/every` or `/after` with arguments—the dialog itself is read-and-remove only" (`GH:reference/copilot-cli-reference/cli-command-reference.md`, slash commands). `/every` and `/after` themselves "can't be scheduled".
- No tool creates one. The documented agent tools are the shell tools (`bash`, `write_bash`, …), file tools, `task`, `read_agent`, `write_agent` (a message **to a running subagent**), `list_agents`, `ask_user`, `glob`, `grep`, `skill`, `web_fetch` (same reference, "Tool availability values"). None schedules a prompt or writes to the session's own prompt input.
- Self-paced `/every` (no interval) lets the model choose *when* the next run fires, not *what* it says: the text is still the one the user typed.
- How they arrive: "When a scheduled prompt is triggered, Copilot precedes the prompt with text such as `[Scheduled prompt #4]` to distinguish it from a prompt you typed yourself" (schedule-prompts, "Identifying scheduled prompts"). Whether that prefix is in the hook's `prompt` field is not documented.
- Other non-typed prompts already known: the stop gate's block reason fed back as the next prompt and Autopilot's continuation text (both fire `userPromptSubmitted`, verified on 1.0.97, `hooks/lib.js` `isContinuation`); neither is ever applied as a reply. Background-agent completion notifications and `write_agent` steering messages are not documented to fire `userPromptSubmitted` in the main session; `/remote` steering from github.com or GitHub Mobile is the user typing.

**VS Code Copilot Chat: no scheduling.** The VS Code hooks docs describe `UserPromptSubmit` as "User submits a prompt" (code.visualstudio.com/docs/copilot/customization/hooks, Preview); no prompt scheduler, cron or wake-up tool is documented for VS Code agent mode or its Local/Copilot CLI harnesses.

**So the claude-factory fix does not apply as such.** There is no agent-schedulable prompt to guard at preToolUse (no CronCreate / ScheduleWakeup / SendMessage equivalent), and no scheduled-prompt hash to record. What remains is the user's own schedule firing later, unattended, at whatever gate is open by then (`/every 10m approve`). `prompt.js` treats a prompt that starts with `[Scheduled prompt …]` as never a reply: one that reads like a reply is refused and logged (`reply_refused`, code `scheduled_prompt`, also in `.factory/last-reply.json`); any other is an ordinary turn. If the CLI delivers the prompt to the hook **without** that prefix, it can't be told from typed text; it is still text the user wrote. Re-check this section when the CLI adds a scheduling tool for agents (watch the changelog for a tool name in "Tool availability values").
