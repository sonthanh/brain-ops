#!/usr/bin/env -S bun run
// monitor-orca-sessions.ts — watchdog over Orca automation HEALTH + the reaper's liveness.
//
// Pairs with reap-orca-sessions.ts. Reports to the user (Telegram, macOS-notification
// fallback) ONLY when something is wrong — silent when healthy. Three alert conditions:
//   1. FAILING RUNS: an enabled automation's latest run in the last 24 h did NOT complete —
//      a definite failure (dispatch_failed / failed / errored / timed_out / cancelled /
//      aborted) or a non-terminal run stuck past MONITOR_STUCK_GRACE_MINUTES (default 180).
//      This is the real "an automation isn't doing its job" signal, read from Orca's own
//      run status (`orca automations runs`), per automation.
//   2. ACCUMULATING: >= MONITOR_LIVE_THRESHOLD live `claude /goal` sessions older than the
//      reaper threshold right now (default 6) — the reaper is falling behind or a spike.
//   3. REAPER DOWN: the reaper hasn't logged a tick in MONITOR_REAPER_STALE_MINUTES (default
//      90) — the de-facto teardown stopped, so idle REPLs would pile up and slow the machine.
//
// WHY run-status, not reap-count (the 2026-06-14 fix): Orca launches automations as
// INTERACTIVE `claude <prompt>` TUIs (tui-agent-config: launchCmd 'claude', argv prompt). An
// interactive claude never self-exits after its final turn — Orca marks the run `completed`
// and snapshots the output, but leaves the idle ~250 MB REPL alive. The reaper kills those
// idle REPLs; that reaping is NORMAL teardown, not a stall. The old "reaps >= 3 / 24 h" alert
// therefore false-fired on healthy completed runs while being BLIND to the genuine failures
// (dispatch_failed, stuck dispatched) that leave no live process to reap. Keying off run
// status fixes both: completed-then-reaped is benign (no alert); a non-completed run is the
// thing worth waking the user for. If Orca is unreachable, run-status checking is skipped
// (logged) and the process-based reaper-liveness + accumulation checks still run.
//
// Alerts are throttled to at most once per 24 h (state file) so a persistent condition doesn't
// spam. Run: bun run monitor-orca-sessions.ts [--dry-run] [--test]
// Scheduled every 6 h via launchd com.brain.monitor-orca-sessions.

import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { parseEtimeToMinutes } from "./reap-orca-sessions.ts";

const HOME = homedir();
const REAPER_LOG = process.env.REAP_LOG ?? `${HOME}/.local/state/reap-orca-sessions/cron.log`;
const ENV_FILE = process.env.BRAIN_ENV_FILE ?? `${HOME}/.config/brain/env`;
const MONITOR_LOG = `${HOME}/.local/state/reap-orca-sessions/monitor.log`;
const STATE_FILE = `${HOME}/.local/state/reap-orca-sessions/monitor-state.json`;

const LIVE_THRESHOLD = Number(process.env.MONITOR_LIVE_THRESHOLD ?? 6);
const REAPER_STALE_MIN = Number(process.env.MONITOR_REAPER_STALE_MINUTES ?? 90);
const STUCK_AGE_MIN = Number(process.env.REAP_AGE_MINUTES ?? 90);
// A non-terminal run (dispatched/running/…) older than this is treated as stuck. Generous so
// genuinely long automations (/improve, /refactor can run 30-60 min) aren't flagged mid-work.
const STUCK_GRACE_MIN = Number(process.env.MONITOR_STUCK_GRACE_MINUTES ?? 180);
const THROTTLE_MS = 24 * 60 * 60 * 1000;
const DRY_RUN = process.argv.includes("--dry-run");
const TEST = process.argv.includes("--test");

/** Parse the leading `[ISO]` timestamp of a log line into epoch ms, or null. */
export function parseLogTimestamp(line: string): number | null {
  const m = line.match(/^\[([^\]]+)\]/);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : t;
}

/** Count `reaped pid=` events in the log within the last `windowMs`. */
export function countReapsInWindow(logText: string, nowMs: number, windowMs: number): number {
  let n = 0;
  for (const line of logText.split("\n")) {
    if (!line.includes("reaped pid=")) continue;
    const ts = parseLogTimestamp(line);
    if (ts !== null && nowMs - ts <= windowMs) n++;
  }
  return n;
}

