#!/usr/bin/env -S bun run
/*
 * ci-watchdog.ts — file an AFK fix issue when a watched repo's main branch
 * is red. launchd com.brain.ci-watchdog (every 30 min, always-on Mac mini).
 *
 * Why: the watched repos are public, so their in-repo autofix listeners run
 * WITHOUT a Claude token (user decision 2026-07-10 — no Claude OAuth secret
 * on a public repo). The GitHub side only reruns infra flakes; real failures
 * need a fixer with local credentials. This watchdog bridges the gap by
 * filing a `status:ready` + `owner:bot` issue on sonthanh/ai-brain — the
 * existing autonomous loop (pickup-auto → /impl) picks it up and fixes it
 * locally, where Claude is already authenticated.
 *
 * Layered with:
 *   - prevention: each repo's pre-push CI gate (hooks/pre-push-ci-gate.sh)
 *   - infra flakes: each repo's autofix-listener.yml reruns within a minute
 *   - this watchdog: anything still red on the next 30-min tick
 *
 * Only acts when the NEWEST run of a workflow on main is a completed
 * failure — a green or in-flight newer run means the failure is stale or a
 * fix is already underway. Dedupes via a seen-run-id state file AND an
 * open-issue search (survives state loss). Caps issues per repo per day so
 * a flapping workflow can't flood the loop.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WatchedRepo {
  repo: string; // owner/name on GitHub
  short: string; // label used in issue titles
  areaLabel: string; // area:* label on the task repo
  workdir: string; // local checkout the fixer should work in
  gateCmd: string; // repo's CI-equivalent local gate
  workflows: string[]; // workflow names to watch (exact match)
}

export const WATCHED: WatchedRepo[] = [
  {
    repo: "sonthanh/brain-os-plugin",
    short: "brain-os-plugin",
    areaLabel: "area:plugin-brain-os",
    workdir: "~/work/brain-os-plugin",
    gateCmd: "shellcheck install.sh && bunx tsc --noEmit && bun test",
    workflows: ["CI", "Release"],
  },
];

export const TASK_REPO = "sonthanh/ai-brain";
export const DAILY_ISSUE_CAP = 2; // per watched repo per UTC day
export const LOG_TAIL_CHARS = 3500;
const SEEN_KEEP = 500;

export interface RunInfo {
  id: number;
  name: string; // workflow name
  status: string; // queued | in_progress | completed | ...
  conclusion: string | null;
  created_at: string;
  head_sha: string;
  html_url: string;
  display_title?: string;
}

/**
 * Pure decision: per workflow name, act only when the newest run (by
 * created_at, any status) is a COMPLETED FAILURE not yet seen. A newer green
 * run → stale failure; a newer queued/in-progress run → fix may be landing,
 * let the next tick decide.
 */
export function pickActionableFailures(runs: RunInfo[], seen: Set<number>): RunInfo[] {
  const newestByWorkflow = new Map<string, RunInfo>();
  for (const r of runs) {
    const cur = newestByWorkflow.get(r.name);
    if (!cur || new Date(r.created_at).getTime() > new Date(cur.created_at).getTime()) {
      newestByWorkflow.set(r.name, r);
    }
  }
  return [...newestByWorkflow.values()].filter(
    (r) => r.status === "completed" && r.conclusion === "failure" && !seen.has(r.id),
  );
}

export interface FiledEntry {
  runId: number;
  date: string; // YYYY-MM-DD (UTC)
  issueUrl: string;
  repo: string;
}

export function underDailyCap(filed: FiledEntry[], repo: string, todayUTC: string, cap: number = DAILY_ISSUE_CAP): boolean {
  return filed.filter((f) => f.repo === repo && f.date === todayUTC).length < cap;
}

export function issueTitle(cfg: WatchedRepo, run: RunInfo): string {
  return `[autofix] ${cfg.short}: ${run.name} failed on main (run ${run.id})`;
}

export function issueBody(cfg: WatchedRepo, run: RunInfo, logTail: string): string {
  return `## Goal

The latest **${run.name}** run on \`main\` of \`${cfg.repo}\` FAILED. Restore green by fixing the root cause.

- Run: ${run.html_url}
- Commit: \`${run.head_sha.slice(0, 8)}\` — ${run.display_title ?? "(no title)"}

## Failed log tail

\`\`\`text
${logTail || "(log unavailable — read it with: gh run view " + run.id + " --repo " + cfg.repo + " --log-failed)"}
\`\`\`

## How to fix

- Work in \`${cfg.workdir}\` (shared checkout — stage only your files, commit in one shot).
- Reproduce locally first: \`${cfg.gateCmd}\`
- Fix the ROOT CAUSE and add/extend a regression test where the failure class allows. NEVER delete or weaken an assertion just to go green — if a test encodes a wrong expectation introduced by the breaking commit, correct it and say so in the commit message.
- If this is a secret-scan/gitleaks failure: STOP. Do not patch. Relabel \`type:human-review\` and comment a diagnosis — a leaked credential needs human rotation and history rewrite.
- Push (the repo's pre-push gate reruns the same checks), then verify the new run: \`gh run watch --repo ${cfg.repo}\`.

## Acceptance criteria

- [ ] Latest ${run.name} run on \`main\` of ${cfg.repo} is green
- [ ] Root cause fixed with regression coverage (or a one-line justification why it is not testable)

_Filed by ci-watchdog (brain-ops/scripts/ci-watchdog.ts)._`;
}

