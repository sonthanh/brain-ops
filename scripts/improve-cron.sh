#!/usr/bin/env bash
# improve-cron.sh — runs weekly Sunday 04:00 local via launchd (com.brain.improve).
# Invokes /improve via `claude -p` to kick the skill-learning loop.
#
# Gates:
#   • Same-week dedup (.last-run marker, written only on success)
#   • Weekly quota skip (ccstatusline cache, env-overridable threshold)
#
# Flags:
#   --dry-run        exit before `claude -p`; still writes log lines so the
#                    acceptance checklist can verify PATH + gate + log format
#                    without burning quota.
#
# Log format matches pickup-auto/cron.log so render-status.sh auto-parses.

set -uo pipefail

export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v22.16.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

VAULT="${IMPROVE_VAULT:-$HOME/work/brain}"
STATE_DIR="${IMPROVE_STATE_DIR:-$HOME/.local/state/improve}"
LOG_FILE="$STATE_DIR/cron.log"
LAST_RUN="$STATE_DIR/.last-run"
ENV_FILE="${IMPROVE_ENV_FILE:-$HOME/.config/brain/env}"
USAGE_FILE="${IMPROVE_USAGE_FILE:-$HOME/.cache/ccstatusline/usage.json}"
WEEKLY_THRESHOLD="${IMPROVE_THRESHOLD:-80}"
MODEL="${IMPROVE_MODEL:-sonnet}"

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

# ISO week tag (YYYY-Www) — used for same-week dedup since this cron is weekly.
iso_week() {
  date "+%G-W%V"
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

# ---- Same-week dedup (defensive against double-fire within the same ISO week).
THIS_WEEK=$(iso_week)
if [[ -f "$LAST_RUN" && "$(cat "$LAST_RUN" 2>/dev/null)" == "$THIS_WEEK" ]]; then
  log "already ran this week ($THIS_WEEK) — skipping"
  exit 0
fi

# ---- Weekly quota gate. Skip path does NOT write .last-run so the next
# scheduled run (or a manual retry after quota resets) can still proceed.
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

# ---- Dry-run short-circuit (acceptance-test path)
if (( DRY_RUN == 1 )); then
  log "dry-run: skipping claude invocation; would run: claude --dangerously-skip-permissions --model $MODEL -p /improve"
  log "=== improve done (dry-run) ==="
  exit 0
fi

# ---- Invoke /improve (no arg → Phase 1 rank-only across all outcome logs)
log "invoking: claude --dangerously-skip-permissions --model $MODEL -p /improve"
if cd "$VAULT" && claude --dangerously-skip-permissions --model "$MODEL" -p "/improve" >> "$LOG_FILE" 2>&1; then
  log "improve completed successfully"
  echo "$THIS_WEEK" > "$LAST_RUN"
  log "=== improve done ==="
  exit 0
else
  RC=$?
  log "improve failed (exit=$RC)"
  send_telegram "*Improve Failed*: \`/improve\` cron exited $RC on $(date +%Y-%m-%d) ($THIS_WEEK). Check \`$LOG_FILE\`."
  log "=== improve done (failed) ==="
  exit "$RC"
fi
