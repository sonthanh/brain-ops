#!/usr/bin/env bash
# improve-cron.sh — runs daily 20:00 local via launchd (com.brain.improve).
# Invokes /improve in full auto-batch mode: Step 0 (memory triage), then Phase 1
# ranks, then the wrapper re-invokes /improve <top-candidate> for full
# Phase 1-5 on the chosen skill. Daily cadence is safe because the weekly
# quota gate self-throttles when the budget gets tight.
#
# Gates (in order):
#   1. Weekly quota skip (ccstatusline cache, env-overridable threshold) — natural
#      backpressure; the same-week dedup gate that previously short-circuited
#      Sunday-only firing was removed when the cadence flipped to daily.
#   2. GUARD — /improve evals must exist with >= MIN cases
#   3. GUARD — no recent human commits to skills/improve/ without Claude
#      co-author (signals user had to correct /improve; auto must stop and
#      wait for user review). See issue sonthanh/ai-brain#8 "red flag" req.
#
# Flags:
#   --dry-run        exit before `claude -p`; still exercises guards + logs
#                    for acceptance tests without burning quota.
#
# Log format matches pickup-auto/cron.log so render-status.sh auto-parses.

set -uo pipefail

export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v22.16.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

VAULT="${IMPROVE_VAULT:-$HOME/work/brain}"
STATE_DIR="${IMPROVE_STATE_DIR:-$HOME/.local/state/improve}"
LOG_FILE="$STATE_DIR/cron.log"
ENV_FILE="${IMPROVE_ENV_FILE:-$HOME/.config/brain/env}"
USAGE_FILE="${IMPROVE_USAGE_FILE:-$HOME/.cache/ccstatusline/usage.json}"
WEEKLY_THRESHOLD="${IMPROVE_THRESHOLD:-80}"
MODEL="${IMPROVE_MODEL:-sonnet}"
PLUGIN_REPO="${IMPROVE_PLUGIN_REPO:-$HOME/work/brain-os-plugin}"
IMPROVE_EVALS="$PLUGIN_REPO/skills/improve/evals/evals.json"
MIN_EVAL_CASES="${IMPROVE_MIN_EVAL_CASES:-5}"
REVIEW_WINDOW="${IMPROVE_REVIEW_WINDOW:-14 days ago}"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
  esac
done

mkdir -p "$STATE_DIR"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"
}

send_telegram() {
  local msg="$1"
  if (( DRY_RUN == 1 )); then
    log "telegram (dry-run): would send: ${msg//$'\n'/ }"
    return 0
  fi
  if [[ -z "${TG_BOT_TOKEN:-}" || -z "${TG_CHAT_ID:-}" ]]; then
    log "telegram: credentials missing — skipping alert"
    return 1
  fi
  local payload
  payload=$(jq -n \
    --argjson chat_id "${TG_CHAT_ID}" \
    --arg text "$msg" \
    '{chat_id: $chat_id, text: $text, parse_mode: "Markdown"}') || return 1
  curl -sf -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$payload" >/dev/null 2>&1 || log "telegram: send failed"
}

log "=== improve tick (dry_run=$DRY_RUN model=$MODEL) ==="

# ---- Pre-flight
for bin in claude jq curl; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    log "ERROR: $bin not in PATH — aborting"
    exit 1
  fi
done

if [[ ! -d "$VAULT" ]]; then
  log "ERROR: vault dir $VAULT not found — aborting"
  exit 1
fi

# ---- Weekly quota gate. The same-week dedup that lived here was removed when
# cadence flipped to daily — quota is the only natural-backpressure gate now.
if [[ -f "$USAGE_FILE" ]]; then
  DECISION=$(jq -r --argjson threshold "$WEEKLY_THRESHOLD" '
    def reset_epoch:
      if .weeklyResetAt then
        (.weeklyResetAt | sub("\\..*$"; "Z") | fromdateiso8601)
      else 0 end;
    (.weeklyUsage // 0) as $u |
    reset_epoch as $r |
    if $u >= $threshold and (now < $r) then
      "skip:" + ($u|tostring) + ":" + (.weeklyResetAt // "unknown")
    else
      "run:" + ($u|tostring)
    end
  ' "$USAGE_FILE" 2>/dev/null || echo "run:parse-error")

  case "$DECISION" in
    skip:*)
      log "SKIP — weekly usage ${DECISION#skip:} (>= ${WEEKLY_THRESHOLD}%)"
      exit 0
      ;;
    run:*)
      log "PROCEED — weekly usage ${DECISION#run:}%"
      ;;
    *)
      log "WARN: unknown decision '$DECISION' — proceeding"
      ;;
  esac
