import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface DraftLedgerRow {
  draftId: string;
  threadId: string;
  messageId: string;
  sender: string;
  subject: string;
  bodyHash: string;
  createdAt: string;
}

const HEADER_COLS = [
  "Draft ID",
  "Thread ID",
  "Message ID",
  "Sender",
  "Subject",
  "Body Hash",
  "Created (UTC)",
];
const HEADER_ROW = `| ${HEADER_COLS.join(" | ")} |`;
const SEPARATOR_ROW = `| ${HEADER_COLS.map(() => "---").join(" | ")} |`;

function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function unescapePipe(s: string): string {
  return s.replace(/\\\|/g, "|");
}

const PIPE_PLACEHOLDER = "";

function splitRow(line: string): string[] {
  const inner = line.replace(/^\|/, "").replace(/\|$/, "");
  const masked = inner.replace(/\\\|/g, PIPE_PLACEHOLDER);
  return masked.split("|").map((c) => c.trim().replace(new RegExp(PIPE_PLACEHOLDER, "g"), "|"));
}

const QUOTE_START_RE = /^(?:On .+ wrote:\s*|-+\s*Original Message\s*-+\s*|From: .+)$/;

export function normalizeBody(body: string): string {
  let s = body.replace(/\r\n?/g, "\n");

  const lines = s.split("\n");
  const quoteIdx = lines.findIndex((line) => QUOTE_START_RE.test(line));
  const truncated = quoteIdx >= 0 ? lines.slice(0, quoteIdx) : lines;

  const trimmedLines = truncated.map((l) => l.replace(/[ \t]+$/, ""));
  s = trimmedLines.join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/^\n+|\n+$/g, "");
  return s;
}

export function hashBody(body: string): string {
  const normalized = normalizeBody(body);
  return createHash("sha256").update(normalized, "utf-8").digest("hex").slice(0, 16);
}

export function parseLedger(content: string): DraftLedgerRow[] {
  const lines = content.split("\n");
  let inOpen = false;
  let seenHeader = false;
  const rows: DraftLedgerRow[] = [];
  for (const line of lines) {
    if (/^##\s+Open\s*$/.test(line)) {
      inOpen = true;
      seenHeader = false;
      continue;
    }
    if (inOpen && /^##\s+/.test(line)) {
      inOpen = false;
      continue;
    }
    if (!inOpen) continue;
    if (!line.startsWith("|")) continue;
    if (line.trim().match(/^\|\s*-+/)) continue;
    if (!seenHeader) {
      seenHeader = true;
      continue;
    }
    const cols = splitRow(line).map(unescapePipe);
    if (cols.length < 7) continue;
    rows.push({
      draftId: cols[0]!,
      threadId: cols[1]!,
      messageId: cols[2]!,
      sender: cols[3]!,
      subject: cols[4]!,
      bodyHash: cols[5]!,
      createdAt: cols[6]!,
    });
  }
  return rows;
}

export function serializeLedger(rows: DraftLedgerRow[], updatedAt?: string): string {
  const sorted = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const updated = updatedAt ?? sorted[sorted.length - 1]?.createdAt ?? "";
  const createdDate = updated.slice(0, 10);

  const tableRows = sorted.map((r) => {
    const cells = [
      r.draftId,
      r.threadId,
      r.messageId,
      r.sender,
      r.subject,
      r.bodyHash,
      r.createdAt,
    ].map((c) => escapePipe(c));
    return `| ${cells.join(" | ")} |`;
  });

  return [
    "---",
    "title: Outstanding Drafts",
    `created: ${createdDate}`,
    `updated: ${updated}`,
    "tags: [emails, drafts, ledger]",
    "zone: business",
    "---",
    "",
    "# Outstanding Drafts",
    "",
    `Last computed: ${updated}`,
    `Open: ${sorted.length}`,
    "",
    "## Open",
    HEADER_ROW,
    SEPARATOR_ROW,
    ...tableRows,
    "",
  ].join("\n");
}

export function readLedger(path: string): DraftLedgerRow[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8");
  return parseLedger(content);
}

export function writeLedger(path: string, rows: DraftLedgerRow[], updatedAt?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeLedger(rows, updatedAt), "utf-8");
}

export function mergeLedger(
  existing: DraftLedgerRow[],
  newRows: DraftLedgerRow[],
): DraftLedgerRow[] {
  const byId = new Map<string, DraftLedgerRow>();
  for (const row of existing) byId.set(row.draftId, row);
  for (const row of newRows) byId.set(row.draftId, row);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
