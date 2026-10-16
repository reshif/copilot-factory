# Copilot CLI: JSON output, usage and cost fields, models and session resume (research for Phase 4)

What `factory run` can learn about each agent run from the GitHub Copilot CLI (version ~1.0.97),
and what it cannot. Read on 2026-10-16 from the live sources below; every claim cites one. Where the
docs say nothing, this file says **unknown** and the factory records the field as unknown (null)
instead of inventing it.

Sources (fetched 2026-10-16):
- `PR` = github/docs `content/copilot/reference/copilot-cli-reference/cli-programmatic-reference.md`
  (https://github.com/github/docs/blob/main/content/copilot/reference/copilot-cli-reference/cli-programmatic-reference.md)
- `CR` = github/docs `content/copilot/reference/copilot-cli-reference/cli-command-reference.md`
  (https://github.com/github/docs/blob/main/content/copilot/reference/copilot-cli-reference/cli-command-reference.md)
- `SE` = github/docs `content/copilot/how-tos/copilot-sdk/features/streaming-events.md`
  (https://github.com/github/docs/blob/main/content/copilot/how-tos/copilot-sdk/features/streaming-events.md)
- `CL` = github/copilot-cli `changelog.md` (https://github.com/github/copilot-cli/blob/main/changelog.md); newest entry 1.0.98 (2026-10-14)

## 1. `--output-format json`

| Fact | Source |
|---|---|
| `--output-format=FORMAT`: `text` (default) or `json`; with `json` "the CLI emits JSONL (one JSON object per line)". | PR "Command line options" |
| Added to prompt mode in 0.0.422 ("Add --output-format json flag to emit JSONL in prompt mode for programmatic integrations"). | CL 0.0.422 |
| 1.0.97: "Redact secrets safely in --output-format json output while preserving valid variable references". | CL 1.0.97 |
| The record schema of `-p --output-format json` is **not documented**. The only documented JSON record is the final `workflow.result` of `copilot workflow run` (`type`, `data.name`, `data.run.runId`, `data.run.status`, …), and for that command "Add `--silent` to suppress progress and other event records". | PR "Workflow output" |
| `-s`, `--silent`: "Output only the agent response (without usage statistics), useful for scripting with `-p`." | CR "Command-line options" |

**Event shape the factory reads.** The SDK documents the session event stream (SE), and the
records `-p --output-format json` prints carry the same envelope (`type`, `data`, and `agentId` on a
sub-agent's events; `runner.js` already reads replies from `assistant.message` this way, checked
against 1.0.97 with a mock model). Envelope (SE "Event envelope"): `id`, `timestamp`, `parentId`, `agentId?`,
`ephemeral?`, `type`, `data`.

Event types with run, tool or usage data (SE):

| Event | Data fields used | Notes |
|---|---|---|
| `assistant.message` | `messageId`, `content`, `toolRequests?`, `outputTokens?` | the reply; `toolRequests[]` are the tool calls it asks for |
| `tool.execution_start` | `toolCallId`, `toolName`, `arguments?`, `mcpServerName?` | one per tool call: counted as tool calls, the last one's name kept |
| `tool.execution_complete` | `toolCallId`, `success`, `result?`, `error?` | |
| `assistant.usage` (ephemeral) | `model`, `inputTokens?`, `outputTokens?`, `reasoningTokens?`, `cacheReadTokens?`, `cacheWriteTokens?`, `cost?` ("Model multiplier cost for billing"), `duration?`, `quotaSnapshots?`, `copilotUsage?` | one per model API call |
| `session.usage_checkpoint` | `totalNanoAiu` ("Session-wide accumulated nano-AI units cost"), `totalPremiumRequests?` | durable aggregate |
| `session.shutdown` | `shutdownType`, `totalPremiumRequests`, `totalApiDurationMs`, `sessionStartTime`, `codeChanges`, `modelMetrics`, `currentModel?` | end of session |
| `subagent.completed` / `subagent.failed` | `agentName`, `model?`, `durationMs?`, `totalTokens?`, `totalToolCalls?` | a sub-agent the session started |

**Unknown** (not stated in any source above):
- whether `-p --output-format json` prints *ephemeral* events (`assistant.usage` is ephemeral; SE:
  ephemeral events are "streamed in real time but not persisted");
- whether `-s` suppresses usage or event records in JSON mode for `-p` (it does for `workflow run`,
  PR; for `-p` the docs only say it drops the text usage statistics);
- the shape of `ModelMetric` in `session.shutdown.modelMetrics` (SE names the type without fields);
- how `totalNanoAiu` converts to the AI Credits shown by `/usage` (the factory keeps the raw nano-AIU);
- a session id field in the `-p` JSONL (the factory does not need one: it passes `--session-id <uuid>`
  itself, §3).
- `CL 1.0.81` mentions `--usage-output-file` JSON output with per-agent usage metrics; the reference
  docs do not document the flag, so the factory does not use it.

**What the factory does (P4.1).** `factory run` streams each agent's stdout, as it arrives, to
`.factory/scratch/runs/<job>/<run>/<label>.jsonl` and, when the process ends, reads it for: the number
of `tool.execution_start` events (tool calls) and the last tool's name; the sum of the
`assistant.usage` token fields and `cost`; `totalPremiumRequests` and `totalNanoAiu` from the last
`session.shutdown` / `session.usage_checkpoint`. A field no record carried stays null, and
`usage.reported` is false when no usage record arrived at all, so a report never shows a zero it was
not told.

## 2. `--model` values

| Fact | Source |
|---|---|
| `--model=MODEL`: "Set the AI model you want to use. Pass `auto` as the value to let Copilot pick the best available model automatically." | CR "Command-line options" |
| Supported models table: `claude-sonnet-5.5` ("General-purpose coding (default)"), `gpt-5.4`, `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-luna`, `claude-opus-5.5` ("Recommended, high-capability complex tasks"), `claude-haiku-5.5` and `claude-haiku-4.5` ("Fast, lightweight operations"), `gpt-5.3-codex`, `gemini-3.7-flash`, `gemini-3.8-flash`. | CR "Supported models" |
| Model precedence: custom agent frontmatter `model`, then `--model`, then `COPILOT_MODEL`, then `model` in `settings.json`, then the default. | PR "Model precedence" |
| `--effort=LEVEL` / `--reasoning-effort=LEVEL`: `low`, `medium`, `high`, `xhigh`, `max`. | CR "Command-line options" |
| 1.0.98 adds "support for Gemini 4 Argon" (newer than the 1.0.97 the factory targets). | CL 1.0.98 |
| 1.0.64: "Add model family aliases like opus, sonnet, haiku, gpt, and gemini in the model setting". Documented for the `model` **setting** only; neither reference says `--model` takes them. | CL 1.0.64 |
| 1.0.89: "Adding support for claude-opus-5.5"; 1.0.94: "Add Claude Haiku 5.5 to model selection and --model completions". No entry names claude-sonnet-5.5 (**unknown** since when). | CL 1.0.89, 1.0.94 |
| 0.0.421: "Error when --model flag specifies an unavailable model". The wording of that error is **not documented** anywhere. | CL 0.0.421 |

**Model safety (review B1).** Because the ids are not accepted everywhere (an older CLI, an org that has not enabled a model, a plan, BYOK), `factory run` treats a refusal as recoverable: a non-zero exit with no assistant reply and a line that names the model (the word or the id) with a refusal word ("not available", "unsupported", "not enabled" …) re-spawns the same turn once with no `--model`, logs `agent_model_fallback` and remembers the id for three days (`cli/core/models.js`). `factory doctor` warns below 1.0.89 / 1.0.94. The factory keeps passing ids rather than the CLI's family aliases, which are documented for the setting only.

The CLI takes model **ids**; `opus`, `sonnet` and `haiku` are the factory's own aliases, mapped by
`policy.agents.model_ids` (defaults `claude-opus-5.5`, `claude-sonnet-5.5`, `claude-haiku-5.5`, all in
the table above). Since the agent files set no `model`, `--model` decides (precedence above).

**Per-role defaults (P4.2)**, in `policy/default-policy.json` `agents.models`, overridable per role in
`.factory/policy.json` (`null` or `"default"` = the Copilot session default):
- fast (`haiku`): interviewer, researcher, finding-verifier, tester (the sweep check);
- standard (`sonnet`): builder, contract-writer, brief-writer, the reviewers, option-generator,
  threat-modeler, planner, slicer, integrator, lesson-writer;
- strongest (`opus`): god-eye, architect.
`builder_escalation: ["opus"]` from attempt `builder_escalation_from_attempt` (3).

## 3. `--resume` and `--session-id`

| Fact | Source |
|---|---|
| `-r`, `--resume[=VALUE]`: resume by session id, id prefix or name; bare `--resume` needs a TTY, and under `-p` with several sessions "the CLI exits with an error … pass an explicit `--resume=SESSION-ID`". | CR "Command-line options" |
| `--session-id ID`: "If the ID matches an existing session or task, that session or task is resumed. If nothing matches, a new session is created only when the value is a valid UUID." Do not combine with `--resume`, `--continue` or `--connect`. | CR "Command-line options" |
| `-p`'s exit summary "includes a `copilot --resume=SESSION-ID` hint". | CR `-p` row |
| 1.0.97: "Show billed AI Credits in /usage for token-billed sessions, including after resume". | CL 1.0.97 |
| `session.usage_checkpoint` is "used to reconstruct accounting when a session is resumed". | SE |

The factory keeps using `--session-id <uuid>` (a new UUID per agent; the same id for a format
correction, a builder's time-up turn and the next attempt's resume). A resumed session's usage
records may include the earlier turns' totals (checkpoints are session-wide): **unknown** whether a
resumed `-p` turn re-reports them, so the factory reports per-run usage as the CLI gave it and does
not subtract.

## 4. Other usage surfaces (not used)

- `/usage` (interactive): "session usage metrics and statistics, including per-model token totals …
  AI Credit consumption" (CR "Slash commands").
- OpenTelemetry export: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, cache tokens per
  span, and `github.copilot.session.shutdown` with `github.copilot.total_premium_requests` (CR
  "OpenTelemetry"). A team that runs an OTel collector gets the same numbers there.