// Orca automation-run statuses. `completed`/`succeeded` = the agent finished its turn;
// `skipped` = a precheck intentionally suppressed the run (not a failure). Everything in
// FAILED is a terminal failure. Anything else (dispatched/dispatching/running/pending/queued)
// is non-terminal — only "stuck" once it has outlived the grace window without completing.
const HEALTHY_STATUSES = new Set(["completed", "succeeded", "skipped"]);
const FAILED_STATUSES = new Set([
  "dispatch_failed",
  "failed",
  "errored",
  "error",
  "timed_out",
  "timeout",
  "cancelled",
  "canceled",
  "aborted",
]);

/** Classify a single automation run from its status + scheduled time. Pure for testing. */
export function classifyRun(
  status: string,
  scheduledForMs: number,
  nowMs: number,
  graceMs: number,
): "healthy" | "failed" | "stuck" | "in-progress" {
  if (HEALTHY_STATUSES.has(status)) return "healthy";
  if (FAILED_STATUSES.has(status)) return "failed";
  return nowMs - scheduledForMs > graceMs ? "stuck" : "in-progress";
}

/** Build the list of alert reasons (empty array = healthy). Pure for testing. */
export function decideAlerts(input: {
  unhealthyRuns: { name: string; status: string; kind: string }[];
  liveStuck: number;
  reaperAgeMin: number | null;
  liveThreshold: number;
  reaperStaleMin: number;
}): string[] {
  const out: string[] = [];
  if (input.reaperAgeMin === null || input.reaperAgeMin > input.reaperStaleMin) {
    out.push(
      `🔴 Reaper DOWN — no tick for ${input.reaperAgeMin === null ? "ever (no log)" : input.reaperAgeMin.toFixed(0) + " min"} (expected every 30 min). Idle REPLs will pile up and slow the machine.`,
    );
  }
  if (input.unhealthyRuns.length > 0) {
    const list = input.unhealthyRuns.map((r) => `${r.name} (${r.status})`).join(", ");
    out.push(
      `⚠️ Automation failure — ${input.unhealthyRuns.length} automation(s) had a run that did NOT complete in the last 24 h: ${list}. These aren't the benign idle-then-reaped sessions — their work didn't finish.`,
    );
  }
  if (input.liveStuck >= input.liveThreshold) {
    out.push(
      `⚠️ Accumulating — ${input.liveStuck} idle \`claude /goal\` session(s) live right now. The reaper may be falling behind.`,
    );
  }
  return out;
}

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    mkdirSync(dirname(MONITOR_LOG), { recursive: true });
    appendFileSync(MONITOR_LOG, line + "\n");
  } catch {
    /* best-effort */
  }
  console.log(msg);
}

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/^\s*export\s+/, "").trim();
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || line.startsWith("#")) continue;
    env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

/** Count live `claude /goal` sessions; return total and those older than STUCK_AGE_MIN. */
function liveGoalSessions(): { total: number; stuck: number } {
  let total = 0;
  let stuck = 0;
  for (const line of sh(`ps -Awwo etime=,command=`).split("\n")) {
    const m = line.match(/^\s*(\S+)\s+(.*)$/);
    if (!m) continue;
    const command = m[2];
    if (command.includes("--plugin-dir")) continue;
    if (!/(^|\/)claude\s+\/goal/.test(command)) continue;
    total++;
    if (parseEtimeToMinutes(m[1]) > STUCK_AGE_MIN) stuck++;
  }
  return { total, stuck };
}

function reaperAgeMinutes(): number | null {
  if (!existsSync(REAPER_LOG)) return null;
  const lines = readFileSync(REAPER_LOG, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const ts = parseLogTimestamp(lines[i]);
    if (ts !== null) return (Date.now() - ts) / 60000;
  }
  return null;
}

