/*
 * gmail-triage-scheduler — Cloudflare Worker that starts "Gmail Triage"
 * (sonthanh/ai-brain .github/workflows/gmail-triage.yml) on a fixed schedule.
 *
 * Why: GitHub's own cron is best-effort. 2026-09-25 → 10-01 it started 25 of
 * 56 scheduled triage runs (45%), median 99 min late; the GitHub-hosted
 * watchdog was dropped the same way (2 of ~28 ticks). Cloudflare cron
 * triggers fire on time, and GitHub runs a workflow_dispatch immediately.
 *
 * Schedule lives in wrangler.toml [triggers] crons. Each tick POSTs one
 * workflow_dispatch; a duplicate (e.g. a manual run at the same time) just
 * queues behind the workflow's `gmail-ledger` concurrency group.
 *
 * Failure: retried, then a Telegram alert (when TELEGRAM_* secrets are set)
 * and a thrown error so the tick shows as failed in Cloudflare's logs. The
 * likely cause is an expired GitHub token — rotate it with the setup script.
 */

export interface Env {
  /** Fine-grained PAT: sonthanh/ai-brain only, "Actions: Read and write". */
  GH_TOKEN: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}

export const REPO = "sonthanh/ai-brain";
export const WORKFLOW_FILE = "gmail-triage.yml";
export const WORKFLOW_REF = "main";
/** Waits before attempts 2 and 3. GitHub API blips clear within seconds. */
export const RETRY_DELAYS_MS = [5_000, 20_000];

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

export interface DispatchResult {
  ok: boolean;
  attempts: number;
  /** Last HTTP status, or 0 when the request itself threw. */
  status: number;
  detail: string;
}

export function dispatchRequest(token: string): { url: string; init: RequestInit } {
  return {
    url: `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        // GitHub rejects API requests without a User-Agent.
        "User-Agent": "brain-ops-gmail-triage-scheduler",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: WORKFLOW_REF }),
    },
  };
}

/** 401/403/404/422 are config errors (token, permission, ref) — retrying cannot fix them. */
export function isRetryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

export async function dispatchTriage(token: string, fetchFn: FetchFn, sleep: SleepFn): Promise<DispatchResult> {
  const { url, init } = dispatchRequest(token);
  let status = 0;
  let detail = "";
  for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      const res = await fetchFn(url, init);
      status = res.status;
      if (status === 204) return { ok: true, attempts: attempt, status, detail: "dispatched" };
      detail = (await res.text()).slice(0, 300);
    } catch (e) {
      status = 0;
      detail = e instanceof Error ? e.message : String(e);
    }
    const delay = RETRY_DELAYS_MS[attempt - 1];
    if (!isRetryable(status) || delay === undefined) return { ok: false, attempts: attempt, status, detail };
    await sleep(delay);
  }
  return { ok: false, attempts: RETRY_DELAYS_MS.length + 1, status, detail };
}

export function alertText(result: DispatchResult, cron: string): string {
  const hint =
    result.status === 401 || result.status === 403
      ? "GitHub token expired or lost permission — rotate it: bun run scripts/setup-gmail-triage-scheduler.ts --rotate-token"
      : "Check Cloudflare logs: bunx wrangler tail gmail-triage-scheduler";
  return [
    "⚠️ Gmail triage was NOT started",
    `Schedule: ${cron}`,
    `GitHub answered ${result.status || "no response"} after ${result.attempts} attempt(s): ${result.detail}`,
    hint,
  ].join("\n");
}

async function sendTelegram(env: Env, text: string, fetchFn: FetchFn): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
}

export async function onSchedule(cron: string, env: Env, fetchFn: FetchFn, sleep: SleepFn): Promise<DispatchResult> {
  const result = await dispatchTriage(env.GH_TOKEN, fetchFn, sleep);
  if (result.ok) {
    console.log(`gmail-triage dispatched (cron ${cron}, attempt ${result.attempts})`);
    return result;
  }
  const text = alertText(result, cron);
  console.error(text);
  try {
    await sendTelegram(env, text, fetchFn);
  } catch (e) {
    console.error(`telegram alert failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  throw new Error(`gmail-triage dispatch failed: HTTP ${result.status}`);
}

const sleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  async scheduled(controller: { cron: string }, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(onSchedule(controller.cron, env, (u, i) => fetch(u, i), sleep));
  },
};
