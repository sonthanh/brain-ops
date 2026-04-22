import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  appendLearning,
  readLearnings,
  type LearningEntry,
} from "../src/lib/learnings.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-learnings-test");
const LEARNINGS_MAX_BYTES = 8192;

function makeEntry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    type: "deleted",
    threadId: "t-default",
    subject: "Re: default",
    sender: "external@test.com",
    observedAt: "2026-04-21 12:00 UTC",
    ...overrides,
  };
}

describe("learnings store (append + FIFO 8KB cap)", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("round-trip (append → read)", () => {
    test("single entry round-trips via readLearnings", () => {
      const path = join(TEST_DIR, "learnings.md");
      const entry = makeEntry({ type: "deleted", threadId: "t1" });
      appendLearning(path, entry);
      const rows = readLearnings(path);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("deleted");
      expect(rows[0]?.threadId).toBe("t1");
    });

    test("multiple entries round-trip preserving order", () => {
      const path = join(TEST_DIR, "learnings.md");
      appendLearning(path, makeEntry({ threadId: "t1", observedAt: "2026-04-21 10:00 UTC" }));
      appendLearning(path, makeEntry({ threadId: "t2", observedAt: "2026-04-21 11:00 UTC" }));
      appendLearning(path, makeEntry({ threadId: "t3", observedAt: "2026-04-21 12:00 UTC" }));
      const rows = readLearnings(path);
      expect(rows.map((r) => r.threadId)).toEqual(["t1", "t2", "t3"]);
    });

    test("sent-edited entry preserves both draft + sent body excerpts", () => {
      const path = join(TEST_DIR, "learnings.md");
      appendLearning(
        path,
        makeEntry({
          type: "sent-edited",
          threadId: "t-edit",
          draftBodyExcerpt: "original draft text here",
          sentBodyExcerpt: "final sent text here",
        }),
      );
      const rows = readLearnings(path);
      expect(rows[0]?.draftBodyExcerpt).toBe("original draft text here");
      expect(rows[0]?.sentBodyExcerpt).toBe("final sent text here");
    });

    test("team-handled entry preserves responder", () => {
      const path = join(TEST_DIR, "learnings.md");
      appendLearning(
        path,
        makeEntry({
          type: "team-handled",
          threadId: "t-team",
          responder: "duc.hoang@emvn.co",
        }),
      );
      const rows = readLearnings(path);
      expect(rows[0]?.type).toBe("team-handled");
      expect(rows[0]?.responder).toBe("duc.hoang@emvn.co");
    });
  });

  describe("Guard 20 — retention-8kb-cap (FIFO oldest-drop)", () => {
    test("file stays ≤ 8192 bytes after a single small append", () => {
      const path = join(TEST_DIR, "learnings.md");
      appendLearning(path, makeEntry());
      expect(statSync(path).size).toBeLessThanOrEqual(LEARNINGS_MAX_BYTES);
    });

    test("heavy append sequence caps file at ≤ 8192 bytes", () => {
      const path = join(TEST_DIR, "learnings.md");
      const big = "x".repeat(300);
      for (let i = 0; i < 40; i++) {
        appendLearning(
          path,
          makeEntry({
            type: "sent-edited",
            threadId: `thread-${String(i).padStart(3, "0")}`,
            subject: `subject-${i}`,
            sender: `s${i}@test.com`,
            draftBodyExcerpt: big,
            sentBodyExcerpt: big,
            observedAt: `2026-04-21 ${String(i % 24).padStart(2, "0")}:00 UTC`,
          }),
        );
      }
      const finalSize = statSync(path).size;
      expect(finalSize).toBeLessThanOrEqual(LEARNINGS_MAX_BYTES);
    });

    test("FIFO drops OLDEST entries first (thread-000 gone, most recent kept)", () => {
      const path = join(TEST_DIR, "learnings.md");
      const big = "x".repeat(300);
      for (let i = 0; i < 40; i++) {
        appendLearning(
          path,
          makeEntry({
            type: "sent-edited",
            threadId: `thread-${String(i).padStart(3, "0")}`,
            draftBodyExcerpt: big,
            sentBodyExcerpt: big,
            observedAt: `2026-04-21 ${String(i % 24).padStart(2, "0")}:00 UTC`,
          }),
        );
      }
      const rows = readLearnings(path);
      const threadIds = rows.map((r) => r.threadId);
      expect(threadIds).toContain("thread-039");
      expect(threadIds).not.toContain("thread-000");
      expect(threadIds).not.toContain("thread-001");
    });

    test("after FIFO drops, file is still round-trip parseable", () => {
      const path = join(TEST_DIR, "learnings.md");
      const big = "x".repeat(300);
      for (let i = 0; i < 40; i++) {
        appendLearning(
          path,
          makeEntry({
            type: "sent-edited",
            threadId: `thread-${String(i).padStart(3, "0")}`,
            draftBodyExcerpt: big,
            sentBodyExcerpt: big,
            observedAt: `2026-04-21 ${String(i % 24).padStart(2, "0")}:00 UTC`,
          }),
        );
      }
      const rows = readLearnings(path);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(40);
      // Each survivor has its core fields intact
      for (const r of rows) {
        expect(r.type).toBe("sent-edited");
        expect(r.threadId).toMatch(/^thread-\d{3}$/);
        expect(r.draftBodyExcerpt?.length).toBe(300);
      }
    });

  });
});
