// bootstrap.test.ts — cover the pure helpers of the migration bootstrap. The imperative main
// (clone / launchctl / fs writes) is verified by a guarded dry-run, not unit tests.

import { describe, expect, test } from "bun:test";
import { allLabels, brainOsEnabled, missingPrereqs, renderBrainConfig, renderEnvSkeleton, repoPlan, REQUIRED_BINS } from "./bootstrap.ts";

describe("repoPlan", () => {
  test("clones the 4 repos under ~/work with sonthanh SSH remotes", () => {
    const plan = repoPlan("/Users/x");
    expect(plan.map((r) => r.dir)).toEqual([
      "/Users/x/work/brain",
      "/Users/x/work/brain-ops",
      "/Users/x/work/brain-os-plugin",
      "/Users/x/work/brain-geo-analysis-plugin",
    ]);
    expect(plan[0].remote).toBe("git@github.com:sonthanh/ai-brain.git");
    expect(plan.every((r) => r.remote.startsWith("git@github.com:sonthanh/"))).toBe(true);
  });

  test("is home-relative — no hardcoded username", () => {
    expect(repoPlan("/home/junjun")[0].dir).toBe("/home/junjun/work/brain");
  });
});

describe("renderBrainConfig", () => {
  test("embeds the given home as the vault path + fixed task repo", () => {
    const cfg = renderBrainConfig("/Users/junjun");
    expect(cfg).toContain("vault_path: /Users/junjun/work/brain");
    expect(cfg).toContain("gh_task_repo: sonthanh/ai-brain");
  });
});

describe("renderEnvSkeleton", () => {
  test("has empty TG_* keys for the operator to fill", () => {
    const env = renderEnvSkeleton();
    expect(env).toContain("TG_BOT_TOKEN=\n");
    expect(env).toContain("TG_CHAT_ID=\n");
  });
});

describe("missingPrereqs", () => {
  test("reports only the binaries the resolver cannot find", () => {
    const present = new Set(["git", "bun", "node"]);
    expect(missingPrereqs((b) => (present.has(b) ? `/usr/bin/${b}` : null)).sort()).toEqual(["claude", "gh", "jq"]);
  });

  test("empty when all present", () => {
    expect(missingPrereqs(() => "/usr/bin/x")).toEqual([]);
    expect([...REQUIRED_BINS]).toContain("claude");
  });
});

describe("brainOsEnabled", () => {
  test("true when a brain-os@… plugin is enabled", () => {
    expect(brainOsEnabled(JSON.stringify({ enabledPlugins: { "brain-os@brain-os-marketplace": true } }))).toBe(true);
  });
  test("false when disabled, absent, or malformed", () => {
    expect(brainOsEnabled(JSON.stringify({ enabledPlugins: { "brain-os@brain-os-marketplace": false } }))).toBe(false);
    expect(brainOsEnabled(JSON.stringify({ enabledPlugins: {} }))).toBe(false);
    expect(brainOsEnabled(null)).toBe(false);
    expect(brainOsEnabled("not json")).toBe(false);
  });
});

describe("allLabels", () => {
  test("covers every agent automation + support job, all com.brain.*", () => {
    const labels = allLabels();
    expect(labels).toContain("com.brain.automation.vault-lint");
    expect(labels).toContain("com.brain.gmail-triage-watchdog");
    expect(labels).toContain("com.brain.triage");
    expect(labels.every((l) => l.startsWith("com.brain."))).toBe(true);
    // 9 agent automations + 5 support jobs. Was 10 until 2026-08-08, when geo-digest
    // moved to GitHub Actions (ai-brain .github/workflows/geo-digest.yml).
    expect(labels.length).toBe(14);
  });
});
