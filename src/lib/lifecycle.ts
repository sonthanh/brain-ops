import type { gmail_v1 } from "@googleapis/gmail";
import type { DraftLedgerRow } from "./ledger.ts";
import { hashBody } from "./ledger.ts";
import type { Identities } from "./identities.ts";
import type { LearningEntry } from "./learnings.ts";

export interface LifecycleCheckOptions {
  ledgerRows: DraftLedgerRow[];
  gmail: gmail_v1.Gmail;
  identities: Identities;
  now: Date;
  staleDays?: number;
}

export interface LifecycleCheckResult {
  classifySignals: LearningEntry[];
  draftSignals: LearningEntry[];
  processedDraftIds: string[];
  orphanDraftsDeleted: string[];
}

const DEFAULT_STALE_DAYS = 14;
const EXCERPT_CAP = 300;
const LEDGER_TS_RE = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+UTC$/;

function parseSenderEmail(fromHeader: string): string {
  const angle = fromHeader.match(/<([^>]+)>/);
  const addr = angle && angle[1] ? angle[1] : fromHeader;
  return addr.trim().toLowerCase();
}

function classifySender(
  email: string,
  identities: Identities,
): "me" | "team" | "external" {
  if (identities.me.has(email)) return "me";
  const atIdx = email.indexOf("@");
  if (atIdx < 0) return "external";
  const domain = email.slice(atIdx + 1);
  if (identities.teamDomains.has(domain)) return "team";
  return "external";
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  const data = payload.body?.data;
  if (typeof data === "string" && data.length > 0) {
    return Buffer.from(data, "base64url").toString("utf-8");
  }
  const parts = payload.parts ?? [];
  for (const p of parts) {
    if (p.mimeType === "text/plain") {
      const pd = p.body?.data;
      if (typeof pd === "string" && pd.length > 0) {
        return Buffer.from(pd, "base64url").toString("utf-8");
      }
    }
  }
  for (const p of parts) {
    const nested = extractBody(p);
    if (nested) return nested;
  }
  return "";
}

function truncate(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) : s;
}

function parseLedgerCreatedAt(s: string): number {
  const m = s.match(LEDGER_TS_RE);
  if (!m) return NaN;
  return Date.UTC(
    parseInt(m[1]!, 10),
    parseInt(m[2]!, 10) - 1,
    parseInt(m[3]!, 10),
    parseInt(m[4]!, 10),
    parseInt(m[5]!, 10),
  );
}

function formatUtc(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

type DraftState = { alive: true; body: string } | { alive: false };

async function fetchDraftState(
  gmail: gmail_v1.Gmail,
  draftId: string,
): Promise<DraftState> {
  try {
    const res = await gmail.users.drafts.get({ userId: "me", id: draftId, format: "full" });
    const body = extractBody(res.data.message?.payload ?? undefined);
    return { alive: true, body };
  } catch (e: unknown) {
    const code = (e as { code?: number }).code;
    if (code === 404) return { alive: false };
    throw e;
  }
}

interface ClassifiedMessage {
  id: string;
  from: string;
  classification: "me" | "team" | "external";
  body: string;
  dateMs: number;
}

async function fetchThreadMessagesAfter(
  gmail: gmail_v1.Gmail,
  threadId: string,
  afterMs: number,
  identities: Identities,
): Promise<ClassifiedMessage[]> {
  let messages: gmail_v1.Schema$Message[] = [];
  try {
    const res = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });
    messages = res.data.messages ?? [];
  } catch {
    return [];
  }

  const out: ClassifiedMessage[] = [];
  for (const m of messages) {
    // Gmail returns live drafts in threads.get with labelIds=["DRAFT"]. They
    // are not sent messages — ignore them or we misclassify the draft's own
    // body as a me-reply, match the hash (it IS the draft body), and emit a
    // spurious sent-as-is signal. Real-world regression caught 2026-04-22.
    if (m.labelIds?.includes("DRAFT")) continue;
    const dateStr = m.internalDate;
    const dateMs = typeof dateStr === "string" ? parseInt(dateStr, 10) : 0;
    if (Number.isNaN(afterMs) || dateMs <= afterMs) continue;
    const headers = m.payload?.headers ?? [];
    const fromHeader = headers.find((h) => h.name === "From")?.value ?? "";
    const sender = parseSenderEmail(fromHeader);
    out.push({
      id: m.id ?? "",
      from: sender,
      classification: classifySender(sender, identities),
      body: extractBody(m.payload ?? undefined),
      dateMs,
    });
  }
  return out;
}

export async function checkLifecycle(
  opts: LifecycleCheckOptions,
): Promise<LifecycleCheckResult> {
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const staleThresholdMs = staleDays * 24 * 60 * 60 * 1000;
  const nowMs = opts.now.getTime();
  const observedAt = formatUtc(opts.now);

  const classifySignals: LearningEntry[] = [];
  const draftSignals: LearningEntry[] = [];
  const processedDraftIds: string[] = [];
  const orphanDraftsDeleted: string[] = [];

  for (const row of opts.ledgerRows) {
    const createdAtMs = parseLedgerCreatedAt(row.createdAt);
    const draftState = await fetchDraftState(opts.gmail, row.draftId);
    const draftBody = draftState.alive ? draftState.body : undefined;
    const replies = await fetchThreadMessagesAfter(
      opts.gmail,
      row.threadId,
      createdAtMs,
      opts.identities,
    );

    const meReply = replies.find((r) => r.classification === "me");
    const teamReply = replies.find((r) => r.classification === "team");

    const base = {
      threadId: row.threadId,
      subject: row.subject,
      sender: row.sender,
      observedAt,
    };

    async function deleteOrphanIfAlive(): Promise<void> {
      if (!draftState.alive) return;
      try {
        await opts.gmail.users.drafts.delete({ userId: "me", id: row.draftId });
        orphanDraftsDeleted.push(row.draftId);
      } catch {
        // Best-effort — a failed delete shouldn't abort the lifecycle sweep.
      }
    }

    if (meReply) {
      const sentHash = hashBody(meReply.body);
      if (sentHash === row.bodyHash) {
        draftSignals.push({ ...base, type: "sent-as-is" });
      } else {
        const edited: LearningEntry = {
          ...base,
          type: "sent-edited",
          sentBodyExcerpt: truncate(meReply.body, EXCERPT_CAP),
        };
        if (draftBody !== undefined) {
          edited.draftBodyExcerpt = truncate(draftBody, EXCERPT_CAP);
        }
        draftSignals.push(edited);
      }
      processedDraftIds.push(row.draftId);
      await deleteOrphanIfAlive();
      continue;
    }

    if (teamReply) {
      classifySignals.push({
        ...base,
        type: "team-handled",
        responder: teamReply.from,
      });
      processedDraftIds.push(row.draftId);
      await deleteOrphanIfAlive();
      continue;
    }

    if (!draftState.alive) {
      classifySignals.push({ ...base, type: "deleted" });
      processedDraftIds.push(row.draftId);
      continue;
    }

    // Draft alive, no me/team reply → stale check (never removes ledger row).
    if (!Number.isNaN(createdAtMs) && nowMs - createdAtMs >= staleThresholdMs) {
      classifySignals.push({ ...base, type: "stale" });
    }
  }

  return { classifySignals, draftSignals, processedDraftIds, orphanDraftsDeleted };
}
