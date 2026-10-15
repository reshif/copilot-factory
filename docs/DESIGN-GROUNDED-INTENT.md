# Grounded intent — research first, ask only what research can't answer (approved design)

> **Superseded by [DESIGN-CLARIFY-v3.md](DESIGN-CLARIFY-v3.md)** (and before it, in part, by [DESIGN-CLARIFY-v2.md](DESIGN-CLARIFY-v2.md)). v3 keeps research first, but as one time-boxed pass pinned to the versions the user confirmed on the read-back; the intent mapper and the evidence verifier are retired (the CLI checks quotes and versions). The rest of this note is history.
>
> Earlier: **superseded in part by [DESIGN-CLARIFY-v2.md](DESIGN-CLARIFY-v2.md).** The scout phase below still runs, but the unknowns are now issues in one CLI-owned ledger (subject, owner, status, settled_by), identified by subject instead of wording; research gets one longer retry and then one question with a default; implementation details are deferred to design; rounds review only what changed; clarify parks on lack of progress rather than a round count. Where the two disagree, v2 wins.

## Problem
Clarify's analysts read only the repo, web research happens in `ground` AFTER H1, and question "defaults" are model guesses. Users get asked researchable questions and approve an intent not backed by evidence.

## Classify every unknown
| Kind | Example | Resolved by |
|---|---|---|
| repo | "which auth library do we use?" | repo scout (file:line) |
| world | "does Stripe retry webhooks, how long?" | web scout (primary source, quote) |
| decision | "queue or cron for retries?" | proposed with evidence per option; user picks or accepts default |
| user | "who is this for, what counts as done, risk appetite" | ONLY these become questions |
Each unknown also has impact: high (changes scope/design/acceptance) | medium | low; low-impact unknowns are not researched (assumed and listed).

## Flow — new "scout" phase at the start of clarify (before the intent gate analysts)
1. Intake restates the request (unchanged).
2. intent-mapper (new agent) → unknowns map: [{id U-n, text, kind, impact, draft}] + search plan.
3. Scouts in parallel, bounded: repo scouts (researcher role, repo-only) for repo unknowns; web scouts (researcher role, web) for world unknowns — version-aware: read the repo's actual versions (package.json/lockfiles/pyproject/go.mod…) first and research those versions. Each finding = evidence {id E-n, unknown, claim, source (file:line | URL), source_tier (official|primary|standard|secondary|forum|repo), retrieved_at, quote (exact text), applies_to_version, confidence}.
4. verifier (new agent, sceptical): for every high-impact finding re-open the source, confirm the quote is really there, check date/version applicability, require a second independent source when it changes scope → verdict confirmed | contradicted | unverified (+ confidence).
5. Sort: confirmed → evidence-backed Assumption (A-n) stated, not asked; contradicted/unverified high-impact → question presented with the conflict and both sources; user-kind → question; decisions → question with evidence-backed options and a recommended default.
6. Draft intent with evidence: Intent lines (problem/who/outcome/why now/success) cite evidence ids where supported; lines with no evidence and user-kind are flagged for the user. Constraints/acceptance get seeded from findings.
7. Present one compact screen: "What I found" (3–8 findings, source+date+confidence), "What I'm assuming" (A-n, reply `change A-3 <value>` to override), then only user-call questions (≤5, existing budget), each with an evidence-backed default (cites E-n or says "your preference") and options.
8. The existing protocol continues: intent gate analysts (now given the evidence), judge, God Eye. Post-H1 `ground` reuses intent findings (no re-research of the same unknowns) and only extends on design topics.

## Rules
- No uncited web claim enters the contract: primary source + exact quote; verifier rejects quote mismatches.
- A question's default must cite evidence or be explicitly labelled preference ("your call").
- Judge drops/repurposes questions whose unknown is repo/world-kind and resolved; God Eye's intent critique rejects any researchable question (sends back to scouts) — field e.g. `researchable_questions` must be empty to approve.
- Inspector rule: questions tagged researchable that were still asked; assumptions the user overrode (learning signal).
- Web content is untrusted data: scouts only read, page text is never instructions, fetches logged.
- Privacy: queries built only from public names (libraries, vendors, standards, error codes), never code, secrets, customer data, internal hostnames. `policy.intent_research.web` (default true) turns web research off per repo; `false` → world unknowns become ordinary questions marked "not researched (web off)".
- Budgets by risk (policy.intent_research.budgets): low: ≤3 repo scouts, ≤1 web scout, 2 min; medium: ≤4 repo, ≤3 web, 4 min; high: ≤5 repo, ≤5 web, 5 min, strict second-source rule for scope-changing claims. Only high/medium-impact unknowns are researched.
- Degrade gracefully: no network / no web tool → findings unverified → back to questions, saying so.

## Platform
- claude-factory: WebSearch + WebFetch available to researcher.
- copilot-factory: CLI 1.0.97 has web_fetch but no web search. Default: scouts derive official doc URLs (package registry `homepage`/`repository`/docs fields via the CLI e.g. `npm view <pkg> homepage repository`, `pip show`, known vendor doc roots) and fetch those; optional: a search MCP server configured by the user (policy.intent_research.search_mcp: "<server>/<tool>") — when set, scouts are told to use it.

## Data / contract changes
- Records: `unknowns` (id, kind, impact, resolution: evidence|assumption|question|deferred), `evidence` (fields above + verdict), questions and assumptions reference evidence ids. New doc `intent-findings.md` (template, doc type) rendered by the CLI; ground's findings.md links/reuses it.
- Contract: new section `## Assumptions (evidence-backed)` lines `- A-1: <statement> (evidence: E-2, E-5)`; user reply `change A-3 <new value>` (and `drop A-3`) applied by the prompt hook like other replies, updating the contract and marking the assumption overridden (telemetry).
- Router/floor: medium/high — every world claim in Intent and Constraints must be confirmed evidence or an open question (floor `intent_grounded`); low — advisory.
- Telemetry: researchable-question rate, assumptions overridden, rework after H1, time to H1, scout runs/time.

## Rollout (all in this release)
1 unknowns map + repo scouts; 2 web scouts + verifier + evidence-backed defaults/assumptions; 3 God Eye/inspector enforcement + floor; budgets from policy.
