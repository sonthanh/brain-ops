import { describe, expect, test } from "bun:test";
import {
  BUDGET_REFUSE_MINUTES,
  BUDGET_WARN_MINUTES,
  budgetVerdict,
  decide,
  DRIFT_ALLOWANCE_MIN,
  estimateMinutes,
  mostRecentSlotMs,
  SLOT_MINUTE,
  SLOTS_UTC,
} from "./gmail-triage-watchdog";

// Slots: 05:23, 07:23, 09:23, 11:23, 13:23, 15:23, 18:23, 23:23 UTC.
const at = (iso: string) => new Date(iso).getTime();

describe("mostRecentSlotMs", () => {
  test("mid-morning: previous slot is 09:23 today", () => {
    expect(mostRecentSlotMs(at("2026-07-10T10:00:00Z"))).toBe(at("2026-07-10T09:23:00Z"));
  });

  test("early morning before first slot: falls back to yesterday's 23:23", () => {
    expect(mostRecentSlotMs(at("2026-07-10T04:00:00Z"))).toBe(at("2026-07-09T23:23:00Z"));
  });

  test("exactly at a slot returns that slot", () => {
    expect(mostRecentSlotMs(at("2026-07-10T13:23:00Z"))).toBe(at("2026-07-10T13:23:00Z"));
  });

  test("during the evening gap (18:23 → 23:23), previous slot is 18:23", () => {
    expect(mostRecentSlotMs(at("2026-07-10T22:00:00Z"))).toBe(at("2026-07-10T18:23:00Z"));
  });
});

describe("decide (slot-aware)", () => {
  test("dispatches when there are no runs at all", () => {
    const d = decide([], at("2026-07-10T10:00:00Z"));
    expect(d.dispatch).toBe(true);
  });

  test("slot covered by a run at/after the slot time → quiet", () => {
    const runs = [{ created_at: "2026-07-10T09:40:00Z", status: "completed" }];
    const d = decide(runs, at("2026-07-10T11:00:00Z")); // slot 09:23 covered
    expect(d.dispatch).toBe(false);
    expect(d.reason).toContain("covered");
  });

  test("uncovered slot within the drift allowance → quiet (cron may still fire)", () => {
    const runs = [{ created_at: "2026-07-10T07:30:00Z", status: "completed" }];
    // slot 09:23, now 10:00 → 37 min overdue < 90
    const d = decide(runs, at("2026-07-10T10:00:00Z"));
    expect(d.dispatch).toBe(false);
    expect(d.reason).toContain("drift allowance");
  });

  test("uncovered slot past the drift allowance → dispatch", () => {
    const runs = [{ created_at: "2026-07-10T07:30:00Z", status: "completed" }];
    // slot 09:23, now 11:00 → 97 min overdue > 90
    const d = decide(runs, at("2026-07-10T11:00:00Z"));
    expect(d.dispatch).toBe(true);
    expect(d.reason).toContain("overdue");
  });

  test("night gap: run after 23:23 keeps the watchdog quiet until 05:23+drift", () => {
    const runs = [{ created_at: "2026-07-09T23:55:00Z", status: "completed" }];
    // 04:30 — most recent slot is yesterday 23:23, covered by the 23:55 run.
    expect(decide(runs, at("2026-07-10T04:30:00Z")).dispatch).toBe(false);
    // 06:00 — slot 05:23 uncovered but only 37 min overdue.
    expect(decide(runs, at("2026-07-10T06:00:00Z")).dispatch).toBe(false);
    // 07:00 — slot 05:23 now 97 min overdue → dispatch.
    expect(decide(runs, at("2026-07-10T07:00:00Z")).dispatch).toBe(true);
  });

  test("never dispatches while a run is queued or in progress", () => {
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
      const runs = [
        { created_at: "2026-07-10T05:00:00Z", status },
        { created_at: "2026-07-09T13:30:00Z", status: "completed" },
      ];
      const d = decide(runs, at("2026-07-10T12:00:00Z"));
      expect(d.dispatch).toBe(false);
      expect(d.reason).toContain(status);
    }
  });

  test("failed/cancelled runs still cover their slot (autofix owns failures, watchdog owns absence)", () => {
    const runs = [{ created_at: "2026-07-10T09:30:00Z", status: "completed" }];
    expect(decide(runs, at("2026-07-10T10:30:00Z")).dispatch).toBe(false);
  });
});

describe("estimateMinutes", () => {
  test("sums run durations rounded up, minimum 1 min per started run", () => {
    const runs = [
      { run_started_at: "2026-07-10T10:00:00Z", updated_at: "2026-07-10T10:03:30Z", conclusion: "success" }, // 4
      { run_started_at: "2026-07-10T12:00:00Z", updated_at: "2026-07-10T12:00:10Z", conclusion: "failure" }, // 1
    ];
    expect(estimateMinutes(runs)).toBe(5);
  });

  test("skipped runs bill nothing", () => {
    const runs = [{ run_started_at: "2026-07-10T10:00:00Z", updated_at: "2026-07-10T10:05:00Z", conclusion: "skipped" }];
    expect(estimateMinutes(runs)).toBe(0);
  });

  test("missing or bogus timestamps are ignored", () => {
    expect(
      estimateMinutes([
        { run_started_at: null, updated_at: "2026-07-10T10:05:00Z", conclusion: "success" },
        { run_started_at: "2026-07-10T10:05:00Z", updated_at: "2026-07-10T10:00:00Z", conclusion: "success" },
      ]),
    ).toBe(0);
  });
});

describe("budgetVerdict", () => {
  test("thresholds: ok below warn, warn at 1500, refuse at 1900", () => {
    expect(budgetVerdict(BUDGET_WARN_MINUTES - 1).level).toBe("ok");
    expect(budgetVerdict(BUDGET_WARN_MINUTES).level).toBe("warn");
    expect(budgetVerdict(BUDGET_REFUSE_MINUTES - 1).level).toBe("warn");
    expect(budgetVerdict(BUDGET_REFUSE_MINUTES).level).toBe("refuse");
  });
});

describe("config sync", () => {
  test("slot list matches gmail-triage.yml cron '23 5,7,9,11,13,15,18,23 * * *'", () => {
    expect(SLOTS_UTC).toEqual([5, 7, 9, 11, 13, 15, 18, 23]);
    expect(SLOT_MINUTE).toBe(23);
    expect(DRIFT_ALLOWANCE_MIN).toBe(90);
  });
});
