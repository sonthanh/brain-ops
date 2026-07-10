#!/usr/bin/env -S bun run
/*
 * gmail-triage-watchdog.ts — re-dispatch "Gmail Triage" when GitHub cron
 * skips or drifts past a slot. launchd com.brain.gmail-triage-watchdog
 * (every 30 min, always-on Mac mini).
 *
 * Why: GitHub scheduled workflows are best-effort — slots fire 20-140 min
 * late or never (2026-07-03 and 2026-07-10: the early-UTC slot silently
 * skipped, inbox sat untriaged all morning). The in-repo autofix listener
 * only wakes on a run that FAILED; a run that never started produces no
 * event at all. This watchdog closes that gap deterministically from the
 * local machine.
 *
 * Slot-aware: it knows the workflow's cron slots (SLOTS_UTC — KEEP IN SYNC
 * with .github/workflows/gmail-triage.yml in sonthanh/ai-brain) and
 * dispatches only when the most recent slot is >90 min overdue with no run
 * covering it. A fixed staleness threshold would false-fire across the 5h
 * night gap (23:23 UTC → 05:23 UTC has no slot by design).
 *
 * Budget-guarded: the sonthanh account has 2,000 free Actions minutes/month
 * (SSOT: vault working-rules.md § GitHub Actions budget) and the private
 * repo bills every job minute. Before dispatching, the watchdog estimates
 * month-to-date usage from run durations; it warns at ≥75% (1,500 min) and
 * REFUSES to dispatch at ≥95% (1,900 min) — a watchdog that burns the last
 * of the quota would cause the very outage it exists to prevent.
 *
 * A duplicate dispatch (cron slot firing right after us) is harmless: the
 * workflow's `gmail-ledger` concurrency group queues it, the run fetches
 * unread-only and caps work at 40 emails, so a second run is a ~2-min no-op.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const REPO = "sonthanh/ai-brain";
export const WORKFLOW_FILE = "gmail-triage.yml";

// Cron slots of gmail-triage.yml: '23 5,7,9,11,13,15,18,23 * * *' (UTC).
export const SLOTS_UTC = [5, 7, 9, 11, 13, 15, 18, 23];
export const SLOT_MINUTE = 23;
// GitHub cron is routinely 20-140 min late; only treat a slot as MISSED
// (vs merely drifting) past this allowance.
export const DRIFT_ALLOWANCE_MIN = 90;

export const BUDGET_MINUTES_PER_MONTH = 2000;
export const BUDGET_WARN_MINUTES = 1500; // 75%
export const BUDGET_REFUSE_MINUTES = 1900; // 95%

const ACTIVE_STATUSES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

export interface RunInfo {
  created_at: string;
  status: string;
}

export interface Decision {
  dispatch: boolean;
  reason: string;
}

/** Most recent scheduled slot time (UTC) at or before `nowMs`. */
export function mostRecentSlotMs(nowMs: number, slots: number[] = SLOTS_UTC, minute: number = SLOT_MINUTE): number {
  const now = new Date(nowMs);
  let best = -Infinity;
  for (const dayOffset of [0, -1]) {
    for (const hour of slots) {
      const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hour, minute, 0, 0);
      if (t <= nowMs && t > best) best = t;
    }
  }
  return best;
}

/** Pure decision: given recent runs (any order), should we dispatch now? */
export function decide(runs: RunInfo[], nowMs: number): Decision {
  const active = runs.find((r) => ACTIVE_STATUSES.has(r.status));
  if (active) {
    return { dispatch: false, reason: `a run is already ${active.status} (created ${active.created_at})` };
  }
  const slotMs = mostRecentSlotMs(nowMs);
  const slotISO = new Date(slotMs).toISOString();
  if (runs.length === 0) {
    return { dispatch: true, reason: "no runs found at all" };
  }
  const newestMs = Math.max(...runs.map((r) => new Date(r.created_at).getTime()));
  if (newestMs >= slotMs) {
    return { dispatch: false, reason: `slot ${slotISO} is covered (newest run ${new Date(newestMs).toISOString()})` };
  }
  const overdueMin = (nowMs - slotMs) / 60_000;
  if (overdueMin <= DRIFT_ALLOWANCE_MIN) {
    return {
      dispatch: false,
      reason: `slot ${slotISO} uncovered but only ${overdueMin.toFixed(0)} min overdue (<= ${DRIFT_ALLOWANCE_MIN} min drift allowance)`,
    };
  }
  return {
    dispatch: true,
    reason: `slot ${slotISO} is ${overdueMin.toFixed(0)} min overdue with no run — cron skipped or drifted too far`,
  };
}