else
  log "WARN: no usage cache at $USAGE_FILE — proceeding without gate"
fi

# ---- GUARD 1: /improve must have an eval test with >= MIN_EVAL_CASES.
# Auto-improve of /improve itself would run Phase 4's eval gate, which needs
# evals to exist. If absent/insufficient, stop and ask for review.
if [[ ! -f "$IMPROVE_EVALS" ]]; then
  log "GUARD-1 FAIL: $IMPROVE_EVALS missing — halting auto-improve"
  send_telegram "*Improve Halted*: \`skills/improve/evals/evals.json\` missing. Auto-improve needs evals on \`/improve\` itself. Add cases then re-enable cron."
  log "=== improve done (halted: no evals) ==="
  exit 0
fi
EVAL_CASES=$(jq 'length' "$IMPROVE_EVALS" 2>/dev/null || echo 0)
if (( EVAL_CASES < MIN_EVAL_CASES )); then
  log "GUARD-1 FAIL: $EVAL_CASES eval cases (need >= $MIN_EVAL_CASES) — halting"
  send_telegram "*Improve Halted*: only $EVAL_CASES eval cases for \`/improve\` (min $MIN_EVAL_CASES). Add more cases then re-enable cron."
  log "=== improve done (halted: insufficient evals) ==="
  exit 0
fi
log "guard-1 ok: $EVAL_CASES eval cases present"

# ---- GUARD 2: RED FLAG — recent user corrections to skills/improve/.
# If the user has made commits to /improve's skill dir without Claude as
# co-author in the review window, it signals /improve is unreliable right
# now. Auto must halt and wait for explicit user review.
USER_CORRECTIONS=0
if [[ -d "$PLUGIN_REPO/.git" ]]; then
  while IFS= read -r HASH; do
    [[ -z "$HASH" ]] && continue
    if ! git -C "$PLUGIN_REPO" show -s --format="%B" "$HASH" 2>/dev/null \
         | grep -qE "Co-Authored-By:.*Claude"; then
      USER_CORRECTIONS=$((USER_CORRECTIONS + 1))
    fi
  done < <(git -C "$PLUGIN_REPO" log \
             --since="$REVIEW_WINDOW" \
             --format="%H" \
             -- skills/improve/ 2>/dev/null)
fi
if (( USER_CORRECTIONS > 0 )); then
  log "GUARD-2 FAIL (red flag): $USER_CORRECTIONS non-Claude commit(s) to skills/improve/ since '$REVIEW_WINDOW' — halting"
  send_telegram "*Improve Halted*: $USER_CORRECTIONS user correction(s) to \`/improve\` since $REVIEW_WINDOW. Auto-improve paused. Review and clear before next cron."
  log "=== improve done (halted: user corrections) ==="
  exit 0
fi
log "guard-2 ok: no user corrections to skills/improve/ since $REVIEW_WINDOW"

# ---- Step 0 probe: count memory feedback files across all Claude account dirs.
# The realpath-dedupe mirrors what /improve memory does (Step 0.0 — symlinks
# between accounts must not double-count).
STEP0_PENDING=$(python3 - <<'PY' 2>/dev/null | wc -l | tr -d ' '
import glob, os, sys
seen = set()
for f in glob.glob(os.path.expanduser('~/.claude*/projects/*/memory/feedback_*.md')):
    canon = os.path.realpath(f)
    if canon not in seen:
        seen.add(canon)
        print(canon)
PY
)
log "step 0 probe: $STEP0_PENDING memory feedback file(s) across ~/.claude*/projects/*/memory/"

