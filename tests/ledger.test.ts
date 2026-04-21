import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeBody,
  hashBody,
  parseLedger,
  serializeLedger,
  readLedger,
  writeLedger,
  mergeLedger,
  type DraftLedgerRow,
} from "../src/lib/ledger.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-ledger-test");

describe("ledger", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("hash-normalization (T6)", () => {
    test("same body with different trailing whitespace produces same hash", () => {
      const a = "Hi there.\r\n";
      const b = "Hi there.   \n\n\n";
      expect(hashBody(a)).toBe(hashBody(b));
      expect(hashBody(a)).not.toBe("");
    });

    test("CRLF and LF normalized", () => {
      expect(hashBody("line1\r\nline2\r\n")).toBe(hashBody("line1\nline2\n"));
    });

    test("hash is 16 lowercase hex chars", () => {
      const h = hashBody("some content");
      expect(h).toMatch(/^[0-9a-f]{16}$/);
    });

    test("preserves case", () => {
      expect(hashBody("URGENT")).not.toBe(hashBody("urgent"));
    });
  });

  describe("hash-strips-quotes (T7)", () => {
    test("'On X wrote:' quote block stripped", () => {
      const withQuote =
        "Thanks for the note.\n\nOn Apr 20, John Doe <john@example.com> wrote:\n> old text";
      const withoutQuote = "Thanks for the note.";
      expect(hashBody(withQuote)).toBe(hashBody(withoutQuote));
    });

    test("'-----Original Message-----' quote block stripped", () => {
      const withQuote =
        "OK.\n\n-----Original Message-----\nFrom: someone\nSubject: blah\n\n> quoted";
      const withoutQuote = "OK.";
      expect(hashBody(withQuote)).toBe(hashBody(withoutQuote));
    });
  });

  describe("normalizeBody direct behavior", () => {
    test("collapses 3+ blank lines to 2", () => {
      const input = "a\n\n\n\n\nb";
      const normalized = normalizeBody(input);
      expect(normalized).toBe("a\n\nb");
    });

    test("strips trailing whitespace per line", () => {
      expect(normalizeBody("hello   \nworld\t  ")).toBe("hello\nworld");
    });
  });

  describe("ledger-schema-format (T5)", () => {
    test("round-trip: serialize then parse returns same rows", () => {
      const rows: DraftLedgerRow[] = [
        {
          draftId: "r-abc123",
          threadId: "19d8fe000001",
          messageId: "19d8fe000002",
          sender: "chris@fnmpg.com",
          subject: "Re: Posthaste",
          bodyHash: "ab34cd0011223344",
          createdAt: "2026-04-21 16:30 UTC",
        },
        {
          draftId: "r-def456",
          threadId: "19d8fe000003",
          messageId: "19d8fe000004",
          sender: "alex@melosy.net",
          subject: "Potential fit",
          bodyHash: "ff11ee2200334455",
          createdAt: "2026-04-21 17:30 UTC",
        },
      ];
      const ser = serializeLedger(rows, "2026-04-21 17:30 UTC");
      const parsed = parseLedger(ser);
      expect(parsed).toEqual(rows);
    });

    test("serialized ledger contains required header row", () => {
      const rows: DraftLedgerRow[] = [];
      const ser = serializeLedger(rows, "2026-04-21 17:30 UTC");
      expect(ser).toContain("| Draft ID | Thread ID |");
      expect(ser).toContain("# Outstanding Drafts");
      expect(ser).toMatch(/^---\n/);
    });

    test("subjects with pipe chars round-trip without corruption", () => {
      const rows: DraftLedgerRow[] = [
        {
          draftId: "d1",
          threadId: "t1",
          messageId: "m1",
          sender: "x@y.com",
          subject: "Re: a | b | c",
          bodyHash: "0123456789abcdef",
          createdAt: "2026-04-21 16:30 UTC",
        },
      ];
      const parsed = parseLedger(serializeLedger(rows));
      expect(parsed[0]?.subject).toBe("Re: a | b | c");
    });

    test("parse returns empty array for missing ## Open section", () => {
      expect(parseLedger("# Something else\n\nno table here")).toEqual([]);
    });
  });

  describe("ledger-merge-existing (T4)", () => {
    test("merge adds new rows to existing, no duplicates by draftId", () => {
      const existing: DraftLedgerRow[] = [
        {
          draftId: "A",
          threadId: "t1",
          messageId: "m1",
          sender: "a@x.com",
          subject: "A",
          bodyHash: "aaaa000011112222",
          createdAt: "2026-04-20 10:00 UTC",
        },
        {
          draftId: "B",
          threadId: "t2",
          messageId: "m2",
          sender: "b@x.com",
          subject: "B",
          bodyHash: "bbbb000011112222",
          createdAt: "2026-04-20 11:00 UTC",
        },
      ];
      const newRows: DraftLedgerRow[] = [
        {
          draftId: "C",
          threadId: "t3",
          messageId: "m3",
          sender: "c@x.com",
          subject: "C",
          bodyHash: "cccc000011112222",
          createdAt: "2026-04-21 12:00 UTC",
        },
      ];
      const merged = mergeLedger(existing, newRows);
      expect(merged).toHaveLength(3);
      expect(merged.map((r) => r.draftId).sort()).toEqual(["A", "B", "C"]);
    });

    test("merge de-dupes on draftId collision — new row wins", () => {
      const existing: DraftLedgerRow[] = [
        {
          draftId: "A",
          threadId: "t1",
          messageId: "m1",
          sender: "a@x.com",
          subject: "Old",
          bodyHash: "old0000000000000",
          createdAt: "2026-04-20 10:00 UTC",
        },
      ];
      const newRows: DraftLedgerRow[] = [
        {
          draftId: "A",
          threadId: "t1",
          messageId: "m1",
          sender: "a@x.com",
          subject: "New",
          bodyHash: "new0000000000000",
          createdAt: "2026-04-21 10:00 UTC",
        },
      ];
      const merged = mergeLedger(existing, newRows);
      expect(merged).toHaveLength(1);
      expect(merged[0]?.subject).toBe("New");
      expect(merged[0]?.bodyHash).toBe("new0000000000000");
    });

    test("merged rows sorted by createdAt ascending", () => {
      const existing: DraftLedgerRow[] = [
        {
          draftId: "Z",
          threadId: "tZ",
          messageId: "mZ",
          sender: "z@x.com",
          subject: "Z",
          bodyHash: "zzzz000011112222",
          createdAt: "2026-04-21 15:00 UTC",
        },
      ];
      const newRows: DraftLedgerRow[] = [
        {
          draftId: "A",
          threadId: "tA",
          messageId: "mA",
          sender: "a@x.com",
          subject: "A",
          bodyHash: "aaaa000011112222",
          createdAt: "2026-04-21 10:00 UTC",
        },
      ];
      const merged = mergeLedger(existing, newRows);
      expect(merged.map((r) => r.draftId)).toEqual(["A", "Z"]);
    });
  });

  describe("readLedger / writeLedger I/O", () => {
    test("readLedger returns [] for missing file", () => {
      const path = join(TEST_DIR, "does-not-exist.md");
      expect(readLedger(path)).toEqual([]);
    });

    test("writeLedger + readLedger round-trips rows", () => {
      const path = join(TEST_DIR, "sub", "ledger.md");
      const rows: DraftLedgerRow[] = [
        {
          draftId: "X",
          threadId: "tX",
          messageId: "mX",
          sender: "x@y.com",
          subject: "Re: test",
          bodyHash: "abcdef0123456789",
          createdAt: "2026-04-21 16:30 UTC",
        },
      ];
      writeLedger(path, rows, "2026-04-21 16:30 UTC");
      expect(existsSync(path)).toBe(true);
      expect(readLedger(path)).toEqual(rows);
    });
  });
});
