#!/usr/bin/env -S bun run
// orca-automation-doctor.ts — auto-FIX layer for Orca automation runs.
//
// Pairs with monitor-orca-sessions.ts (ALERT layer) and reap-orca-sessions.ts (TEARDOWN
// layer). The doctor runs hourly via launchd, scans every enabled automation's latest run,
// and AUTO-RETRIES the ones that failed to launch — one at a time, staggered.
//
// WHY this exists (root-caused 2026-06-27): Orca launches each automation by typing its
// `claude '<prompt>'` command into an INTERACTIVE shell. Under concurrent launches (e.g. many
// automations firing at once, or a missed-run catch-up storm after the machine wakes / after a
// mass re-enable), Orca's keystroke injection RACES — the first character doubles (`cclaude`
// instead of `claude`), the shell hits "command not found", exits 1, and Orca records the run
// as `dispatch_failed`. The agent NEVER launched, so NO work happened and NO side effects fired
// (verified: such runs die in ~4 s with a <4 KB snapshot showing only the mangled shell line and
// no Claude Code banner). A single, staggered re-run types `claude` cleanly and succeeds — that
// is exactly the fix this script automates. The old situation was: such failures sat dead until
// the next day's scheduled run.
//
// SAFE-RETRY DISCRIMINATOR (the load-bearing safety rule): retry ONLY a run that
//   (1) is in a terminal FAILED state, AND
//   (2) NEVER launched Claude Code — no banner marker in its output snapshot, AND
//   (3) has a tiny snapshot (< SNAPSHOT_LAUNCH_FLOOR) corroborating "never ran".
// All three ⇒ the agent did zero work ⇒ re-running cannot double any side effect. A run that
// LAUNCHED and then failed/hung (large snapshot, banner present) is NEVER retried — it may have
// emailed, committed, or closed issues, so a blind re-run would duplicate those. Those are left
// for the human (the monitor alerts on them on its next tick). This is why we don't retry on
// `status==dispatch_failed` alone: that label ALSO hides successful self-closing runs — an
// automation that ends by running `orca terminal close` SIGHUPs itself, exits non-zero, and is
// recorded `dispatch_failed` even though its work landed (confirmed 2026-06-27). Those self-close
// "failures" carry a full TUI transcript (big snapshot, banner) ⇒ they read as skip-launched and
// are correctly NOT retried.
//
// Snapshot caveat (safe by construction): an Orca terminal can be REUSED, so a snapshot may carry
// scrollback from a PRIOR run (banner / `cclaude` from an earlier attempt). That can only push a
// genuine never-launched failure in a dirty terminal toward skip-ambiguous/skip-launched — i.e.
// a MISSED retry (the next scheduled run recovers it), never a wrongful retry of a real success.
// The dangerous direction (retry a run that did work) is impossible: a run that emailed/committed
// left a full transcript, so it can never present the <SNAPSHOT_LAUNCH_FLOOR no-banner shape that
// the retry path requires. The safety bias is structural, not heuristic.
//
// CAPS (anti-hammer): each failed occurrence (keyed by run id) is retried at most once; each
// automation is retried at most DAILY_CAP times per calendar day; at most RETRY_BUDGET_PER_TICK
// retries fire per tick, sequentially with STAGGER_MS between them so the doctor never recreates
// the very concurrency storm it's healing. Exhausted/!launched-failed/stuck runs are logged and
// left for monitor-orca-sessions.ts to alert on — the doctor FIXES, the monitor SHOUTS.
//
// Run: bun run orca-automation-doctor.ts [--dry-run]   (launchd: com.brain.orca-automation-doctor, hourly)

import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { ORCA_BIN } from "./reap-orca-sessions.ts";
import { classifyRun } from "./monitor-orca-sessions.ts";

const HOME = homedir();
const DOCTOR_LOG = `${HOME}/.local/state/reap-orca-sessions/doctor.log`;
const STATE_FILE = `${HOME}/.local/state/reap-orca-sessions/doctor-state.json`;

const DRY_RUN = process.argv.includes("--dry-run");

// A non-terminal run older than this (min) is "stuck" — long automations (/improve, /refactor)
// legitimately run 30-60 min, so the grace is generous to avoid flagging mid-work.
const STUCK_GRACE_MIN = Number(process.env.DOCTOR_STUCK_GRACE_MINUTES ?? 180);
// A launched session writes a large transcript; a pure dispatch race leaves only the mangled
// shell line. Snapshots under this size corroborate "Claude never launched".
const SNAPSHOT_LAUNCH_FLOOR = Number(process.env.DOCTOR_SNAPSHOT_FLOOR ?? 8192);
// Max retries per automation per calendar day (a broadly-broken Orca shouldn't be hammered).
const DAILY_CAP = Number(process.env.DOCTOR_DAILY_CAP ?? 4);
// Max retries fired in a single tick, sequentially, so we never recreate a launch storm.
const RETRY_BUDGET_PER_TICK = Number(process.env.DOCTOR_RETRY_BUDGET_PER_TICK ?? 3);
// Gap between sequential retries within a tick (ms) — keeps launches staggered.
const STAGGER_MS = Number(process.env.DOCTOR_STAGGER_MS ?? 8000);

