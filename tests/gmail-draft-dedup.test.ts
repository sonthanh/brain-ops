import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDrafts } from "../src/gmail-draft.ts";
import { readLedger } from "../src/lib/ledger.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-dedup-test");

function writeDrafts(drafts: Array<{
  messageId: string;
  to: string;
  subject: string;
  body: string;
  threadId?: string;
}>): string {
  mkdirSync(TEST_DIR, { recursive: true });
  const path = join(TEST_DIR, "drafts.json");
  writeFileSync(path, JSON.stringify(drafts));
  return path;
}

// Minimal mock Gmail client — shape matches `gmail_v1.Gmail` usage in gmail-draft.ts
type MockCall = { method: string; args: Record<string, unknown> };

function createMockGmail(options: {
  existingDraftThreadIds?: string[];
  messageHeaders?: Record<string, { messageId: string; references: string; threadId: string }>;
  createShouldFailForMessageIds?: string[];
}) {
  const calls: MockCall[] = [];
  const existing = options.existingDraftThreadIds ?? [];
  const headers = options.messageHeaders ?? {};
  const createFails = new Set(options.createShouldFailForMessageIds ?? []);

  const gmail = {
    users: {
      drafts: {
        list: async (args: { userId: string; maxResults?: number; pageToken?: string }) => {
          calls.push({ method: "drafts.list", args });
          return {
            data: {
              drafts: existing.map((threadId, i) => ({
                id: `existing-${i}`,
                message: { id: `msg-${i}`, threadId },
              })),
              nextPageToken: undefined,
            },
          };
        },
        create: async (args: {
          userId: string;
          requestBody: { message: { raw: string; threadId?: string } };
        }) => {
          calls.push({ method: "drafts.create", args });
          // Decode threadId to see which message we're creating for (by extracting from raw)
          const raw = args.requestBody.message.raw;
          const decoded = Buffer.from(raw, "base64url").toString("utf-8");
          const failing = [...createFails].find((mid) => decoded.includes(mid));
          if (failing) {
            throw new Error(`simulated failure for messageId context`);
          }
          return {
            data: {
              id: `draft-created-${calls.length}`,
              message: {
                id: `msg-${calls.length}`,
                threadId: args.requestBody.message.threadId,
              },
            },
          };
        },
      },
      messages: {
        get: async (args: { userId: string; id: string }) => {
          calls.push({ method: "messages.get", args });
          const h = headers[args.id] ?? {
            messageId: `<${args.id}@test>`,
            references: "",
            threadId: `thread-for-${args.id}`,
          };
          return {
            data: {
              threadId: h.threadId,
              payload: {
                headers: [
                  { name: "Message-ID", value: h.messageId },
                  { name: "References", value: h.references },
                ],
              },
            },
          };
        },
      },
    },
  };
  return { gmail, calls };
}

