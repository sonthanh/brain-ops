import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LearningType =
  | "deleted"
  | "sent-as-is"
  | "sent-edited"
  | "team-handled"
  | "stale"
  /**
   * SLA false positive captured retroactively: a row the resolver could not
   * close via guard evidence, that the user manually moved to `## Resolved`
   * (or routed to `## Auto-suppressed`) with a `user-asserted ...` note.
   * Each entry tells the next classify run that this thread / sender pattern
   * should be skipped from SLA tracking up-front. Emitted by sla-refresh; the
   * classifier loads the file each pre-classify run. See ai-brain /audit
   * 2026-05-16 finding B (P5 cause-layer: stop re-asking the same threads).
   */
  | "sla-false-positive";

export interface LearningEntry {
  type: LearningType;
  threadId: string;
  subject: string;
  sender: string;
  observedAt: string;
  responder?: string;
  draftBodyExcerpt?: string;
  sentBodyExcerpt?: string;
  /**
   * Verbatim audit reason copied from the ledger cell that anchored the
   * false-positive judgement — `resolvedBy` for Resolved rows,
   * `replyReason` (cells[12]) for Auto-suppressed rows. Surfaced so the
   * classifier prompt can extract the pattern (`team-handled out-of-band`,
   * `Zendesk auto-generated echo`, etc.) without re-reading the ledger.
   * Present only for `sla-false-positive`; absent on lifecycle types.
   */
  reason?: string;
}

const MAX_BYTES = 8192;
const SEPARATOR = "\n---\n";
const HEADER_PREFIX = [
  "# Gmail Learnings",
  "<!-- Append-only log. One JSON entry per line after the `---` separator below. -->",
  "<!-- FIFO 8KB cap — oldest entries are dropped automatically when the file exceeds the cap. -->",
].join("\n");

function composeFile(entries: string[]): string {
  return HEADER_PREFIX + SEPARATOR + entries.join("\n") + (entries.length ? "\n" : "");
}

function splitFile(content: string): string[] {
  const idx = content.indexOf(SEPARATOR);
  if (idx < 0) return [];
  const body = content.slice(idx + SEPARATOR.length);
  return body.split("\n").filter((l) => l.trim().length > 0);
}

export function readLearnings(path: string): LearningEntry[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8");
  const lines = splitFile(content);
  const entries: LearningEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as LearningEntry;
      entries.push(parsed);
    } catch {
      // skip malformed lines — forward-compatible with future field tweaks
    }
  }
  return entries;
}

export function appendLearning(path: string, entry: LearningEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  const existing: string[] = existsSync(path) ? splitFile(readFileSync(path, "utf-8")) : [];
  existing.push(JSON.stringify(entry));

  // FIFO drop oldest until ≤ cap; never drop the entry we just added
  let output = composeFile(existing);
  while (Buffer.byteLength(output, "utf-8") > MAX_BYTES && existing.length > 1) {
    existing.shift();
    output = composeFile(existing);
  }

  writeFileSync(path, output, "utf-8");
}

/**
 * Append-if-absent variant. Skips writing when an entry with the same
 * `threadId` AND `type` already exists in the file. Returns `true` when the
 * entry was appended, `false` when a duplicate suppressed the write.
 *
 * Used by sla-refresh to emit `sla-false-positive` events idempotently across
 * runs. The classifier reads each run and would otherwise see the same row
 * re-emitted every refresh tick — the 8KB cap is non-negotiable, dedup is the
 * cap-protection for high-frequency event types.
 */
export function appendLearningIfAbsent(
  path: string,
  entry: LearningEntry,
): boolean {
  if (existsSync(path)) {
    const lines = splitFile(readFileSync(path, "utf-8"));
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Partial<LearningEntry>;
        if (parsed.threadId === entry.threadId && parsed.type === entry.type) {
          return false;
        }
      } catch {
        // skip malformed lines (forward-compatible with future field tweaks)
      }
    }
  }
  appendLearning(path, entry);
  return true;
}
