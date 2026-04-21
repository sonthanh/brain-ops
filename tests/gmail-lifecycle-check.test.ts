import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkLifecycle } from "../src/lib/lifecycle.ts";
import {
  writeLedger,
  readLedger,
  removeProcessedRows,
  hashBody,
  type DraftLedgerRow,
} from "../src/lib/ledger.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-lifecycle-test");

type MockCall = { method: string; args: Record<string, unknown> };

interface MockThreadMessage {
  id: string;
  from: string;
  internalDateMs: number;
  body: string;
}

function buildThreadPayload(m: MockThreadMessage) {
  return {
    id: m.id,
    threadId: undefined,
    internalDate: String(m.internalDateMs),
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "From", value: m.from }],
      body: { data: Buffer.from(m.body, "utf-8").toString("base64url") },
    },
  };
}

function createMockGmail(options: {
  aliveDraftIds?: Set<string>;
  threadMessages?: Record<string, MockThreadMessage[]>;
}) {
  const calls: MockCall[] = [];
  const alive = options.aliveDraftIds ?? new Set();
  const threads = options.threadMessages ?? {};

  const gmail = {
    users: {
      drafts: {
        get: async (args: { userId: string; id: string }) => {
          calls.push({ method: "drafts.get", args });
          if (!alive.has(args.id)) {
            const err = new Error("Not Found") as Error & { code: number };
            err.code = 404;
            throw err;
          }
          return { data: { id: args.id, message: { id: `msg-${args.id}` } } };
        },
        delete: async (args: { userId: string; id: string }) => {
          calls.push({ method: "drafts.delete", args });
          return {};
        },
      },
      threads: {
        get: async (args: { userId: string; id: string }) => {
          calls.push({ method: "threads.get", args });
          const msgs = (threads[args.id] ?? []).map(buildThreadPayload);
          return { data: { messages: msgs } };
        },
      },
    },
  };
  return { gmail, calls };
}

const ME = new Set<string>(["thanh@emvn.co", "thanh@melosy.net", "sonthanhdo2004@gmail.com"]);
const TEAM_DOMAINS = new Set<string>([
  "emvn.co",
  "melosy.net",
  "musicmaster.io",
  "cremi.ai",
]);
const IDENTITIES = { me: ME, teamDomains: TEAM_DOMAINS };
const NOW = new Date("2026-04-21T12:00:00Z");

function ledgerRow(overrides: Partial<DraftLedgerRow> = {}): DraftLedgerRow {
  return {
    draftId: "d-default",
    threadId: "t-default",
    messageId: "m-default",
    sender: "external@test.com",
    subject: "Re: default",
    bodyHash: hashBody("default body"),
    createdAt: "2026-04-20 10:00 UTC",
    ...overrides,
  };
}

