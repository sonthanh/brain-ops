import { createGmailClient } from "./lib/gmail-client.ts";
import type { Email } from "./lib/types.ts";

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

        emails.push({
          id,
          from: header("From"),
          subject: header("Subject"),
          snippet: d.data.snippet || "",
          date: header("Date"),
          labels: d.data.labelIds || [],
        });
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return emails;
}

// CLI entry point — only runs when executed directly
if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  fetchUnreadEmails({ dryRun })
    .then((emails) => {
      console.log(JSON.stringify(emails, null, 2));
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
