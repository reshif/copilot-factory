#!/usr/bin/env bash
# Checks the points in README "Status" that need a signed-in Copilot CLI.
# Run it on your own machine, signed in to Copilot, from anywhere:
#   bash scripts/verify-copilot.sh            # uses the installed plugins
#   bash scripts/verify-copilot.sh --model claude-haiku-5.5
# It makes two short `copilot -p` calls (a few premium requests / AI credits) in a
# throwaway git repo, and writes everything to ./copilot-verify-<time>/ — send that
# folder's report.md back if anything is marked FAIL or UNKNOWN.
set -u
MODEL=""
[ "${1:-}" = "--model" ] && MODEL="${2:-}"
COPILOT="${COPILOT_BIN:-copilot}"
OUT="$PWD/copilot-verify-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
REPORT="$OUT/report.md"
ok()   { echo "- PASS: $*" | tee -a "$REPORT"; }
bad()  { echo "- FAIL: $*" | tee -a "$REPORT"; }
unk()  { echo "- UNKNOWN: $*" | tee -a "$REPORT"; }
echo "# copilot-factory verification — $(date -u +%FT%TZ)" > "$REPORT"
echo "" >> "$REPORT"

command -v "$COPILOT" >/dev/null || { bad "copilot not found (set COPILOT_BIN)"; exit 1; }
echo "copilot: $("$COPILOT" --version 2>&1 | head -1)" | tee -a "$REPORT"
echo "" >> "$REPORT"

# 1. Plugins and skills
"$COPILOT" plugin list --json > "$OUT/plugins.json" 2>&1
grep -q '"factory"' "$OUT/plugins.json" && ok "plugin factory installed" || bad "plugin factory not installed (copilot plugin install factory@copilot-factory)"
grep -q '"factory-inspector"' "$OUT/plugins.json" && ok "plugin factory-inspector installed" || unk "plugin factory-inspector not installed (optional)"
"$COPILOT" skill list > "$OUT/skills.txt" 2>&1
n=$(grep -cE '^\s+(amend|clarify|console|distill|gate|intake|park|review|ship|start|why) - ' "$OUT/skills.txt")
[ "$n" = 11 ] && ok "all 11 factory skills listed" || bad "$n of 11 factory skills listed (see skills.txt)"

