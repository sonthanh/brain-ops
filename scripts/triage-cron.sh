#!/usr/bin/env bash
# triage-cron.sh — nightly backlog triage. launchd com.brain.triage (02:30).
#
# Thin wrapper (no logic): runs the vault's deterministic classifier and writes
# a fresh triage report. REPORT-ONLY by design — it does not mutate labels.
# To enable the full auto-work loop (promote bot-safe → owner:bot → pickup-auto
# drains every 2h), change the bun invocation to add `--commit --promote`. Kept
# gated until the classifier earns trust. All judgment lives in triage-issues.ts.
set -uo pipefail

export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v22.16.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

VAULT="${TRIAGE_VAULT:-$HOME/work/brain}"
STATE_DIR="${TRIAGE_STATE_DIR:-$HOME/.local/state/triage}"
LOG_FILE="$STATE_DIR/cron.log"
REPORT="$VAULT/business/tasks/triage-report.md"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$STATE_DIR"
cd "$VAULT" || { echo "[$NOW] FATAL: vault not found at $VAULT" >> "$LOG_FILE"; exit 1; }

{
  echo "<!-- generated: $(date '+%Y-%m-%d %H:%M') (com.brain.triage) -->"
  echo ""
  bun run scripts/triage-issues.ts
} > "$REPORT" 2>> "$LOG_FILE"

echo "[$NOW] triage report written → $REPORT" >> "$LOG_FILE"
