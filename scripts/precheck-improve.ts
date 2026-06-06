#!/usr/bin/env -S bun run
/**
 * precheck-improve.ts — Orca automation precheck for the "Improve skills" job.
 *
 * Ports the two halting guards that used to live in improve-cron.sh so they run
 * BEFORE Orca spawns the (expensive) claude agent. Exit 0 → Orca runs the
 * automation; any non-zero exit → Orca records a *skipped* run (silent, no
 * Telegram), which is exactly the behaviour we want: pause auto-improve while a
 * human correction is pending, without paging anyone every single night.
 *
 *   GUARD-1  /improve must own an eval suite with >= minEvalCases cases
 *            (Phase 4's eval gate needs them; absent/thin → stop and review).
 *   GUARD-2  RED FLAG — no human (non-Claude-co-authored) commits to
 *            skills/improve/ inside reviewWindow. A user correction signals
 *            /improve is unreliable right now; auto must wait for review.
 *
 * Env overrides mirror the old cron: IMPROVE_PLUGIN_REPO, IMPROVE_MIN_EVAL_CASES,
 * IMPROVE_REVIEW_WINDOW.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PrecheckVerdict = { ok: boolean; reason: string };

export function checkEvals(evalsPath: string, minCases: number): PrecheckVerdict {
  if (!existsSync(evalsPath)) {
    return { ok: false, reason: `GUARD-1: ${evalsPath} missing` };
  }
  let count: number;
  try {
    const parsed = JSON.parse(readFileSync(evalsPath, "utf8"));
    count = Array.isArray(parsed) ? parsed.length : -1;
  } catch (e) {
    return { ok: false, reason: `GUARD-1: ${evalsPath} unparseable (${e})` };
  }
  if (count < minCases) {
    return {
      ok: false,
      reason: `GUARD-1: only ${count} eval case(s) (need >= ${minCases})`,
    };
  }
  return { ok: true, reason: `guard-1 ok: ${count} eval cases` };
}

/** Non-Claude-co-authored commits to skills/improve/ within the window. */
export function userCorrections(repo: string, reviewWindow: string): string[] {
  const res = spawnSync(
    "git",
    [
      "-C",
      repo,
      "log",
      `--since=${reviewWindow}`,
      "--format=%h %s",
      "--invert-grep",
      "-i",
      "--grep=Co-Authored-By:.*Claude",
      "--",
      "skills/improve/",
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    // No git / not a repo — treat as no corrections (don't block on infra).
    return [];
  }
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function checkRedFlag(repo: string, reviewWindow: string): PrecheckVerdict {
  const hits = userCorrections(repo, reviewWindow);
  if (hits.length > 0) {
    return {
      ok: false,
      reason: `GUARD-2 (red flag): ${hits.length} user correction(s) to skills/improve/ since ${reviewWindow} — auto-improve paused:\n  ${hits.join("\n  ")}`,
    };
  }
  return {
    ok: true,
    reason: `guard-2 ok: no user corrections to skills/improve/ since ${reviewWindow}`,
  };
}

export type PrecheckOpts = {
  pluginRepo: string;
  minEvalCases: number;
  reviewWindow: string;
};

export function precheck(opts: PrecheckOpts): PrecheckVerdict {
  const evalsPath = join(opts.pluginRepo, "skills", "improve", "evals", "evals.json");
  const g1 = checkEvals(evalsPath, opts.minEvalCases);
  if (!g1.ok) return g1;
  const g2 = checkRedFlag(opts.pluginRepo, opts.reviewWindow);
  if (!g2.ok) return g2;
  return { ok: true, reason: `${g1.reason}; ${g2.reason}` };
}

export function optsFromEnv(): PrecheckOpts {
  return {
    pluginRepo:
      process.env.IMPROVE_PLUGIN_REPO ?? join(homedir(), "work", "brain-os-plugin"),
    minEvalCases: Number(process.env.IMPROVE_MIN_EVAL_CASES ?? "5"),
    reviewWindow: process.env.IMPROVE_REVIEW_WINDOW ?? "14 days ago",
  };
}

if (import.meta.main) {
  const v = precheck(optsFromEnv());
  console.log(v.reason);
  process.exit(v.ok ? 0 : 1);
}
