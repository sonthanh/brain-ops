#!/usr/bin/env -S bun run
// run-automation.ts — runs ONE brain automation headlessly via `claude -p`, under launchd.
//
// WHY this exists (2026-06-27): brain automations previously ran as INTERACTIVE Orca `claude`
// TUIs. That had three failure modes — a concurrent-launch keystroke race (`cclaude` →
// dispatch_failed), a self-close `orca terminal close` that SIGHUPed the session so SUCCESSFUL
// runs were mislabeled `dispatch_failed`, and an idle-REPL leak (interactive claude never
// self-exits → ~250 MB/run left alive until reaped). `claude -p` (print/headless) removes all
// three by construction: no interactive shell to mistype into, a real process exit code, and it
// exits the moment its work is done. Verified: `claude -p "/goal …"` honors the /goal completion
// gate headlessly and exits 0. This reverses the 2026-06-06 Orca migration for the agent jobs;
// the two purely-deterministic jobs (codeburn, issue-triage) go back to plain bash launchd with
// no claude at all.
//
// One generic runner + a declarative registry (automations.config.ts) replaces the divergent
// per-skill cron scripts. It keeps EXACTLY the gates the old crons had — same-day dedup and a
// weekly-quota skip — and nothing more.
//
// Usage: bun run run-automation.ts <automation-id>      (launchd: com.brain.automation.<id>)
// Exit code is claude's own exit code (0 success), so launchd records the true outcome.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { AUTOMATIONS, type AutomationSpec } from "./automations.config.ts";

const HOME = homedir();
const STATE_ROOT = `${HOME}/.local/state/brain-automations`;
const ENV_FILE = process.env.BRAIN_ENV_FILE ?? `${HOME}/.config/brain/env`;
const USAGE_FILE = process.env.CC_USAGE_FILE ?? `${HOME}/.cache/ccstatusline/usage.json`;
const QUOTA_THRESHOLD = Number(process.env.BRAIN_AUTOMATION_QUOTA_THRESHOLD ?? 90);
// Hard wall-clock cap when a spec doesn't set its own. Covers the observed runtimes (vault-lint
// ~10m, refactor ~20m) with margin; the reaper can't catch headless `claude -p`, so this is the
// only thing that stops a hung run from idling and stacking across fires.
const DEFAULT_TIMEOUT_MS = Number(process.env.BRAIN_AUTOMATION_TIMEOUT_MS ?? 45 * 60 * 1000);
const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Pure core (unit-tested in run-automation.test.ts)
// ---------------------------------------------------------------------------

/** Dedup marker for "now" at the configured granularity. Empty string ⇒ dedup disabled. */
export function dedupMarker(kind: AutomationSpec["dedup"], iso: string): string {
  if (kind === "none") return "";
  if (kind === "hour") return iso.slice(0, 13); // YYYY-MM-DDTHH
  return iso.slice(0, 10); // YYYY-MM-DD
}

/**
 * Decide whether the weekly-quota gate allows the run. Mirrors the old cron's jq logic:
 * skip only when usage is AT/OVER threshold AND the weekly window hasn't reset yet. Missing or
 * unparseable usage ⇒ "run" (fail open, never block work on a telemetry gap).
 */
export function quotaDecision(
  usage: { weeklyUsage?: number; weeklyResetAt?: string } | null,
  threshold: number,
  nowMs: number,
): { run: boolean; usage: number | null; reason: string } {
  if (!usage || typeof usage.weeklyUsage !== "number") {
    return { run: true, usage: null, reason: "no usage data — proceeding" };
  }
  const u = usage.weeklyUsage;
  const resetMs = usage.weeklyResetAt ? Date.parse(usage.weeklyResetAt) : NaN;
  const beforeReset = !Number.isNaN(resetMs) && nowMs < resetMs;
  if (u >= threshold && beforeReset) {
    return { run: false, usage: u, reason: `weekly usage ${u}% ≥ ${threshold}% (resets ${usage.weeklyResetAt})` };
  }
  return { run: true, usage: u, reason: `weekly usage ${u}%` };
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/^\s*export\s+/, "").trim();
    if (line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

async function sendTelegram(label: string, msg: string): Promise<void> {
  const env = loadEnv(ENV_FILE);
  const token = env.TG_BOT_TOKEN ?? process.env.TG_BOT_TOKEN ?? "";
  const chatId = env.TG_CHAT_ID ?? process.env.TG_CHAT_ID ?? "";
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: /^\d+$/.test(chatId) ? Number(chatId) : chatId,
        text: `*${label} failed*\n${msg}`,
        parse_mode: "Markdown",
      }),
    });
  } catch {
    /* best-effort */
  }
}