# Find the installed factory CLI
ROOT=$(node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=(Array.isArray(l)?l:l.plugins||[]).find(x=>x.name==="factory");console.log(p&&(p.path||p.installPath||p.installedFrom&&require("path").join(p.installedFrom,"plugins","factory"))||"")' "$OUT/plugins.json" 2>/dev/null)
[ -f "$ROOT/bin/factory" ] || ROOT=$(ls -d "${COPILOT_HOME:-$HOME/.copilot}"/installed-plugins/*/factory 2>/dev/null | head -1)
FACTORY="node $ROOT/bin/factory"
[ -f "$ROOT/bin/factory" ] && ok "factory CLI found at $ROOT/bin/factory" || { bad "factory CLI not found under the installed plugin"; exit 1; }

# 2. A throwaway repo with the factory initialised
REPO="$OUT/repo"
mkdir -p "$REPO" && cd "$REPO" && git init -q && git commit -q --allow-empty -m init
$FACTORY init > "$OUT/init.json" 2>&1 && ok "factory init" || bad "factory init (see init.json)"
EVENTS="$REPO/.factory/log/events.jsonl"
before=$(wc -l < "$EVENTS" 2>/dev/null || echo 0)

# 3. Headless agent call: --agent factory:<role>, JSON output shape, hooks in -p, guard
PROMPT='Do exactly these steps and nothing else. 1) Run the shell command: cat .factory/project.json  2) Reply with exactly this JSON object and nothing else: {"ok":true}'
ARGS=(-p "$PROMPT" --agent factory:researcher --output-format json -s --no-ask-user --allow-all-tools)
[ -n "$MODEL" ] && ARGS+=(--model "$MODEL")
"$COPILOT" "${ARGS[@]}" > "$OUT/agent.jsonl" 2> "$OUT/agent.stderr"
code=$?
echo "" >> "$REPORT"; echo "copilot -p exit code: $code" | tee -a "$REPORT"
if grep -qi "No authentication information found" "$OUT/agent.stderr" "$OUT/agent.jsonl"; then
  bad "not signed in to Copilot: run 'copilot' and /login (or set COPILOT_GITHUB_TOKEN), then run this script again"
  exit 1
fi
grep -qi "agent.*not found\|unknown agent\|no such agent" "$OUT/agent.stderr" "$OUT/agent.jsonl" && bad "--agent factory:researcher not recognised (see agent.stderr)" || { [ $code = 0 ] && ok "--agent factory:researcher runs headless" || unk "copilot -p exited $code (see agent.stderr)"; }
node -e '
const lines=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);let js=0,types={};
for(const l of lines){try{const e=JSON.parse(l);js++;types[e.type||"(no type)"]=(types[e.type||"(no type)"]||0)+1}catch{}}
console.log(JSON.stringify({lines:lines.length,json_lines:js,types}));' "$OUT/agent.jsonl" > "$OUT/agent-shape.json" 2>&1
grep -q '"assistant.message"' "$OUT/agent-shape.json" && ok "--output-format json has assistant.message events (what factory run reads)" || bad "no assistant.message events in the JSON output — send agent-shape.json and agent.jsonl"
grep -q '{\\"ok\\":true}\|{"ok":true}\|\\"ok\\": *true' "$OUT/agent.jsonl" && ok "the agent's final JSON object is in the output" || unk "final {\"ok\":true} not found in agent.jsonl"

# 3b. Guard probe: the builder agent can edit files, so it really attempts the write.
GPROMPT='Use your file editing tool (not the shell) to create the file .factory/policy.json containing exactly {"probe":true}. If the tool call is refused, do not retry and do not use the shell; just reply with exactly this JSON object: {"refused":true}'
GARGS=(-p "$GPROMPT" --agent factory:builder --output-format json -s --no-ask-user --allow-all-tools)
[ -n "$MODEL" ] && GARGS+=(--model "$MODEL")
"$COPILOT" "${GARGS[@]}" > "$OUT/guard.jsonl" 2> "$OUT/guard.stderr"

# 4. Did the plugin hooks fire inside the -p process?
tail -n +"$((before+1))" "$EVENTS" > "$OUT/new-events.jsonl" 2>/dev/null
grep -q '"PostToolUse"' "$OUT/new-events.jsonl" && ok "postToolUse hook fired inside copilot -p (activity logged)" || bad "no PostToolUse events logged: plugin hooks may not run in -p processes"
grep -q '"guard_deny"' "$OUT/new-events.jsonl" && ok "preToolUse guard denied the builder's write to .factory/policy.json" || { grep -q '"refused"' "$OUT/guard.jsonl" && unk "the builder reports a refusal but no guard_deny was logged (see guard.jsonl)" || bad "guard_deny not logged (see guard.jsonl: did the builder attempt the write?)"; }
grep -q '"probe"' "$REPO/.factory/policy.json" && bad "the write to .factory/policy.json went through — the guard did NOT protect it" || ok ".factory/policy.json was not changed"
grep -q '"hook_error"' "$OUT/new-events.jsonl" && bad "hook_error events logged (see new-events.jsonl)" || ok "no hook errors"
node -e '
const ev=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const t=ev.filter(e=>e.event==="PostToolUse"||e.event==="guard_deny").map(e=>({event:e.event,tool:e.tool,target:e.target}));
console.log(JSON.stringify(t,null,1));' "$OUT/new-events.jsonl" > "$OUT/tool-events.json" 2>&1

# 5. The runner end to end (dry run: shows the exact commands, spends nothing)
J=$($FACTORY job new --title "verify" --type bug --risk low 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).job)}catch{}})')
[ -n "$J" ] && ok "factory job new ($J)" || bad "factory job new"
$FACTORY run fanout-judge --config clarify --dry-run > "$OUT/run-dry.json" 2>&1 && ok "factory run --dry-run (see run-dry.json for the exact copilot commands)" || unk "factory run --dry-run (see run-dry.json)"

echo "" >> "$REPORT"
echo "Files: $OUT" | tee -a "$REPORT"
echo "Manual checks left: in an interactive 'copilot' session in $REPO run /agent (expect 19 factory agents) and /factory:start." | tee -a "$REPORT"
