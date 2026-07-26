import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { classifyPrecheckExit, dedupMarker, isoWeekMarker, quotaDecision } from "./run-automation.ts";
import { AUTOMATIONS } from "./automations.config.ts";

describe("classifyPrecheckExit", () => {
  test("0 → run", () => expect(classifyPrecheckExit(0)).toBe("run"));
  test("semantic non-zero (10 = geo-dev no-op) → skip", () => expect(classifyPrecheckExit(10)).toBe("skip"));
  test("1 (precheck-improve skip) → skip", () => expect(classifyPrecheckExit(1)).toBe("skip"));
  test("127 command-not-found → error (must NOT masquerade as skip)", () =>
    expect(classifyPrecheckExit(127)).toBe("error"));
  test("126 not-executable → error", () => expect(classifyPrecheckExit(126)).toBe("error"));
});

describe("dedupMarker", () => {
  const iso = "2026-06-27T13:45:09.123Z";
  test("day → YYYY-MM-DD", () => expect(dedupMarker("day", iso)).toBe("2026-06-27"));
  test("hour → YYYY-MM-DDTHH", () => expect(dedupMarker("hour", iso)).toBe("2026-06-27T13"));
  test("week → YYYY-Www", () => expect(dedupMarker("week", iso)).toBe("2026-W26"));
  test("none → empty (disabled)", () => expect(dedupMarker("none", iso)).toBe(""));
});

describe("isoWeekMarker (geo-digest Sat+Sun catch-up idempotency)", () => {
  // The whole point: Saturday's primary fire and Sunday's catch-up must produce the SAME marker so
  // a successful Saturday run makes Sunday dedup-skip. W30 2026 = Mon 07-20 … Sun 07-26.
  test("Saturday and the next Sunday collapse to one marker", () => {
    expect(isoWeekMarker("2026-07-25T06:00:00Z")).toBe("2026-W30"); // Sat
    expect(isoWeekMarker("2026-07-26T07:00:00Z")).toBe("2026-W30"); // Sun (same ISO week)
  });
  test("the following Monday rolls to the next week", () => {
    expect(isoWeekMarker("2026-07-27T06:00:00Z")).toBe("2026-W31"); // Mon
  });
  test("Jan 1 2026 (a Thursday) is week 1 of week-year 2026", () => {
    expect(isoWeekMarker("2026-01-01T12:00:00Z")).toBe("2026-W01");
  });
  test("week-year rollover: 2027-01-01 (Friday) belongs to 2026-W53", () => {
    expect(isoWeekMarker("2027-01-01T12:00:00Z")).toBe("2026-W53");
  });
});

describe("quotaDecision", () => {
  const now = Date.parse("2026-06-27T13:00:00Z");
  const future = "2026-06-30T19:59:59Z"; // reset still ahead
  const past = "2026-06-26T00:00:00Z"; // already reset

  test("under threshold → run", () => {
    const d = quotaDecision({ weeklyUsage: 25, weeklyResetAt: future }, 90, now);
    expect(d.run).toBe(true);
  });
  test("at/over threshold before reset → skip", () => {
    const d = quotaDecision({ weeklyUsage: 92, weeklyResetAt: future }, 90, now);
    expect(d.run).toBe(false);
    expect(d.reason).toContain("≥ 90%");
  });
  test("over threshold but window already reset → run", () => {
    const d = quotaDecision({ weeklyUsage: 95, weeklyResetAt: past }, 90, now);
    expect(d.run).toBe(true);
  });
  test("missing usage → run (fail open)", () => {
    expect(quotaDecision(null, 90, now).run).toBe(true);
    expect(quotaDecision({}, 90, now).run).toBe(true);
  });
  test("usage present but no resetAt → run (can't prove still-capped)", () => {
    expect(quotaDecision({ weeklyUsage: 99 }, 90, now).run).toBe(true);
  });
});

describe("automations.config integrity", () => {
  test("every spec has an absolute workdir, a prompt, and a non-empty schedule", () => {
    for (const [id, s] of Object.entries(AUTOMATIONS)) {
      expect(s.id).toBe(id);
      expect(s.workdir.startsWith("/")).toBe(true);
      expect(s.prompt.length).toBeGreaterThan(10);
      expect(s.schedule.length).toBeGreaterThan(0);
      for (const c of s.schedule) {
        expect(c.Hour).toBeGreaterThanOrEqual(0);
        expect(c.Hour).toBeLessThanOrEqual(23);
        expect(c.Minute).toBeGreaterThanOrEqual(0);
        expect(c.Minute).toBeLessThanOrEqual(59);
      }
    }
  });
  test("no ported prompt still carries the Orca self-close teardown", () => {
    for (const s of Object.values(AUTOMATIONS)) {
      expect(s.prompt).not.toContain("orca terminal close");
      expect(s.prompt).not.toContain("ORCA_TERMINAL_HANDLE");
    }
  });
  test("every automation invoking a /geo- skill loads the geo plugin explicitly (cwd-independent)", () => {
    // geo skills are NOT in global enabledPlugins → they only resolve via cwd or --plugin-dir.
    for (const s of Object.values(AUTOMATIONS)) {
      if (/\/geo-/.test(s.prompt)) {
        expect((s.pluginDirs ?? []).some((d) => d.includes("brain-geo-analysis-plugin"))).toBe(true);
      }
    }
  });
  test("every precheck's interpreter binary exists on disk (guards the BUN_BIN 127 regression)", () => {
    // The precheck runs under launchd's PATH, which omits ~/.bun/bin. If the resolved bun path does
    // not exist, the command exits 127 and (pre-fix) was silently swallowed as an intentional skip —
    // which hid geo-dev for a week. The first token of every precheck must be an existing executable.
    for (const s of Object.values(AUTOMATIONS)) {
      if (!s.precheck) continue;
      const bin = s.precheck.split(/\s+/)[0];
      expect(bin.startsWith("/")).toBe(true);
      expect(existsSync(bin)).toBe(true);
    }
  });
  test("geo-dev waits for its background Workflow (else -p kills it at 600s)", () => {
    const geoDev = AUTOMATIONS["geo-dev"];
    expect(geoDev.waitForBackgroundTasks).toBe(true);
    // and gives the long workflow more than the default cap
    expect(geoDev.timeoutMs).toBeGreaterThan(45 * 60 * 1000);
  });
});
