---
name: review
description: "Monthly factory review: reads telemetry per recipe and proposes recipe, floor or policy changes for the user to make. Use when the user types /factory:review, asks for the factory review, or asks how the factory is doing. Not for code review: Copilot's built-in /review does that."
argument-hint: "[days to look back, default 30]"
---
# Monthly factory review

Telemetry informs the user; the system never changes its own recipes. Recipes, floors and policy live in the plugin and are edited by the user (the guard blocks agents).

1. Run `factory telemetry report --since <days> --format md` (days = the number the user gave after the command, or 30) and show it.
2. Walk through these questions with the numbers:
   - **Primary**: any escaped defects or reverts within 30 days of merge? For each, which floor step would have caught it?
   - **Cost**: which recipe costs the most agent runs and hours per job? Which steps (fix rounds, review lanes) cost much and changed little?
   - **Lanes**: which review lanes raise mostly refuted or minor findings (low precision)? Which confirm real problems?
   - **Gates**: where do denials cluster — contract, design or plan? That's where drafts are weakest.
   - **Quality signals** (the "Quality signals" tables): roles with a high correction-turn or null-result rate have an output contract that drifts from their schema (their agent file's final-message section, or the schema); lanes with a high refute rate raise false positives; park rules that recur point at a cap or budget to revisit; a high God Eye revise rate on one focus (intent, design, plan) shows where drafts are weakest. Before proposing a change from one of these, read two or three transcripts behind it (`.factory/scratch/runner/<job>/`), because a number alone can mislead.
   - **Grounded intent** (the "Grounded intent" table): how often clarify asked questions research could have answered, how many evidence-backed assumptions the user overrode, scout runs and time, and time to H1. Many researchable questions point at `intent_research` (web off, budgets too small for the risk); many overrides mean the evidence or the mapper's "repo/world" calls are off.
3. Propose at most three concrete changes, each as a small JSON diff against `recipes/*.json`, `policy/floors.json` or the project's `.factory/policy.json`, with the evidence for it. Floor changes are policy changes — say so.
4. Recurring accepted lessons with a clear check can be promoted by the user: `factory lessons promote L4 --check "<command>"` (human-only, from their terminal).
5. For a specific open question ("is the extra lane worth it?"), suggest a paired A/B: the same task on the same base commit through both recipes, three runs each, compared as a range — not a single number.
