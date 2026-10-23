#!/bin/zsh
# Self-healing corpus runner.
#
# Runs the baseline eval until evaluation-files/baseline-v0.json reports
# status "complete" (k=3, the rubric's measurement-perfect set: 27 combos
# x 3 runs = 81 case-runs). Prefers the local OmniRoute gateway (no
# quota), falls back to whichever Cloudflare Workers AI account has daily
# allocation left, and sleeps 10 minutes when neither does. Resume mode
# only re-runs case-runs missing from the report, so quota resets and
# restarts never re-pay measured work.
set -u
cd "/Users/hamza/Desktop/k.o.v.e" || exit 1
set -a; source .dev.vars; set +a

LOG="evaluation-files/runner.log"
REPORT="evaluation-files/baseline-v0.json"
MAX_IDLE_CYCLES=90

log() { echo "[$(date -u +%FT%TZ)] $*" >>"$LOG"; }

is_complete() {
  [ -f "$REPORT" ] || return 1
  node -e 'const r=require("./evaluation-files/baseline-v0.json"); process.exit(r.status==="complete"?0:1)' 2>/dev/null
}

dev_var() { grep -h "^$1=" .dev.vars 2>/dev/null | tail -1 | cut -d= -f2-; }

OMNI_URL="${KOVE_EVAL_OMNIROUTE_BASE_URL:-$(dev_var OMNIROUTE_BASE_URL)}"
OMNI_URL="${OMNI_URL:-http://localhost:20128/v1}"
OMNI_KEY="${KOVE_EVAL_OMNIROUTE_KEY:-$(dev_var OMNIROUTE_KEY)}"
OMNI_MODEL="${KOVE_EVAL_OMNIROUTE_MODEL:-$(dev_var OMNIROUTE_MODEL)}"

probe_omni() {
  # /v1/models advertises the full catalog even when every upstream is dead,
  # so a model slug plus a canary completion is the real health check.
  [ -n "$OMNI_KEY" ] && [ -n "$OMNI_MODEL" ] || return 1
  curl -s -m 90 -X POST "$OMNI_URL/chat/completions" \
    -H "Authorization: Bearer $OMNI_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$OMNI_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}" 2>/dev/null |
    grep -q '"choices"'
}

probe_cf() {
  curl -s -m 30 -X POST \
    -H "Authorization: Bearer $2" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":1}' \
    "https://api.cloudflare.com/client/v4/accounts/$1/ai/run/@cf/google/gemma-4-26b-a4b-it" |
    grep -q '"success":true'
}

run_eval() {
  log "resume run ($1)"
  shift
  env KOVE_EVAL_BASELINE=1 KOVE_EVAL_RUNS=3 KOVE_EVAL_RESUME=1 "$@" \
    pnpm --filter @kove-advanced/agent test:run src/eval/baseline.test.ts >>"$LOG" 2>&1
  log "run exited with status $?"
}

log "runner started (report: $REPORT, k=3)"
idle=0
while ! is_complete; do
  if pgrep -f "vitest run src/eval/baseline.test.ts" >/dev/null 2>&1; then
    sleep 30
    continue
  fi
  ran=0
  # One model per report: Workers fallbacks only engage when the gateway was
  # unreachable this cycle. Mixing providers in one report corrupts the
  # comparison (runBaseline also refuses to merge across models).
  if probe_omni; then
    run_eval "omniroute $OMNI_URL" KOVE_EVAL_LLM_PROVIDER=omni
    ran=1
  fi
  if [ "$ran" -eq 0 ] && ! is_complete && probe_cf "$CLOUDFLARE_ACCOUNT_ID" "$CLOUDFLARE_API_TOKEN"; then
    run_eval "cloudflare account 1" KOVE_EVAL_LLM_PROVIDER=workers \
      KOVE_EVAL_CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
      KOVE_EVAL_CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN"
    ran=1
  fi
  if [ "$ran" -eq 0 ] && ! is_complete && probe_cf "$CLOUDFLARE_ACCOUNT_ID_2" "$CLOUDFLARE_API_TOKEN_2"; then
    run_eval "cloudflare account 2" KOVE_EVAL_LLM_PROVIDER=workers \
      KOVE_EVAL_CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID_2" \
      KOVE_EVAL_CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_2"
    ran=1
  fi
  if is_complete; then
    break
  fi
  if [ "$ran" -eq 0 ]; then
    idle=$((idle + 1))
    if [ "$idle" -ge "$MAX_IDLE_CYCLES" ]; then
      log "giving up after $idle idle cycles (no LLM backend for ~15h)"
      exit 1
    fi
    log "no healthy backend; sleeping 10 min (idle cycle $idle/$MAX_IDLE_CYCLES)"
    sleep 600
  else
    idle=0
    log "run finished but report still incomplete; re-probing"
  fi
done
log "corpus complete: $(node -e 'const r=require("./evaluation-files/baseline-v0.json"); console.log(`${r.total} case-runs, model ${r.model}, status ${r.status}`)' 2>/dev/null)"