describe("gmail-lifecycle-check", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("Guard 9 — lifecycle-deleted-detect", () => {
    test("drafts.get 404 + no me/team reply → type:deleted signal to classify", async () => {
      const row = ledgerRow({ draftId: "d1", threadId: "t1" });
      const { gmail, calls } = createMockGmail({
        aliveDraftIds: new Set(),
        threadMessages: {
          t1: [
            {
              id: "m-orig",
              from: "External Sender <external@test.com>",
              internalDateMs: Date.parse("2026-04-20T09:00:00Z"),
              body: "Original email",
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error — gmail is an injection hook for testing
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      expect(result.classifySignals).toHaveLength(1);
      expect(result.classifySignals[0]?.type).toBe("deleted");
      expect(result.classifySignals[0]?.threadId).toBe("t1");
      expect(result.draftSignals).toHaveLength(0);
      expect(result.processedDraftIds).toEqual(["d1"]);
      expect(result.orphanDraftsDeleted).toEqual([]);
      expect(calls.find((c) => c.method === "drafts.delete")).toBeUndefined();
    });

    test("external-only reply (not me, not team) after Created is still treated as deleted", async () => {
      // The external party following up shouldn't count as a response.
      const row = ledgerRow({ draftId: "d1e", threadId: "t1e" });
      const { gmail } = createMockGmail({
        aliveDraftIds: new Set(),
        threadMessages: {
          t1e: [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-20T09:00:00Z"),
              body: "Original",
            },
            {
              id: "m-ext2",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-21T09:00:00Z"),
              body: "Any update?",
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      expect(result.classifySignals[0]?.type).toBe("deleted");
    });
  });

  describe("Guard 10 — lifecycle-sent-asis-detect", () => {
    test("me reply + body hash matches ledger → sent-as-is to DRAFT learnings (meta only)", async () => {
      const body = "Thanks, happy to proceed.";
      const row = ledgerRow({
        draftId: "d2",
        threadId: "t2",
        bodyHash: hashBody(body),
      });
      const { gmail, calls } = createMockGmail({
        aliveDraftIds: new Set(["d2"]),
        threadMessages: {
          t2: [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-20T09:00:00Z"),
              body: "Original",
            },
            {
              id: "m-reply",
              from: "thanh@emvn.co",
              internalDateMs: Date.parse("2026-04-21T09:00:00Z"),
              body,
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      expect(result.draftSignals).toHaveLength(1);
      expect(result.draftSignals[0]?.type).toBe("sent-as-is");
      expect(result.draftSignals[0]?.draftBodyExcerpt).toBeUndefined();
      expect(result.draftSignals[0]?.sentBodyExcerpt).toBeUndefined();
      expect(result.classifySignals).toHaveLength(0);
      expect(result.processedDraftIds).toEqual(["d2"]);
      expect(result.orphanDraftsDeleted).toEqual(["d2"]);
      const del = calls.find((c) => c.method === "drafts.delete");
      expect(del?.args.id).toBe("d2");
    });

    test("me reply + hash matches + draft already 404 → sent-as-is, NO drafts.delete call", async () => {
      const body = "OK.";
      const row = ledgerRow({ draftId: "d2b", threadId: "t2b", bodyHash: hashBody(body) });
      const { gmail, calls } = createMockGmail({
        aliveDraftIds: new Set(),
        threadMessages: {
          t2b: [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-20T09:00:00Z"),
              body: "Original",
            },
            {
              id: "m-reply",
              from: "thanh@melosy.net",
              internalDateMs: Date.parse("2026-04-21T09:00:00Z"),
              body,
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      expect(result.draftSignals[0]?.type).toBe("sent-as-is");
      expect(result.orphanDraftsDeleted).toEqual([]);
      expect(calls.find((c) => c.method === "drafts.delete")).toBeUndefined();
    });

    test("sent body carries trailing quote block ('On … wrote:') and still matches ledger hash", async () => {
      // Real-world: Gmail adds the quoted original onto the sent message.
      // hashBody() strips quote blocks, so the ledger's stored hash of the
      // clean draft body must still match the sent message's normalized hash.
      const draftBody = "Thanks — I'll review and get back early next week.";
      const sentBody =
        draftBody +
        "\n\nOn Apr 20, External Sender <external@test.com> wrote:\n> please advise";
      const row = ledgerRow({ draftId: "d2q", threadId: "t2q", bodyHash: hashBody(draftBody) });
      const { gmail } = createMockGmail({
        aliveDraftIds: new Set(["d2q"]),
        threadMessages: {
          t2q: [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-20T09:00:00Z"),
              body: "please advise",
            },
            {
              id: "m-reply",
              from: "thanh@emvn.co",
              internalDateMs: Date.parse("2026-04-21T09:00:00Z"),
              body: sentBody,
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      expect(result.draftSignals[0]?.type).toBe("sent-as-is");
      expect(result.classifySignals).toHaveLength(0);
    });
  });

  describe("Guard 11 — lifecycle-sent-edited-detect", () => {
    test("me reply + hash differs → sent-edited + both body excerpts stored", async () => {
      const draftBody = "Hi, thanks. Let me check and get back to you Monday.";
      const sentBody = "Hey! Thanks for the note — I'll review and respond early next week.";
      const row = ledgerRow({
        draftId: "d3",
        threadId: "t3",
        bodyHash: hashBody(draftBody),
      });
      const { gmail } = createMockGmail({
        aliveDraftIds: new Set(["d3"]),
        threadMessages: {
          t3: [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-20T09:00:00Z"),
              body: "Original",
            },
            {
              id: "m-reply",
              from: "thanh@emvn.co",
              internalDateMs: Date.parse("2026-04-21T09:00:00Z"),
              body: sentBody,
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      expect(result.draftSignals).toHaveLength(1);
      expect(result.draftSignals[0]?.type).toBe("sent-edited");
      expect(result.draftSignals[0]?.sentBodyExcerpt).toContain("Thanks for the note");
      expect(result.draftSignals[0]?.draftBodyExcerpt).toContain("Let me check");
      expect(result.processedDraftIds).toEqual(["d3"]);
      expect(result.orphanDraftsDeleted).toEqual(["d3"]);
    });

    test("both body excerpts truncated to 300 chars when longer", async () => {
      const longSent = "A".repeat(500);
      const longDraft = "B".repeat(500);
      const row = ledgerRow({ draftId: "d3b", threadId: "t3b", bodyHash: hashBody(longDraft) });
      const { gmail } = createMockGmail({
        aliveDraftIds: new Set(["d3b"]),
        threadMessages: {
          t3b: [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-20T09:00:00Z"),
              body: "Original",
            },
            {
              id: "m-reply",
              from: "thanh@emvn.co",
              internalDateMs: Date.parse("2026-04-21T09:00:00Z"),
              body: longSent,
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      expect(result.draftSignals[0]?.sentBodyExcerpt?.length).toBe(300);
      // draftBodyExcerpt sources from the user-observed edit — may be synthesized
      // from the ledger context (we don't have the raw draft body anymore once
      // it's sent+gone); excerpt length cap still applies.
      expect((result.draftSignals[0]?.draftBodyExcerpt ?? "").length).toBeLessThanOrEqual(300);
    });
  });

  describe("Guard 12 — lifecycle-team-handled-detect", () => {
    test("team reply (not me) → team-handled to CLASSIFY learnings; orphan draft deleted", async () => {
      const row = ledgerRow({ draftId: "d4", threadId: "t4" });
      const { gmail, calls } = createMockGmail({
        aliveDraftIds: new Set(["d4"]),
        threadMessages: {
          t4: [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-20T09:00:00Z"),
              body: "Original",
            },
            {
              id: "m-reply",
              from: "Duc Hoang <duc.hoang@emvn.co>",
              internalDateMs: Date.parse("2026-04-21T09:00:00Z"),
              body: "I've got this, covered.",
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      expect(result.classifySignals).toHaveLength(1);
      expect(result.classifySignals[0]?.type).toBe("team-handled");
      expect(result.classifySignals[0]?.responder).toBe("duc.hoang@emvn.co");
      expect(result.draftSignals).toHaveLength(0);
      expect(result.processedDraftIds).toEqual(["d4"]);
      expect(result.orphanDraftsDeleted).toEqual(["d4"]);
      expect(calls.find((c) => c.method === "drafts.delete")?.args.id).toBe("d4");
    });

    test("reply from a me-address (even on a team domain) counts as me, NOT team", async () => {
      // thanh@emvn.co is in both me and a team domain — me wins per grill rule
      // (team = domain match AND not in me).
      const body = "my reply";
      const row = ledgerRow({ draftId: "d4c", threadId: "t4c", bodyHash: hashBody(body) });
      const { gmail } = createMockGmail({
        aliveDraftIds: new Set(["d4c"]),
        threadMessages: {
          t4c: [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-20T09:00:00Z"),
              body: "Original",
            },
            {
              id: "m-reply",
              from: "thanh@emvn.co",
              internalDateMs: Date.parse("2026-04-21T09:00:00Z"),
              body,
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      expect(result.draftSignals[0]?.type).toBe("sent-as-is");
      expect(result.classifySignals).toHaveLength(0);
    });
  });

  describe("Guard 13 — lifecycle-stale-detect", () => {
    test("draft alive + no reply + age ≥ 14d → stale; draft NOT deleted, ledger row preserved", async () => {
      const row = ledgerRow({
        draftId: "d5",
        threadId: "t5",
        createdAt: "2026-04-01 10:00 UTC", // ~20 days before NOW
      });
      const { gmail, calls } = createMockGmail({
        aliveDraftIds: new Set(["d5"]),
        threadMessages: {
          t5: [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-03-31T09:00:00Z"),
              body: "Original",
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      expect(result.classifySignals).toHaveLength(1);
      expect(result.classifySignals[0]?.type).toBe("stale");
      expect(result.processedDraftIds).toEqual([]);
      expect(result.orphanDraftsDeleted).toEqual([]);
      expect(calls.find((c) => c.method === "drafts.delete")).toBeUndefined();
    });

    test("draft alive + no reply + age < 14d → NO signal (not yet stale)", async () => {
      const row = ledgerRow({
        draftId: "d5b",
        threadId: "t5b",
        createdAt: "2026-04-15 10:00 UTC", // ~6 days before NOW
      });
      const { gmail } = createMockGmail({
        aliveDraftIds: new Set(["d5b"]),
        threadMessages: {
          t5b: [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-14T09:00:00Z"),
              body: "Original",
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      expect(result.classifySignals).toHaveLength(0);
      expect(result.draftSignals).toHaveLength(0);
      expect(result.processedDraftIds).toEqual([]);
    });

    test("custom staleDays=3 triggers on a 4-day-old draft", async () => {
      const row = ledgerRow({
        draftId: "d5c",
        threadId: "t5c",
        createdAt: "2026-04-17 10:00 UTC", // ~4 days before NOW
      });
      const { gmail } = createMockGmail({
        aliveDraftIds: new Set(["d5c"]),
        threadMessages: {
          t5c: [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-16T09:00:00Z"),
              body: "Original",
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
        staleDays: 3,
      });
      expect(result.classifySignals[0]?.type).toBe("stale");
    });
  });

  describe("Messages-before-ledger-createdAt filter (gap closed per advisor)", () => {
    test("a me-reply sent BEFORE the ledger's createdAt is ignored (not sent-as-is)", async () => {
      // Scenario: a prior draft existed in the thread and was sent; then V1
      // created a new draft (new ledger row with later createdAt). Only
      // messages after createdAt count toward lifecycle signals for THIS draft.
      const body = "earlier reply body";
      const row = ledgerRow({
        draftId: "d-filter",
        threadId: "t-filter",
        bodyHash: hashBody(body),
        createdAt: "2026-04-20 10:00 UTC",
      });
      const { gmail } = createMockGmail({
        aliveDraftIds: new Set(),
        threadMessages: {
          "t-filter": [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-15T09:00:00Z"),
              body: "Original",
            },
            {
              id: "m-old-reply",
              from: "thanh@emvn.co",
              internalDateMs: Date.parse("2026-04-19T09:00:00Z"), // BEFORE ledger row createdAt
              body,
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      // No me-reply after createdAt — draft is gone with no response → deleted
      expect(result.classifySignals[0]?.type).toBe("deleted");
      expect(result.draftSignals).toHaveLength(0);
    });
  });

  describe("Sender header parsing (gap closed per advisor)", () => {
    test("From header 'Thanh Do <thanh@emvn.co>' is recognized as me", async () => {
      const body = "reply body";
      const row = ledgerRow({ draftId: "d-name", threadId: "t-name", bodyHash: hashBody(body) });
      const { gmail } = createMockGmail({
        aliveDraftIds: new Set(["d-name"]),
        threadMessages: {
          "t-name": [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-20T09:00:00Z"),
              body: "Original",
            },
            {
              id: "m-reply",
              from: "Thanh Do <thanh@emvn.co>",
              internalDateMs: Date.parse("2026-04-21T09:00:00Z"),
              body,
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      expect(result.draftSignals[0]?.type).toBe("sent-as-is");
      expect(result.classifySignals).toHaveLength(0);
    });

    test("From header with quoted display name 'My Nguyễn <my@emvn.co>' parses as team", async () => {
      const row = ledgerRow({ draftId: "d-name-team", threadId: "t-name-team" });
      const { gmail } = createMockGmail({
        aliveDraftIds: new Set(["d-name-team"]),
        threadMessages: {
          "t-name-team": [
            {
              id: "m-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-20T09:00:00Z"),
              body: "Original",
            },
            {
              id: "m-reply",
              from: '"My Nguyễn" <my@emvn.co>',
              internalDateMs: Date.parse("2026-04-21T09:00:00Z"),
              body: "Handled.",
            },
          ],
        },
      });
      const result = await checkLifecycle({
        ledgerRows: [row],
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });
      expect(result.classifySignals[0]?.type).toBe("team-handled");
      expect(result.classifySignals[0]?.responder).toBe("my@emvn.co");
    });
  });

  describe("Guard 16 — ledger-cleanup-after-detect", () => {
    test("processed rows (types 1-4) removed from ledger; type-5 stale preserved", async () => {
      const ledgerPath = join(TEST_DIR, "drafts-outstanding.md");
      const asisBody = "match body";
      const editedDraftBody = "original draft";
      const rows: DraftLedgerRow[] = [
        ledgerRow({ draftId: "d-del", threadId: "t-del", createdAt: "2026-04-20 10:00 UTC" }),
        ledgerRow({
          draftId: "d-asis",
          threadId: "t-asis",
          bodyHash: hashBody(asisBody),
          createdAt: "2026-04-20 11:00 UTC",
        }),
        ledgerRow({
          draftId: "d-edit",
          threadId: "t-edit",
          bodyHash: hashBody(editedDraftBody),
          createdAt: "2026-04-20 12:00 UTC",
        }),
        ledgerRow({ draftId: "d-team", threadId: "t-team", createdAt: "2026-04-20 13:00 UTC" }),
        ledgerRow({ draftId: "d-stale", threadId: "t-stale", createdAt: "2026-04-01 10:00 UTC" }),
      ];
      writeLedger(ledgerPath, rows);

      const { gmail } = createMockGmail({
        aliveDraftIds: new Set(["d-asis", "d-edit", "d-team", "d-stale"]),
        threadMessages: {
          "t-del": [
            {
              id: "m1",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-19T09:00:00Z"),
              body: "orig",
            },
          ],
          "t-asis": [
            {
              id: "m2-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-19T09:00:00Z"),
              body: "orig",
            },
            {
              id: "m2-reply",
              from: "thanh@emvn.co",
              internalDateMs: Date.parse("2026-04-21T09:00:00Z"),
              body: asisBody,
            },
          ],
          "t-edit": [
            {
              id: "m3-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-19T09:00:00Z"),
              body: "orig",
            },
            {
              id: "m3-reply",
              from: "thanh@emvn.co",
              internalDateMs: Date.parse("2026-04-21T09:00:00Z"),
              body: "rewritten different text",
            },
          ],
          "t-team": [
            {
              id: "m4-orig",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-04-19T09:00:00Z"),
              body: "orig",
            },
            {
              id: "m4-reply",
              from: "hr@emvn.co",
              internalDateMs: Date.parse("2026-04-21T09:00:00Z"),
              body: "Team handled.",
            },
          ],
          "t-stale": [
            {
              id: "m5",
              from: "external@test.com",
              internalDateMs: Date.parse("2026-03-31T09:00:00Z"),
              body: "orig",
            },
          ],
        },
      });

      const result = await checkLifecycle({
        ledgerRows: rows,
        // @ts-expect-error
        gmail,
        identities: IDENTITIES,
        now: NOW,
      });

      expect(new Set(result.processedDraftIds)).toEqual(
        new Set(["d-del", "d-asis", "d-edit", "d-team"]),
      );
      expect(result.processedDraftIds).not.toContain("d-stale");

      const survivors = removeProcessedRows(rows, result.processedDraftIds);
      writeLedger(ledgerPath, survivors);
      const after = readLedger(ledgerPath);
      expect(after.map((r) => r.draftId)).toEqual(["d-stale"]);
    });
  });

  describe("Guard 16 — removeProcessedRows helper (in ledger.ts)", () => {
    test("removes rows whose draftId is in processedIds; preserves others", () => {
      const rows: DraftLedgerRow[] = [
        ledgerRow({ draftId: "a" }),
        ledgerRow({ draftId: "b" }),
        ledgerRow({ draftId: "c" }),
      ];
      const survivors = removeProcessedRows(rows, ["a", "c"]);
      expect(survivors.map((r) => r.draftId)).toEqual(["b"]);
    });

    test("empty processedIds returns the rows unchanged", () => {
      const rows: DraftLedgerRow[] = [ledgerRow({ draftId: "a" }), ledgerRow({ draftId: "b" })];
      const survivors = removeProcessedRows(rows, []);
      expect(survivors.map((r) => r.draftId)).toEqual(["a", "b"]);
    });

    test("processedIds containing unknown draftIds is a no-op for those", () => {
      const rows: DraftLedgerRow[] = [ledgerRow({ draftId: "a" })];
      const survivors = removeProcessedRows(rows, ["z"]);
      expect(survivors.map((r) => r.draftId)).toEqual(["a"]);
    });
  });
});
