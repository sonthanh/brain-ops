import { gmail_v1 } from "@googleapis/gmail";
import { createGmailClient } from "./lib/gmail-client.ts";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { resolve, join, dirname } from "path";
import type { TriageAction, ExecutionResult, CleanupStats } from "./lib/types.ts";

const CONCURRENCY = 10;
const RETENTION_DAYS = 7;

function extractSender(value: string): string | undefined {
  return (value.match(/<([^>]+)>/) || value.match(/(\S+@\S+)/))?.[1];
}

export async function executeAction(
  gmail: gmail_v1.Gmail,
  action: TriageAction,
  labelCache: Map<string, string>,
): Promise<ExecutionResult> {
  try {
    if (action.action === "archive") {
      await gmail.users.messages.modify({
        userId: "me",
        id: action.id,
        requestBody: { removeLabelIds: ["INBOX"] },
      });
      return { ok: true, skip: false };
    }

    if (action.action === "delete") {
      await gmail.users.messages.trash({ userId: "me", id: action.id });
      return { ok: true, skip: false };
    }

    if (action.action.startsWith("label:")) {
      const name = action.action.slice(6);
      let labelId = labelCache.get(name);
      if (!labelId) {
        const created = await gmail.users.labels.create({
          userId: "me",
          requestBody: { name },
        });
        labelId = created.data.id!;
        labelCache.set(name, labelId);
      }
      await gmail.users.messages.modify({
        userId: "me",
        id: action.id,
        requestBody: { addLabelIds: [labelId] },
      });
      return { ok: true, skip: false };
    }

    if (action.action === "star") {
      await gmail.users.messages.modify({
        userId: "me",
        id: action.id,
        requestBody: { addLabelIds: ["STARRED"] },
      });
      return { ok: true, skip: false };
    }

    if (action.action === "mark-important") {
      await gmail.users.messages.modify({
        userId: "me",
        id: action.id,
        requestBody: { addLabelIds: ["IMPORTANT"] },
      });
      return { ok: true, skip: false };
    }

    if (action.action === "unsubscribe") {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: action.id,
        format: "metadata",
        metadataHeaders: ["From"],
      });
      const from = msg.data.payload?.headers?.find((h) => h.name === "From");
      const sender = from?.value ? extractSender(from.value) : undefined;
      await gmail.users.messages.trash({ userId: "me", id: action.id });
      if (sender) {
        try {
          await gmail.users.settings.filters.create({
            userId: "me",
            requestBody: {
              criteria: { from: sender },
              action: { removeLabelIds: ["INBOX"], addLabelIds: ["TRASH"] },
            },
          });
        } catch {
          // Filter may already exist
        }
      }
      return { ok: true, skip: false };
    }

    if (action.action === "needs-reply") {
      return { ok: false, skip: true, reason: "manual" };
    }

    return { ok: false, skip: true, reason: `unknown: ${action.action}` };
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && e.code === 404) {
      return { ok: false, skip: true, reason: "not found" };
    }
    throw e;
  }
}

async function runBatch<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map(fn))));
  }
  return results;
}

function updateMd(jsonPath: string, stats: Record<string, number>, skipped: number) {
  const mdPath = jsonPath.replace(/\.json$/, ".md");
  if (!existsSync(mdPath)) return;
  let content = readFileSync(mdPath, "utf-8");
  const parts = Object.entries(stats).map(([k, v]) => `${v} ${k}`);
  content += `\n\n## Cleanup Results\n${parts.join(", ")}. ${skipped} skipped.`;
  writeFileSync(mdPath, content);
}

function cleanOldFiles(triageDir: string) {
  if (!existsSync(triageDir)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const file of readdirSync(triageDir)) {
    const match = file.match(/^(\d{4}-\d{2}-\d{2})T/);
    if (!match) continue;
    if (match[1] && new Date(match[1]).getTime() < cutoff) {
      unlinkSync(join(triageDir, file));
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`Cleaned ${cleaned} files older than ${RETENTION_DAYS} days.`);
}

export async function cleanupEmails(options: {
  jsonPath: string;
  dryRun?: boolean;
  credentialsPath?: string;
}): Promise<CleanupStats> {
  const fullPath = resolve(options.jsonPath);
  if (!existsSync(fullPath)) {
    throw new Error(`Not found: ${fullPath}`);
  }

  const actions: TriageAction[] = JSON.parse(readFileSync(fullPath, "utf-8"));
  const pending = actions.filter((a) => a.action !== "needs-reply");

  if (!pending.length) {
    console.log("No pending actions.");
    return { actions: {}, skipped: 0, total: 0 };
  }

  if (options.dryRun) {
    console.log(`[dry-run] Would process ${pending.length} actions:`);
    const counts: Record<string, number> = {};
    for (const a of pending) {
      counts[a.action] = (counts[a.action] || 0) + 1;
    }
    for (const [action, count] of Object.entries(counts)) {
      console.log(`[dry-run]   ${action}: ${count}`);
    }
    return { actions: counts, skipped: 0, total: pending.length };
  }

  const gmail = createGmailClient(options.credentialsPath);

  // Cache labels upfront
  const labelCache = new Map<string, string>();
  const labelsNeeded = new Set(
    pending.filter((a) => a.action.startsWith("label:")).map((a) => a.action.slice(6)),
  );
  if (labelsNeeded.size > 0) {
    const existing = await gmail.users.labels.list({ userId: "me" });
    for (const l of existing.data.labels || []) {
      if (l.name && l.id && labelsNeeded.has(l.name)) {
        labelCache.set(l.name, l.id);
      }
    }
  }

  console.log(`Processing ${pending.length} actions (${CONCURRENCY} concurrent)...`);
  const stats: Record<string, number> = {};
  let skipped = 0;

  const results = await runBatch(pending, CONCURRENCY, (a) =>
    executeAction(gmail, a, labelCache),
  );
  for (let i = 0; i < pending.length; i++) {
    const r = results[i];
    if (r!.ok) stats[pending[i]!.action] = (stats[pending[i]!.action] || 0) + 1;
    else if (r!.skip) skipped++;
  }

  updateMd(fullPath, stats, skipped);
  cleanOldFiles(dirname(fullPath));

  const parts = Object.entries(stats).map(([k, v]) => `${v} ${k}`);
  console.log(`Done: ${parts.join(", ")}. ${skipped} skipped.`);

  return { actions: stats, skipped, total: pending.length };
}

// CLI entry point — only runs when executed directly
if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const jsonPath = args.find((a) => !a.startsWith("--"));

  if (!jsonPath) {
    console.error("Usage: gmail-clean <path.json> [--dry-run]");
    process.exit(1);
  }

  cleanupEmails({ jsonPath, dryRun }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
