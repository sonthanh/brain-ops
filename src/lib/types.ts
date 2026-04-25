export interface Email {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
  /**
   * Deterministic SLA-tier hint set by `detectSlaPrefilter` before LLM classification.
   * When "none", the classifier MUST assign `sla_tier: none` (skip SLA tracking) —
   * catches mechanical false positives (SaaS-platform automation) that the LLM
   * otherwise mis-tags as `normal`. Absent for everything else.
   */
  sla_prefilter_hint?: "none";
}

export type ActionType =
  | "archive"
  | "delete"
  | "star"
  | "mark-important"
  | "unsubscribe"
  | "needs-reply"
  | "read"
  | `label:${string}`;

export type UserCategory = "r-user" | "team-sla-at-risk" | "awareness" | "noise";
export type TaxonomyView = "R" | "A" | "N";

export interface TriageAction {
  action: ActionType;
  id: string;
  from: string;
  subject: string;
  reply_hint?: string;
  /** Dual-perspective taxonomy (optional for backwards-compat with older JSONs; required
   *  going forward per ai-brain#100). Feeds /status Email Focus filter. */
  user_category?: UserCategory;
  team_view?: TaxonomyView;
  user_view?: TaxonomyView;
}

const VALID_ACTIONS = new Set([
  "archive", "delete", "star", "mark-important", "unsubscribe", "needs-reply", "read",
]);

function isValidAction(value: unknown): value is ActionType {
  if (typeof value !== "string") return false;
  return VALID_ACTIONS.has(value) || value.startsWith("label:");
}

const VALID_CATEGORIES = new Set<UserCategory>([
  "r-user", "team-sla-at-risk", "awareness", "noise",
]);
const VALID_VIEWS = new Set<TaxonomyView>(["R", "A", "N"]);

function isUserCategory(v: unknown): v is UserCategory {
  return typeof v === "string" && VALID_CATEGORIES.has(v as UserCategory);
}

function isTaxonomyView(v: unknown): v is TaxonomyView {
  return typeof v === "string" && VALID_VIEWS.has(v as TaxonomyView);
}

export function parseTriageActions(raw: unknown): TriageAction[] {
  if (!Array.isArray(raw)) {
    throw new Error("Expected array of triage actions");
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Action [${i}]: expected object`);
    }
    const {
      action, id, from, subject, reply_hint,
      user_category, team_view, user_view,
    } = item as Record<string, unknown>;
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
      ...(isUserCategory(user_category) ? { user_category } : {}),
      ...(isTaxonomyView(team_view) ? { team_view } : {}),
      ...(isTaxonomyView(user_view) ? { user_view } : {}),
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

export interface SlaThreadMessage {
  from: string;
  to: string;
  date: string;
  /**
   * Raw value of the `Auto-Submitted` header (null when header absent or empty).
   * Guard #4 in the SLA resolver interprets the string directly — storing a boolean
   * loses information because `"no"` and `"auto-notified"` both mean human-sent but
   * are non-empty strings, while `"auto-replied"` and `"auto-generated"` are the
   * only values that disqualify a reply. See commands/gmail-triage.md §8 step 7d.
   */
  auto_submitted: string | null;
}

export interface SlaThread {
  message_id: string;
  thread_messages: SlaThreadMessage[];
}

/**
 * Tri-state semantic-intent flag emitted by the classifier per ledger row
 * (ai-brain#112). `"true"` → reply is owed by team/user; `"false"` → thread
 * semantically closed (confirmation, fyi, rejection, bulk-brief-not-selected),
 * row routed to `## Auto-suppressed`; `"unknown"` → legacy/pre-migration row,
 * treated as `true` by the resolver until first re-sweep judges it.
 */
export type ReplyOwed = "true" | "false" | "unknown";

export type ExecutionResult =
  | { ok: true }
  | { ok: false; reason: string };

export interface CleanupStats {
  actions: Record<string, number>;
  skipped: number;
  total: number;
}