# ---- Dry-run short-circuit (acceptance-test path)
if (( DRY_RUN == 1 )); then
  log "dry-run: skipping claude invocation; would orchestrate: step0=/improve memory (always — also handles index reconcile + expiry) → step1=/improve → parse top candidate → step2=/improve <top>"
  log "=== improve done (dry-run) ==="
  exit 0
fi

# ---- Step 0: Phase 0 — memory triage + index reconcile + expiry.
# Runs BEFORE Phase 1 so explicit user feedback takes precedence over inferred
# log patterns. Always invoked (even when STEP0_PENDING=0) because Step 0.5
# (index reconcile) and Step 0.7 (expiry) are useful regardless of new feedback.
# Failure here is NON-BLOCKING — we still proceed to Phase 1 so Phase 0 bugs
# don't stall log-based improvements.
log "step 0: invoking /improve memory (triage=$STEP0_PENDING, index reconcile, expiry)"
if cd "$VAULT" && claude --dangerously-skip-permissions --model "$MODEL" -p "/improve memory" >> "$LOG_FILE" 2>&1; then
  log "step 0 completed"
else
  RC=$?
  log "step 0 failed (exit=$RC) — continuing to Phase 1 (memory gate is non-blocking)"
  send_telegram "*Improve Step 0 Failed*: \`/improve memory\` cron exited $RC. Continuing to Phase 1. Check \`$LOG_FILE\`."
fi

# ---- Step 1: Phase 1 rank-only, capture output to parse top candidate.
# We ask the skill to emit a parseable marker line `TOP_CANDIDATE: <name>` so
# this wrapper can deterministically orchestrate step 2 regardless of prose
# variance. If the marker is missing we treat as rank-only + notify.
STEP1_OUT=$(mktemp -t improve-step1.XXXXXX)
trap 'rm -f "$STEP1_OUT"' EXIT

STEP1_PROMPT="/improve

Rank skills by failure rate per Phase 1 and stop (do NOT run Phase 2-5). At the end of your output, emit exactly one line in this format:
TOP_CANDIDATE: <skill-name>
— or —
TOP_CANDIDATE: none
Nothing after that line."

log "step 1: ranking skills via /improve"
if ! cd "$VAULT" || ! claude --dangerously-skip-permissions --model "$MODEL" -p "$STEP1_PROMPT" > "$STEP1_OUT" 2>&1; then
  RC=$?
  log "step 1 failed (exit=$RC); see tail below"
  tail -30 "$STEP1_OUT" >> "$LOG_FILE"
  send_telegram "*Improve Failed*: Phase 1 ranking exited $RC. Check \`$LOG_FILE\`."
  log "=== improve done (failed: step 1) ==="
  exit "$RC"
fi
cat "$STEP1_OUT" >> "$LOG_FILE"

TOP=$(grep -oE '^TOP_CANDIDATE:[[:space:]]*[A-Za-z0-9_.-]+' "$STEP1_OUT" | tail -1 | awk '{print $NF}')
if [[ -z "$TOP" || "$TOP" == "none" ]]; then
  log "step 1: no top candidate (TOP='${TOP:-<missing marker>}') — ending batch"
  log "=== improve done (no candidate) ==="
  exit 0
fi
log "step 1: top candidate = $TOP"

# ---- Step 2: full Phase 1-5 pipeline on top candidate.
log "step 2: invoking /improve $TOP (full pipeline)"
if cd "$VAULT" && claude --dangerously-skip-permissions --model "$MODEL" -p "/improve $TOP" >> "$LOG_FILE" 2>&1; then
  log "improve completed successfully (candidate=$TOP)"
  log "=== improve done ==="
  exit 0
else
  RC=$?
  log "improve failed on $TOP (exit=$RC)"
  send_telegram "*Improve Failed*: \`/improve $TOP\` cron exited $RC on $(date +%Y-%m-%d). Check \`$LOG_FILE\`."
  log "=== improve done (failed) ==="
  exit "$RC"
fi