export const ISSUE_LABELS = ["status:ready", "owner:bot", "weight:quick", "priority:p1"];

// ---------------------------------------------------------------------------
// shell plumbing (not under test)
// ---------------------------------------------------------------------------

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${err.trim() || out.trim()}`);
  }
  return out;
}

function notifyMac(msg: string): void {
  try {
    Bun.spawnSync(["osascript", "-e", `display notification ${JSON.stringify(msg)} with title "ci-watchdog"`]);
  } catch {
    // best-effort
  }
}

/** Telegram via ~/.config/brain/env (TG_BOT_TOKEN / TG_CHAT_ID). Best-effort. */
async function notifyTelegram(msg: string): Promise<void> {
  try {
    const envFile = join(process.env.HOME ?? "", ".config/brain/env");
    if (!existsSync(envFile)) return;
    const env = readFileSync(envFile, "utf8");
    const token = env.match(/^TG_BOT_TOKEN=(.+)$/m)?.[1]?.trim();
    const chatId = env.match(/^TG_CHAT_ID=(.+)$/m)?.[1]?.trim();
    if (!token || !chatId) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(chatId), text: msg }),
    });
  } catch {
    // best-effort
  }
}

interface State {
  seen: number[];
  filed: FiledEntry[];
}

if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  const forceIdx = process.argv.indexOf("--force-run-id");
  const forceRunId = forceIdx >= 0 ? Number(process.argv[forceIdx + 1]) : null;

  const stateDir = join(process.env.HOME ?? "", ".local/state/ci-watchdog");
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, "state.json");
  const logFile = join(stateDir, "watchdog.log");
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    appendFileSync(logFile, line + "\n");
  };

  const state: State = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : { seen: [], filed: [] };
  const seen = new Set(state.seen);
  const todayUTC = new Date().toISOString().slice(0, 10);

  try {
    for (const cfg of WATCHED) {
      const raw = await gh([
        "api",
        `repos/${cfg.repo}/actions/runs?branch=main&per_page=25`,
        "--jq",
        "[.workflow_runs[] | {id, name, status, conclusion, created_at, head_sha, html_url, display_title}]",
      ]);
      const runs: RunInfo[] = (JSON.parse(raw) as RunInfo[]).filter((r) => cfg.workflows.includes(r.name));

      let actionable = pickActionableFailures(runs, seen);
      if (forceRunId) {
        const forced = runs.find((r) => r.id === forceRunId);
        actionable = forced ? [forced] : actionable;
        if (!forced) log(`--force-run-id ${forceRunId}: not found in recent runs of ${cfg.repo}`);
      }
      if (actionable.length === 0) {
        log(`ok — ${cfg.repo}: latest main runs green, in-flight, or already handled`);
        continue;
      }

      for (const run of actionable) {
        if (!forceRunId && !underDailyCap(state.filed, cfg.repo, todayUTC)) {
          log(`CAP — ${cfg.repo}: daily issue cap (${DAILY_ISSUE_CAP}) reached; ${run.name} run ${run.id} left for tomorrow/human`);
          await notifyTelegram(`🛑 ci-watchdog: ${cfg.short} ${run.name} still failing but daily issue cap reached — look manually: ${run.html_url}`);
          break;
        }

        // Dedupe against open issues (survives state-file loss).
        const existing = await gh([
          "issue", "list", "-R", TASK_REPO, "--state", "open",
          "--search", `"run ${run.id}" in:title`,
          "--json", "number", "--jq", "length",
        ]);
        if (Number(existing.trim()) > 0) {
          log(`dup — ${cfg.repo} run ${run.id} already has an open issue; marking seen`);
          seen.add(run.id);
          continue;
        }

        let logTail = "";
        try {
          const failedLog = await gh(["run", "view", String(run.id), "--repo", cfg.repo, "--log-failed"]);
          logTail = failedLog.slice(-LOG_TAIL_CHARS);
        } catch {
          // body carries the fallback instruction
        }

        const title = issueTitle(cfg, run);
        if (dryRun) {
          log(`DRY-RUN — would file on ${TASK_REPO}: "${title}" (labels: ${[...ISSUE_LABELS, cfg.areaLabel].join(",")})`);
          continue;
        }

        const issueUrl = (
          await gh([
            "issue", "create", "-R", TASK_REPO,
            "--title", title,
            "--body", issueBody(cfg, run, logTail),
            ...[...ISSUE_LABELS, cfg.areaLabel].flatMap((l) => ["--label", l]),
          ])
        ).trim();

        seen.add(run.id);
        state.filed.push({ runId: run.id, date: todayUTC, issueUrl, repo: cfg.repo });
        log(`FILED — ${issueUrl} for ${cfg.repo} ${run.name} run ${run.id}`);
        const msg = `🔧 ci-watchdog: ${cfg.short} ${run.name} failed on main — filed fix issue for the autonomous loop: ${issueUrl}`;
        notifyMac(msg);
        await notifyTelegram(msg);
      }
    }

    state.seen = [...seen].slice(-SEEN_KEEP);
    if (!dryRun) writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    log(`ERROR — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