function main(): number {
  const id = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (!id || !AUTOMATIONS[id]) {
    console.error(`unknown automation id '${id ?? ""}'. Known: ${Object.keys(AUTOMATIONS).join(", ")}`);
    return 2;
  }
  const spec = AUTOMATIONS[id];
  const stateDir = `${STATE_ROOT}/${id}`;
  const logFile = `${stateDir}/cron.log`;
  const lastRunFile = `${stateDir}/.last-run`;
  mkdirSync(stateDir, { recursive: true });

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    try {
      appendFileSync(logFile, line + "\n");
    } catch {
      /* best-effort */
    }
    console.log(`${id}: ${msg}`);
  };

  log(`=== ${spec.label} tick (model=${spec.model} dry_run=${DRY_RUN}) ===`);

  // Pre-flight
  if (!Bun.which("claude")) {
    log("ERROR: claude not in PATH — aborting");
    return 1;
  }
  if (!existsSync(spec.workdir)) {
    log(`ERROR: workdir ${spec.workdir} not found — aborting`);
    return 1;
  }

  // Precheck (optional): non-zero ⇒ intentional skip (e.g. geo-dev "nothing changed").
  if (spec.precheck) {
    const pc = Bun.spawnSync(["bash", "-lc", spec.precheck], { cwd: spec.workdir, stdout: "pipe", stderr: "pipe" });
    if (pc.exitCode !== 0) {
      log(`SKIP — precheck exited ${pc.exitCode} (intentional skip)`);
      return 0;
    }
    log("precheck passed");
  }

  // Same-day (or same-hour) dedup — defensive against a double-fire / manual re-run.
  const marker = dedupMarker(spec.dedup, new Date().toISOString());
  if (marker) {
    const last = existsSync(lastRunFile) ? readFileSync(lastRunFile, "utf8").trim() : "";
    if (last === marker) {
      log(`already ran this period (${marker}) — skipping`);
      return 0;
    }
  }

  // Weekly-quota gate.
  if (spec.quotaGate) {
    let usage: { weeklyUsage?: number; weeklyResetAt?: string } | null = null;
    try {
      usage = JSON.parse(readFileSync(USAGE_FILE, "utf8"));
    } catch {
      usage = null;
    }
    const q = quotaDecision(usage, QUOTA_THRESHOLD, Date.now());
    if (!q.run) {
      log(`SKIP — ${q.reason}`);
      return 0; // skip path does NOT write the marker, so a later retry can still run
    }
    log(`quota ok — ${q.reason}`);
  }

  const pluginArgs = (spec.pluginDirs ?? []).flatMap((d) => ["--plugin-dir", d]);
  const argv = ["claude", "--dangerously-skip-permissions", ...pluginArgs, "--model", spec.model, "-p", spec.prompt];
  if (DRY_RUN) {
    log(`dry-run: would exec: claude ${pluginArgs.join(" ")} --model ${spec.model} -p '<prompt ${spec.prompt.length}c>' (cwd ${spec.workdir})`);
    return 0;
  }

  // Skills that invoke the Workflow tool detach it as a background task; `claude -p` kills
  // background tasks at a 600s default ceiling (CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS) and exits
  // "successfully" but incomplete. =0 makes -p wait for the workflow; the harness then re-invokes
  // the agent to finish (verified). Bounded by `timeout` below so it can't wait forever.
  const env: Record<string, string> = { ...process.env };
  if (spec.waitForBackgroundTasks) env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = "0";
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  log(`invoking claude -p (cwd ${spec.workdir}, timeout ${(timeoutMs / 60000).toFixed(0)}m${spec.waitForBackgroundTasks ? ", waits for bg workflows" : ""})`);
  const started = Date.now();
  // stdin from /dev/null so claude doesn't wait 3s for piped input; stream output to the log.
  const proc = Bun.spawnSync(argv, {
    cwd: spec.workdir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const out = proc.stdout.toString() + proc.stderr.toString();
  try {
    appendFileSync(logFile, out + (out.endsWith("\n") ? "" : "\n"));
  } catch {
    /* best-effort */
  }
  const mins = ((Date.now() - started) / 60000).toFixed(1);

  // A timeout kill surfaces as a signal (no clean exit code) — treat as a failure, not success.
  const timedOut = proc.signalCode === "SIGKILL" || (proc.exitCode === null && proc.signalCode != null);
  if (proc.exitCode === 0 && !timedOut) {
    if (marker) writeFileSync(lastRunFile, marker);
    log(`=== ${spec.label} done OK in ${mins}m ===`);
    return 0;
  }
  const why = timedOut ? `TIMED OUT after ${mins}m (cap ${(timeoutMs / 60000).toFixed(0)}m)` : `exit=${proc.exitCode}`;
  log(`=== ${spec.label} FAILED ${why} ===`);
  if (spec.alertOnFail && !DRY_RUN) void sendTelegram(spec.label, `\`claude -p\` ${why}. Check \`${logFile}\`.`);
  return proc.exitCode || 1;
}

if (import.meta.main) process.exit(main());
