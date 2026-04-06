import { createGmailClient } from "./lib/gmail-client.ts";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseDraftRequests } from "./lib/types.ts";
import type { DraftRequest } from "./lib/types.ts";

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

export async function createDrafts(options: {
  jsonPath: string;
  dryRun?: boolean;
  credentialsPath?: string;
}): Promise<{ created: number; failed: number }> {
  const fullPath = resolve(options.jsonPath);
  const drafts = parseDraftRequests(JSON.parse(readFileSync(fullPath, "utf-8")));

  if (!drafts.length) {
    console.log("No drafts to create.");
    return { created: 0, failed: 0 };
  }

  if (options.dryRun) {
    console.log(`[dry-run] Would create ${drafts.length} drafts:`);
    for (const d of drafts) {
      console.log(`[dry-run]   Reply to ${d.to}: "${d.subject}"`);
    }
    return { created: drafts.length, failed: 0 };
  }

  const gmail = createGmailClient(options.credentialsPath);
  let created = 0;
  let failed = 0;

  for (const draft of drafts) {
    try {
      // Fetch original message headers for proper threading
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

      const mime = buildMimeMessage(draft, references, originalMsgId);

      await gmail.users.drafts.create({
        userId: "me",
        requestBody: {
          message: {
            raw: base64url(mime),
            threadId: threadId || undefined,
          },
        },
      });

      console.log(`Created draft: Reply to ${draft.to} — "${draft.subject}"`);
      created++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed draft for ${draft.to}: ${msg}`);
      failed++;
    }
  }

  console.log(`Done: ${created} created, ${failed} failed.`);
  return { created, failed };
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

  createDrafts({ jsonPath, dryRun }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