/** Run an `orca … --json` command and parse it; null on any failure (incl. Orca down). */
function orcaJson(cmd: string): unknown {
  const out = sh(cmd);
  if (!out.trim()) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

type Unhealthy = { name: string; status: string; kind: string };

/**
 * Ask Orca which enabled automations have an unhealthy LATEST run in the window.
 * "Latest run in window" is the verdict, so a failure that later retried to `completed`
 * reads as healthy (recovered). An automation that simply didn't run in the window is out
 * of scope here (that's the missed-SLA / artifact-watchdog concern, not session health).
 * Returns null if Orca is unreachable — the caller then SKIPS the run-status check rather
 * than falsely reporting "all healthy".
 */
function unhealthyAutomationRuns(nowMs: number, windowMs: number, graceMs: number): Unhealthy[] | null {
  const listed = orcaJson(`orca automations list --json`) as {
    result?: { automations?: { id: string; name: string; enabled: boolean }[] };
  } | null;
  const automations = listed?.result?.automations;
  if (!automations) return null; // Orca unreachable or unexpected shape

  const unhealthy: Unhealthy[] = [];
  for (const a of automations) {
    if (!a.enabled) continue;
    const runsResp = orcaJson(`orca automations runs --id ${a.id} --json`) as {
      result?: { runs?: { status: string; scheduledFor: number }[] };
    } | null;
    const inWindow = (runsResp?.result?.runs ?? [])
      .filter((r) => typeof r.scheduledFor === "number" && nowMs - r.scheduledFor <= windowMs)
      .sort((x, y) => y.scheduledFor - x.scheduledFor);
    const latest = inWindow[0];
    if (!latest) continue; // didn't run in the window
    const kind = classifyRun(latest.status, latest.scheduledFor, nowMs, graceMs);
    if (kind === "failed" || kind === "stuck") {
      unhealthy.push({ name: a.name, status: latest.status, kind });
    }
  }
  return unhealthy;
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: /^\d+$/.test(chatId) ? Number(chatId) : chatId,
        text,
        parse_mode: "Markdown",
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function notifyMac(title: string, message: string): void {
  const esc = (s: string) => s.replace(/["\\]/g, "\\$&").replace(/\n/g, " ");
  sh(`osascript -e 'display notification "${esc(message)}" with title "${esc(title)}"'`);
}

function recentlyAlerted(): boolean {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return typeof s.lastAlertMs === "number" && Date.now() - s.lastAlertMs < THROTTLE_MS;
  } catch {
    return false;
  }
}

function markAlerted(): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ lastAlertMs: Date.now() }));
  } catch {
    /* best-effort */
  }
}

async function deliver(text: string): Promise<void> {
  const env = loadEnv(ENV_FILE);
  const token = env.TG_BOT_TOKEN ?? process.env.TG_BOT_TOKEN ?? "";
  const chatId = env.TG_CHAT_ID ?? process.env.TG_CHAT_ID ?? "";
  let sent = false;
  if (token && chatId) sent = await sendTelegram(token, chatId, text);
  if (!sent) {
    notifyMac("Orca session monitor", text.replace(/[*`]/g, ""));
    log(`telegram failed/unconfigured — used macOS notification fallback`);
  }
}

async function main(): Promise<void> {
  if (TEST) {
    await deliver(
      "✅ *Orca automation monitor active*\nWatching automation run health (`orca automations runs`), the live-session backlog, and the reaper's liveness. You'll only hear from me when a run fails to complete, sessions pile up, or the reaper stops running.",
    );
    log("sent --test alert");
    return;
  }

  const now = Date.now();
  const reaps24h = existsSync(REAPER_LOG)
    ? countReapsInWindow(readFileSync(REAPER_LOG, "utf8"), now, THROTTLE_MS)
    : 0;
  const live = liveGoalSessions();
  const reaperAge = reaperAgeMinutes();
  const unhealthy = unhealthyAutomationRuns(now, THROTTLE_MS, STUCK_GRACE_MIN * 60 * 1000);
  if (unhealthy === null) {
    log("orca unreachable — skipped run-status check (reaper-liveness + accumulation still ran)");
  }

  const reasons = decideAlerts({
    unhealthyRuns: unhealthy ?? [],
    liveStuck: live.stuck,
    reaperAgeMin: reaperAge,
    liveThreshold: LIVE_THRESHOLD,
    reaperStaleMin: REAPER_STALE_MIN,
  });

  const summary = `unhealthy=${unhealthy === null ? "orca-down" : unhealthy.length} reaps24h=${reaps24h} liveGoal=${live.total} liveStuck=${live.stuck} reaperAge=${reaperAge === null ? "none" : reaperAge.toFixed(0) + "m"}`;

  if (reasons.length === 0) {
    log(`healthy — ${summary}`);
    return;
  }
  if (recentlyAlerted() && !DRY_RUN) {
    log(`issue present but throttled (alerted <24h ago) — ${summary}`);
    return;
  }

  const text = `🩺 *Orca automation health — issue detected*\n\n${reasons.join("\n\n")}\n\n_${summary}_\nCheck: \`orca automations runs --id <id>\` for the failing job; \`bun run ~/work/brain-ops/scripts/reap-orca-sessions.ts\` to clear idle sessions now.`;
  if (DRY_RUN) {
    log(`DRY-RUN would alert — ${summary}`);
    console.log("\n--- alert body ---\n" + text);
    return;
  }
  await deliver(text);
  markAlerted();
  log(`ALERTED — ${summary}`);
}

if (import.meta.main) await main();
