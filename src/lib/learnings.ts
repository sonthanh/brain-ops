import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LearningType =
  | "deleted"
  | "sent-as-is"
  | "sent-edited"
  | "team-handled"
  | "stale";

export interface LearningEntry {
  type: LearningType;
  threadId: string;
  subject: string;
  sender: string;
  observedAt: string;
  responder?: string;
  draftBodyExcerpt?: string;
  sentBodyExcerpt?: string;
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
