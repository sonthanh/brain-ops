#!/usr/bin/env bash
# codeburn-optimize-cron.sh — weekly Monday 09:00 local via launchd
# (com.brain.codeburn-optimize).
#
# Runs `codeburn optimize --period week`, saves the report to
# $STATE_DIR/reports/YYYY-MM-DD.md, and files a GitHub issue in
# $GH_TASK_REPO with the findings.
#
# Idempotent:
#   - Same-week dedup via .last-run ISO-week marker
#   - Skip filing if a prior "Codeburn weekly:" issue is still open (match by
#     title prefix, no label dependency)
#
# Flags:
#   --dry-run    skip gh issue create; still runs codeburn + saves report

set -uo pipefail

export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v22.16.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

STATE_DIR="${CODEBURN_STATE_DIR:-$HOME/.local/state/codeburn-optimize}"
REPORTS_DIR="$STATE_DIR/reports"
LOG_FILE="$STATE_DIR/cron.log"
LAST_RUN="$STATE_DIR/.last-run"
GH_TASK_REPO="${CODEBURN_GH_REPO:-sonthanh/ai-brain}"
PERIOD="${CODEBURN_PERIOD:-week}"
TITLE_PREFIX="Codeburn weekly:"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
  esac
done

mkdir -p "$REPORTS_DIR"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"
}

iso_week() { date "+%G-W%V"; }

log "=== codeburn-optimize tick (dry_run=$DRY_RUN period=$PERIOD) ==="

for bin in codeburn gh jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    log "ERROR: $bin not in PATH — aborting"
    exit 1
  fi
done

THIS_WEEK=$(iso_week)
if [[ "$DRY_RUN" == 0 && -f "$LAST_RUN" && "$(cat "$LAST_RUN" 2>/dev/null)" == "$THIS_WEEK" ]]; then
  log "already ran this week ($THIS_WEEK) — skipping"
  exit 0
fi

if (( DRY_RUN == 0 )); then
  if ! gh auth status >/dev/null 2>&1; then
    log "ERROR: gh not authenticated — aborting"
    exit 1
  fi
fi

TODAY=$(date +%Y-%m-%d)
REPORT="$REPORTS_DIR/$TODAY.md"

{
  echo "# Codeburn weekly optimize — $TODAY"
  echo
  echo "Period: \`$PERIOD\`"
  echo
  echo '```'
  codeburn optimize --period "$PERIOD" 2>&1
  echo '```'
} > "$REPORT"

if [[ ! -s "$REPORT" ]]; then
  log "ERROR: empty report — aborting"
  exit 1
fi
log "report written: $REPORT ($(wc -c < "$REPORT") bytes)"

HEALTH=$(grep -oE 'Health: [A-F][+-]? \([^)]*\)' "$REPORT" | head -1 | sed 's/^Health: //' || true)
SAVINGS=$(grep -oE 'Potential savings: [^)]*\)' "$REPORT" | head -1 | sed 's/^Potential savings: //' || true)
log "health: ${HEALTH:-unknown} | savings: ${SAVINGS:-unknown}"

if (( DRY_RUN == 0 )); then
  OPEN_COUNT=$(gh issue list \
    --repo "$GH_TASK_REPO" \
    --state open \
    --search "in:title \"$TITLE_PREFIX\"" \
    --json number 2>/dev/null | jq length)
  if [[ "${OPEN_COUNT:-0}" -gt 0 ]]; then
    log "skip: $OPEN_COUNT open '$TITLE_PREFIX' issue(s) in $GH_TASK_REPO — close first"
    echo "$THIS_WEEK" > "$LAST_RUN"
    exit 0
  fi
fi

TITLE="$TITLE_PREFIX $TODAY — ${HEALTH:-unknown} — ${SAVINGS:-unknown savings}"

if (( DRY_RUN == 1 )); then
  log "dry-run: would create issue '$TITLE' ($(wc -c < "$REPORT") bytes body)"
  exit 0
fi

ISSUE_URL=$(gh issue create \
  --repo "$GH_TASK_REPO" \
  --title "$TITLE" \
  --body-file "$REPORT" 2>&1) || {
    log "ERROR: gh issue create failed: $ISSUE_URL"
    exit 1
  }

log "issue created: $ISSUE_URL"
echo "$THIS_WEEK" > "$LAST_RUN"
log "=== done ==="
