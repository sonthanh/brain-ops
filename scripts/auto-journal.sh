#!/usr/bin/env bash
set -euo pipefail

# Auto Journal — runs daily via launchd
# Summarizes previous day(s) using /journal skill with Opus

VAULT="$HOME/work/brain"
REPOS=("$HOME/work/brain" "$HOME/work/brain-ops" "$HOME/work/brain-os-plugin" "$HOME/work/brain-os-marketplace")
LOG_DIR="$VAULT/daily/journal/logs"
JOURNAL_DIR="$VAULT/daily/journal"
SESSION_DIR="$VAULT/daily/sessions"
HANDOVER_DIR="$VAULT/daily/handovers"
ENV_FILE="$HOME/.config/brain/env"
MAX_RETRIES=3
RETRY_DELAY=300  # 5 minutes

# Load Telegram credentials
if [[ -f "$ENV_FILE" ]]; then
  source "$ENV_FILE"
fi

mkdir -p "$LOG_DIR"

log() {
  local date_str="$1"
  local msg="$2"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $msg" >> "$LOG_DIR/$date_str.log"
}

send_telegram() {
  local msg="$1"
  if [[ -z "${TG_BOT_TOKEN:-}" || -z "${TG_CHAT_ID:-}" ]]; then
    echo "Telegram credentials not configured" >&2
    return 1
  fi
  curl -sf -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c "
import json, os
print(json.dumps({
    'chat_id': int(os.environ['TG_CHAT_ID']),
    'text': os.environ['TG_MSG'],
    'parse_mode': 'Markdown'
}))
" )" || echo "Telegram send failed" >&2
}

has_activity() {
  local date_str="$1"
  local next_date
  next_date=$(date -j -f "%Y-%m-%d" "$date_str" "+%Y-%m-%d" 2>/dev/null || echo "$date_str")
  local next_day
  next_day=$(date -j -v+1d -f "%Y-%m-%d" "$date_str" "+%Y-%m-%d" 2>/dev/null)

  # Check git activity across all repos
  for repo in "${REPOS[@]}"; do
    if [[ -d "$repo/.git" ]]; then
      local commits
      commits=$(git -C "$repo" log --oneline --since="${date_str}T00:00" --until="${next_day}T00:00" 2>/dev/null | head -1)
      if [[ -n "$commits" ]]; then
        return 0
      fi
    fi
  done

  # Check session files
  if compgen -G "$SESSION_DIR/${date_str}-*" > /dev/null 2>&1; then
    return 0
  fi

  # Check handover files
  if compgen -G "$HANDOVER_DIR/${date_str}-*" > /dev/null 2>&1; then
    return 0
  fi

  return 1
}

run_journal() {
  local date_str="$1"
  local attempt=0

  log "$date_str" "Starting journal for $date_str"

  while (( attempt < MAX_RETRIES )); do
    attempt=$((attempt + 1))
    log "$date_str" "Attempt $attempt/$MAX_RETRIES"

    if cd "$VAULT" && claude -p "/journal $date_str" --model claude-opus-4-6 >> "$LOG_DIR/$date_str.log" 2>&1; then
      log "$date_str" "Journal completed successfully"
      return 0
    fi

    log "$date_str" "Attempt $attempt failed"

    if (( attempt < MAX_RETRIES )); then
      log "$date_str" "Waiting ${RETRY_DELAY}s before retry"
      sleep "$RETRY_DELAY"
    fi
  done

  # All retries exhausted — notify
  log "$date_str" "All $MAX_RETRIES attempts failed"
  export TG_MSG="*Auto Journal Failed*: Could not generate journal for $date_str after $MAX_RETRIES attempts. Run \`/journal $date_str\` manually."
  send_telegram "$TG_MSG"
  return 1
}

find_last_journal_date() {
  # Find the most recent journal file
  local latest
  latest=$(find "$JOURNAL_DIR" -maxdepth 1 -name "????-??-??-journey.md" 2>/dev/null | sort -r | head -1)
  if [[ -n "$latest" ]]; then
    basename "$latest" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
  fi
}

dates_between() {
  local start="$1"
  local end="$2"
  local current
  current=$(date -j -v+1d -f "%Y-%m-%d" "$start" "+%Y-%m-%d")

  while [[ "$current" < "$end" || "$current" == "$end" ]]; do
    echo "$current"
    current=$(date -j -v+1d -f "%Y-%m-%d" "$current" "+%Y-%m-%d")
  done
}

# --- Main ---

yesterday=$(date -j -v-1d "+%Y-%m-%d")

# Check for gaps (backfill)
last_journal=$(find_last_journal_date)

if [[ -n "$last_journal" && "$last_journal" < "$yesterday" ]]; then
  echo "Gap detected: last journal=$last_journal, target=$yesterday"
  for gap_date in $(dates_between "$last_journal" "$yesterday"); do
    if has_activity "$gap_date"; then
      echo "Backfilling $gap_date (has activity)"
      run_journal "$gap_date"
    else
      log "$gap_date" "Skipped — no activity detected"
      echo "Skipping $gap_date (no activity)"
    fi
  done
else
  # Normal run — just yesterday
  if has_activity "$yesterday"; then
    run_journal "$yesterday"
  else
    log "$yesterday" "Skipped — no activity detected"
    echo "No activity on $yesterday, skipping"
  fi
fi
