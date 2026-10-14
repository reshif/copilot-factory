---
name: review
description: Monthly factory review (about 30 minutes) — read the telemetry per recipe, decide which steps cost much and change little, and propose recipe or floor changes for the user to make. Use when the user types /factory:review or asks how the factory is doing.
argument-hint: "[days to look back, default 30]"
---
# Monthly factory review

Telemetry informs the user; the system never changes its own recipes. Recipes, floors and policy live in the plugin and are edited by the user (the guard blocks agents).

1. Run `factory telemetry report --since <days> --format md` (days = the number in `$ARGUMENTS`, or 30) and show it.
2. Walk through these questions with the numbers:
   - **Primary**: any escaped defects or reverts within 30 days of merge? For each, which floor step would have caught it?
   - **Cost**: which recipe costs the most agent runs and hours per job? Which steps (fix rounds, review lanes) cost much and changed little?
   - **Lanes**: which review lanes raise mostly refuted or minor findings (low precision)? Which confirm real problems?
   - **Gates**: where do denials cluster — contract, design or plan? That's where drafts are weakest.
3. Propose at most three concrete changes, each as a small JSON diff against `recipes/*.json`, `policy/floors.json` or the project's `.factory/policy.json`, with the evidence for it. Floor changes are policy changes — say so.
4. Recurring accepted lessons with a clear check can be promoted by the user: `factory lessons promote L4 --check "<command>"` (human-only, from their terminal).
5. For a specific open question ("is the extra lane worth it?"), suggest a paired A/B: the same task on the same base commit through both recipes, three runs each, compared as a range — not a single number.
