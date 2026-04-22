import { createGmailClient } from "./lib/gmail-client.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { detectSlaPrefilter } from "./lib/sla-prefilter.ts";
import type { Email, SlaThread, SlaThreadMessage } from "./lib/types.ts";

const BATCH_SIZE = 20;

export async function fetchUnreadEmails(options: {
  dryRun?: boolean;
  credentialsPath?: string;
}): Promise<Email[]> {
  if (options.dryRun) {
    console.log("[dry-run] Would fetch unread emails from Gmail API");
    console.log("[dry-run] Query: is:unread in:inbox");
    console.log("[dry-run] Batch size:", BATCH_SIZE);
    return [];
  }

  const gmail = createGmailClient(options.credentialsPath);
  const emails: Email[] = [];
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread in:inbox",
      maxResults: 100,
      pageToken,
    });

    if (!res.data.messages) break;

    for (let i = 0; i < res.data.messages.length; i += BATCH_SIZE) {
      const chunk = res.data.messages.slice(i, i + BATCH_SIZE);
      const validChunk = chunk.filter((m) => m.id);
      const details = await Promise.all(
        validChunk.map((m) =>
          gmail.users.messages.get({
            userId: "me",
            id: m.id as string,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          }),
        ),
      );

      for (const d of details) {
        const id = d.data.id;
        if (!id) continue;

        const headers = d.data.payload?.headers || [];
        const header = (name: string): string =>
          headers.find((h) => h.name === name)?.value || "";

        const from = header("From");
        const prefilterHint = detectSlaPrefilter(from);

        emails.push({
          id,
          from,
          subject: header("Subject"),
          snippet: d.data.snippet || "",
          date: header("Date"),
          labels: d.data.labelIds || [],
          ...(prefilterHint ? { sla_prefilter_hint: prefilterHint } : {}),
        });
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return emails;
}

/**
 * Parse sla-open.md and extract Message IDs from ## Breached and ## Open tables.
 */
function parseLedgerMessageIds(ledgerPath: string): string[] {
  let content: string;
  try {
    content = readFileSync(ledgerPath, "utf-8");
  } catch {
    return [];
  }

  const ids: string[] = [];
  // Match table rows: | tier | owner | from | to | subject | MESSAGE_ID | ...
  // Message ID is column 6 (0-indexed: 5) in both Breached and Open tables
  for (const line of content.split("\n")) {
    if (!line.startsWith("|") || line.startsWith("|--") || line.startsWith("| Tier")) continue;
    const cols = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cols.length >= 6 && cols[5] && !cols[5].startsWith("Message")) {
      ids.push(cols[5]);
    }
  }
  return ids;
}

/**
 * Fetch thread data for each open SLA item's message ID.
 */
export async function fetchSlaThreads(options: {
  ledgerPath: string;
  dryRun?: boolean;
  credentialsPath?: string;
}): Promise<SlaThread[]> {
  const messageIds = parseLedgerMessageIds(options.ledgerPath);
  if (messageIds.length === 0) return [];

  if (options.dryRun) {
    console.error(`[dry-run] Would fetch ${messageIds.length} SLA threads`);
    return [];
  }

  const gmail = createGmailClient(options.credentialsPath);
  const threads: SlaThread[] = [];

  for (const msgId of messageIds) {
    try {
      // Get the message to find its threadId
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: msgId,
        format: "metadata",
        metadataHeaders: ["From", "To", "Date", "Auto-Submitted"],
      });

      const threadId = msg.data.threadId;
      if (!threadId) continue;

      // Fetch all messages in the thread
      const thread = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: ["From", "To", "Date", "Auto-Submitted"],
      });

      const threadMessages: SlaThreadMessage[] = [];
      for (const m of thread.data.messages || []) {
        const headers = m.payload?.headers || [];
        const header = (name: string): string =>
          headers.find((h) => h.name === name)?.value || "";

        threadMessages.push({
          from: header("From"),
          to: header("To"),
          date: header("Date"),
          auto_submitted: header("Auto-Submitted") !== "",
        });
      }

      threads.push({ message_id: msgId, thread_messages: threadMessages });
    } catch (e) {
      console.error(`[sla-threads] Failed to fetch thread for ${msgId}:`, e);
    }
  }

  return threads;
}

// CLI entry point — only runs when executed directly
if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const slaLedgerArg = args.find((a) => a.startsWith("--sla-ledger="));
  const slaLedgerPath = slaLedgerArg?.split("=")[1];

  fetchUnreadEmails({ dryRun })
    .then(async (emails) => {
      console.log(JSON.stringify(emails, null, 2));

      // Fetch SLA threads if ledger path provided
      if (slaLedgerPath) {
        const slaThreads = await fetchSlaThreads({
          ledgerPath: slaLedgerPath,
          dryRun,
        });
        writeFileSync("/tmp/sla-threads.json", JSON.stringify(slaThreads, null, 2));
        console.error(`Fetched ${slaThreads.length} SLA threads`);
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
