import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fetchSlaThreads, fetchUnreadEmails } from "../src/gmail-fetch.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-gmail-fetch");

describe("gmail-fetch", () => {
  describe("dry-run", () => {
    test("returns empty array without calling API", async () => {
      const emails = await fetchUnreadEmails({ dryRun: true });
      expect(emails).toEqual([]);
    });

    test("logs dry-run messages", async () => {
      const spy = spyOn(console, "log").mockImplementation(() => {});
      try {
        await fetchUnreadEmails({ dryRun: true });
        const logs = spy.mock.calls.map((args) => args.join(" "));
        expect(logs.some((l) => l.includes("[dry-run]"))).toBe(true);
        expect(logs.some((l) => l.includes("is:unread in:inbox"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("fetchSlaThreads ledger parsing", () => {
    let ledgerPath: string;

    beforeEach(() => {
      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      ledgerPath = join(TEST_DIR, "sla-open.md");
    });

    afterEach(() => {
      rmSync(TEST_DIR, { recursive: true, force: true });
    });

    test("Resolved rows ARE fetched (for re-open detection) AND parser uses col-4 not col-5 for Resolved layout", async () => {
      // Two invariants in one test:
      //   1. Resolved-section message IDs MUST be returned — the resolver's
      //      re-open pass walks `ledger.resolved` and needs thread data
      //      for each. Without these, partners re-engaging on closed
      //      threads (e.g. Kerrie ES filing 2026-05-16: Resolved 08:43 UTC,
      //      Kerrie follow-up 08:47 UTC via accounting@tunebot.io group)
      //      silently stay closed.
      //   2. Parser must use col-4 (not col-5) inside the Resolved section
      //      because the Resolved schema has no `To` column. Earlier bug:
      //      col-5 in Resolved indexes the Received DATE; Gmail then
      //      rejected the "id" with "Invalid id value".
      writeFileSync(ledgerPath, `---
title: SLA Open Items
tags: [emails, sla, ledger]
---

# SLA Open Items

Last computed: 2026-04-23 10:00 UTC
Open: 0 | Breached: 1 (fast: 0, normal: 1, slow: 0)

## Breached
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Overdue | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|---------|--------|----------|
| normal | business | External <ext@x.com> | business@emvn.co | "Q" | msg_real_breached | 2026-04-18 13:15 | 2026-04-22 13:15 | ~1.0 bd | 🟠 breached | team-sla-at-risk |

## Open (within SLA)
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Remaining | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|-----------|--------|----------|

## Resolved (last 7 days, audit trail)
| Tier | Owner | From | Subject | Message ID | Received | Resolved (UTC) | Resolved by |
|------|-------|------|---------|------------|----------|----------------|-------------|
| normal | legal | Counsel <c@x.com> | "Re: Q" | msg_resolved_ok | 2026-04-20 09:00 | 2026-04-22 15:00 UTC | thanh@emvn.co |
`);
      const spy = spyOn(console, "error").mockImplementation(() => {});
      try {
        await fetchSlaThreads({ ledgerPath, dryRun: true });
        const logs = spy.mock.calls.map((a) => a.join(" "));
        // Both Breached row + Resolved row should be fetched (2 threads).
        expect(logs.some((l) => l.includes("Would fetch 2 SLA threads"))).toBe(true);
        // Negative: the Resolved row's Received date must NOT leak in as
        // an ID. The dry-run path doesn't expose the ID list directly,
        // but the count itself (2, not 3) tells us no spurious date got
        // collected.
      } finally {
        spy.mockRestore();
      }
    });
  });
});