// Markers that prove Claude Code actually launched in a run's terminal snapshot. Any one ⇒
// the agent started (and may have done work) ⇒ NOT a pure dispatch race ⇒ never auto-retry.
const LAUNCH_MARKERS = [
  "ClaudeCode",
  "Claude Code",
  "Opus 4",
  "Sonnet 4",
  "Haiku 4",
  "/goal active",
  "esc to interrupt",
  "Context left until",
];

// ---------------------------------------------------------------------------
// Pure core (unit-tested in orca-automation-doctor.test.ts)
// ---------------------------------------------------------------------------

/** True iff the snapshot shows Claude Code actually launched (any banner/runtime marker). */
export function runLaunched(snapshot: string): boolean {
  return LAUNCH_MARKERS.some((m) => snapshot.includes(m));
}

export type DoctorAction =
  | "ok" // healthy / in-progress / skipped — nothing to do
  | "retry" // failed, never launched, under caps — safe to re-run
  | "skip-launched" // failed but Claude launched (possible side effects) — human's call
  | "skip-stuck" // non-terminal past grace — leave running / for monitor
  | "skip-occurrence-exhausted" // this exact run already retried once
  | "skip-daily-cap" // automation hit its per-day retry ceiling
  | "skip-ambiguous"; // failed, no banner, but snapshot too large to be sure it didn't run

/**
 * Decide what to do about an automation's latest run. Pure: all IO resolved by the caller.
 * The safety bias is "when unsure, DON'T retry" — a missed retry costs a delayed run; a wrong
 * retry can double an irreversible side effect (email sent, issue closed, commit pushed).
 */
export function decideAction(input: {
  status: string;
  scheduledForMs: number;
  nowMs: number;
  graceMs: number;
  launched: boolean;
  snapshotBytes: number;
  retriesForOccurrence: number; // times THIS run id has already been retried
  retriesToday: number; // times this automation was retried today
  snapshotFloor: number;
  dailyCap: number;
}): DoctorAction {
  // Any `skipped*` status (skipped / skipped_missed / skipped_unavailable) is an INTENTIONAL
  // non-run — a precheck suppressed it, or a missed occurrence was deliberately not replayed.
  // Never a failure, never stuck; the doctor ignores it. (classifyRun only knows bare "skipped",
  // so it would otherwise mis-bucket the suffixed variants as "stuck" once they age past grace.)
  if (input.status.startsWith("skipped")) return "ok";
  const kind = classifyRun(input.status, input.scheduledForMs, input.nowMs, input.graceMs);
  if (kind === "healthy" || kind === "in-progress") return "ok";
  if (kind === "stuck") return "skip-stuck";
  // kind === "failed"
  if (input.launched) return "skip-launched";
  if (input.snapshotBytes >= input.snapshotFloor) return "skip-ambiguous";
  if (input.retriesForOccurrence >= 1) return "skip-occurrence-exhausted";
  if (input.retriesToday >= input.dailyCap) return "skip-daily-cap";
  return "retry";
}

/** Local calendar day key (YYYY-MM-DD) for daily-cap bucketing. */
export function dayKey(nowMs: number): string {
  return new Date(nowMs).toLocaleDateString("en-CA"); // en-CA → ISO-like YYYY-MM-DD, local tz
}

export interface DoctorState {
  occurrences: Record<string, number>; // runId -> retry count
  daily: Record<string, Record<string, number>>; // dayKey -> automationId -> count
  lastTickMs?: number;
}

/** Drop occurrence/day buckets older than the retention window so state never grows unbounded. */
export function pruneState(state: DoctorState, nowMs: number, keepDays = 3): DoctorState {
  const cutoff = new Set<string>();
  for (let i = 0; i < keepDays; i++) cutoff.add(dayKey(nowMs - i * 24 * 60 * 60 * 1000));
  const daily: DoctorState["daily"] = {};
  for (const [k, v] of Object.entries(state.daily ?? {})) if (cutoff.has(k)) daily[k] = v;
  return { occurrences: state.occurrences ?? {}, daily };
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

function sh(cmd: string): string {
  try {
    // 32 MB buffer: automation run lists carry large prompts + snapshots (ENOBUFS otherwise).
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return "";
  }
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    mkdirSync(dirname(DOCTOR_LOG), { recursive: true });
    appendFileSync(DOCTOR_LOG, line + "\n");
  } catch {
    /* best-effort */
  }
  console.log(msg);
}

