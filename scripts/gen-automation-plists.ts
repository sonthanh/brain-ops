#!/usr/bin/env -S bun run
// gen-automation-plists.ts — render one launchd plist per entry in automations.config.ts.
//
// The config's `schedule` is the single source of truth; this renders it into
// ~/Library/LaunchAgents/com.brain.automation.<id>.plist (StartCalendarInterval, no RunAtLoad —
// scheduled fire only). It WRITES the plist files and PRINTS the bootstrap commands; it does NOT
// load them (loading is a stateful action the operator runs after eyeballing the output).
//
// Usage:
//   bun run gen-automation-plists.ts            # write all plists, print bootstrap commands
//   bun run gen-automation-plists.ts --print    # print plist XML to stdout, write nothing
//   bun run gen-automation-plists.ts <id> ...    # restrict to specific automation ids

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { AUTOMATIONS, type AutomationSpec } from "./automations.config.ts";

const HOME = homedir();
const BUN = "/opt/homebrew/bin/bun";
const RUNNER = `${HOME}/work/brain-ops/scripts/run-automation.ts`;
const LA_DIR = `${HOME}/Library/LaunchAgents`;
const PATH_ENV = `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

export function calendarXml(schedule: AutomationSpec["schedule"]): string {
  const entry = (c: { Hour: number; Minute: number; Weekday?: number }) => {
    const parts = [`            <key>Hour</key><integer>${c.Hour}</integer>`, `            <key>Minute</key><integer>${c.Minute}</integer>`];
    if (typeof c.Weekday === "number") parts.push(`            <key>Weekday</key><integer>${c.Weekday}</integer>`);
    return `        <dict>\n${parts.join("\n")}\n        </dict>`;
  };
  return schedule.map(entry).join("\n");
}

export function renderPlist(spec: AutomationSpec): string {
  const label = `com.brain.automation.${spec.id}`;
  const stateDir = `${HOME}/.local/state/brain-automations/${spec.id}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${BUN}</string>
        <string>run</string>
        <string>${RUNNER}</string>
        <string>${spec.id}</string>
    </array>

    <key>StartCalendarInterval</key>
    <array>
${calendarXml(spec.schedule)}
    </array>

    <key>RunAtLoad</key>
    <false/>

    <key>StandardOutPath</key>
    <string>${stateDir}/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>${stateDir}/launchd.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${PATH_ENV}</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
</dict>
</plist>
`;
}

function main(): void {
  const args = process.argv.slice(2);
  const printOnly = args.includes("--print");
  const ids = args.filter((a) => !a.startsWith("-"));
  const specs = Object.values(AUTOMATIONS).filter((s) => ids.length === 0 || ids.includes(s.id));

  const bootstrapCmds: string[] = [`UID_NUM=$(id -u)`];
  for (const spec of specs) {
    const xml = renderPlist(spec);
    const label = `com.brain.automation.${spec.id}`;
    const path = `${LA_DIR}/${label}.plist`;
    if (printOnly) {
      console.log(`\n# ===== ${path} =====\n${xml}`);
      continue;
    }
    mkdirSync(`${HOME}/.local/state/brain-automations/${spec.id}`, { recursive: true });
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
