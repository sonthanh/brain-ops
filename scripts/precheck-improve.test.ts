import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkEvals,
  checkRedFlag,
  precheck,
  userCorrections,
} from "./precheck-improve.ts";

function git(repo: string, args: string[], env?: Record<string, string>) {
  const res = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res;
}

describe("checkEvals (GUARD-1)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "evals-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("missing file → not ok", () => {
    expect(checkEvals(join(dir, "nope.json"), 5).ok).toBe(false);
  });
  test("fewer than min cases → not ok", () => {
    const p = join(dir, "thin.json");
    writeFileSync(p, JSON.stringify([1, 2, 3]));
    expect(checkEvals(p, 5).ok).toBe(false);
  });
  test("at or above min cases → ok", () => {
    const p = join(dir, "ok.json");
    writeFileSync(p, JSON.stringify([1, 2, 3, 4, 5]));
    const v = checkEvals(p, 5);
    expect(v.ok).toBe(true);
    expect(v.reason).toContain("5 eval cases");
  });
  test("unparseable → not ok", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{not json");
    expect(checkEvals(p, 5).ok).toBe(false);
  });
});

describe("checkRedFlag / userCorrections (GUARD-2)", () => {
  let repo: string;
  const COAUTHOR = "Co-Authored-By: Claude <noreply@anthropic.com>";
  const env = {
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@e.co",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@e.co",
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "repo-"));
    git(repo, ["init", "-q"]);
    mkdirSync(join(repo, "skills", "improve"), { recursive: true });
    // Commit 1: Claude-co-authored edit to skills/improve/ — should NOT count.
    writeFileSync(join(repo, "skills", "improve", "SKILL.md"), "v1");
    git(repo, ["add", "."], env);
    git(repo, ["commit", "-q", "-m", `improve: bot edit\n\n${COAUTHOR}`], env);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("only Claude-co-authored commits → ok (0 hits)", () => {
    expect(userCorrections(repo, "1 year ago")).toHaveLength(0);
    expect(checkRedFlag(repo, "1 year ago").ok).toBe(true);
  });

  test("a non-co-authored user edit → not ok (red flag)", () => {
    writeFileSync(join(repo, "skills", "improve", "SKILL.md"), "v2");
    git(repo, ["add", "."], env);
    git(repo, ["commit", "-q", "-m", "improve: human correction"], env);
    const hits = userCorrections(repo, "1 year ago");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("human correction");
    expect(checkRedFlag(repo, "1 year ago").ok).toBe(false);
  });

  test("edits outside skills/improve/ are ignored", () => {
    writeFileSync(join(repo, "README.md"), "unrelated");
    git(repo, ["add", "."], env);
    git(repo, ["commit", "-q", "-m", "docs: unrelated human edit"], env);
    // still only the one skills/improve/ correction from the previous test
    expect(userCorrections(repo, "1 year ago")).toHaveLength(1);
  });

  test("non-git path → no corrections (infra-safe)", () => {
    expect(userCorrections(join(tmpdir(), "definitely-not-a-repo-xyz"), "1 year ago"))
      .toHaveLength(0);
  });
});

describe("precheck (integration)", () => {
  let repo: string;
  const env = {
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@e.co",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@e.co",
  };
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "full-"));
    git(repo, ["init", "-q"]);
    mkdirSync(join(repo, "skills", "improve", "evals"), { recursive: true });
    writeFileSync(
      join(repo, "skills", "improve", "evals", "evals.json"),
      JSON.stringify([1, 2, 3, 4, 5, 6]),
    );
    writeFileSync(join(repo, "skills", "improve", "SKILL.md"), "v1");
    git(repo, ["add", "."], env);
    git(repo, [
      "commit", "-q", "-m",
      "improve: bot edit\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
    ], env);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("evals ok + no user edits → run (ok)", () => {
    const v = precheck({ pluginRepo: repo, minEvalCases: 5, reviewWindow: "1 year ago" });
    expect(v.ok).toBe(true);
  });

  test("a human correction flips it to skip", () => {
    writeFileSync(join(repo, "skills", "improve", "SKILL.md"), "v2");
    git(repo, ["add", "."], env);
    git(repo, ["commit", "-q", "-m", "improve: human fix"], env);
    const v = precheck({ pluginRepo: repo, minEvalCases: 5, reviewWindow: "1 year ago" });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("GUARD-2");
  });
});