function orcaJson(cmd: string): any {
  const out = sh(cmd);
  if (!out.trim()) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function loadState(): DoctorState {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return { occurrences: s.occurrences ?? {}, daily: s.daily ?? {}, lastTickMs: s.lastTickMs };
  } catch {
    return { occurrences: {}, daily: {} };
  }
}

function saveState(state: DoctorState): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...state, lastTickMs: Date.now() }, null, 2));
  } catch {
    /* best-effort */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Automation {
  id: string;
  name: string;
  enabled: boolean;
}
interface Run {
  id: string;
  status: string;
  scheduledFor: number;
  startedAt?: number;
  outputSnapshot?: { content?: string };
}

async function main(): Promise<void> {
  const now = Date.now();
  const graceMs = STUCK_GRACE_MIN * 60 * 1000;
  let state = pruneState(loadState(), now);
  const today = dayKey(now);
  state.daily[today] ??= {};

  const listed = orcaJson(`${ORCA_BIN} automations list --json`) as {
    result?: { automations?: Automation[] };
  } | null;
  const automations = listed?.result?.automations;
  if (!automations) {
    log("orca unreachable — skipped tick (no automations list)");
    return;
  }

  const retryQueue: { auto: Automation; run: Run }[] = [];
  const summary: string[] = [];

  for (const a of automations) {
    if (!a.enabled) continue;
    const runsResp = orcaJson(`${ORCA_BIN} automations runs --id ${a.id} --json`) as {
      result?: { runs?: Run[] };
    } | null;
    const runs = (runsResp?.result?.runs ?? [])
      .filter((r) => typeof r.scheduledFor === "number")
      .sort((x, y) => y.scheduledFor - x.scheduledFor);
    const latest = runs[0];
    if (!latest) continue;

    const snapshot = latest.outputSnapshot?.content ?? "";
    const action = decideAction({
      status: latest.status,
      // "Stuck" means RUNNING too long — measure from when it actually started, not from its
      // scheduled time. A catch-up dispatched hours late (e.g. after a mass re-enable) is fresh,
      // not stuck. Falls back to scheduledFor when a run never recorded a start.
      scheduledForMs: latest.startedAt ?? latest.scheduledFor,
      nowMs: now,
      graceMs,
      launched: runLaunched(snapshot),
      snapshotBytes: Buffer.byteLength(snapshot),
      retriesForOccurrence: state.occurrences[latest.id] ?? 0,
      retriesToday: state.daily[today][a.id] ?? 0,
      snapshotFloor: SNAPSHOT_LAUNCH_FLOOR,
      dailyCap: DAILY_CAP,
    });

    if (action === "ok") continue;
    summary.push(`${a.name}=${action}(${latest.status})`);
    if (action === "retry") retryQueue.push({ auto: a, run: latest });
  }

  if (retryQueue.length === 0) {
    log(`healthy — nothing to retry. ${summary.length ? "noted: " + summary.join(", ") : "all latest runs ok"}`);
    saveState(state);
    return;
  }

  // Fire retries sequentially, staggered, within this tick's budget. Anything over budget
  // is left for the next hourly tick (its occurrence retry-count is still 0, so it's eligible).
  let fired = 0;
  for (const { auto, run } of retryQueue) {
    if (fired >= RETRY_BUDGET_PER_TICK) {
      log(`retry budget (${RETRY_BUDGET_PER_TICK}) spent — ${auto.name} deferred to next tick`);
      continue;
    }
    if (DRY_RUN) {
      log(`DRY-RUN would retry ${auto.name} (failed run ${run.id}, status=${run.status})`);
      fired++;
      continue;
    }
    if (fired > 0) await sleep(STAGGER_MS); // stagger to avoid recreating the launch storm
    const res = orcaJson(`${ORCA_BIN} automations run ${auto.id} --json`);
    const ok = res?.ok === true;
    state.occurrences[run.id] = (state.occurrences[run.id] ?? 0) + 1;
    state.daily[today][auto.id] = (state.daily[today][auto.id] ?? 0) + 1;
    fired++;
    log(`${ok ? "RETRIED" : "RETRY-FAILED"} ${auto.name} (was run ${run.id}, status=${run.status}) — occurrence#${state.occurrences[run.id]} today#${state.daily[today][auto.id]}`);
  }

  saveState(state);
  log(`tick done — fired ${fired} retr${fired === 1 ? "y" : "ies"}; noted: ${summary.join(", ")}`);
}

if (import.meta.main) await main();