export interface BillableRun {
  run_started_at?: string | null;
  updated_at?: string | null;
  conclusion?: string | null;
}

/**
 * Estimate billable Actions minutes from run timestamps. Approximation:
 * billing is per-job rounded up; run duration is close enough for a guard
 * (skipped runs never start a job → 0). Each started run bills ≥1 min.
 */
export function estimateMinutes(runs: BillableRun[]): number {
  let total = 0;
  for (const r of runs) {
    if (r.conclusion === "skipped") continue;
    if (!r.run_started_at || !r.updated_at) continue;
    const ms = new Date(r.updated_at).getTime() - new Date(r.run_started_at).getTime();
    if (!Number.isFinite(ms) || ms <= 0) continue;
    total += Math.max(1, Math.ceil(ms / 60_000));
  }
  return total;
}

export type BudgetVerdict = { level: "ok" | "warn" | "refuse"; usedMinutes: number };

export function budgetVerdict(usedMinutes: number): BudgetVerdict {
  if (usedMinutes >= BUDGET_REFUSE_MINUTES) return { level: "refuse", usedMinutes };
  if (usedMinutes >= BUDGET_WARN_MINUTES) return { level: "warn", usedMinutes };
  return { level: "ok", usedMinutes };
}

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${err.trim() || out.trim()}`);
  }
  return out;
}

function notifyMac(msg: string): void {
  try {
    Bun.spawnSync([
      "osascript",
      "-e",
      `display notification ${JSON.stringify(msg)} with title "gmail-triage watchdog"`,
    ]);
  } catch {
    // notification is best-effort
  }
}

if (import.meta.main) {
  const stateDir = join(process.env.HOME ?? "/Users/thanhdo", ".local/state/gmail-triage-watchdog");
  mkdirSync(stateDir, { recursive: true });
  const logFile = join(stateDir, "watchdog.log");
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    appendFileSync(logFile, line + "\n");
  };

  try {
    const raw = await gh([
      "api",
      `repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=10`,
      "--jq",
      "[.workflow_runs[] | {created_at, status}]",
    ]);
    const runs: RunInfo[] = JSON.parse(raw);
    const decision = decide(runs, Date.now());
    if (!decision.dispatch) {
      log(`ok — ${decision.reason}`);
      process.exit(0);
    }

    // Budget gate — only on the dispatch path (keeps routine ticks to 1 API call).
    const monthStart = new Date().toISOString().slice(0, 8) + "01";
    const billableRaw = await gh([
      "api",
      "--paginate",
      `repos/${REPO}/actions/runs?created=%3E%3D${monthStart}&per_page=100`,
      "--jq",
      "[.workflow_runs[] | {run_started_at, updated_at, conclusion}]",
    ]);
    // --paginate emits one JSON array per page; normalize to a single array.
    const billable: BillableRun[] = billableRaw
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((page) => JSON.parse(page));
    const verdict = budgetVerdict(estimateMinutes(billable));
    if (verdict.level === "refuse") {
      const msg = `REFUSING dispatch — est. ${verdict.usedMinutes}/${BUDGET_MINUTES_PER_MONTH} Actions min used this month (>= ${BUDGET_REFUSE_MINUTES}). Quota exhaustion would stop ALL workflows.`;
      log(`${msg} (${decision.reason})`);
      notifyMac(msg);
      process.exit(0);
    }
    if (verdict.level === "warn") {
      const msg = `Actions budget warning: est. ${verdict.usedMinutes}/${BUDGET_MINUTES_PER_MONTH} min used this month (>= ${BUDGET_WARN_MINUTES}). Consider trimming slots (gmail-triage.yml cron).`;
      log(msg);
      notifyMac(msg);
    }

    log(`STALE — ${decision.reason}; dispatching ${WORKFLOW_FILE} (est. ${verdict.usedMinutes} min used this month)`);
    await gh(["workflow", "run", WORKFLOW_FILE, "--repo", REPO]);
    log("dispatched ok");
  } catch (e) {
    log(`ERROR — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
