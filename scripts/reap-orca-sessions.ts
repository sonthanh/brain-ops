#!/usr/bin/env -S bun run
// reap-orca-sessions.ts — de-facto teardown for Orca automation sessions.
//
// Root cause it works around: Orca launches automations as INTERACTIVE `claude <prompt>`
// TUIs (tui-agent-config: launchCmd 'claude', argv prompt injection). An interactive claude
// does NOT self-exit after its final turn — it returns to the REPL and waits for stdin that
// never comes. Orca marks the run `completed` and snapshots the output, but leaves the idle
// ~250 MB process alive. So this is NOT "successful runs exit, only stuck ones linger" —
// EVERY completed run leaks an idle REPL (verified 2026-06-14: a completed run idled ~104 min
// until reaped; a trivial test run was `completed` in 7 s yet still alive at 93 s). Orca has
// no built-in teardown of completed terminals, so this reaper IS that teardown. Without it,
// idle REPLs pile up (observed ~40 sessions / ~10 GB on 2026-06-14, slowing the machine and
// — likely — starving new automation launches into `dispatch_failed`).
//
// This reaps any `claude /goal …` process older than REAP_AGE_MINUTES (default 180). It asks
// Orca to close the tab (kills the PTY), then hard-kills as a fallback. Reaping a completed
// session is normal teardown, not a failure — `monitor-orca-sessions.ts` keys its health
// alerts off Orca's run status, not off how many sessions this reaper cleaned up.
//
// WHY age-only, not a CPU idle gate (the 2026-06-19 fix): the old gate skipped any session
// burning ≥0.05 s CPU over a 2 s sample, assuming a finished run is ~0 % CPU. FALSE — an idle
// Claude Code TUI sits at ~10 % CPU forever (render loop, spinner, watchers), the SAME as a
// working agent between turns. So CPU cannot distinguish done-from-working; the gate returned
// "still active" on EVERY completed REPL and never reaped them. Real failure: a completed
// `/vault-lint` session idled 3.75 DAYS (pid 1443), logging "skip … still active (+0.17s CPU)"
// on every 30-min tick while holding `caffeinate` and blocking system sleep. No reliable proxy
// for "agent is done" exists at the process level (lastOutputAt redraws too, run-status doesn't
// map cleanly to a live PID), so we use the one unambiguous signal: age. Orca automations are
// batch jobs that finish in seconds–60 min (the longest, /geo-digest, < ~90 min), so a `/goal`
// REPL past 180 min is, overwhelmingly, a completed-and-idle leak. A rare false-kill of a
// genuinely long run is cheap and self-correcting: Orca marks it incomplete, the monitor
// alerts, and it re-runs next schedule — far cheaper than the chronic multi-day leak.
//
// It is deliberately narrow: it ONLY matches automation sessions (`claude /goal`), NEVER
// real interactive user sessions (`claude --plugin-dir …`) or anything else. Verified
// 2026-06-19: every enabled Orca automation prompt begins with `/goal`, so the matcher covers
// them all today. KNOWN GAP: a future non-`/goal` automation prompt would leak the same way
// but isn't matched — broadening the matcher risks killing the user's own interactive
// `claude`, so it's left narrow until such prompts actually exist.
//
// Run: bun run reap-orca-sessions.ts [--dry-run]
// Scheduled every 30 min via launchd com.brain.reap-orca-sessions.

import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

/**
 * Absolute path to the `orca` CLI. Resolved once so this works under launchd, whose default
 * PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) excludes `/usr/local/bin` where orca lives — a bare
 * `orca` would silently no-op there. Same trap as the `sp` absolute-path rule in CLAUDE.md.
 * Shared by monitor-orca-sessions.ts.
 */
export const ORCA_BIN = ((): string => {
  for (const p of [
    process.env.ORCA_BIN,
    "/usr/local/bin/orca",
    "/opt/homebrew/bin/orca",
    "/Applications/Orca.app/Contents/Resources/bin/orca",
  ]) {
    if (p && existsSync(p)) return p;
  }
  return "orca"; // last resort: rely on PATH
})();

