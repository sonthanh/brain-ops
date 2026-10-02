#!/usr/bin/env -S bun run
/*
 * setup-gmail-triage-scheduler.ts — deploy the Cloudflare Worker that starts
 * Gmail Triage on time (workers/gmail-triage-scheduler). Idempotent: safe to
 * re-run; each step checks before acting.
 *
 *   bun run scripts/setup-gmail-triage-scheduler.ts              # first setup / redeploy
 *   bun run scripts/setup-gmail-triage-scheduler.ts --rotate-token
 *   bun run scripts/setup-gmail-triage-scheduler.ts --dry-run    # print the plan, call nothing
 *
 * Steps:
 *   1. Cloudflare login check (`wrangler whoami`). Not logged in → exits and
 *      tells you to run `bunx wrangler@4 login` once.
 *   2. Deploy the worker (`wrangler deploy` — idempotent).
 *   3. GH_TOKEN secret: set only when missing, or with --rotate-token. The
 *      token is read from the CLIPBOARD (copy it from GitHub first), checked
 *      against the GitHub API, stored, then the clipboard is cleared. It is
 *      never printed.
 *      Token: fine-grained PAT, repository sonthanh/ai-brain only,
 *      permission "Actions: Read and write".
 *   4. Telegram alert secrets: set when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *      are in the environment and the secrets are missing. Without them the
 *      worker still runs, but a failed start only shows in Cloudflare logs.
 */

import { join } from "node:path";

export const WORKER_DIR = join(import.meta.dir, "..", "workers", "gmail-triage-scheduler");
export const WRANGLER = ["bunx", "wrangler@4"];
export const TOKEN_CHECK_URL = "https://api.github.com/repos/sonthanh/ai-brain/actions/workflows/gmail-triage.yml";

export interface State {
  existingSecrets: string[];
  rotateToken: boolean;
  telegramInEnv: boolean;
}

export type Step = "deploy" | "put-gh-token" | "put-telegram" | "warn-no-telegram";

/** Pure plan: which steps to run given what already exists. */
export function plan(s: State): Step[] {
  const steps: Step[] = ["deploy"];
  if (s.rotateToken || !s.existingSecrets.includes("GH_TOKEN")) steps.push("put-gh-token");
  const hasTelegram = s.existingSecrets.includes("TELEGRAM_BOT_TOKEN") && s.existingSecrets.includes("TELEGRAM_CHAT_ID");
  if (!hasTelegram) steps.push(s.telegramInEnv ? "put-telegram" : "warn-no-telegram");
  return steps;
}

/** `wrangler secret list --format json` → secret names. A not-yet-deployed worker has none. */
export function parseSecretNames(json: string): string[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map((x) => String(x?.name ?? "")).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function isLoggedIn(whoamiOutput: string): boolean {
  return !/not authenticated|wrangler login/i.test(whoamiOutput) && /logged in|account/i.test(whoamiOutput);
}

function run(cmd: string[], opts: { stdin?: string; quiet?: boolean } = {}): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, {
    cwd: WORKER_DIR,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = p.stdout.toString() + p.stderr.toString();
  if (!opts.quiet) process.stdout.write(out);
  return { code: p.exitCode ?? 1, out };
}

function putSecret(name: string, value: string): void {
  const r = run([...WRANGLER, "secret", "put", name], { stdin: value, quiet: true });
  if (r.code !== 0) throw new Error(`wrangler secret put ${name} failed:\n${r.out.replaceAll(value, "***")}`);
  console.log(`✔ secret ${name} stored`);
}

async function readAndCheckToken(): Promise<string> {
  const token = Bun.spawnSync(["pbpaste"]).stdout.toString().replace(/\s+/g, "");
  if (!token) throw new Error("clipboard is empty — copy the GitHub token first");
  const res = await fetch(TOKEN_CHECK_URL, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "brain-ops-setup", Accept: "application/vnd.github+json" },
  });
  if (res.status !== 200) {
    throw new Error(
      `GitHub rejected the clipboard token (HTTP ${res.status}). It must be a fine-grained PAT for sonthanh/ai-brain with "Actions: Read and write". Nothing was stored.`,
    );
  }
  return token;
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const rotateToken = args.has("--rotate-token");
  const telegramInEnv = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

  try {
    if (dryRun) {
      console.log("[dry-run] would check Cloudflare login, then run:");
      for (const s of plan({ existingSecrets: [], rotateToken, telegramInEnv })) console.log(`[dry-run]   ${s}`);
      console.log("[dry-run] (assumes no secrets exist yet; a real run skips the ones already set)");
      process.exit(0);
    }

    const who = run([...WRANGLER, "whoami"], { quiet: true });
    if (!isLoggedIn(who.out)) {
      console.error("✘ Not logged in to Cloudflare. Run once:  bunx wrangler@4 login   then re-run this script.");
      process.exit(1);
    }
    console.log("✔ Cloudflare login ok");

    const listed = run([...WRANGLER, "secret", "list", "--format", "json"], { quiet: true });
    const steps = plan({ existingSecrets: parseSecretNames(listed.out), rotateToken, telegramInEnv });

    // Validate the token before deploying, so a bad clipboard leaves nothing half-set-up.
    const token = steps.includes("put-gh-token") ? await readAndCheckToken() : null;

    for (const step of steps) {
      if (step === "deploy") {
        const r = run([...WRANGLER, "deploy"]);
        if (r.code !== 0) throw new Error("wrangler deploy failed (output above)");
        console.log("✔ worker deployed");
      } else if (step === "put-gh-token" && token) {
        putSecret("GH_TOKEN", token);
        Bun.spawnSync(["pbcopy"], { stdin: new TextEncoder().encode("") });
        console.log("✔ clipboard cleared");
      } else if (step === "put-telegram") {
        putSecret("TELEGRAM_BOT_TOKEN", process.env.TELEGRAM_BOT_TOKEN!);
        putSecret("TELEGRAM_CHAT_ID", process.env.TELEGRAM_CHAT_ID!);
      } else if (step === "warn-no-telegram") {
        console.log("⚠ No Telegram alert secrets — a failed start will only show in Cloudflare logs.");
        console.log("  To add: TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… bun run scripts/setup-gmail-triage-scheduler.ts");
      }
    }
    console.log("Done. Watch a tick live with: cd workers/gmail-triage-scheduler && bunx wrangler@4 tail");
  } catch (e) {
    console.error(`✘ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
