# GitHub Copilot CLI: plugins, marketplaces, and how the CLI works (research for porting claude-factory)

Sources are local snapshots. Abbreviations used in citations:
- `D/` = `research/gh-docs/content/copilot/`
- `R/` = `research/gh-docs/data/reusables/copilot/`
- `CL` = `research/copilot-cli/changelog.md`. Entries are cited as `CL vX.Y.Z`. The newest entry is 1.0.97 (2026-10-13).
- `AC/` = `research/awesome-copilot/`
- `VS/` = `research/vscode-docs/docs/`

---

## 0. Answers to the key porting questions

| Question | Answer | Source |
|---|---|---|
| Can the existing `.claude-plugin/marketplace.json` be used as a Copilot marketplace? | **Yes.** Copilot looks for the marketplace manifest in this order: `marketplace.json`, `.plugin/marketplace.json`, `.github/plugin/marketplace.json`, `.claude-plugin/marketplace.json`. The docs also give `copilot plugin marketplace add anthropics/claude-code` as a working example. | `D/reference/copilot-cli-reference/cli-plugin-reference.md` (File locations; reusable `R/copilot-cli/cli-claude-plugin-dir.md`); `D/how-tos/copilot-cli/customize-copilot/plugins-finding-installing.md` |
| Can the existing `plugins/*/.claude-plugin/plugin.json` be used? | **Yes, as a "legacy" plugin**, because it has no Agent Plugins `$schema`. Legacy manifests are looked for in this order: `.plugin/plugin.json`, `plugin.json`, `.github/plugin/plugin.json`, `.claude-plugin/plugin.json`. | cli-plugin-reference.md (File locations); `CL v1.0.6` ("Plugins using .claude-plugin/plugin.json are discovered when loaded via --plugin-dir"); `CL v1.0.10` (.claude-plugin MCP/LSP fix) |
| Is there a `${PLUGIN_ROOT}`-like variable for hooks? | **Yes.** Plugin hooks get the env vars `PLUGIN_ROOT`, `COPILOT_PLUGIN_ROOT` and **`CLAUDE_PLUGIN_ROOT`**, all set to the plugin's install directory. They also get `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_DATA`, plus the templates `{{project_dir}}` and `{{plugin_data_dir}}`. The current reference docs mention only `$COPILOT_PLUGIN_DATA` for hooks; the rest comes from the changelog. | `CL v1.0.26`, `CL v1.0.12`; `D/reference/hooks-reference.md` ("Sandboxed sessions") |
| Do Claude-format `hooks/hooks.json` files work unchanged? | **Mostly.** Supported: the nested `{matcher, hooks:[…]}` structure, an optional `type`, PascalCase event names, Claude matcher semantics, and the Claude tool names `Bash`/`Read`/`Edit`/`Write`/`Grep`/`Glob`/`WebFetch`/`WebSearch`/`TodoWrite`/`Agent`/`Task`. **Not documented:** the Claude output wrapper `hookSpecificOutput`, and `MultiEdit`/`NotebookEdit`/`NotebookRead` as hook matcher names. **`SubagentStart` (PascalCase) is not listed as an alias.** See §4. | `CL v1.0.6`, `CL v1.0.62`, `CL v1.0.66`; hooks-reference.md |
| Are plugin `bin/` directories added to PATH? | **No evidence they are.** Nothing in the docs or changelog says a plugin `bin/` is put on PATH. `PLUGIN_ROOT` is documented only for hook processes, MCP stdio servers, LSP servers and agent `mcp-servers` frontmatter, not for the agent's `bash` tool. The workarounds in §9 are my own suggestions. | grep across all gh-docs, CL and vscode-docs found nothing |
| Can one repo be both a Claude Code marketplace and a Copilot marketplace? | **Yes, with no filename clash.** Both tools read `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json`. To give Copilot its own catalog, add `.github/plugin/marketplace.json`: Copilot finds it before `.claude-plugin/`, and Claude Code ignores it. **Do not add a root `marketplace.json` or a plugin-root `plugin.json` unless you intend Copilot to use them first**, because those win the lookup order. A plugin-root `plugin.json` carrying the Agent Plugins `$schema` changes where components are discovered (they move to `com.github.copilot/`). | cli-plugin-reference.md (File locations, `plugin.json` section) |

---

## 1. Plugin formats

Copilot CLI supports two plugin formats (`D/concepts/agents/about-plugins.md`; `D/how-tos/copilot-cli/customize-copilot/plugins-creating.md`; cli-plugin-reference.md):

1. **Agent Plugins 1.0 / 1.1 (Open Plugin Spec).** A plugin opts in by setting `$schema` to exactly `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` or `.../1.1.0/plugin.schema.json`.
   - The manifest must be at the plugin root as `plugin.json`.
   - A root `plugin.json` that targets Agent Plugins takes precedence over `.plugin/plugin.json` and `.claude-plugin/plugin.json` ("spec §5.1").
   - If the declared Agent Plugins version is unsupported, the plugin is rejected and contributes nothing. It does not fall back to legacy.
   - Support for this format was added in `CL v1.0.74` ("Open Plugin Spec v1 plugin manifests and mcp.json").
