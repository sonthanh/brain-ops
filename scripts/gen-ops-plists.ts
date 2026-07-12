#!/usr/bin/env -S bun run
// gen-ops-plists.ts — render launchd plists for the 5 brain SUPPORT jobs (watchdogs, the
// session reaper, and the two deterministic bash crons) that are NOT `claude -p` agent
// automations. The agent automations live in automations.config.ts + gen-automation-plists.ts;
// these five are a different shape (bash crons + bun watchdogs, interval- and calendar-based),
// so they get their own small renderer here.
//
// Portable by construction: the bun and node binaries are resolved with Bun.which at generation
// time, so the emitted PATH points at whatever toolchain THIS machine has. The former hand-
// written plists hardcoded `~/.nvm/versions/node/v22.16.0/bin`, which goes stale on every node
// upgrade (this machine is already on v22.23.1) and does not exist on another machine at all.
//
// Usage:
//   bun run gen-ops-plists.ts            # write all plists, print bootstrap commands
//   bun run gen-ops-plists.ts --print    # print plist XML to stdout, write nothing
//   bun run gen-ops-plists.ts <id> ...   # restrict to specific ids

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const HOME = homedir();
const OPS = `${HOME}/work/brain-ops`;
const BRAIN = `${HOME}/work/brain`;
const LA_DIR = `${HOME}/Library/LaunchAgents`;
const BUN = Bun.which("bun") ?? "/opt/homebrew/bin/bun";

// Resolve node's bin dir on THIS machine (nvm, brew, or system) so the bash crons that shell
// out to `node` find it regardless of how node was installed. Empty when node is absent — the
// generator warns in that case because codeburn-optimize + triage require it.
const NODE_PATH = Bun.which("node");
const NODE_DIR = NODE_PATH ? dirname(NODE_PATH) : "";
export const PATH_ENV = [NODE_DIR, `${HOME}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
  .filter(Boolean)
  .join(":");

export type Calendar = { Hour: number; Minute: number; Weekday?: number };

export interface OpsJob {
  /** Stable id — used for the state/log dir and the `com.brain.<id>` launchd label. */
  id: string;
  /** Absolute ProgramArguments (bun-run a .ts, or /bin/bash a cron script). */
  program: string[];
  /** Optional cwd the job runs from. */
  workingDir?: string;
  /** Poll interval in seconds (mutually exclusive with `calendar`). */
  intervalSec?: number;
  /** Wall-clock fire time (mutually exclusive with `intervalSec`). */
  calendar?: Calendar;
  /** Fire once immediately on load, then on schedule (the reaper wants this). */
  runAtLoad?: boolean;
}

export const OPS_JOBS: OpsJob[] = [
  {
    id: "reap-orca-sessions",
    program: [BUN, "run", `${OPS}/scripts/reap-orca-sessions.ts`],
    intervalSec: 1800,
    runAtLoad: true,
  },
  {
    id: "ci-watchdog",
    program: [BUN, "run", `${OPS}/scripts/ci-watchdog.ts`],
    workingDir: OPS,
    intervalSec: 1800,
  },
  {
    id: "gmail-triage-watchdog",
    program: [BUN, "run", `${OPS}/scripts/gmail-triage-watchdog.ts`],
    workingDir: OPS,
    intervalSec: 1800,
  },
  {
    id: "codeburn-optimize",
    program: ["/bin/bash", `${OPS}/scripts/codeburn-optimize-cron.sh`],
    workingDir: BRAIN,
    calendar: { Hour: 20, Minute: 0, Weekday: 5 }, // Friday 20:00
  },
  {
    id: "triage",
    program: ["/bin/bash", `${OPS}/scripts/triage-cron.sh`],
    workingDir: BRAIN,
    calendar: { Hour: 2, Minute: 30 }, // daily 02:30
  },
];

function calendarInner(c: Calendar): string {
  const parts = [`        <key>Hour</key><integer>${c.Hour}</integer>`, `        <key>Minute</key><integer>${c.Minute}</integer>`];
  if (typeof c.Weekday === "number") parts.push(`        <key>Weekday</key><integer>${c.Weekday}</integer>`);
  return parts.join("\n");
}

export function renderPlist(job: OpsJob): string {
  const label = `com.brain.${job.id}`;
  const stateDir = `${HOME}/.local/state/${job.id}`;
  const progArgs = job.program.map((a) => `        <string>${a}</string>`).join("\n");
  const schedule =
    job.intervalSec != null
      ? `    <key>StartInterval</key>\n    <integer>${job.intervalSec}</integer>`
      : `    <key>StartCalendarInterval</key>\n    <dict>\n${calendarInner(job.calendar!)}\n    </dict>`;
  const workingDir = job.workingDir ? `    <key>WorkingDirectory</key>\n    <string>${job.workingDir}</string>\n\n` : "";
  const runAtLoad = job.runAtLoad ? `    <key>RunAtLoad</key>\n    <true/>\n\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
${progArgs}
    </array>

${schedule}

${workingDir}${runAtLoad}    <key>StandardOutPath</key>
    <string>${stateDir}/launchd-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${stateDir}/launchd-stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PATH_ENV}</string>
    </dict>
</dict>
</plist>
`;
}

function main(): void {
  const args = process.argv.slice(2);
  const printOnly = args.includes("--print");
  const ids = args.filter((a) => !a.startsWith("-"));
  const jobs = OPS_JOBS.filter((j) => ids.length === 0 || ids.includes(j.id));

  if (!NODE_DIR) {
    console.warn("WARNING: `node` not found on PATH — codeburn-optimize + triage crons need it. Install node (brew install node) before loading those jobs.");
  }

  if (!printOnly) mkdirSync(LA_DIR, { recursive: true }); // fresh macOS accounts lack ~/Library/LaunchAgents

  const bootstrapCmds: string[] = ["UID_NUM=$(id -u)"];
  for (const job of jobs) {
    const xml = renderPlist(job);
    const label = `com.brain.${job.id}`;
    const path = `${LA_DIR}/${label}.plist`;
    if (printOnly) {
      console.log(`\n# ===== ${path} =====\n${xml}`);
      continue;
    }
    mkdirSync(`${HOME}/.local/state/${job.id}`, { recursive: true });
    writeFileSync(path, xml);
    console.log(`wrote ${path}`);
    bootstrapCmds.push(
      `launchctl bootout gui/$UID_NUM "${path}" 2>/dev/null; launchctl bootstrap gui/$UID_NUM "${path}" && launchctl enable gui/$UID_NUM/${label}`,
    );
  }
  if (!printOnly) {
    console.log("\n# --- bootstrap (run after review) ---");
    console.log(bootstrapCmds.join("\n"));
  }
}

if (import.meta.main) main();
