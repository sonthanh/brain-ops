/**
 * Plain-text body extraction for the SLA classifiers.
 *
 * Gmail's `snippet` is a ~200-char preview. On 2026-09-26 every "missed ask" in
 * the SLA classifier eval (4 of 4) sat past that cut-off — e.g. a partner's
 * "could you let us know the expected payment date?" — and two rows judged
 * "notification" turned out to be real asks once the full text was read. The
 * classifiers need what the sender actually wrote — without the quoted
 * history, which repeats earlier messages and would blow up the prompt.
 */
import type { gmail_v1 } from "@googleapis/gmail";

/** Per-message cap. Long enough for a real ask; bounds prompt size on 40-email runs. */
export const BODY_MAX_CHARS = 2000;
/** Only the newest messages of a thread carry `body_text`; older ones keep `snippet`. */
export const BODY_MESSAGES_PER_THREAD = 5;

function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf-8");
}

function findPart(
  part: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string,
): gmail_v1.Schema$MessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && !part.filename && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mimeType);
    if (hit) return hit;
  }
  return undefined;
}

const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (m) => HTML_ENTITIES[m] ?? m)
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** The message's own text: text/plain when present, else text/html with markup removed. */
export function extractPlainText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain) return decodeBase64Url(plain.body?.data).replace(/\r\n/g, "\n").trim();
  const html = findPart(payload, "text/html");
  if (html) return htmlToText(decodeBase64Url(html.body?.data).replace(/\r\n/g, "\n"));
  return "";
}

/**
 * Reply-header markers, one per mail client / locale seen in the EMVN inbox.
 * Each matches at a line start; the first match anywhere cuts the text.
 * The "On … wrote:" family allows one wrapped line (Gmail wraps long headers).
 */
const QUOTE_MARKERS: RegExp[] = [
  /^On\b[^\n]{0,300}(?:\n[^\n]{0,300})?\bwrote:[ \t]*$/m, // Gmail / Apple Mail (EN)
  /^Vào\b[^\n]{0,300}(?:\n[^\n]{0,300})?đã viết:[ \t]*$/m, // Gmail (VI)
  /^Le\b[^\n]{0,300}(?:\n[^\n]{0,300})?a écrit\s*:[ \t]*$/m, // Gmail (FR)
  /^Am\b[^\n]{0,300}(?:\n[^\n]{0,300})?schrieb[^\n]*:[ \t]*$/m, // Gmail (DE)
  /^\d{4}년[^\n]{0,300}작성:[ \t]*$/m, // Gmail (KO)
  /^_{8,}[ \t]*\n+(?:From|Từ):/m, // Outlook separator
  /^(?:From|Từ):[^\n]*\n(?:Sent|Date|Gửi):/m, // Outlook / Zendesk / Apple Mail header block
  /^-{2,}[ \t]*(?:Original Message|Forwarded message)[ \t]*-*/im,
];

/** Drop the quoted conversation history, keeping only the newest text the sender wrote. */
export function stripQuotedHistory(text: string): string {
  let cut = text.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  const own = text
    .slice(0, cut)
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
  // A pure forward has nothing above the marker; the forwarded text IS the message.
  if (own.length > 0) return own;
  return text
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
}

/** Final `body_text` value: own text only, blank-line runs collapsed, length-capped. */
export function bodyTextFromPayload(payload: gmail_v1.Schema$MessagePart | undefined): string {
  const text = stripQuotedHistory(extractPlainText(payload)).replace(/\n{3,}/g, "\n\n");
  return text.length > BODY_MAX_CHARS ? `${text.slice(0, BODY_MAX_CHARS)}…` : text;
}

/** Keep `body_text` on the newest BODY_MESSAGES_PER_THREAD messages (input is chronological). */
export function keepBodiesOnLatest<T extends { body_text?: string }>(messages: T[]): T[] {
  const firstKept = Math.max(0, messages.length - BODY_MESSAGES_PER_THREAD);
  return messages.map((m, i) => {
    if (i >= firstKept || m.body_text === undefined) return m;
    const { body_text: _dropped, ...rest } = m;
    return rest as T;
  });
}
