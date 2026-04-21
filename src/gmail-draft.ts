import { createGmailClient } from "./lib/gmail-client.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDraftRequests } from "./lib/types.ts";
import type { DraftRequest } from "./lib/types.ts";
import type { gmail_v1 } from "@googleapis/gmail";
import {
  readLedger,
  writeLedger,
  mergeLedger,
  hashBody,
  type DraftLedgerRow,
} from "./lib/ledger.ts";

const DEFAULT_LEDGER_PATH = "business/intelligence/emails/drafts-outstanding.md";

function buildMimeMessage(draft: DraftRequest, references: string, inReplyTo: string): string {
  const lines = [
    `To: ${draft.to}`,
    `Subject: ${draft.subject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    draft.body,
  ];
  return lines.join("\r\n");
}

function base64url(str: string): string {
  return Buffer.from(str).toString("base64url");
}

function nowUtcString(): string {
  const d = new Date();
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

async function listExistingDraftThreadIds(gmail: gmail_v1.Gmail): Promise<Set<string>> {
  const set = new Set<string>();
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.drafts.list({
      userId: "me",
      maxResults: 100,
      pageToken,
    });
    for (const d of res.data.drafts ?? []) {
      const t = d.message?.threadId;
      if (t) set.add(t);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return set;
}

export async function createDrafts(options: {
  jsonPath: string;
  dryRun?: boolean;
  credentialsPath?: string;
  ledgerPath?: string;
  gmailClient?: gmail_v1.Gmail;
}): Promise<{ created: number; skipped: number; failed: number }> {
  const fullPath = resolve(options.jsonPath);
  const drafts = parseDraftRequests(JSON.parse(readFileSync(fullPath, "utf-8")));

  if (!drafts.length) {
    console.log("No drafts to create.");
    return { created: 0, skipped: 0, failed: 0 };
  }

  if (options.dryRun) {
    console.log(`[dry-run] Would create ${drafts.length} drafts:`);
    for (const d of drafts) {
      console.log(`[dry-run]   Reply to ${d.to}: "${d.subject}"`);
    }
    return { created: drafts.length, skipped: 0, failed: 0 };
  }

  const gmail = options.gmailClient ?? createGmailClient(options.credentialsPath);
  const ledgerPath = options.ledgerPath ?? DEFAULT_LEDGER_PATH;

  const existingThreadIds = await listExistingDraftThreadIds(gmail);
  const newRows: DraftLedgerRow[] = [];
  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const draft of drafts) {
    try {
      const original = await gmail.users.messages.get({
        userId: "me",
        id: draft.messageId,
        format: "metadata",
        metadataHeaders: ["Message-ID", "References"],
      });

      const headers = original.data.payload?.headers || [];
      const originalMsgId = headers.find((h) => h.name === "Message-ID")?.value || "";
      const existingRefs = headers.find((h) => h.name === "References")?.value || "";
      const references = existingRefs ? `${existingRefs} ${originalMsgId}` : originalMsgId;
      const threadId = original.data.threadId || draft.threadId;

      if (threadId && existingThreadIds.has(threadId)) {
        console.log(`draft-exists-skipped: ${draft.to} — thread ${threadId}`);
        skipped++;
        continue;
      }

      const mime = buildMimeMessage(draft, references, originalMsgId);

      const createRes = await gmail.users.drafts.create({
        userId: "me",
        requestBody: {
          message: {
            raw: base64url(mime),
            threadId: threadId || undefined,
          },
        },
      });

      const draftId = createRes.data.id ?? "";
      const resolvedThreadId = createRes.data.message?.threadId ?? threadId ?? "";

      newRows.push({
        draftId,
        threadId: resolvedThreadId,
        messageId: draft.messageId,
        sender: draft.to,
        subject: draft.subject,
        bodyHash: hashBody(draft.body),
        createdAt: nowUtcString(),
      });

      console.log(`Created draft: Reply to ${draft.to} — "${draft.subject}"`);
      created++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed draft for ${draft.to}: ${msg}`);
      failed++;
    }
  }

  if (newRows.length > 0) {
    const existingLedger = readLedger(ledgerPath);
    const merged = mergeLedger(existingLedger, newRows);
    writeLedger(ledgerPath, merged, nowUtcString());
  }

  console.log(`Done: ${created} created, ${skipped} skipped, ${failed} failed.`);
  return { created, skipped, failed };
}

// CLI entry point — only runs when executed directly
if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const jsonPath = args.find((a) => !a.startsWith("--"));

  if (!jsonPath) {
    console.error("Usage: gmail-draft <drafts.json> [--dry-run]");
    process.exit(1);
  }

  const ledgerPath = process.env.DRAFTS_LEDGER_PATH;
  createDrafts({ jsonPath, dryRun, ledgerPath }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
