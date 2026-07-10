import { describe, expect, test } from "bun:test";
import { decide, STALE_HOURS } from "./gmail-triage-watchdog";

const NOW = new Date("2026-07-10T08:00:00Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("decide", () => {
  test("dispatches when there are no runs at all", () => {
    const d = decide([], NOW);
    expect(d.dispatch).toBe(true);
    expect(d.reason).toContain("no runs");
  });

  test("dispatches when the newest run is older than the threshold", () => {
    const d = decide([{ created_at: hoursAgo(4), status: "completed" }], NOW);
    expect(d.dispatch).toBe(true);
    expect(d.reason).toContain("4.0h");
  });

  test("stays quiet when the newest run is fresh", () => {
    const runs = [
      { created_at: hoursAgo(1), status: "completed" },
      { created_at: hoursAgo(5), status: "completed" },
    ];
    expect(decide(runs, NOW).dispatch).toBe(false);
  });

  test("uses the NEWEST run even if the list is unordered", () => {
    const runs = [
      { created_at: hoursAgo(6), status: "completed" },
      { created_at: hoursAgo(0.5), status: "completed" },
    ];
    expect(decide(runs, NOW).dispatch).toBe(false);
  });

  test("never dispatches while a run is queued or in progress, however old the last completed run is", () => {
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
      const runs = [
        { created_at: hoursAgo(0.1), status },
        { created_at: hoursAgo(9), status: "completed" },
      ];
      const d = decide(runs, NOW);
      expect(d.dispatch).toBe(false);
      expect(d.reason).toContain(status);
    }
  });

  test("threshold boundary: exactly at STALE_HOURS does not dispatch, just past it does", () => {
    const at = decide([{ created_at: hoursAgo(STALE_HOURS), status: "completed" }], NOW);
    expect(at.dispatch).toBe(false);
    const past = decide([{ created_at: hoursAgo(STALE_HOURS + 0.1), status: "completed" }], NOW);
    expect(past.dispatch).toBe(true);
  });

  test("failed/cancelled completed runs still count as 'ran' (autofix owns failures, watchdog owns absence)", () => {
    const d = decide([{ created_at: hoursAgo(1), status: "completed" }], NOW, STALE_HOURS);
    expect(d.dispatch).toBe(false);
  });
});
