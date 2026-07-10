import { describe, expect, test } from "bun:test";
import {
  DAILY_ISSUE_CAP,
  ISSUE_LABELS,
  WATCHED,
  issueBody,
  issueTitle,
  pickActionableFailures,
  underDailyCap,
  type FiledEntry,
  type RunInfo,
} from "./ci-watchdog";

const run = (over: Partial<RunInfo>): RunInfo => ({
  id: 1,
  name: "CI",
  status: "completed",
  conclusion: "success",
  created_at: "2026-07-10T10:00:00Z",
  head_sha: "abcdef1234567890",
  html_url: "https://github.com/sonthanh/brain-os-plugin/actions/runs/1",
  display_title: "some commit",
  ...over,
});

describe("pickActionableFailures", () => {
  test("newest completed failure with nothing newer → actionable", () => {
    const runs = [
      run({ id: 2, conclusion: "failure", created_at: "2026-07-10T11:00:00Z" }),
      run({ id: 1, conclusion: "success", created_at: "2026-07-10T10:00:00Z" }),
    ];
    expect(pickActionableFailures(runs, new Set()).map((r) => r.id)).toEqual([2]);
  });

  test("newer green run → stale failure is NOT actionable", () => {
    const runs = [
      run({ id: 3, conclusion: "success", created_at: "2026-07-10T12:00:00Z" }),
      run({ id: 2, conclusion: "failure", created_at: "2026-07-10T11:00:00Z" }),
    ];
    expect(pickActionableFailures(runs, new Set())).toEqual([]);
  });

  test("newer run still in progress → wait, not actionable this tick", () => {
    const runs = [
      run({ id: 3, status: "in_progress", conclusion: null, created_at: "2026-07-10T12:00:00Z" }),
      run({ id: 2, conclusion: "failure", created_at: "2026-07-10T11:00:00Z" }),
    ];
    expect(pickActionableFailures(runs, new Set())).toEqual([]);
  });

  test("already-seen failure is skipped", () => {
    const runs = [run({ id: 2, conclusion: "failure", created_at: "2026-07-10T11:00:00Z" })];
    expect(pickActionableFailures(runs, new Set([2]))).toEqual([]);
  });

  test("workflows are independent — CI red + Release green → only CI", () => {
    const runs = [
      run({ id: 5, name: "Release", conclusion: "success", created_at: "2026-07-10T12:00:00Z" }),
      run({ id: 4, name: "CI", conclusion: "failure", created_at: "2026-07-10T11:30:00Z" }),
      run({ id: 3, name: "CI", conclusion: "success", created_at: "2026-07-10T10:00:00Z" }),
    ];
    expect(pickActionableFailures(runs, new Set()).map((r) => r.id)).toEqual([4]);
  });

  test("cancelled newest run is not actionable (only failure files an issue)", () => {
    const runs = [run({ id: 2, conclusion: "cancelled", created_at: "2026-07-10T11:00:00Z" })];
    expect(pickActionableFailures(runs, new Set())).toEqual([]);
  });
});

describe("underDailyCap", () => {
  const filed = (n: number, repo = "sonthanh/brain-os-plugin", date = "2026-07-10"): FiledEntry[] =>
    Array.from({ length: n }, (_, i) => ({ runId: i, date, issueUrl: "u", repo }));

  test("below cap → true", () => {
    expect(underDailyCap(filed(DAILY_ISSUE_CAP - 1), "sonthanh/brain-os-plugin", "2026-07-10")).toBe(true);
  });

  test("at cap → false", () => {
    expect(underDailyCap(filed(DAILY_ISSUE_CAP), "sonthanh/brain-os-plugin", "2026-07-10")).toBe(false);
  });

  test("other repo and other day do not count against the cap", () => {
    const entries = [...filed(DAILY_ISSUE_CAP, "sonthanh/other"), ...filed(DAILY_ISSUE_CAP, "sonthanh/brain-os-plugin", "2026-07-09")];
    expect(underDailyCap(entries, "sonthanh/brain-os-plugin", "2026-07-10")).toBe(true);
  });
});

describe("issue content", () => {
  const cfg = WATCHED[0]!;
  const failed = run({ id: 42, conclusion: "failure" });

  test("title carries repo, workflow, and searchable run id", () => {
    expect(issueTitle(cfg, failed)).toBe("[autofix] brain-os-plugin: CI failed on main (run 42)");
  });

  test("body includes run url, gate command, secret-scan stop rule, and AC", () => {
    const body = issueBody(cfg, failed, "some log tail");
    expect(body).toContain(failed.html_url);
    expect(body).toContain(cfg.gateCmd);
    expect(body).toContain("some log tail");
    expect(body).toContain("secret-scan/gitleaks failure: STOP");
    expect(body).toContain("## Acceptance criteria");
  });

  test("empty log tail falls back to a read-it-yourself instruction", () => {
    const body = issueBody(cfg, failed, "");
    expect(body).toContain("gh run view 42 --repo sonthanh/brain-os-plugin --log-failed");
  });

  test("labels route into the autonomous loop", () => {
    expect(ISSUE_LABELS).toContain("status:ready");
    expect(ISSUE_LABELS).toContain("owner:bot");
    expect(ISSUE_LABELS).toContain("weight:quick");
  });
});
