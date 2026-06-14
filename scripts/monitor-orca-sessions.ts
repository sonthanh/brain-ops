#!/usr/bin/env -S bun run
// monitor-orca-sessions.ts — watchdog over the Orca-automation-session leak + its reaper.
//
// Pairs with reap-orca-sessions.ts. The reaper cleans stuck `claude /goal` sessions every
// 30 min; this monitor reports to the user (Telegram, macOS-notification fallback) ONLY when
// something is wrong — it is silent when healthy. Three alert conditions:
//   1. RECURRING: the reaper had to reap >= MONITOR_REAP_THRESHOLD sessions in the last 24 h
//      (default 3) — automations keep getting stuck, worth investigating the root automations.
//   2. ACCUMULATING: >= MONITOR_LIVE_THRESHOLD stuck `claude /goal` sessions are live right now
//      (default 6) — the reaper is falling behind or the problem spiked.
//   3. REAPER DOWN: the reaper hasn't logged a tick in MONITOR_REAPER_STALE_MINUTES (default
//      90) — the fix itself stopped running, so leaks would silently return.
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

const REAP_THRESHOLD = Number(process.env.MONITOR_REAP_THRESHOLD ?? 3);
const LIVE_THRESHOLD = Number(process.env.MONITOR_LIVE_THRESHOLD ?? 6);
const REAPER_STALE_MIN = Number(process.env.MONITOR_REAPER_STALE_MINUTES ?? 90);
const STUCK_AGE_MIN = Number(process.env.REAP_AGE_MINUTES ?? 90);
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

/** Build the list of alert reasons (empty array = healthy). Pure for testing. */
export function decideAlerts(input: {
  reaps24h: number;
  liveStuck: number;
  reaperAgeMin: number | null;
  reapThreshold: number;
  liveThreshold: number;
  reaperStaleMin: number;
}): string[] {
  const out: string[] = [];
  if (input.reaperAgeMin === null || input.reaperAgeMin > input.reaperStaleMin) {
    out.push(
      `🔴 Reaper DOWN — no tick for ${input.reaperAgeMin === null ? "ever (no log)" : input.reaperAgeMin.toFixed(0) + " min"} (expected every 30 min). Stuck sessions will return silently.`,
    );
  }
  if (input.reaps24h >= input.reapThreshold) {
    out.push(
      `⚠️ Recurring — ${input.reaps24h} automation run(s) got stuck and were auto-cleaned in the last 24 h. The reaper is handling it, but the automations keep stalling.`,
    );
  }
  if (input.liveStuck >= input.liveThreshold) {
    out.push(
      `⚠️ Accumulating — ${input.liveStuck} stuck \`claude /goal\` session(s) live right now. The reaper may be falling behind.`,
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
      "✅ *Orca session monitor active*\nWatching for stuck `claude /goal` automation sessions. You'll only hear from me if the leak recurs, accumulates, or the reaper stops running.",
    );
    log("sent --test alert");
    return;
  }

  const reaps24h = existsSync(REAPER_LOG)
    ? countReapsInWindow(readFileSync(REAPER_LOG, "utf8"), Date.now(), THROTTLE_MS)
    : 0;
  const live = liveGoalSessions();
  const reaperAge = reaperAgeMinutes();
  const reasons = decideAlerts({
    reaps24h,
    liveStuck: live.stuck,
    reaperAgeMin: reaperAge,
    reapThreshold: REAP_THRESHOLD,
    liveThreshold: LIVE_THRESHOLD,
    reaperStaleMin: REAPER_STALE_MIN,
  });

  const summary = `reaps24h=${reaps24h} liveGoal=${live.total} liveStuck=${live.stuck} reaperAge=${reaperAge === null ? "none" : reaperAge.toFixed(0) + "m"}`;

  if (reasons.length === 0) {
    log(`healthy — ${summary}`);
    return;
  }
  if (recentlyAlerted() && !DRY_RUN) {
    log(`issue present but throttled (alerted <24h ago) — ${summary}`);
    return;
  }

  const text = `🩺 *Orca automation leak — issue detected*\n\n${reasons.join("\n\n")}\n\n_${summary}_\nFix: \`bun run ~/work/brain-ops/scripts/reap-orca-sessions.ts\` to clean now; check \`orca automations list\` for repeatedly-stuck jobs.`;
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
