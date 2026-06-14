import { describe, expect, test } from "bun:test";
import {
  classifyRun,
  countReapsInWindow,
  decideAlerts,
  parseLogTimestamp,
} from "./monitor-orca-sessions.ts";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

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

describe("classifyRun", () => {
  const now = Date.parse("2026-06-14T12:00:00Z");
  const grace = 3 * HOUR;

  test("completed/succeeded/skipped are healthy regardless of age", () => {
    expect(classifyRun("completed", now - 10 * HOUR, now, grace)).toBe("healthy");
    expect(classifyRun("succeeded", now - 10 * HOUR, now, grace)).toBe("healthy");
    expect(classifyRun("skipped", now - 10 * HOUR, now, grace)).toBe("healthy");
  });
  test("dispatch_failed/failed/errored/timeouts/cancels are failures", () => {
    for (const s of [
      "dispatch_failed",
      "failed",
      "errored",
      "timed_out",
      "cancelled",
      "aborted",
    ]) {
      expect(classifyRun(s, now - HOUR, now, grace)).toBe("failed");
    }
  });
  test("non-terminal within grace is in-progress, past grace is stuck", () => {
    expect(classifyRun("dispatched", now - HOUR, now, grace)).toBe("in-progress");
    expect(classifyRun("running", now - HOUR, now, grace)).toBe("in-progress");
    expect(classifyRun("dispatched", now - 5 * HOUR, now, grace)).toBe("stuck");
    expect(classifyRun("dispatching", now - 5 * HOUR, now, grace)).toBe("stuck");
  });
});

describe("decideAlerts", () => {
  const base = {
    unhealthyRuns: [] as { name: string; status: string; kind: string }[],
    liveStuck: 0,
    reaperAgeMin: 10,
    liveThreshold: 6,
    reaperStaleMin: 90,
  };

  test("healthy -> no alerts", () => {
    expect(decideAlerts(base)).toEqual([]);
  });
  test("benign teardowns alone never alert (the core false-positive fix)", () => {
    // No unhealthy runs even if many sessions were reaped — reaping a completed
    // session is normal teardown, not a stall.
    expect(decideAlerts({ ...base, unhealthyRuns: [] })).toEqual([]);
  });
  test("failed automation run -> alert naming the automation", () => {
    const r = decideAlerts({
      ...base,
      unhealthyRuns: [{ name: "Issue triage", status: "dispatch_failed", kind: "failed" }],
    });
    expect(r.length).toBe(1);
    expect(r[0]).toContain("Issue triage");
    expect(r[0]).toContain("dispatch_failed");
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
    expect(
      decideAlerts({
        ...base,
        reaperAgeMin: null,
        unhealthyRuns: [{ name: "Geo improve", status: "dispatch_failed", kind: "failed" }],
        liveStuck: 9,
      }).length,
    ).toBe(3);
  });
});
