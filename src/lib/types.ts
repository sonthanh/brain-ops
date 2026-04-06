export interface Email {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
}

export type ActionType =
  | "archive"
  | "delete"
  | "star"
  | "mark-important"
  | "unsubscribe"
  | "needs-reply"
  | `label:${string}`;

export interface TriageAction {
  action: ActionType;
  id: string;
  from: string;
  subject: string;
  reply_hint?: string;
}

const VALID_ACTIONS = new Set([
  "archive", "delete", "star", "mark-important", "unsubscribe", "needs-reply",
]);

function isValidAction(value: unknown): value is ActionType {
  if (typeof value !== "string") return false;
  return VALID_ACTIONS.has(value) || value.startsWith("label:");
}

export function parseTriageActions(raw: unknown): TriageAction[] {
  if (!Array.isArray(raw)) {
    throw new Error("Expected array of triage actions");
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Action [${i}]: expected object`);
    }
    const { action, id, from, subject, reply_hint } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id) throw new Error(`Action [${i}]: missing id`);
    if (!isValidAction(action)) throw new Error(`Action [${i}]: invalid action "${action}"`);
    if (typeof from !== "string") throw new Error(`Action [${i}]: missing from`);
    if (typeof subject !== "string") throw new Error(`Action [${i}]: missing subject`);
    return {
      action,
      id,
      from,
      subject,
      ...(typeof reply_hint === "string" ? { reply_hint } : {}),
    };
  });
}

export interface DraftRequest {
  messageId: string;      // original message ID to reply to
  to: string;             // reply recipient
  subject: string;        // reply subject (usually "Re: ...")
  body: string;           // plain text reply body
  threadId?: string;      // Gmail thread ID for proper threading
}

export function parseDraftRequests(raw: unknown): DraftRequest[] {
  if (!Array.isArray(raw)) {
    throw new Error("Expected array of draft requests");
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Draft [${i}]: expected object`);
    }
    const { messageId, to, subject, body, threadId } = item as Record<string, unknown>;
    if (typeof messageId !== "string" || !messageId) throw new Error(`Draft [${i}]: missing messageId`);
    if (typeof to !== "string" || !to) throw new Error(`Draft [${i}]: missing to`);
    if (typeof subject !== "string") throw new Error(`Draft [${i}]: missing subject`);
    if (typeof body !== "string" || !body) throw new Error(`Draft [${i}]: missing body`);
    return {
      messageId,
      to,
      subject,
      body,
      ...(typeof threadId === "string" ? { threadId } : {}),
    };
  });
}

export type ExecutionResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface CleanupStats {
  actions: Record<string, number>;
  skipped: number;
  total: number;
}