describe("gmail-draft dedup + ledger", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("T1 — dedup-skip-existing", () => {
    test("skips create when draft exists in same thread", async () => {
      const jsonPath = writeDrafts([
        { messageId: "m1", to: "x@y.com", subject: "Re: test", body: "Hi." },
      ]);
      const ledgerPath = join(TEST_DIR, "drafts-outstanding.md");
      const { gmail, calls } = createMockGmail({
        existingDraftThreadIds: ["thread-for-m1"],
      });

      const result = await createDrafts({
        jsonPath,
        ledgerPath,
        // @ts-expect-error — gmailClient is an injection hook for testing
        gmailClient: gmail,
      });

      expect(result).toEqual({ created: 0, skipped: 1, failed: 0 });
      const createCalls = calls.filter((c) => c.method === "drafts.create");
      expect(createCalls).toHaveLength(0);
    });
  });

  describe("T2 — dedup-create-when-absent", () => {
    test("creates draft when no existing draft in thread", async () => {
      const jsonPath = writeDrafts([
        { messageId: "m1", to: "x@y.com", subject: "Re: test", body: "Hi." },
      ]);
      const ledgerPath = join(TEST_DIR, "drafts-outstanding.md");
      const { gmail, calls } = createMockGmail({
        existingDraftThreadIds: ["thread-for-OTHER"],
      });

      const result = await createDrafts({
        jsonPath,
        ledgerPath,
        // @ts-expect-error — gmailClient is an injection hook for testing
        gmailClient: gmail,
      });

      expect(result).toEqual({ created: 1, skipped: 0, failed: 0 });
      const createCalls = calls.filter((c) => c.method === "drafts.create");
      expect(createCalls).toHaveLength(1);
    });
  });

  describe("T3 — ledger-write-success-only", () => {
    test("ledger contains only successful drafts; failed ones excluded", async () => {
      const jsonPath = writeDrafts([
        { messageId: "m1", to: "a@x.com", subject: "Re: A", body: "A body" },
        { messageId: "m2", to: "b@x.com", subject: "Re: B", body: "B body" },
        { messageId: "m3", to: "c@x.com", subject: "Re: C", body: "C body" },
      ]);
      const ledgerPath = join(TEST_DIR, "drafts-outstanding.md");
      const { gmail } = createMockGmail({
        createShouldFailForMessageIds: ["B body"],
      });

      const result = await createDrafts({
        jsonPath,
        ledgerPath,
        // @ts-expect-error — gmailClient is an injection hook for testing
        gmailClient: gmail,
      });

      expect(result.failed).toBe(1);
      expect(result.created).toBe(2);

      const ledgerRows = readLedger(ledgerPath);
      expect(ledgerRows).toHaveLength(2);
      const senders = ledgerRows.map((r) => r.sender).sort();
      expect(senders).toEqual(["a@x.com", "c@x.com"]);
    });
  });

  describe("T4 — ledger-merge-existing (integration via createDrafts)", () => {
    test("existing ledger rows preserved; new ones added", async () => {
      const ledgerPath = join(TEST_DIR, "drafts-outstanding.md");
      // Pre-seed ledger with 1 existing row via a dry-run write
      const { writeLedger } = await import("../src/lib/ledger.ts");
      writeLedger(
        ledgerPath,
        [
          {
            draftId: "preexisting-1",
            threadId: "thread-preexisting",
            messageId: "msg-preexisting",
            sender: "old@x.com",
            subject: "Old",
            bodyHash: "old00000000000aa",
            createdAt: "2026-04-20 10:00 UTC",
          },
        ],
        "2026-04-20 10:00 UTC",
      );

      const jsonPath = writeDrafts([
        { messageId: "m-new", to: "new@x.com", subject: "Re: new", body: "New body" },
      ]);
      const { gmail } = createMockGmail({});

      await createDrafts({
        jsonPath,
        ledgerPath,
        // @ts-expect-error — gmailClient is an injection hook for testing
        gmailClient: gmail,
      });

      const rows = readLedger(ledgerPath);
      expect(rows).toHaveLength(2);
      const senders = rows.map((r) => r.sender).sort();
      expect(senders).toEqual(["new@x.com", "old@x.com"]);
    });
  });

  describe("T8 — action-input-ledger-path", () => {
    test("action.yml declares drafts-ledger-path input with default", () => {
      const yml = require("node:fs").readFileSync(
        join(import.meta.dir, "..", "actions", "gmail-draft", "action.yml"),
        "utf-8",
      );
      expect(yml).toContain("drafts-ledger-path:");
      expect(yml).toContain("business/intelligence/emails/drafts-outstanding.md");
    });

    test("action.yml passes DRAFTS_LEDGER_PATH env var to CLI", () => {
      const yml = require("node:fs").readFileSync(
        join(import.meta.dir, "..", "actions", "gmail-draft", "action.yml"),
        "utf-8",
      );
      expect(yml).toContain("DRAFTS_LEDGER_PATH");
    });
  });
});
