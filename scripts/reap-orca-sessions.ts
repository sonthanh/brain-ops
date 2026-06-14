#!/usr/bin/env -S bun run
// reap-orca-sessions.ts — janitor for stuck Orca automation sessions.
//
// Root cause it fixes: Orca scheduled automations launch *interactive* `claude /goal …`
// sessions. A run that completes normally exits, but a run that gets STUCK (waiting on
// input, an error, a rate-limit, a HITL prompt) idles forever as a live `claude` process
// holding ~250 MB. Over a multi-day uptime these pile up and exhaust swap (observed: ~40
// sessions / ~10 GB on 2026-06-14, which slowed the whole machine).
//
// This reaps any `claude /goal …` process that is BOTH (a) older than REAP_AGE_MINUTES
// (default 90) AND (b) idle right now (no measurable CPU over a 2 s sample). The idle gate
// means a slow-but-still-working run is never killed — only genuinely stuck sessions are.
// It asks Orca to close the tab (kills the PTY), then hard-kills as a fallback.
//
// It is deliberately narrow: it ONLY matches automation sessions (`claude /goal`), NEVER
// real interactive user sessions (`claude --plugin-dir …`) or anything else.
//
// Run: bun run reap-orca-sessions.ts [--dry-run]
// Scheduled every 30 min via launchd com.brain.reap-orca-sessions.

import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const AGE_MINUTES = Number(process.env.REAP_AGE_MINUTES ?? 90);
const IDLE_SAMPLE_SECONDS = Number(process.env.REAP_IDLE_SAMPLE_SECONDS ?? 2);
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
 * (Idle-detection is applied separately, in main, before actually reaping.)
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

/** Cumulative CPU seconds consumed by a pid (from `ps -o time=`). */
function cpuSecondsForPid(pid: number): number {
  return parseEtimeToMinutes(sh(`ps -o time= -p ${pid}`)) * 60;
}

/** Read ORCA_TERMINAL_HANDLE from a process's environment, if present. */
function terminalHandleForPid(pid: number): string | null {
  const m = sh(`ps eww -p ${pid} -o command=`).match(/ORCA_TERMINAL_HANDLE=(\S+)/);
  return m ? m[1] : null;
}

export function main(): void {
  const out = sh(`ps -Awwo pid=,etime=,command=`);
  type Cand = { pid: number; etimeMinutes: number; command: string; cpu0: number };
  const candidates: Cand[] = [];
  let scanned = 0;

  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const command = m[3];
    if (!/(^|\/)claude\s+\/goal/.test(command)) continue;
    scanned++;
    const pid = Number(m[1]);
    const etimeMinutes = parseEtimeToMinutes(m[2]);
    if (!isReapable(command, etimeMinutes, AGE_MINUTES)) continue;
    candidates.push({ pid, etimeMinutes, command, cpu0: cpuSecondsForPid(pid) });
  }

  let reaped = 0;
  if (candidates.length > 0) {
    sh(`sleep ${IDLE_SAMPLE_SECONDS}`); // measure CPU movement over the interval
    for (const c of candidates) {
      const movedCpu = cpuSecondsForPid(c.pid) - c.cpu0;
      const snippet = c.command.replace(/\s+/g, " ").slice(0, 90);
      if (movedCpu >= 0.05) {
        log(
          `skip pid=${c.pid} age=${c.etimeMinutes.toFixed(0)}m — still active (+${movedCpu.toFixed(2)}s CPU) :: ${snippet}`,
        );
        continue;
      }
      const handle = terminalHandleForPid(c.pid);
      if (DRY_RUN) {
        log(
          `DRY-RUN would reap pid=${c.pid} age=${c.etimeMinutes.toFixed(0)}m idle handle=${handle ?? "none"} :: ${snippet}`,
        );
        reaped++;
        continue;
      }
      if (handle) sh(`orca terminal close --terminal ${handle}`);
      sh(`kill -KILL ${c.pid} 2>/dev/null`); // fallback: ensure the process is gone
      log(
        `reaped pid=${c.pid} age=${c.etimeMinutes.toFixed(0)}m idle handle=${handle ?? "none"} :: ${snippet}`,
      );
      reaped++;
    }
  }

  log(
    `reap tick: scanned ${scanned} /goal session(s), reaped ${reaped} (age>${AGE_MINUTES}m & idle)${DRY_RUN ? " [dry-run]" : ""}`,
  );
}

if (import.meta.main) main();
