import { describe, expect, test } from "bun:test";
import { isReapable, parseEtimeToMinutes } from "./reap-orca-sessions.ts";

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
