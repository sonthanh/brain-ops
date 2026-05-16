import { createGmailClient } from "./lib/gmail-client.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { detectSlaPrefilter } from "./lib/sla-prefilter.ts";
import type { Email, SlaThread, SlaThreadMessage } from "./lib/types.ts";
import type { gmail_v1 } from "@googleapis/gmail";

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
 * Parse sla-open.md and extract Message IDs from `## Breached`, `## Open
 * (within SLA)`, AND `## Resolved` tables. The Resolved layout has one
 * fewer column (no `To`), so its Message ID is at col 4 instead of col 5.
 *
 * Resolved rows are included so the resolver's re-open pass can detect
 * partners re-engaging on previously-resolved threads. Without this, the
 * re-open detection path receives no thread data and never fires —
 * confirmed bug 2026-05-16 (Kerrie ES filing 19e2583c9748bb1f: Resolved
 * 2026-05-14 08:43 UTC, thread msg[2] Kerrie follow-up at 08:47 UTC via
 * via-X group rewrite; should have reopened, didn't).
 */
function parseLedgerMessageIds(ledgerPath: string): string[] {
  let content: string;
  try {
    content = readFileSync(ledgerPath, "utf-8");
  } catch {
    return [];
  }

  const ids: string[] = [];
  let activeSection: "breached" | "open" | "resolved" | null = null;
  for (const line of content.split("\n")) {
    if (/^##\s+Breached\s*$/.test(line)) { activeSection = "breached"; continue; }
    if (/^##\s+Open\s*\(within SLA\)\s*$/.test(line)) { activeSection = "open"; continue; }
    if (/^##\s+Resolved\b/.test(line)) { activeSection = "resolved"; continue; }
    if (/^##\s+/.test(line)) { activeSection = null; continue; }
    if (activeSection === null) continue;
    if (!line.startsWith("|") || line.startsWith("|--") || line.startsWith("| Tier")) continue;
    // Split, then strip ONLY the leading + trailing empty cells (the `|...|`
    // border tokens). Internal empty cells MUST be preserved — e.g. a
    // detectReopen-synthesized row with empty `To` would otherwise shift
    // every column-index left by one. Production case 2026-05-16: synthetic
    // reopened row had empty To; col-5 then pointed at the Received date
    // (`2026-05-14 08:47`), Gmail API got that as a message id and 400'd.
    const raw = line.split("|").map((c) => c.trim());
    // Drop one leading + one trailing empty (from `|...|` borders). If the
    // line genuinely starts/ends with non-border content (unusual), leave
    // alone.
    if (raw.length >= 2 && raw[0] === "") raw.shift();
    if (raw.length >= 1 && raw[raw.length - 1] === "") raw.pop();
    const cols = raw;
    // Breached/Open: Message ID at col 5 (after Tier, Owner, From, To, Subject).
    // Resolved: Message ID at col 4 (no To column — schema is Tier, Owner, From, Subject, Message ID, ...).
    const idIdx = activeSection === "resolved" ? 4 : 5;
    if (cols.length > idIdx && cols[idIdx] && !cols[idIdx].startsWith("Message")) {
      ids.push(cols[idIdx]);
    }
  }
  return ids;
}

/**
 * Extract one email address from a header field (`Name <addr@host>`,
 * `addr@host`). Returns lower-cased, or empty string. Mirrors
 * sla-resolver's `extractAddress` — kept local to avoid an import cycle.
 */
function extractAddressLocal(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const angle = s.match(/<([^>]+)>/);
  if (angle && angle[1]) return angle[1].trim().toLowerCase();
  const first = s.split(",")[0]?.trim() ?? "";
  const tok = first.split(/\s+/).find((t) => t.includes("@")) ?? first;
  return tok.replace(/[<>]/g, "").toLowerCase();
}

/**
 * Format YYYY/MM/DD for Gmail's `after:` query operator. Accepts both
 * ledger-format `YYYY-MM-DD HH:MM` and RFC 2822 date strings (Gmail headers).
 * Gmail interprets the date as the user's mailbox timezone, so widen by 1
 * day backwards to avoid timezone-edge misses.
 */
function gmailAfterDate(receivedAt: string): string {
  let baseMs: number;
  const isoLike = receivedAt.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoLike) {
    baseMs = Date.UTC(Number(isoLike[1]), Number(isoLike[2]) - 1, Number(isoLike[3]));
  } else {
    const parsed = Date.parse(receivedAt);
    if (!Number.isFinite(parsed)) return "";
    baseMs = parsed;
  }
  const widened = new Date(baseMs - 24 * 3_600_000);
  return `${widened.getUTCFullYear()}/${String(widened.getUTCMonth() + 1).padStart(2, "0")}/${String(widened.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Search for team-outbound to the partner's real external address across ALL
 * Gmail threads (not just the SLA thread). Catches cases the team handled
 * out-of-thread — Zendesk auto-creates new threadIds on every ticket
 * response, accounting/legal sometimes replies in a forked thread.
 *
 * Query: `to:{external} from:({team-domains-OR}) after:{sinceDate}`
 *
 * Returns up to 10 candidate messages with full metadata (same shape as
 * thread_messages), excluding any messages already in the same-thread set
 * (avoid double-counting).
 */
async function fetchCrossThreadReplies(
  gmail: gmail_v1.Gmail,
  realExternalAddr: string,
  receivedAtUtc: string,
  teamDomains: Set<string>,
  sameThreadMessageIds: Set<string>,
): Promise<SlaThreadMessage[]> {
  if (!realExternalAddr || teamDomains.size === 0) return [];
  const since = gmailAfterDate(receivedAtUtc);
  if (!since) return [];
  const domainClause = [...teamDomains].map((d) => d).join(" OR ");
  const q = `to:${realExternalAddr} from:(${domainClause}) after:${since}`;
  let listRes;
  try {
    listRes = await gmail.users.messages.list({ userId: "me", q, maxResults: 10 });
  } catch (e) {
    console.error(`[cross-thread] search failed for ${realExternalAddr}:`, e);
    return [];
  }
  const ids = (listRes.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => !!id && !sameThreadMessageIds.has(id));
  const out: SlaThreadMessage[] = [];
  for (const id of ids) {
    try {
      const md = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Date", "Auto-Submitted", "X-Original-Sender", "Reply-To"],
      });
      const headers = md.data.payload?.headers || [];
      const header = (name: string): string =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
      const autoSub = header("Auto-Submitted");
      const xOrig = header("X-Original-Sender");
      const replyTo = header("Reply-To");
      out.push({
        message_id: id,
        from: header("From"),
        to: header("To"),
        date: header("Date"),
        auto_submitted: autoSub === "" ? null : autoSub,
        x_original_sender: xOrig === "" ? null : xOrig,
        reply_to: replyTo === "" ? null : replyTo,
      });
    } catch (e) {
      console.error(`[cross-thread] fetch failed for ${id}:`, e);
    }
  }
  return out;
}

/**
 * Fetch thread data for each open SLA item's message ID.
 *
 * When `teamDomains` is provided, also runs a Gmail-wide search for any
 * team-outbound to the partner's real external address (X-Original-Sender
 * when present, else From) AFTER the SLA inbound's date, and attaches the
 * matches as `cross_thread_replies`. Resolver treats those as additional
 * candidate replies under the same 4-guard rule, so cases where the team
 * replied in a different thread (Zendesk new-ticket, accounting fork) no
 * longer surface as fake stale breaches.
 */
export async function fetchSlaThreads(options: {
  ledgerPath: string;
  dryRun?: boolean;
  credentialsPath?: string;
  teamDomains?: Set<string>;
  ledgerReceivedAtByMid?: Map<string, string>;
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
        metadataHeaders: ["From", "To", "Date", "Auto-Submitted", "X-Original-Sender", "Reply-To"],
      });

      const threadId = msg.data.threadId;
      if (!threadId) continue;

      // Fetch all messages in the thread
      const thread = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: ["From", "To", "Date", "Auto-Submitted", "X-Original-Sender", "Reply-To"],
      });

      const threadMessages: SlaThreadMessage[] = [];
      let slaInbound: SlaThreadMessage | undefined;
      for (const m of thread.data.messages || []) {
        const headers = m.payload?.headers || [];
        const header = (name: string): string =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

        const autoSubmittedRaw = header("Auto-Submitted");
        const xOrigSender = header("X-Original-Sender");
        const replyTo = header("Reply-To");
        const tm: SlaThreadMessage = {
          ...(m.id ? { message_id: m.id } : {}),
          from: header("From"),
          to: header("To"),
          date: header("Date"),
          auto_submitted: autoSubmittedRaw === "" ? null : autoSubmittedRaw,
          x_original_sender: xOrigSender === "" ? null : xOrigSender,
          reply_to: replyTo === "" ? null : replyTo,
        };
        threadMessages.push(tm);
        if (m.id === msgId) slaInbound = tm;
      }

      let crossThreadReplies: SlaThreadMessage[] | undefined;
      if (options.teamDomains && options.teamDomains.size > 0 && slaInbound) {
        const realExternal =
          extractAddressLocal(slaInbound.x_original_sender) ||
          extractAddressLocal(slaInbound.reply_to) ||
          extractAddressLocal(slaInbound.from);
        const ledgerReceivedAt =
          options.ledgerReceivedAtByMid?.get(msgId) ?? slaInbound.date;
        const sameThreadIds = new Set(
          threadMessages
            .map((m) => m.message_id)
            .filter((id): id is string => !!id),
        );
        crossThreadReplies = await fetchCrossThreadReplies(
          gmail,
          realExternal,
          ledgerReceivedAt,
          options.teamDomains,
          sameThreadIds,
        );
      }

      threads.push({
        message_id: msgId,
        gmail_thread_id: threadId,
        thread_messages: threadMessages,
        ...(crossThreadReplies && crossThreadReplies.length > 0
          ? { cross_thread_replies: crossThreadReplies }
          : {}),
      });
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
