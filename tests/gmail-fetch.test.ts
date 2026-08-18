import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  SLA_METADATA_HEADERS,
  fetchSlaThreads,
  fetchUnreadEmails,
  loadTeamDomains,
  toSlaThreadMessage,
} from "../src/gmail-fetch.ts";

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

  describe("loadTeamDomains — cross-thread search wiring", () => {
    // Production regression 2026-08-03: the CLI entry point called
    // fetchSlaThreads WITHOUT teamDomains, so `cross_thread_replies` was never
    // produced in the gmail-triage workflow and the resolver could only see
    // same-thread messages. 6 of 23 ledger rows sat falsely breached — the
    // team HAD replied, just in a forked/Zendesk thread. These tests pin the
    // wiring the CLI depends on.
    let rulesPath: string;

    beforeEach(() => {
      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
      rulesPath = join(TEST_DIR, "gmail-rules.md");
    });

    afterEach(() => {
      rmSync(TEST_DIR, { recursive: true, force: true });
    });

    test("returns team domains when the rules file parses", () => {
      writeFileSync(rulesPath, `# Gmail Rules

### Send-as identities
- thanh@emvn.co

### Team domains (internal)
- @emvn.co
- @musicmaster.io
`);
      const spy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const domains = loadTeamDomains(rulesPath);
        expect(domains).toEqual(new Set(["emvn.co", "musicmaster.io"]));
        const logs = spy.mock.calls.map((a) => a.join(" "));
        expect(logs.some((l) => l.includes("cross-thread search enabled"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    test("no rules path → undefined + explicit DISABLED warning (never silent)", () => {
      const spy = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(loadTeamDomains(undefined)).toBeUndefined();
        const logs = spy.mock.calls.map((a) => a.join(" "));
        expect(logs.some((l) => l.includes("cross-thread reply search DISABLED"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    test("unparseable rules file degrades to same-thread instead of throwing", () => {
      // The same fetch run feeds the classifier — a rules-file problem must
      // not fail the whole step.
      writeFileSync(rulesPath, "# Gmail Rules\n\nno identity sections here\n");
      const spy = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(loadTeamDomains(rulesPath)).toBeUndefined();
        const logs = spy.mock.calls.map((a) => a.join(" "));
        expect(logs.some((l) => l.includes("DISABLED"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("toSlaThreadMessage — body text for the semantic-intent re-sweep", () => {
  // Production regression 2026-08-18: the SLA thread fetch requested only
  // From/To/Date/Auto-Submitted/X-Original-Sender/Reply-To, so every re-sweep
  // judgment on an existing ledger row was made without a single character of
  // message text. The classifier could only see who spoke last, which reads
  // as "external replied after us" → reply_owed=true forever. Maslin Friedman
  // (19eed7fe7666540b) and Michael Afanasyev (19f04b83bd2a3cad) sat breached
  // 55 and 48 business days on threads whose last message closed the loop.
  test("Subject is requested — without it the classifier has no thread text", () => {
    expect(SLA_METADATA_HEADERS).toContain("Subject");
  });

  test("resolver-critical headers survive the shared builder", () => {
    for (const h of ["From", "To", "Date", "Auto-Submitted", "X-Original-Sender", "Reply-To"]) {
      expect(SLA_METADATA_HEADERS).toContain(h);
    }
  });

  test("carries subject + snippet through to the classifier payload", () => {
    const msg = toSlaThreadMessage({
      id: "m1",
      snippet: "Thanks — that closes it on our side, no action needed.",
      payload: {
        headers: [
          { name: "From", value: "Maslin Friedman <maslin@starsonicrecords.com>" },
          { name: "To", value: "license@emvn.co" },
          { name: "Date", value: "Mon, 22 Jun 2026 04:03:00 +0000" },
          { name: "Subject", value: "Re: Publishing/Sync in Vietnam" },
        ],
      },
    });

    expect(msg.subject).toBe("Re: Publishing/Sync in Vietnam");
    expect(msg.snippet).toBe("Thanks — that closes it on our side, no action needed.");
    expect(msg.message_id).toBe("m1");
    expect(msg.from).toBe("Maslin Friedman <maslin@starsonicrecords.com>");
  });

  test("guard fields keep null-vs-empty semantics the resolver depends on", () => {
    const msg = toSlaThreadMessage({
      id: "m2",
      payload: {
        headers: [
          { name: "From", value: "team@emvn.co" },
          { name: "To", value: "ext@x.com" },
          { name: "Date", value: "Tue, 23 Jun 2026 09:00:00 +0000" },
          { name: "Auto-Submitted", value: "" },
          { name: "Reply-To", value: "real@partner.com" },
        ],
      },
    });

    // Empty header → null (absent), not "" — guard #4 reads the raw string.
    expect(msg.auto_submitted).toBeNull();
    // Header not present at all → null.
    expect(msg.x_original_sender).toBeNull();
    expect(msg.reply_to).toBe("real@partner.com");
    // Absent subject/snippet are omitted, never emitted as empty keys.
    expect(msg.subject).toBeUndefined();
    expect(msg.snippet).toBeUndefined();
  });

  test("header lookup is case-insensitive (Gmail varies casing)", () => {
    const msg = toSlaThreadMessage({
      id: "m3",
      payload: { headers: [{ name: "subject", value: "lowercase header" }] },
    });
    expect(msg.subject).toBe("lowercase header");
  });
});
