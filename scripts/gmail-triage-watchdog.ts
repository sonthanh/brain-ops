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
 * local machine: if no run has started for STALE_HOURS and none is queued
 * or in progress, dispatch one via `gh workflow run`.
 *
 * A duplicate dispatch (cron slot firing right after us) is harmless: the
 * workflow's `gmail-ledger` concurrency group queues it, the run fetches
 * unread-only and caps work at 30 emails, so a second run is a ~2-min no-op.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const REPO = "sonthanh/ai-brain";
export const WORKFLOW_FILE = "gmail-triage.yml";
// Slots are every 2h; GitHub drift is commonly 20-140 min. 2.5h means a
// skipped slot is repaired within ~3h worst-case (threshold + 30-min tick).
export const STALE_HOURS = 2.5;

const ACTIVE_STATUSES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

export interface RunInfo {
  created_at: string;
  status: string;
}

export interface Decision {
  dispatch: boolean;
  reason: string;
}

/** Pure decision: given recent runs (any order), should we dispatch now? */
export function decide(runs: RunInfo[], nowMs: number, staleHours: number = STALE_HOURS): Decision {
  const active = runs.find((r) => ACTIVE_STATUSES.has(r.status));
  if (active) {
    return { dispatch: false, reason: `a run is already ${active.status} (created ${active.created_at})` };
  }
  if (runs.length === 0) {
    return { dispatch: true, reason: "no runs found at all" };
  }
  const newestMs = Math.max(...runs.map((r) => new Date(r.created_at).getTime()));
  const ageHours = (nowMs - newestMs) / 3_600_000;
  if (ageHours > staleHours) {
    return {
      dispatch: true,
      reason: `newest run is ${ageHours.toFixed(1)}h old (> ${staleHours}h) — cron slot skipped or drifted`,
    };
  }
  return { dispatch: false, reason: `newest run is ${ageHours.toFixed(1)}h old (<= ${staleHours}h)` };
}

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${err.trim() || out.trim()}`);
  }
  return out;
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
    log(`STALE — ${decision.reason}; dispatching ${WORKFLOW_FILE}`);
    await gh(["workflow", "run", WORKFLOW_FILE, "--repo", REPO]);
    log("dispatched ok");
  } catch (e) {
    log(`ERROR — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
