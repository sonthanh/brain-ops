import { gmail_v1 } from "@googleapis/gmail";
import { createGmailClient } from "./lib/gmail-client.ts";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "fs";
import { resolve, join, dirname } from "path";
import { parseTriageActions } from "./lib/types.ts";
import type { TriageAction, ExecutionResult, CleanupStats } from "./lib/types.ts";

const CONCURRENCY = 10;
const RETENTION_DAYS = 7;

/** Label IDs for actions that just modify labels on a message.
 *  Every action removes UNREAD so processed emails don't reappear in
 *  `is:unread in:inbox` fetches or confuse `label:unread` searches.
 *
 *  `needs-reply` adds STARRED here so that draft-existence and star are
 *  atomic within a single workflow run: the Draft replies step runs after
 *  cleanup and either creates a Gmail draft or leaves the starred message
 *  visibly unresolved. Per 2026-04-22 grill (ai-brain#100): "draft existence
 *  = starred; both or neither." */
const LABEL_ACTIONS: Record<string, { add?: string[]; remove?: string[] }> = {
  archive: { remove: ["INBOX", "UNREAD"] },
  star: { add: ["STARRED"], remove: ["UNREAD"] },
  "mark-important": { add: ["IMPORTANT"], remove: ["UNREAD"] },
  "needs-reply": { add: ["STARRED"], remove: ["UNREAD"] },
  read: { remove: ["UNREAD"] },
};

function extractSender(value: string): string | undefined {
  return (value.match(/<([^>]+)>/) || value.match(/(\S+@\S+)/))?.[1];
}

export async function executeAction(
  gmail: gmail_v1.Gmail,
  action: TriageAction,
  labelCache: Map<string, string>,
): Promise<ExecutionResult> {
  try {
    // Simple label-based actions (archive, star, mark-important)
    const labelAction = LABEL_ACTIONS[action.action];
    if (labelAction) {
      await gmail.users.messages.modify({
        userId: "me",
        id: action.id,
        requestBody: {
          addLabelIds: labelAction.add,
          removeLabelIds: labelAction.remove,
        },
      });
      return { ok: true };
    }

    if (action.action === "delete") {
      await gmail.users.messages.trash({ userId: "me", id: action.id });
      return { ok: true };
    }

    if (action.action.startsWith("label:")) {
      const name = action.action.slice(6);
      let labelId = labelCache.get(name);
      if (!labelId) {
        const created = await gmail.users.labels.create({
          userId: "me",
          requestBody: { name },
        });
        labelId = created.data.id ?? undefined;
        if (!labelId) return { ok: false, reason: "label creation returned no ID" };
        labelCache.set(name, labelId);
      }
      await gmail.users.messages.modify({
        userId: "me",
        id: action.id,
        requestBody: { addLabelIds: [labelId], removeLabelIds: ["UNREAD"] },
      });
      return { ok: true };
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
        } catch (e) {
          console.warn(`Failed to create filter for ${sender}: ${e}`);
        }
      }
      return { ok: true };
    }

    return { ok: false, reason: `unknown: ${action.action}` };
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && e.code === 404) {
      return { ok: false, reason: "not found" };
    }
    throw e;
  }
}

function updateMd(jsonPath: string, stats: Record<string, number>, skipped: number) {
  const mdPath = jsonPath.replace(/\.json$/, ".md");
  if (!existsSync(mdPath)) return;
  let content = readFileSync(mdPath, "utf-8");
  const parts = Object.entries(stats).map(([k, v]) => `${v} ${k}`);
  const section = `\n\n## Cleanup Results\n${parts.join(", ")}. ${skipped} skipped.`;
  // Prevent duplicate cleanup results on re-runs
  if (content.includes("## Cleanup Results")) return;
  content += section;
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
      try {
        unlinkSync(join(triageDir, file));
        cleaned++;
      } catch (e) {
        console.warn(`Failed to clean ${file}: ${e}`);
      }
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

  const actions: TriageAction[] = parseTriageActions(JSON.parse(readFileSync(fullPath, "utf-8")));
  // Every action in the JSON is eligible for cleanup — even needs-reply, which
  // adds STARRED atomically with the downstream Draft step (per ai-brain#100).
  const pending = actions;

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

  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((a) => executeAction(gmail, a, labelCache)),
    );
    for (let j = 0; j < batch.length; j++) {
      const r = results[j]!;
      const action = batch[j]!.action;
      if (r.ok) {
        stats[action] = (stats[action] || 0) + 1;
      } else {
        skipped++;
      }
    }
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
