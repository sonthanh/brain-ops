import { describe, expect, test } from "bun:test";
import {
  countReapsInWindow,
  decideAlerts,
  parseLogTimestamp,
} from "./monitor-orca-sessions.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("parseLogTimestamp", () => {
  test("parses leading ISO bracket", () => {
    expect(parseLogTimestamp("[2026-06-14T08:22:20.546Z] reap tick")).toBe(
      Date.parse("2026-06-14T08:22:20.546Z"),
    );
  });
  test("null on non-timestamped line", () => {
    expect(parseLogTimestamp("brain main $ >")).toBeNull();
  });
});

describe("countReapsInWindow", () => {
  const now = Date.parse("2026-06-14T12:00:00Z");
  const logText = [
    `[2026-06-14T11:00:00Z] reaped pid=1 age=120m idle :: claude /goal a`,
    `[2026-06-14T10:00:00Z] reaped pid=2 age=130m idle :: claude /goal b`,
    `[2026-06-12T10:00:00Z] reaped pid=3 age=130m idle :: claude /goal c`, // >24h ago
    `[2026-06-14T11:30:00Z] reap tick: scanned 2 reaped 1`, // not a "reaped pid=" line
  ].join("\n");

  test("counts only reaps within window", () => {
    expect(countReapsInWindow(logText, now, DAY)).toBe(2);
  });
  test("empty log -> 0", () => {
    expect(countReapsInWindow("", now, DAY)).toBe(0);
  });
});

describe("decideAlerts", () => {
  const base = {
    reaps24h: 0,
    liveStuck: 0,
    reaperAgeMin: 10,
    reapThreshold: 3,
    liveThreshold: 6,
    reaperStaleMin: 90,
  };

  test("healthy -> no alerts", () => {
    expect(decideAlerts(base)).toEqual([]);
  });
  test("recurring stuck runs -> alert", () => {
    const r = decideAlerts({ ...base, reaps24h: 3 });
    expect(r.length).toBe(1);
    expect(r[0]).toContain("Recurring");
  });
  test("accumulation -> alert", () => {
    const r = decideAlerts({ ...base, liveStuck: 6 });
    expect(r[0]).toContain("Accumulating");
  });
  test("reaper down (stale log) -> alert", () => {
    expect(decideAlerts({ ...base, reaperAgeMin: 200 })[0]).toContain("Reaper DOWN");
  });
  test("reaper down (no log ever) -> alert", () => {
    expect(decideAlerts({ ...base, reaperAgeMin: null })[0]).toContain("Reaper DOWN");
  });
  test("multiple conditions stack", () => {
    expect(decideAlerts({ ...base, reaperAgeMin: null, reaps24h: 5, liveStuck: 9 }).length).toBe(3);
  });
});
