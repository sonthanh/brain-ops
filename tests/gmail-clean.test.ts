import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cleanupEmails } from "../src/gmail-clean.ts";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import type { TriageAction } from "../src/lib/types.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-test");

function writeTriage(actions: TriageAction[]): string {
  mkdirSync(TEST_DIR, { recursive: true });
  const path = join(TEST_DIR, "2026-04-05T10-00.json");
  writeFileSync(path, JSON.stringify(actions));
  return path;
}

describe("gmail-clean", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("dry-run", () => {
    test("reports action counts without calling API", async () => {
      const path = writeTriage([
        { action: "archive", id: "1", from: "a@test.com", subject: "Test 1" },
        { action: "archive", id: "2", from: "b@test.com", subject: "Test 2" },
        { action: "star", id: "3", from: "c@test.com", subject: "Test 3" },
        { action: "needs-reply", id: "4", from: "d@test.com", subject: "Test 4" },
      ]);

      const result = await cleanupEmails({ jsonPath: path, dryRun: true });

      // needs-reply is now included — it stars the message atomically with the
      // downstream Draft step (ai-brain#100).
      expect(result.total).toBe(4);
      expect(result.actions["archive"]).toBe(2);
      expect(result.actions["star"]).toBe(1);
      expect(result.actions["needs-reply"]).toBe(1);
    });

    test("handles empty action list", async () => {
      const path = writeTriage([]);
      const result = await cleanupEmails({ jsonPath: path, dryRun: true });
      expect(result.total).toBe(0);
    });

    test("needs-reply items are processed (starred) — they are no longer filtered out", async () => {
      const path = writeTriage([
        { action: "needs-reply", id: "1", from: "a@test.com", subject: "Reply me" },
      ]);
      const result = await cleanupEmails({ jsonPath: path, dryRun: true });
      expect(result.total).toBe(1);
      expect(result.actions["needs-reply"]).toBe(1);
    });
  });

  test("throws on missing file", async () => {
    expect(
      cleanupEmails({ jsonPath: "/nonexistent/file.json", dryRun: true }),
    ).rejects.toThrow("Not found");
  });

  describe("action parsing", () => {
    test("handles label: prefix actions", async () => {
      const path = writeTriage([
        { action: "label:important-client", id: "1", from: "a@test.com", subject: "Deal" },
        { action: "label:newsletters", id: "2", from: "b@test.com", subject: "Weekly" },
      ]);

      const result = await cleanupEmails({ jsonPath: path, dryRun: true });
      expect(result.actions["label:important-client"]).toBe(1);
      expect(result.actions["label:newsletters"]).toBe(1);
    });

    test("handles all action types in dry-run", async () => {
      const path = writeTriage([
        { action: "archive", id: "1", from: "a@test.com", subject: "A" },
        { action: "delete", id: "2", from: "b@test.com", subject: "B" },
        { action: "star", id: "3", from: "c@test.com", subject: "C" },
        { action: "mark-important", id: "4", from: "d@test.com", subject: "D" },
        { action: "unsubscribe", id: "5", from: "e@test.com", subject: "E" },
        { action: "label:work", id: "6", from: "f@test.com", subject: "F" },
        { action: "needs-reply", id: "7", from: "g@test.com", subject: "G", reply_hint: "confirm" },
        { action: "read", id: "8", from: "h@test.com", subject: "H" },
      ]);

      const result = await cleanupEmails({ jsonPath: path, dryRun: true });
      expect(result.total).toBe(8);
      expect(Object.keys(result.actions)).toHaveLength(8);
    });
  });

  describe("taxonomy fields", () => {
    test("preserves user_category + team_view + user_view when present", async () => {
      const path = writeTriage([
        {
          action: "archive",
          id: "1",
          from: "a@test.com",
          subject: "noise",
          user_category: "noise",
          team_view: "N",
          user_view: "N",
        },
        {
          action: "needs-reply",
          id: "2",
          from: "b@test.com",
          subject: "user must reply",
          reply_hint: "acknowledge",
          user_category: "r-user",
          team_view: "R",
          user_view: "R",
        },
      ]);
      const result = await cleanupEmails({ jsonPath: path, dryRun: true });
      expect(result.total).toBe(2);
      expect(result.actions["archive"]).toBe(1);
      expect(result.actions["needs-reply"]).toBe(1);
    });
  });
});
