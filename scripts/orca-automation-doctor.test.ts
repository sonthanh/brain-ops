import { describe, expect, test } from "bun:test";
import { decideAction, dayKey, pruneState, runLaunched, type DoctorState } from "./orca-automation-doctor.ts";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.parse("2026-06-27T12:00:00Z");

// Defaults shared across decideAction cases — overridden per test.
const base = {
  scheduledForMs: now - 5 * MIN, // recent
  nowMs: now,
  graceMs: 180 * MIN,
  launched: false,
  snapshotBytes: 2000, // tiny → corroborates "never launched"
  retriesForOccurrence: 0,
  retriesToday: 0,
  snapshotFloor: 8192,
  dailyCap: 4,
};

describe("runLaunched", () => {
  test("real dispatch-race snapshot (mangled shell line, no banner) → not launched", () => {
    const snap =
      "%\n\n\nbrain main $✘? > cclaude '/goal Run the weekly /geo-digest for the current ISO week";
    expect(runLaunched(snap)).toBe(false);
  });
  test("snapshot with the Claude Code banner → launched", () => {
    expect(runLaunched("▝▜█████▛▘ Opus 4.8 (1M context) ... ClaudeCode v2.1.185")).toBe(true);
  });
  test("snapshot showing /goal active → launched", () => {
    expect(runLaunched("◎ /goal active (2h)\nzsh: warning: 1 jobs SIGHUPed")).toBe(true);
  });
  test("empty snapshot → not launched", () => {
    expect(runLaunched("")).toBe(false);
  });
});

describe("decideAction — the safety discriminator", () => {
  test("failed + never launched + tiny snapshot + under caps → RETRY", () => {
    expect(decideAction({ ...base, status: "dispatch_failed" })).toBe("retry");
  });

  test("failed but LAUNCHED → skip-launched (side effects may have fired)", () => {
    expect(decideAction({ ...base, status: "dispatch_failed", launched: true, snapshotBytes: 50000 })).toBe(
      "skip-launched",
    );
  });

  test("failed, no banner, but LARGE snapshot → skip-ambiguous (can't prove it didn't run)", () => {
    expect(decideAction({ ...base, status: "dispatch_failed", snapshotBytes: 20000 })).toBe("skip-ambiguous");
  });

  test("this occurrence already retried once → skip-occurrence-exhausted", () => {
    expect(decideAction({ ...base, status: "dispatch_failed", retriesForOccurrence: 1 })).toBe(
      "skip-occurrence-exhausted",
    );
  });

  test("automation hit its daily cap → skip-daily-cap", () => {
    expect(decideAction({ ...base, status: "dispatch_failed", retriesToday: 4 })).toBe("skip-daily-cap");
  });

  test("other terminal failure states are retryable too", () => {
    for (const status of ["failed", "errored", "timed_out", "cancelled", "aborted"]) {
      expect(decideAction({ ...base, status })).toBe("retry");
    }
  });
});

describe("decideAction — non-failure states", () => {
  test("completed → ok", () => {
    expect(decideAction({ ...base, status: "completed" })).toBe("ok");
  });
  test("skipped (precheck) → ok", () => {
    expect(decideAction({ ...base, status: "skipped" })).toBe("ok");
  });
  test("skipped_missed / skipped_unavailable → ok even when aged past grace (intentional non-run)", () => {
    for (const status of ["skipped_missed", "skipped_unavailable"]) {
      expect(decideAction({ ...base, status, scheduledForMs: now - 10 * HOUR })).toBe("ok");
    }
  });
  test("dispatched within grace → ok (in-progress, leave it running)", () => {
    expect(decideAction({ ...base, status: "dispatched", scheduledForMs: now - 5 * MIN })).toBe("ok");
  });
  test("dispatched PAST grace → skip-stuck (don't retry a possibly-working run)", () => {
    expect(decideAction({ ...base, status: "dispatched", scheduledForMs: now - 4 * HOUR })).toBe("skip-stuck");
  });
});

describe("decideAction — ordering guarantees", () => {
  test("a LAUNCHED failure is never retried even with budget + fresh occurrence", () => {
    // launched takes precedence over cap checks → no double side effects, ever.
    expect(
      decideAction({ ...base, status: "failed", launched: true, snapshotBytes: 99999, retriesToday: 0 }),
    ).toBe("skip-launched");
  });
});

describe("dayKey", () => {
  test("stable YYYY-MM-DD shape", () => {
    expect(dayKey(now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("pruneState", () => {
  test("drops day buckets older than the retention window, keeps recent", () => {
    const todayK = dayKey(now);
    const oldK = dayKey(now - 10 * DAY);
    const state: DoctorState = {
      occurrences: { r1: 1 },
      daily: { [todayK]: { a1: 2 }, [oldK]: { a1: 5 } },
    };
    const pruned = pruneState(state, now);
    expect(pruned.daily[todayK]).toEqual({ a1: 2 });
    expect(pruned.daily[oldK]).toBeUndefined();
    expect(pruned.occurrences).toEqual({ r1: 1 });
  });
});