2. **Legacy Copilot plugin.** Any manifest without one of those exact `$schema` values. This is the format claude-factory's manifests would load as today.

The docs recommend Agent Plugins 1.0 for new plugins "unless you require configurable component paths" (about-plugins.md).

---

## 2. `plugin.json` schema (every field)

### 2a. Legacy manifest (cli-plugin-reference.md, "Legacy manifest fields")

| Field | Type | Notes |
|---|---|---|
| `name` (required) | string | Kebab-case: letters, numbers and hyphens. Maximum 64 characters. **Used by `copilot plugin uninstall NAME`** (plugins-creating.md). `CL 0.0.405`: uppercase letters are allowed. |
| `description` | string | Maximum 1024 characters. |
| `version` | string | Semver. |
| `author` | object | `name` (required), `email`, `url`. |
| `homepage` | string | |
| `repository` | string | |
| `license` | string | |
| `keywords` | string[] | |
| `category` | string | |
| `tags` | string[] | |
| `agents` | string or string[] | Default `agents/`. Contains `.agent.md` files; see §3 for the `.md` ambiguity. |
| `skills` | string or string[] | Default `skills/`. Each skill is a subdirectory with a `SKILL.md`. If there is no `skills/` directory, a root `SKILL.md` is used. |
| `commands` | string or string[] | Command directories. `CL 0.0.406`: plugin commands are translated into skills. |
| `hooks` | string or object | Path to a hooks file, or an inline hooks object. |
| `extensions` | string, string[] or object | Extension directories. `{ paths:[…], exclusive:true }` suppresses built-in extensions. |
| `mcpServers` | string or object | Path to an MCP config file (for example `.mcp.json`), or inline servers. |
| `lspServers` | string or object | Path to an LSP config file, or inline servers. |

The current claude-factory manifests use only `name`, `version`, `description`, `author` (`name` only) and `keywords`. Every one of those is valid in a legacy manifest.

### 2b. Agent Plugins 1.0 manifest (closed schema)

Allowed fields: `$schema` (required), `name` (required), `version`, `description`, `author{name,email,url}`, `homepage`, `repository`, `license`, `keywords`, `extensions` (client data keyed by reverse-domain namespace). Unknown fields are reported and ignored.

Name rules: 1–64 characters; only lowercase ASCII letters, digits, `-` and `.`; must start and end alphanumeric; must not contain `--` or `..`.

Components:
- Portable: `skills/<name>/SKILL.md` (fixed location, no root `SKILL.md` fallback) and a root `mcp.json` (fixed, must carry the matching Agent Plugins `$schema`).
- Copilot-specific, under `com.github.copilot/`: `agents/`, `commands/`, `rules/`, `hooks/hooks.json`, `lsp.json`. `CL v1.0.79` added `extensions/` here.

Source: cli-plugin-reference.md, "Agent Plugins 1.0 manifest fields". Example manifest: `R/copilot-cli/cli-example-plugin-file.md`.

Real-world use: every in-repo plugin in awesome-copilot uses the Agent Plugins schema (for example `AC/plugins/java-development/plugin.json`). Their `main` branch holds only `plugin.json` and `README.md`. A CI step (`AC/eng/materialize-plugins.mjs`) copies agents and hooks into `com.github.copilot/` and skills into `skills/`, then strips the repo-private namespace `extensions["com.github.awesome-copilot"]` from the manifest it serves (`AC/AGENTS.md` lines 116–126).

---

## 3. What a plugin can contain and where it goes (legacy layout)

From cli-plugin-reference.md "File locations" and about-plugins.md:

| Component | Legacy location |
|---|---|
| Manifest | `.plugin/plugin.json`, `plugin.json`, `.github/plugin/plugin.json`, `.claude-plugin/plugin.json` (checked in that order) |
| Agents | `agents/` (default; can be overridden) |
| Skills | `skills/` (default), else a root `SKILL.md` |
| Hooks | `hooks.json` or `hooks/hooks.json` |
| MCP | `.mcp.json`, `.github/mcp.json`, or the `mcpServers` field. `CL 0.0.401` also accepts Claude-style `.mcp.json` without the `mcpServers` wrapper. |
| LSP | `lsp.json` or `.github/lsp.json`. The same document also says `lsp-config/servers.json` (inconsistent). `CL v1.0.6` adds `.lsp.json`. |
| Commands | path from `commands` (translated into skills) |
| Extensions | `extensions` field |
| **bin/** | **Not a recognized component** |

**Agent file naming is ambiguous.**
- cli-plugin-reference.md says `agents/` holds "`.agent.md` files".
- The custom-agents reference says the agent ID is built by stripping "`.agent.md` or `.md`" (`D/reference/copilot-cli-reference/cli-command-reference.md`, "Custom agents reference").
- The SDK plugin doc shows `agents/code-reviewer.md` (`D/how-tos/copilot-sdk/features/plugin-directories.md`).
- awesome-copilot renames `foo.md` to `foo.agent.md` when materializing (`AC/eng/materialize-plugins.mjs` line 33).

Conclusion: plain `*.md` agents probably load, but `.agent.md` is the safe choice.

**Agent frontmatter** (cli-command-reference.md, "Custom agent frontmatter fields"): `description` (required), `name`, `tools` (default `["*"]`), `model`, `models`, `modelPolicy`, `reasoningEffort`, `infer`, `mcp-servers`, `include-custom-instructions`. Agent-scoped `hooks` were added in `CL v1.0.97` (hooks-reference.md, "Agent-scoped hooks").

Claude tool names are accepted as case-insensitive aliases in agent `tools` (`D/reference/custom-agents-configuration.md`, "Tool aliases"):

| Copilot alias | Claude names accepted |
|---|---|
| `execute` | `shell`, `Bash`, `powershell` |
| `read` | `Read`, `NotebookRead` |
| `edit` | `Edit`, `MultiEdit`, `Write`, `NotebookEdit` |
| `search` | `Grep`, `Glob` |
| `agent` | `custom-agent`, `Task` |
| `web` | `WebSearch`, `WebFetch` |
| `todo` | `TodoWrite` |

`CL v1.0.22`: plugin agents respect the model in their frontmatter. `CL v1.0.81`: `--agent <plugin>:<agent>` works headless.

**Skill frontmatter** (cli-command-reference.md, "Skill frontmatter fields"):
- `name` (required; letters, digits, `-`, `_`, `.`, `:`, spaces; maximum 64; colons allow names like `my-plugin:search`)
- `description` (required; maximum 1024)
- `argument-hint`
- `allowed-tools` (string or array; `"*"` means all)
- `user-invocable` (default `true`)
- `disable-model-invocation` (default `false`)

When two plugins ship skills with the same name, both stay available as `/my-plugin/search` and `/other-plugin/search`, and the bare name goes to the higher-priority plugin. `CL v1.0.6` mentions a "`:` namespace separator", so the separator in invocations is unclear.

**MCP inside a plugin:**
- For Agent Plugins `mcp.json` stdio servers, `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded, as are the aliases `CLAUDE_PLUGIN_DATA` and `COPILOT_PLUGIN_DATA`. They are expanded in `args`, `env` and `cwd`, and are also set as env vars. Remote server configs are passed through literally (cli-plugin-reference.md "Components"; plugins-creating.md).
- In a plugin agent's `mcp-servers` frontmatter, `${PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_ROOT}` and `${COPILOT_PLUGIN_ROOT}` are expanded (`CL v1.0.85`).
- LSP `cwd` and `bash` also support `${PLUGIN_ROOT}`.
- **The docs do not say** whether `${CLAUDE_PLUGIN_ROOT}` is expanded in a legacy `.mcp.json` `command` field.

**Plugin data:** each installed plugin gets a persistent directory under `~/.copilot/plugin-data/` (`D/reference/copilot-cli-reference/cli-config-dir-reference.md`).

**Post-install message:** `CL v1.0.22` says "Plugins can now display a post-install message". The manifest field for it is **undocumented**. There is **no documented install script or `npm install` step**: files are copied into the cache as-is, without `.git` (`CL v1.0.57`). claude-factory's `bin/` has no npm dependencies, so this is fine.

---

## 4. Hooks: format, events, and Claude compatibility (`D/reference/hooks-reference.md`)

**Native format:**
```json
{ "version": 1, "hooks": { "preToolUse": [ { "type": "command", "bash": "…", "powershell": "…", "command": "…", "exec": "…", "args": [], "cwd": "…", "env": {}, "timeoutSec": 30, "matcher": "regex" } ] } }
```
- `command` is the cross-platform fallback.
- `timeout` is an alias for `timeoutSec`. The default is 30 seconds.
- HTTP hooks (`type:"http"`) and prompt hooks (`type:"prompt"`, `sessionStart` only) also exist.

**Claude compatibility (changelog):**
- `CL v1.0.6`: "Hook config files now support Claude Code's nested matcher/hooks structure and optional type field", and PascalCase event names are accepted.
- `CL v1.0.62`: Claude-format `preToolUse` and `permissionRequest` matchers (`Bash`, `Read`, `*`) work, and payloads carry Claude tool names.
- `CL v1.0.66`: nested Claude-style groups also work in inline settings hooks.

**Events, with their PascalCase aliases:**

| camelCase | PascalCase alias |
|---|---|
| `sessionStart` | `SessionStart` |
| `sessionEnd` | `SessionEnd` |
| `userPromptSubmitted` | `UserPromptSubmit` |
| `userPromptTransformed` | (none) |
| `preToolUse` | `PreToolUse` |
| `postToolUse` | `PostToolUse` |
| `postToolUseFailure` | `PostToolUseFailure` |
| `agentStop` | `Stop` |
| `subagentStart` | **none listed** |
| `subagentStop` | `SubagentStop` |
| `errorOccurred` | `ErrorOccurred` |
| `preCompact` | `PreCompact` |
| `permissionRequest` | `PermissionRequest` |
| `notification` | (none) |

**Payload shape depends on the event-name case.** PascalCase event names produce snake_case payloads with `hook_event_name`, `session_id`, `tool_name`, `tool_input`, `cwd`, `transcript_path`, and so on. camelCase names produce camelCase payloads.

**Claude matcher semantics** apply only to PascalCase `PreToolUse` and `PermissionRequest`. Runtime tool names map to Claude names as follows:

| Runtime tool | Claude name |
|---|---|
| `bash`, `powershell` | `Bash` |
| `view` | `Read` |
| `create` | `Write` |
| `edit`, `str_replace_editor`, `apply_patch` | `Edit` |
| `grep`, `rg` | `Grep` |
| `glob` | `Glob` |
| `web_fetch` | `WebFetch` |
| `web_search` | `WebSearch` |
| `ask_user` | `AskUserQuestion` |
| `update_todo` | `TodoWrite` |
| `task` | `Agent` (`Task` also accepted) |

Tools with no Claude equivalent keep their runtime names. Other events, such as `PostToolUse`, use **native anchored regex against the runtime `toolName`**. So a `PostToolUse` matcher like `Bash|Write|Edit` will probably not match the runtime names `bash`, `edit` and `create`. Ambiguous: the docs say the snake_case payloads exist but describe Claude matcher semantics only for PreToolUse and PermissionRequest.

**Outputs:**

| Event | Output fields |
|---|---|
| `preToolUse` | `permissionDecision` (`allow`/`deny`/`ask`), `permissionDecisionReason`, `modifiedArgs`. `CL v1.0.24` also honors `updatedInput` and `additionalContext`. |
| `agentStop` / `subagentStop` | `decision` (`block`/`allow`), `reason`; `modifiedResponse` for `subagentStop` only. Runaway guard: at most 8 consecutive blocks. |
| `postToolUse` | `modifiedResult`, `additionalContext` |
| `sessionStart`, `subagentStart` | `additionalContext` |
| `userPromptSubmitted` | The reference says command and HTTP hook output is dropped. `CL v1.0.65` says "Include userPromptSubmitted hook additionalContext in the model-facing prompt". **These conflict.** |

**`hookSpecificOutput` is not mentioned anywhere** in the docs or changelog. claude-factory's `guard-rules.js` emits `{hookSpecificOutput:{permissionDecision:'deny'}}` and `prompt.js` emits `{hookSpecificOutput:{additionalContext}}`. To be safe, also emit the fields at the top level, or exit with code 2.

**Exit codes:** exit 2 on `preToolUse` or `permissionRequest` means deny. Command `preToolUse` hooks fail closed on crashes or non-zero exits but **fail open on timeout**.

**Payload argument names:** `tool_input` carries the runtime tool's own arguments. Only the tool *name* is mapped to Claude's. Argument shapes for `view`, `edit` and `create` (for example, `path` versus `file_path`) are **not documented**. Guard logic must be tested against real payloads.

**Load order:** policy, then repo `.github/hooks/*.json`, then user `~/.copilot/hooks/`, then inline repo `.github/copilot/settings(.local).json` and `.claude/settings(.local).json`, then inline user `~/.copilot/settings.json`, then plugins. All matching hooks run.
- `disableAllHooks` in repo settings skips plugin hooks too.
- `-p` mode needs `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true`, or a trusted folder, or `COPILOT_ALLOW_ALL`, for repo hooks (cli-command-reference.md, "Environment variables"). Plugin hooks in `-p` are not explicitly covered.

**Sandbox:** when the session sandbox is enabled, plugin hooks run inside it. They can read their own directory and write `$COPILOT_PLUGIN_DATA`.

**Cloud agent:** it loads hooks only from `.github/hooks/*.json` and "does not ship with … installed plugins" (hooks-reference.md, "Cloud agent execution environment").

---

## 5. `marketplace.json` schema and hosting

Source: cli-plugin-reference.md "marketplace.json"; `D/how-tos/copilot-cli/customize-copilot/plugins-marketplace.md`; example `R/copilot-cli/cli-example-marketplace-file.md`.

**Top-level fields:**
- `name` (required): kebab-case, maximum 64; dots allowed for Agent Plugins. **This becomes the registration key; it cannot be renamed locally.**
- `owner` (required): `{name, email?}`. `CL v1.0.71`: empty emails are allowed.
- `plugins` (required): array.
- `metadata`: `{description?, version?, pluginRoot?}`.

**Plugin entry fields:**
- `name` (required)
- `source` (required)
- `description`, `version`, `author{name,email?,url?}`, `homepage`, `repository`, `license`, `keywords`, `category`, `tags`
- `commands`, `agents`, `skills`, `hooks`, `mcpServers` (used when the plugin source ships no MCP config), `lspServers`
- `strict` (default `true`; `false` relaxes validation)

**`source` forms:**
- A relative path string. It is relative to the repo root, and `./` is optional (`R/copilot-cli/cli-path-to-plugins.md`).
- `{ "source":"github", "repo":"o/r", "ref":"…", "sha":"<40-hex>", "path":"…" }`
- A `url` source type, which also accepts `ref`/`sha`. Its exact field name is not shown in the docs; Claude's equivalent uses `url`.

`sha` pinning was added in `CL v1.0.70`, and remote sources in `CL 0.0.413`.

**Hosting:**
- Put `marketplace.json` at `.github/plugin/marketplace.json`. Copilot also accepts the root, `.plugin/` or `.claude-plugin/` locations (lookup order in §0).
- Users run `copilot plugin marketplace add OWNER/REPO`. Also accepted: `OWNER/REPO#ref` (`CL v1.0.55`), any git URL including SSH (`CL v1.0.41`), or a local path.
- Real examples: `AC/.github/plugin/marketplace.json` (176 entries; fields used are `name`, `source`, `description`, `version`, plus optional `author`, `repository`, `keywords`, `license`, `homepage`). Also `github/copilot-plugins`.

**Declarative marketplace registration** via `extraKnownMarketplaces` in `~/.copilot/settings.json`, `.github/copilot/settings.json`, or `.claude/settings.json` (cli-config-dir-reference.md; example in `D/reference/enterprise-administrators/enterprise-managed-settings.md`):
```json
"extraKnownMarketplaces": { "software-factory": { "source": { "source": "github", "repo": "OWNER/claude-factory" }, "autoUpdate": true } },
"enabledPlugins": { "factory@software-factory": true }
```
- Allowed `source` kinds are `directory`, `git` and `github`.
- `autoUpdate` is honored only in user or managed settings; it is ignored at repo level.
- `CL 0.0.421`: `extraKnownMarketplaces` is read from project `.claude/settings.json` "for Claude compatibility".

**Built-in marketplace:**
- `awesome-copilot` is the only default, and it cannot be removed. Its plugins auto-update each session in trusted directories.
- `copilot-plugins` is **no longer a default** (cli-plugin-reference.md). This contradicts about-plugins.md, which still says it is "added by default", and `CL 0.0.409`.

---

## 6. Commands: install, update, uninstall, list, and caching

Source: cli-plugin-reference.md "CLI commands"; plugins-finding-installing.md.

```
copilot plugin install SPEC        # alias: add
copilot plugin uninstall NAME      # aliases: remove, rm
copilot plugin list [--json]       # rows: {name, marketplace?, version?, enabled, source, installedFrom?}
copilot plugin update NAME | --all
copilot plugin enable NAME / disable NAME
copilot plugin marketplace add SOURCE | list [--json] | browse NAME [--json] | update [NAME] (alias refresh) | remove NAME [--force]
```
- `copilot plugins` is a legacy alias.
- `--config-dir` is deprecated; use `COPILOT_HOME`.

**Install `SPEC` forms:** `plugin@marketplace`, `OWNER/REPO`, `OWNER/REPO:PATH/TO/PLUGIN`, a git URL, or a local path.

**Interactive equivalents:**
- `/plugin` opens a dashboard with Installed / Online / Marketplace views.
- Also available: `/plugin install|update|uninstall|list`, `/plugin marketplace add|remove|list|browse|update`.
- `/plugins` was removed in `CL v1.0.81`.

**Cache locations:**
- Installed plugins: `~/.copilot/installed-plugins/MARKETPLACE/PLUGIN-NAME` for marketplace installs, `~/.copilot/installed-plugins/_direct/SOURCE-ID/` for direct installs.
- Marketplace cache: `~/.cache/copilot/marketplaces/` on Linux, `~/Library/Caches/copilot/marketplaces/` on macOS; `%LOCALAPPDATA%/copilot` is the Windows cache root. Override with `COPILOT_CACHE_HOME`.
- Install metadata is stored in `~/.copilot/config.json`.

**When local changes take effect:**
- A local direct install is cached, so re-run `copilot plugin install ./my-plugin` to pick up edits (plugins-creating.md).
- Plugins sourced by path from a *directory* marketplace load live: changes apply on `/restart` (`CL v1.0.81`).
- `--plugin-dir DIR` loads a plugin for one process only, ephemerally. It can be repeated. `COPILOT_PLUGIN_DIR_ONLY=true` turns off ambient plugins (`D/how-tos/copilot-sdk/features/plugin-directories.md`; `CL v1.0.49`).

**Precedence:**
- Agents and skills: first found wins. Project and personal definitions beat plugin ones.
- MCP: last loaded wins. Plugin servers beat `~/.copilot/mcp-config.json`; `--additional-mcp-config` beats both.
- Built-in tools and agents cannot be overridden.

**Policy:**
- Repo-scoped `enabledPlugins` activate only in that repository.
- Managed `enabledPlugins`, `extraKnownMarketplaces` and `strictKnownMarketplaces` win per entry.

---

## 7. CLI configuration, environment variables, permissions, trust

### Config directory `~/.copilot` (or `$COPILOT_HOME`)

Source: cli-config-dir-reference.md.

| Item | Purpose |
|---|---|
| `settings.json` | User settings, JSONC. Editable with `/settings` or `copilot config`. |
| `config.json` | Internal state: auth, installed plugins, `trustedFolders`. |
| `permissions-config.json` | Per-location approvals. |
| `mcp-config.json` | User MCP servers. |
| `lsp-config.json` | User LSP servers. |
| `providers.json` | Bring-your-own-key model providers. |
| `agents/`, `skills/`, `hooks/`, `extensions/`, `instructions/`, `copilot-instructions.md` | Personal customizations. |
| `installed-plugins/`, `plugin-data/` | Plugin files and plugin state. |
| `session-state/`, `logs/`, `session-store.db`, `mcp-oauth-config/`, `mcp-secrets/`, `ide/`, `command-history-state/` | Runtime state. |

**Settings cascade**, later winning: defaults, MDM, user, repo `.github/copilot/settings.json`, local `.github/copilot/settings.local.json`, env vars, flags.
- The repo can override only a whitelisted set of keys.
- `.claude/settings.json` and `.claude/settings.local.json` are read for the cross-tool subset: `companyAnnouncements`, `disableAllHooks`, `enabledPlugins`, `extraKnownMarketplaces`, `hooks`.

### Environment variables

Source: cli-command-reference.md "Environment variables"; cli-programmatic-reference.md.

| Variable | Purpose |
|---|---|
| `COPILOT_HOME` | Config directory. |
| `COPILOT_CACHE_HOME` | Cache directory. |
| `COPILOT_ALLOW_ALL` | Allow everything. Exactly `true` also trusts the working directory and loads its skills, plugins, MCP servers and hooks. |
| `COPILOT_MODEL` | Model. |
| `COPILOT_AUTO_UPDATE=false` | Turn off CLI and plugin auto-update. |
| `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` | Auth tokens, in precedence order. Fine-grained PATs with "Copilot Requests" work; classic `ghp_` tokens do not. |
| `COPILOT_SKILLS_DIRS`, `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` | Extra discovery directories. |
| `COPILOT_PLUGIN_DIR_ONLY` | Load only `--plugin-dir` plugins. |
| `PLUGINS_DASHBOARD=false` | Turn off `/plugin` and `copilot plugin`. |
| `GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS`, `…_WORKSPACE_MCP`, `…_EXTENSIONS` | Opt-ins for prompt mode. |
| `COPILOT_SUBAGENT_MAX_CONCURRENT` (32), `COPILOT_SUBAGENT_MAX_DEPTH` (4), `COPILOT_TASK_WAIT_TIMEOUT_SECONDS` (600) | Subagent and task limits. |
| `COPILOT_HOOK_ALLOW_LOCALHOST=1` | Allow plain-HTTP localhost targets for HTTP hooks (hooks-reference.md). |
| `COPILOT_PLAN_THEN_AUTOPILOT`, `COPILOT_GH_HOST`, `GH_HOST`, `USE_BUILTIN_RIPGREP`, `USE_TGREP`, `COPILOT_PROVIDERS_CONFIG` | Other settings. |

`copilot help environment` prints the full list.

### Permission model

Source: `D/how-tos/copilot-cli/use-copilot-cli/allowing-tools.md`; cli-command-reference.md "Tool permission patterns".

- Reads and read-only shell commands are auto-approved. Writes, destructive shell commands and URLs prompt.
- Prompt keys: `y`, `n`, `!` (allow similar for the session), `#` (deny similar for the session), `?`. Persistence choices are Once, This location (written to `permissions-config.json`), and Always.
- **Two layers of control:**
  - `--available-tools` / `--excluded-tools` decide which tools the model can see. These use **runtime tool names**: `bash`, `powershell`, `view`, `create`, `edit`, `apply_patch`, `glob`, `grep`/`rg`, `task`, `list_agents`, `read_agent`, `write_agent`, `skill`, `web_fetch`, `ask_user`, `*_bash` variants.
  - `--allow-tool` / `--deny-tool` decide approval. These use **permission kinds**, not tool names: `shell(…)`, `write(…)`, `read(…)`, `url(…)`, `memory`, or `MCPSERVERNAME(tool)`.
    - Examples: `shell(git:*)` matches `git` + space + anything, but not `gitea`. `shell(npm test)` is an exact match. `write(src/*.ts)`; `write(README.md)` matches by trailing path. `url(https://*.github.com)`.
    - Multiple values go in a quoted, comma-separated list.
    - **Deny always beats allow, even with `--allow-all`.**
- Allow-all switches: `--allow-all-tools` ("required when using the CLI programmatically"), `--allow-all-paths`, `--allow-all-urls`, `--allow-all` / `--yolo`, `/allow-all`, `/permissions allow-all|assisted|default`.
  - All of them can be turned off by `permissions.disableBypassPermissionsMode: "disable"` or `"allow-auto-only"`.
- Managed (enterprise) rules use Claude-like syntax: `permissions.{deny,ask,allow}` with `Bash(...)`/`Shell(...)`, `PowerShell(...)`, `Read(...)`, `Edit(...)`/`Write(...)`, `Domain(...)` (cli-config-dir-reference.md "Managed permission rules").
  - **Ambiguity:** the docs never describe these managed rules for user or repo `settings.json`. Only managed sources are documented.
- Skills can pre-approve tools with frontmatter `allowed-tools` (for example `shell`). The docs warn against doing this for untrusted skills (`R/creating-adding-skills.md`).
- `/reset-allowed-tools` and `/permissions reset` clear approvals.

### Trusted folders

- On first launch in a directory the CLI asks whether to trust it, for this session only or permanently.
- Permanent trust is stored in the `trustedFolders` array in `~/.copilot/config.json` (`D/how-tos/copilot-cli/set-up-copilot-cli/configure-copilot-cli.md`; `D/concepts/copilot-surfaces/copilot-cli.md`).
- Trust gates:
  - repo model, effort and context overrides
  - repo hooks, workspace MCP and extensions in `-p`
  - first-party plugin auto-update
- `--add-dir` and `/add-dir` grant path access and also load that directory's `.github/skills` and `.github/agents` as trusted.

---

## 8. Programmatic mode, models, slash commands, SDK and cloud agent

**Programmatic use** (`D/reference/copilot-cli-reference/cli-programmatic-reference.md`):
```
copilot -p "PROMPT" -s --model claude-sonnet-5.5 --allow-tool='shell(factory:*),write' --no-ask-user --output-format json
```
- Other relevant flags: `--agent NAME`, `--plugin-dir`, `--add-dir`, `--share`, `--share-gist`, `--secret-env-vars`, `--autopilot`, `--max-autopilot-continues`, `--fleet`, `--sandbox`.
- The exit summary prints a `--resume=SESSION-ID` hint.
- Since `CL v1.0.81`, installed-plugin agents, skills and MCP servers load in `-p`.

**Models:**
- Precedence: custom agent frontmatter, then `--model`, then `COPILOT_MODEL`, then `model` in `settings.json`, then the default.
- The listed default is `claude-sonnet-5.5`. Other listed models: `claude-opus-5.5`, `claude-haiku-5.5`/`4.5`, `gpt-5.4`, `gpt-6.1-sol`, `gpt-6-astra`/`luna`, `gpt-5.3-codex`, `gemini-3.7`/`3.8-flash`, and `auto`.
- Interactive switching: `/model [--session|--global|--repo|--local]`.
- Effort: `--effort low|medium|high|xhigh|max`.
- Per-repo allowlist: `.github/allowed_models.txt`.
- Built-in agents have their own fixed models (cli-command-reference.md "Built-in agents").

**Slash commands relevant to plugins, agents and skills** (cli-command-reference.md "Slash commands"):

| Command | Purpose |
|---|---|
| `/plugin` (and subcommands) | Plugin dashboard and management. |
| `/skills` | `list`, `info`, `add`, `remove`, `reload`. |
| `/agent` | Choose an agent. |
| `/subagents` (`/agents`) | Per-agent model settings. |
| `/mcp` | MCP server management. |
| `/lsp` | LSP server management. |
| `/env` | Shows loaded instructions, MCP, skills, agents, hooks, plugins, LSPs and extensions. |
| `/instructions` | View and toggle instruction files. |
| `/permissions`, `/allow-all`, `/reset-allowed-tools` | Permission control. |
| `/add-dir` | Grant directory access. |
| `/restart` | Restart the CLI. |
| `/model` | Model selection. |
| `/fleet` | Parallel subagents. |
| `/plan` | Plan mode. |
| `/skill-name` | Invokes a skill directly. |

**SDK:**
- The SDK talks JSON-RPC to the Copilot CLI runtime. The runtime is spawned over stdio by default, or run in-process (`D/how-tos/copilot-sdk/setup/choosing-a-setup-path.md`).
- Plugins reach SDK sessions in three ways: the `--plugin-dir` launch argument, the per-session `pluginDirectories` option, or the startup option `builtinPluginDirectories`.
- Plugin agents can be dispatched with `task(agent_type=…)`.
- Source: `D/how-tos/copilot-sdk/features/plugin-directories.md`.

**Cloud agent:**
- Per about-plugins.md, plugins install declaratively through `enabledPlugins` and `extraKnownMarketplaces` in the repo's `.github/copilot/settings.json`, and the cloud agent reads those keys (cli-config-dir-reference.md "Repository settings").
- **Contradiction:** hooks-reference.md says the cloud-agent sandbox "does not ship with … installed plugins", and only `.github/hooks/*.json` hooks apply there. Also, `bash` is the only shell honored, tools are pre-approved, and `"ask"` decisions become `"deny"`.
- Plugins also work in the GitHub Copilot app (Customize, then Plugins).

---

## 9. Porting implications for claude-factory (my analysis, not doc statements)

1. **Marketplace: no file changes needed.** `copilot plugin marketplace add OWNER/claude-factory`, then `copilot plugin install factory@software-factory`.
   - Add `.github/plugin/marketplace.json` only if Copilot needs different entries. That file takes precedence over `.claude-plugin/` for Copilot.
   - Optionally add a `version` to each entry so `/plugin` can flag available updates.
2. **Keep the plugins legacy:** keep using `.claude-plugin/plugin.json` and do not add an Agent Plugins root `plugin.json`. Then `agents/`, `skills/` and `hooks/hooks.json` are found in their default locations.
3. **Hooks:**
   - `${CLAUDE_PLUGIN_ROOT}` inside the `command` string works on Linux and macOS, because it is an env var expanded by bash (`CL v1.0.26`).
   - On Windows the `command` text is copied to `powershell`, where `${CLAUDE_PLUGIN_ROOT}` does not expand. A port would need a separate `powershell` field using `$env:CLAUDE_PLUGIN_ROOT`, or `exec`/`args`. Placeholder expansion inside `exec`/`args` is undocumented.
   - Fix the output shape: emit top-level `permissionDecision` and `additionalContext`, not only `hookSpecificOutput`.
   - `SubagentStart` (PascalCase) is not listed. Use `subagentStart` in a second, native-format hooks file, or test it.
   - `PostToolUse` matchers should use runtime names (`bash|edit|create|task|web_fetch|web_search`) or the Claude names, since the semantics are unclear.
   - Remember that `preToolUse` timeouts fail open.
4. **`factory` on PATH: not provided by Copilot.** Possible approaches:
   - (a) The SessionStart hook returns `additionalContext` containing the absolute path, e.g. `node "<PLUGIN_ROOT>/bin/factory"`. sessionStart `additionalContext` injection works (`CL v1.0.11`), and `CLAUDE_PLUGIN_ROOT` is known to the hook.
   - (b) Skills say "run `bin/factory` from this plugin's directory". Copilot only promises to make files in the *skill's* directory available (`R/creating-adding-skills.md`).
   - (c) Ship the CLI as an MCP stdio server with `args:["${PLUGIN_ROOT}/…"]`.
   - (d) Ask users to `npm i -g`, since `package.json` already declares `bin.factory`.
   - Permission pattern for the CLI: `--allow-tool='shell(factory:*)'`, or `shell(node:*)` if it is invoked through node.
5. **Agents:** Claude tool names in the `tools:` frontmatter are accepted as aliases. Rename agent files to `*.agent.md` only if plain `.md` turns out not to load (ambiguous). Agent IDs come from the filename.
6. **Cache behavior:** marketplace installs from GitHub are copied to `~/.copilot/installed-plugins/software-factory/factory/`. Any state the CLI writes should go to `$CLAUDE_PLUGIN_DATA`/`COPILOT_PLUGIN_DATA` or the project, never into the plugin directory.

## 10. Ambiguities and contradictions

| # | Topic | Detail |
|---|---|---|
| 1 | Default marketplaces | about-plugins.md says `copilot-plugins` is "added by default"; cli-plugin-reference.md says it no longer is. |
| 2 | LSP file name | `lsp.json` / `.github/lsp.json` versus `lsp-config/servers.json` (both in cli-plugin-reference.md) versus `.lsp.json` (`CL v1.0.6`, SDK doc). |
| 3 | Agent file extension | `.agent.md` versus `.md` (§3). |
| 4 | `userPromptSubmitted` output | The reference says it is dropped; `CL v1.0.65` says `additionalContext` is included. |
| 5 | Plugin hook root variables | The reference documents only `$COPILOT_PLUGIN_DATA`; `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` and the rest are changelog-only. |
| 6 | `hookSpecificOutput` | Not mentioned anywhere. |
| 7 | `SubagentStart` | No PascalCase alias listed. |
| 8 | Cloud-agent plugins | about-plugins.md says they install; hooks-reference.md says the sandbox has no installed plugins. |
| 9 | Manifest lookup order | `.plugin/plugin.json` is checked before root `plugin.json` for legacy plugins; the SDK doc lists `.github/plugin.json` as a location, the CLI reference does not. |
| 10 | Skill namespace separator | `/plugin/skill` versus `plugin:skill`. |
| 11 | `url` source type | Its field names are not shown. |

## 11. Notable recent changelog entries

| Version (date) | Change |
|---|---|
| 1.0.97 (2026-10-13) | Agent-scoped hooks. Marketplace fetches retry with the GitHub token. `--plugin-dir` skills and agents reach autocomplete. Plugin hooks survive `--resume`. |
| 1.0.89 | Direct installs can be enabled and disabled. |
| 1.0.88 | `--plugin-dir` agents work in `--server`. |
| 1.0.85 | `copilot plugin enable`/`disable`/`list --json` (flat array). Cross-kind flags removed (`copilot skill`, `copilot mcp`, `copilot instruction`, `copilot lsp`). `${PLUGIN_ROOT}` in agent `mcp-servers`. |
| 1.0.81 | `/plugins` removed in favor of `/plugin`, `/mcp`, `/skills`. Plugin components load in `-p`. Update flags in `/plugin`. Directory-marketplace plugins load live. |
| 1.0.79 | `autoUpdate` on `extraKnownMarketplaces`. |
| 1.0.78 | First-party plugins auto-update. |
| 1.0.74 | Open Plugin Spec v1 support. |
| 1.0.70 | `sha` pinning. |
| 1.0.62 | Claude-format PreToolUse matchers fixed. |
| 1.0.49 | `plugin update --all`, `COPILOT_PLUGIN_DIR_ONLY`. |
| 1.0.26 | `PLUGIN_ROOT`, `COPILOT_PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` for hooks. |
| 1.0.12 | `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_DATA`; reads `.claude/settings*.json`. |
| 1.0.6 | Claude nested hooks, PascalCase events, `.claude-plugin` support. |
| 1.0.36 | `~/.claude/` agents, skills and commands are **no longer** loaded. |
