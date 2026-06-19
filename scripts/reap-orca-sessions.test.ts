import { describe, expect, test } from "bun:test";
import {
  isReapable,
  parseEtimeToMinutes,
  selectReapable,
} from "./reap-orca-sessions.ts";

describe("parseEtimeToMinutes", () => {
  test("MM:SS", () => {
    expect(parseEtimeToMinutes("12:42")).toBeCloseTo(12.7, 1);
    expect(parseEtimeToMinutes("00:05")).toBeCloseTo(0.083, 2);
  });
  test("HH:MM:SS", () => {
    expect(parseEtimeToMinutes("01:30:00")).toBe(90);
    expect(parseEtimeToMinutes("02:00:30")).toBeCloseTo(120.5, 1);
  });
  test("DD-HH:MM:SS", () => {
    expect(parseEtimeToMinutes("06-07:04:25")).toBeCloseTo(
      6 * 1440 + 7 * 60 + 4 + 25 / 60,
      1,
    );
    expect(parseEtimeToMinutes("01-00:00:00")).toBe(1440);
  });
  test("garbage returns 0", () => {
    expect(parseEtimeToMinutes("not-a-time")).toBe(0);
  });
});

describe("isReapable", () => {
  const THRESHOLD = 120;

  test("old automation /goal session is reapable", () => {
    expect(isReapable("claude /goal Run the nightly triage", 200, THRESHOLD)).toBe(true);
    expect(isReapable("/usr/local/bin/claude /goal do x", 200, THRESHOLD)).toBe(true);
  });

  test("fresh automation session is kept (still working)", () => {
    expect(isReapable("claude /goal Run the nightly triage", 5, THRESHOLD)).toBe(false);
  });

  test("NEVER reaps a real interactive user session", () => {
    expect(
      isReapable(
        "claude --plugin-dir /Users/x/work/brain-os-plugin --plugin-dir /y",
        9999,
        THRESHOLD,
      ),
    ).toBe(false);
  });

  test("NEVER reaps non-claude or non-goal processes", () => {
    expect(isReapable("node server.js", 9999, THRESHOLD)).toBe(false);
    expect(isReapable("claude --resume", 9999, THRESHOLD)).toBe(false);
    expect(isReapable("bash claude-goal-wrapper.sh", 9999, THRESHOLD)).toBe(false);
  });

  test("threshold boundary", () => {
    expect(isReapable("claude /goal x", 120, 120)).toBe(false); // not strictly greater
    expect(isReapable("claude /goal x", 121, 120)).toBe(true);
  });
});

describe("selectReapable", () => {
  const THRESHOLD = 180;
  // Real `ps -Awwo pid=,etime=,command=` lines: leading-space-padded pid, etime, command.
  const PS = [
    // The pid-1443 regression: a completed /vault-lint REPL idle for 3.75 days. The old CPU
    // gate logged "skip … still active (+0.17s CPU)" every tick and never reaped it.
    "  1443 03-16:51:38 claude /goal Run the /vault-lint skill to completion for the brain vault",
    "  2000    45:00 claude /goal Run the nightly triage", // 45 min — under threshold, keep
    "  3000 05:00:00 claude --plugin-dir /Users/x/work/brain-os-plugin --dangerously-skip-permissions", // user session
    "  4000 09:00:00 claude --resume", // user resume, never reap
    "  5000 02:00:00 /opt/homebrew/bin/bun run scripts/reap-orca-sessions.ts", // unrelated
  ].join("\n");

  test("reaps the multi-day idle /goal REPL regardless of CPU (pid-1443 regression)", () => {
    const got = selectReapable(PS, THRESHOLD);
    expect(got.map((c) => c.pid)).toEqual([1443]);
    expect(got[0].etimeMinutes).toBeCloseTo(3 * 1440 + 16 * 60 + 51 + 38 / 60, 0);
  });

  test("keeps a /goal session younger than the threshold", () => {
    expect(selectReapable(PS, THRESHOLD).some((c) => c.pid === 2000)).toBe(false);
  });

  test("never selects interactive, --resume, or non-claude processes", () => {
    const pids = selectReapable(PS, THRESHOLD).map((c) => c.pid);
    expect(pids).not.toContain(3000);
    expect(pids).not.toContain(4000);
    expect(pids).not.toContain(5000);
  });

  test("empty / garbage ps output yields nothing", () => {
    expect(selectReapable("", THRESHOLD)).toEqual([]);
    expect(selectReapable("\n\n  not a ps line\n", THRESHOLD)).toEqual([]);
  });
});
