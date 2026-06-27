import { describe, expect, test } from "bun:test";
import { dedupMarker, quotaDecision } from "./run-automation.ts";
import { AUTOMATIONS } from "./automations.config.ts";

describe("dedupMarker", () => {
  const iso = "2026-06-27T13:45:09.123Z";
  test("day → YYYY-MM-DD", () => expect(dedupMarker("day", iso)).toBe("2026-06-27"));
  test("hour → YYYY-MM-DDTHH", () => expect(dedupMarker("hour", iso)).toBe("2026-06-27T13"));
  test("none → empty (disabled)", () => expect(dedupMarker("none", iso)).toBe(""));
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
});