const AGE_MINUTES = Number(process.env.REAP_AGE_MINUTES ?? 180);
const DRY_RUN = process.argv.includes("--dry-run");
const LOG_FILE =
  process.env.REAP_LOG ?? `${homedir()}/.local/state/reap-orca-sessions/cron.log`;

/** Convert `ps` etime/time ([[DD-]HH:]MM:SS[.ss]) to fractional minutes. */
export function parseEtimeToMinutes(etime: string): number {
  let rest = etime.trim();
  let days = 0;
  const dash = rest.indexOf("-");
  if (dash !== -1) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  let hh = 0,
    mm = 0,
    ss = 0;
  if (parts.length === 3) [hh, mm, ss] = parts;
  else if (parts.length === 2) [mm, ss] = parts;
  else return 0;
  return days * 1440 + hh * 60 + mm + ss / 60;
}

/**
 * True only for an Orca automation session (`claude /goal …`) older than the threshold.
 * Hard-excludes real user sessions (`claude --plugin-dir …`) as a defensive double-check.
 * Age is the sole liveness signal — see the header note on why a CPU idle gate was removed.
 */
export function isReapable(
  command: string,
  etimeMinutes: number,
  thresholdMinutes: number,
): boolean {
  if (command.includes("--plugin-dir")) return false;
  if (!/(^|\/)claude\s+\/goal(\s|$)/.test(command)) return false;
  return etimeMinutes > thresholdMinutes;
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
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* logging is best-effort */
  }
  console.log(msg);
}

/** A live Orca automation session selected for reaping. */
export interface ReapCandidate {
  pid: number;
  etimeMinutes: number;
  command: string;
}

/**
 * Parse `ps -Awwo pid=,etime=,command=` output and return the reapable `claude /goal`
 * sessions (older than the threshold, excluding interactive user sessions). Pure, so the
 * reaping decision — the exact thing the old CPU gate got wrong — is unit-testable.
 */
export function selectReapable(
  psOutput: string,
  thresholdMinutes: number,
): ReapCandidate[] {
  const out: ReapCandidate[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const command = m[3];
    const etimeMinutes = parseEtimeToMinutes(m[2]);
    if (!isReapable(command, etimeMinutes, thresholdMinutes)) continue;
    out.push({ pid: Number(m[1]), etimeMinutes, command });
  }
  return out;
}

/** Read ORCA_TERMINAL_HANDLE from a process's environment, if present. */
function terminalHandleForPid(pid: number): string | null {
  const m = sh(`ps eww -p ${pid} -o command=`).match(/ORCA_TERMINAL_HANDLE=(\S+)/);
  return m ? m[1] : null;
}

export function main(): void {
  const out = sh(`ps -Awwo pid=,etime=,command=`);
  const liveGoal = out
    .split("\n")
    .filter((l) => /(^|\/)claude\s+\/goal/.test(l)).length;
  const candidates = selectReapable(out, AGE_MINUTES);

  let reaped = 0;
  for (const c of candidates) {
    const snippet = c.command.replace(/\s+/g, " ").slice(0, 90);
    const handle = terminalHandleForPid(c.pid);
    if (DRY_RUN) {
      log(
        `DRY-RUN would reap pid=${c.pid} age=${c.etimeMinutes.toFixed(0)}m handle=${handle ?? "none"} :: ${snippet}`,
      );
      reaped++;
      continue;
    }
    if (handle) sh(`${ORCA_BIN} terminal close --terminal ${handle}`);
    sh(`kill -KILL ${c.pid} 2>/dev/null`); // fallback: ensure the process is gone
    log(
      `reaped pid=${c.pid} age=${c.etimeMinutes.toFixed(0)}m handle=${handle ?? "none"} :: ${snippet}`,
    );
    reaped++;
  }

  log(
    `reap tick: ${liveGoal} /goal session(s) live, ${candidates.length} reapable (age>${AGE_MINUTES}m), reaped ${reaped}${DRY_RUN ? " [dry-run]" : ""}`,
  );
}

if (import.meta.main) main();
