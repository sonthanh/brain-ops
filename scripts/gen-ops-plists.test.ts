// gen-ops-plists.test.ts — verify the support-job plist renderer emits well-formed, correct
// launchd plists for each of the 5 jobs.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPS_JOBS, PATH_ENV, renderPlist, type OpsJob } from "./gen-ops-plists.ts";

const byId = (id: string): OpsJob => {
  const j = OPS_JOBS.find((x) => x.id === id);
  if (!j) throw new Error(`no job ${id}`);
  return j;
};

describe("OPS_JOBS registry", () => {
  test("holds exactly the 5 known support jobs", () => {
    expect(OPS_JOBS.map((j) => j.id).sort()).toEqual(
      ["ci-watchdog", "codeburn-optimize", "gmail-triage-watchdog", "reap-orca-sessions", "triage"],
    );
  });

  test("every job is either interval- or calendar-scheduled, never both", () => {
    for (const j of OPS_JOBS) {
      const hasInterval = j.intervalSec != null;
      const hasCalendar = j.calendar != null;
      expect(hasInterval).not.toBe(hasCalendar);
    }
  });
});

describe("renderPlist", () => {
  test("label is com.brain.<id>", () => {
    expect(renderPlist(byId("triage"))).toContain("<string>com.brain.triage</string>");
  });

  test("interval jobs emit StartInterval, calendar jobs emit StartCalendarInterval", () => {
    expect(renderPlist(byId("ci-watchdog"))).toContain("<key>StartInterval</key>\n    <integer>1800</integer>");
    const codeburn = renderPlist(byId("codeburn-optimize"));
    expect(codeburn).toContain("<key>StartCalendarInterval</key>");
    expect(codeburn).toContain("<key>Weekday</key><integer>5</integer>");
    expect(codeburn).toContain("<key>Hour</key><integer>20</integer>");
  });

  test("triage calendar has no Weekday (daily)", () => {
    const triage = renderPlist(byId("triage"));
    expect(triage).toContain("<key>Hour</key><integer>2</integer>");
    expect(triage).toContain("<key>Minute</key><integer>30</integer>");
    expect(triage).not.toContain("<key>Weekday</key>");
  });

  test("WorkingDirectory present only when the job sets one", () => {
    expect(renderPlist(byId("ci-watchdog"))).toContain("<key>WorkingDirectory</key>");
    // reaper has no workingDir
    expect(renderPlist(byId("reap-orca-sessions"))).not.toContain("<key>WorkingDirectory</key>");
  });

  test("RunAtLoad only on the reaper", () => {
    expect(renderPlist(byId("reap-orca-sessions"))).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(renderPlist(byId("triage"))).not.toContain("<key>RunAtLoad</key>");
  });

  test("log paths follow ~/.local/state/<id>/launchd-{stdout,stderr}.log", () => {
    const xml = renderPlist(byId("gmail-triage-watchdog"));
    expect(xml).toContain("/.local/state/gmail-triage-watchdog/launchd-stdout.log");
    expect(xml).toContain("/.local/state/gmail-triage-watchdog/launchd-stderr.log");
  });

  test("PATH is toolchain-detected, never the stale hardcoded nvm version", () => {
    expect(PATH_ENV).not.toContain("v22.16.0");
    expect(PATH_ENV).toContain("/opt/homebrew/bin");
    expect(renderPlist(byId("triage"))).toContain(`<string>${PATH_ENV}</string>`);
  });

  test("bash crons invoke /bin/bash, watchdogs invoke bun run", () => {
    expect(renderPlist(byId("triage"))).toContain("<string>/bin/bash</string>");
    expect(renderPlist(byId("ci-watchdog"))).toMatch(/<string>[^<]*bun<\/string>\n\s*<string>run<\/string>/);
  });

  test("main creates ~/Library/LaunchAgents on a fresh HOME then writes (regression)", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "fresh-home-"));
    const res = Bun.spawnSync(["bun", "run", join(import.meta.dir, "gen-ops-plists.ts")], {
      env: { ...process.env, HOME: fakeHome },
    });
    expect(res.exitCode, res.stderr.toString()).toBe(0);
    expect(existsSync(join(fakeHome, "Library/LaunchAgents/com.brain.triage.plist"))).toBe(true);
  });

  test("every rendered plist passes plutil -lint (well-formed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-plist-"));
    for (const j of OPS_JOBS) {
      const p = join(dir, `com.brain.${j.id}.plist`);
      writeFileSync(p, renderPlist(j));
      const res = Bun.spawnSync(["plutil", "-lint", p]);
      expect(res.exitCode, `${j.id} plist invalid: ${res.stderr.toString()}`).toBe(0);
    }
  });
});
