# Recipes

A recipe is the ordered list of steps a job runs. Recipes are **human-authored and versioned** (`recipes/*.json`); the CLI picks one by rule (`recipes/_selection.json`) when the job is created and locks it (`recipe.lock.json`). Agents cannot edit recipes — the guard blocks it.

## Shipped recipes

| Recipe | Picked when | Steps |
|---|---|---|
| `bug@low` | bug, docs, dependency at low risk | clarify → H1 → ground → decompose (`plan from-contract`: one task) → realize → reconcile → prove → challenge(code) → ship → H4 → distill → close |
| `feature@low` | other work at low risk | clarify → H1 → ground → decompose (+ God Eye plan critique) → H3 (auto after critique) → realize → reconcile → prove → challenge(code, tests) → ship → H4 → distill → close |
| `standard@medium` | any medium-risk work | clarify → H1 → ground → decide → H2 (only with an ADR) → decompose → H3 → realize → reconcile → prove → challenge(code, tests, security) → ship → H4 → distill → close |
| `full@high` | any high-risk work (migration is floored here) | as medium, plus threat model, H2 always, all lanes, **HS** before ship |
| `hotfix@high` | hotfix | as `full@high`, ground scoped to the failing path, plus post-merge challenge(code, security); confirmed problems open a linked follow-up job |
| `spike` | spike | clarify → H1 → ground → decide (recommendation) → HF → close |
| `epic` | `--epic` | clarify(epic) → EH1 → ground → decide (contracts) → EH2 → decompose(slices) → EH3 → children (each slice runs its own recipe) → epic gate → challenge(conformance) → distill → close |

## Format

```json
{
  "id": "bug@low",
  "version": 1,
  "status": "proven",
  "outcome": "change",
  "applies_to": { "work_type": ["bug", "docs", "dependency"], "risk": ["low"] },
  "steps": [
    { "step": "clarify", "run": "skill:clarify" },
    { "step": "H1", "run": "gate" },
    { "step": "challenge", "run": "workflow:fanout-judge", "config": "challenge", "lanes": ["code"] }
  ]
}
```

- `run`: `skill:<name>` · `workflow:<name>` · `cli:<command>` · `gate` · `merge`
- step options: `config`, `lanes` (`"all"` = every high-risk lane plus ux when UI files changed), `mode`, `threat_model` (`true`/`false`/`"policy"` = only at high risk), `plan_critique`, `when: "adr"` (H2 only if an ADR exists), `auto: "plan_critique"` (H3 auto-approved after a plan critique)
- `status`: `candidate` · `trial` · `proven` · `retired` — high-risk jobs only run `proven` recipes
- `outcome`: `change` (ships code; floors apply) · `findings` (spike) · `epic`

Shape: [`schemas/recipe.json`](../schemas/recipe.json).

## Editing a recipe

1. Copy the closest recipe, bump `version`, change steps **above the floor**.
2. Run `factory recipe check` — the CLI refuses any recipe that omits a floor step for a risk it applies to, or puts steps in an impossible order (e.g. ship before challenge).
3. Add or change a rule in `_selection.json` if it should be picked automatically.
4. Running jobs keep the recipe they locked at creation.

Use the monthly review (`/factory:review`) for the evidence behind a change, and a paired A/B (same task, same base commit, three runs each) for a specific question.
