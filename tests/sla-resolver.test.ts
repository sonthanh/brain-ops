import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Identities } from "../src/lib/identities.ts";
import type { SlaThread } from "../src/lib/types.ts";
import {
  classifySender,
  extractAddress,
  formatGuardFailureComment,
  formatSweepDropComment,
  isAutoReply,
  isStrictAutoReply,
  parseSlaLedger,
  resolveSlaLedger,
  serializeSlaLedger,
  validateSlaLedger,
  type SlaLedger,
  type SlaRow,
  type ResolvedRow,
} from "../src/lib/sla-resolver.ts";

const IDENTITIES: Identities = {
  me: new Set([
    "sonthanhdo2004@gmail.com",
    "thanh@emvn.co",
    "thanh@melosy.net",
  ]),
  teamDomains: new Set(["emvn.co", "melosy.net", "musicmaster.io"]),
};

const EXTERNAL_ADDR = "external@example.com";
const MESSAGE_ID = "msg_abc123";

function openRow(overrides: Partial<SlaRow> = {}): SlaRow {
  return {
    tier: "normal",
    owner: "business",
    from: `External Person <${EXTERNAL_ADDR}>`,
    to: "business@emvn.co",
    subject: '"Open question"',
    messageId: MESSAGE_ID,
    receivedAtUtc: "2026-04-18 13:15",
    breachAtUtc: "2026-04-22 13:15",
    overdueOrRemaining: "~1.0h",
    statusCell: "⏳ open",
    category: "team-sla-at-risk",
    ...overrides,
  };
}

function breachedRow(overrides: Partial<SlaRow> = {}): SlaRow {
  return openRow({
    statusCell: "🟠 breached",
    overdueOrRemaining: "~1.5 bd",
    ...overrides,
  });
}

function emptyLedger(): SlaLedger {
  return {
    frontmatter: "---\ntitle: SLA Open Items\ncreated: 2026-04-15\nupdated: 2026-04-23 10:00 UTC\ntags: [emails, sla, ledger]\nzone: business\n---\n",
    headingLine: "# SLA Open Items",
    headingTrailingBlank: "\n",
    lastComputedLine: "Last computed: 2026-04-23 10:00 UTC",
    headerCountsLine: "Open: 0 | Breached: 0 (fast: 0, normal: 0, slow: 0)",
    preBreachedBlock: "\n## Breached\n",
    breached: [],
    betweenBreachedAndOpenBlock: "\n## Open (within SLA)\n",
    open: [],
    betweenOpenAndResolvedBlock: "\n## Resolved (last 7 days, audit trail)\n",
    resolved: [],
    afterResolvedBlock: "",
  };
}

function thread(messageId: string, msgs: Array<{ from: string; to: string; date: string; auto_submitted?: string | null }>): SlaThread {
  return {
    message_id: messageId,
    thread_messages: msgs.map((m) => ({
      from: m.from,
      to: m.to,
      date: m.date,
      auto_submitted: m.auto_submitted ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// extractAddress + classifySender + isAutoReply helpers
// ---------------------------------------------------------------------------

describe("extractAddress", () => {
  test("returns the address inside angle brackets", () => {
    expect(extractAddress("John Doe <john@example.com>")).toBe("john@example.com");
  });

  test("falls back to the bare token when no angle brackets", () => {
    expect(extractAddress("john@example.com")).toBe("john@example.com");
  });

  test("lower-cases the address", () => {
    expect(extractAddress("<John@Example.COM>")).toBe("john@example.com");
  });

  test("empty / whitespace returns empty string", () => {
    expect(extractAddress("")).toBe("");
    expect(extractAddress("   ")).toBe("");
  });

  test("picks the first address when comma-separated", () => {
    expect(extractAddress("a@x.com, b@x.com")).toBe("a@x.com");
  });
});

describe("classifySender", () => {
  test("returns 'me' when address is in identities.me", () => {
    expect(classifySender("thanh@emvn.co", IDENTITIES)).toBe("me");
  });

  test("returns 'team' when address domain is in identities.teamDomains", () => {
    expect(classifySender("support@emvn.co", IDENTITIES)).toBe("team");
    expect(classifySender("partners@melosy.net", IDENTITIES)).toBe("team");
  });

  test("returns 'external' for unknown domains", () => {
    expect(classifySender("random@example.com", IDENTITIES)).toBe("external");
  });

  test("returns 'external' for addresses without @", () => {
    expect(classifySender("garbage", IDENTITIES)).toBe("external");
  });

  test("returns 'external' for empty addresses", () => {
    expect(classifySender("", IDENTITIES)).toBe("external");
  });
});

describe("isAutoReply", () => {
  test.each<[string | null, boolean]>([
    [null, false],
    ["", false],
    ["no", false],
    ["No", false],
    ["auto-notified", false],
    ["auto-replied", true],
    ["auto-generated", true],
    ["Auto-Replied", true],
    ["unknown-value", false],
  ])("Auto-Submitted=%p → isAutoReply=%p", (input, expected) => {
    expect(isAutoReply(input)).toBe(expected);
  });
});

describe("isStrictAutoReply", () => {
  test.each<[string | null, boolean]>([
    [null, false],
    ["", false],
    ["no", false],
    ["auto-notified", false],
    ["auto-replied", true],
    // auto-generated is NOT strict auto-reply — commonly a mailing-list tag on
    // legitimate human replies. See 2026-04-23 Emad diagnostic.
    ["auto-generated", false],
    ["Auto-Replied", true],
    ["  auto-replied  ", true],
    ["unknown-value", false],
  ])("Auto-Submitted=%p → isStrictAutoReply=%p", (input, expected) => {
    expect(isStrictAutoReply(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// resolveSlaLedger — 4-guard rule
// ---------------------------------------------------------------------------

const NOW = new Date("2026-04-23T10:00:00Z");

describe("resolveSlaLedger — 4-guard rule", () => {
  test("guard #1 fail: no reply after receivedAt → still breached, guard failure logged", () => {
    const ledger = { ...emptyLedger(), breached: [breachedRow()] };
    const result = resolveSlaLedger({
      ledger,
      threads: [thread(MESSAGE_ID, [
        { from: EXTERNAL_ADDR, to: "business@emvn.co", date: "2026-04-18T13:15:00Z" },
        // No reply.
      ])],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.resolvedIds).toEqual([]);
    expect(result.guardFailures).toHaveLength(1);
    expect(result.guardFailures[0]!.guardNumber).toBe(1);
    expect(result.guardFailures[0]!.rawReason).toContain("no reply");
    expect(result.ledger.breached).toHaveLength(1);
  });

  test("guard #2 fail: reply from external sender → still breached", () => {
    const ledger = { ...emptyLedger(), breached: [breachedRow()] };
    const result = resolveSlaLedger({
      ledger,
      threads: [thread(MESSAGE_ID, [
        { from: EXTERNAL_ADDR, to: "business@emvn.co", date: "2026-04-18T13:15:00Z" },
        { from: "random@othercompany.com", to: "business@emvn.co", date: "2026-04-22T12:00:00Z" },
      ])],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.resolvedIds).toEqual([]);
    expect(result.guardFailures).toHaveLength(1);
    expect(result.guardFailures[0]!.guardNumber).toBe(2);
    expect(result.guardFailures[0]!.rawReason).toContain("external");
  });

  test("guard #3 fail: reply addressed to internal CC only (external party not in To)", () => {
    const ledger = { ...emptyLedger(), breached: [breachedRow()] };
    const result = resolveSlaLedger({
      ledger,
      threads: [thread(MESSAGE_ID, [
        { from: EXTERNAL_ADDR, to: "business@emvn.co", date: "2026-04-18T13:15:00Z" },
        { from: "thanh@emvn.co", to: "accounting@emvn.co", date: "2026-04-22T12:00:00Z" },
      ])],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.resolvedIds).toEqual([]);
    expect(result.guardFailures).toHaveLength(1);
    expect(result.guardFailures[0]!.guardNumber).toBe(3);
    expect(result.guardFailures[0]!.rawReason).toContain(EXTERNAL_ADDR);
  });

  test("guard #4 fail: Auto-Submitted=auto-replied → still breached with raw value logged", () => {
    const ledger = { ...emptyLedger(), breached: [breachedRow()] };
    const result = resolveSlaLedger({
      ledger,
      threads: [thread(MESSAGE_ID, [
        { from: EXTERNAL_ADDR, to: "business@emvn.co", date: "2026-04-18T13:15:00Z" },
        { from: "thanh@emvn.co", to: EXTERNAL_ADDR, date: "2026-04-22T12:00:00Z", auto_submitted: "auto-replied" },
      ])],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.resolvedIds).toEqual([]);
    expect(result.guardFailures).toHaveLength(1);
    expect(result.guardFailures[0]!.guardNumber).toBe(4);
    expect(result.guardFailures[0]!.rawReason).toContain("auto-replied");
  });

  test("guard #4 pass: team sender + Auto-Submitted=auto-generated resolves (mailing-list distribution)", () => {
    // Production scenario 2026-04-23 Emad Yaghoubi (19da0bbfa059d5c2):
    // team replied from network@musicmaster.io (a Google-Groups-style alias
    // that tags outbound messages Auto-Submitted: auto-generated). The reply
    // is a genuine human reply — only `auto-replied` (vacation responder)
    // should block resolution from a team sender.
    const ledger = { ...emptyLedger(), breached: [breachedRow()] };
    const result = resolveSlaLedger({
      ledger,
      threads: [thread(MESSAGE_ID, [
        { from: EXTERNAL_ADDR, to: "business@emvn.co", date: "2026-04-18T13:15:00Z" },
        { from: "network@musicmaster.io", to: EXTERNAL_ADDR, date: "2026-04-22T12:00:00Z", auto_submitted: "auto-generated" },
      ])],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.resolvedIds).toEqual([MESSAGE_ID]);
    expect(result.ledger.breached).toEqual([]);
    expect(result.ledger.resolved).toHaveLength(1);
    expect(result.ledger.resolved[0]!.resolvedBy).toContain("musicmaster.io");
  });

  test.each<[string | null, string]>([
    [null, "missing header"],
    ["", "empty header"],
    ["no", "'no' literal (Emad Yaghoubi regression)"],
    ["auto-notified", "informational notification"],
  ])("guard #4 pass when Auto-Submitted=%p (%s) and all other guards pass", (autoSubmitted, _label) => {
    const ledger = { ...emptyLedger(), breached: [breachedRow()] };
    const result = resolveSlaLedger({
      ledger,
      threads: [thread(MESSAGE_ID, [
        { from: EXTERNAL_ADDR, to: "business@emvn.co", date: "2026-04-18T13:15:00Z" },
        { from: "thanh@emvn.co", to: EXTERNAL_ADDR, date: "2026-04-22T12:00:00Z", auto_submitted: autoSubmitted },
      ])],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.resolvedIds).toEqual([MESSAGE_ID]);
    expect(result.ledger.breached).toEqual([]);
    expect(result.ledger.resolved).toHaveLength(1);
    expect(result.ledger.resolved[0]!.resolvedBy).toContain("thanh@emvn.co");
  });

  test("all 4 guards pass → row moves to Resolved with resolvedBy set", () => {
    const ledger = { ...emptyLedger(), breached: [breachedRow()] };
    const result = resolveSlaLedger({
      ledger,
      threads: [thread(MESSAGE_ID, [
        { from: EXTERNAL_ADDR, to: "business@emvn.co", date: "2026-04-18T13:15:00Z" },
        { from: "thanh@emvn.co", to: EXTERNAL_ADDR, date: "2026-04-22T12:00:00Z" },
      ])],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.resolvedIds).toEqual([MESSAGE_ID]);
    expect(result.ledger.resolved).toHaveLength(1);
    expect(result.ledger.resolved[0]!.resolvedAtUtc).toContain("2026-04-22");
  });

  test("me-address reply resolves (sonthanhdo2004@gmail.com)", () => {
    const ledger = { ...emptyLedger(), breached: [breachedRow()] };
    const result = resolveSlaLedger({
      ledger,
      threads: [thread(MESSAGE_ID, [
        { from: EXTERNAL_ADDR, to: "business@emvn.co", date: "2026-04-18T13:15:00Z" },
        { from: "sonthanhdo2004@gmail.com", to: EXTERNAL_ADDR, date: "2026-04-22T12:00:00Z" },
      ])],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.resolvedIds).toEqual([MESSAGE_ID]);
  });

  test("with multiple candidate replies, picks the first passing one", () => {
    const ledger = { ...emptyLedger(), breached: [breachedRow()] };
    const result = resolveSlaLedger({
      ledger,
      threads: [thread(MESSAGE_ID, [
        { from: EXTERNAL_ADDR, to: "business@emvn.co", date: "2026-04-18T13:15:00Z" },
        // First candidate fails guard 4 (auto)
        { from: "thanh@emvn.co", to: EXTERNAL_ADDR, date: "2026-04-20T12:00:00Z", auto_submitted: "auto-replied" },
        // Second candidate passes
        { from: "thanh@emvn.co", to: EXTERNAL_ADDR, date: "2026-04-22T12:00:00Z" },
      ])],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.resolvedIds).toEqual([MESSAGE_ID]);
    expect(result.guardFailures).toEqual([]);
    expect(result.ledger.resolved[0]!.resolvedAtUtc).toContain("2026-04-22");
  });
});

// ---------------------------------------------------------------------------
// Breach crossover + thread-not-found
// ---------------------------------------------------------------------------

describe("resolveSlaLedger — status recompute", () => {
  test("open row past its breach_at moves to breached", () => {
    const row = openRow({ breachAtUtc: "2026-04-23 08:00" });
    const ledger = { ...emptyLedger(), open: [row] };
    const result = resolveSlaLedger({
      ledger,
      threads: [],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.ledger.open).toEqual([]);
    expect(result.ledger.breached).toHaveLength(1);
    expect(result.ledger.breached[0]!.statusCell).toBe("🟠 breached");
  });

  test("breached row stays breached", () => {
    const ledger = { ...emptyLedger(), breached: [breachedRow()] };
    const result = resolveSlaLedger({
      ledger,
      threads: [],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.ledger.breached).toHaveLength(1);
  });

  test("thread-not-found: row left unchanged except status/remaining recomputed", () => {
    const ledger = { ...emptyLedger(), open: [openRow()] };
    const result = resolveSlaLedger({
      ledger,
      threads: [], // no threads at all
      identities: IDENTITIES,
      now: NOW,
    });
    // openRow has breachAt=2026-04-22 13:15 which is BEFORE NOW (2026-04-23) → promoted
    expect(result.ledger.breached).toHaveLength(1);
    expect(result.ledger.breached[0]!.messageId).toBe(MESSAGE_ID);
    expect(result.guardFailures).toEqual([]);
  });

  test("header counts line recomputed after status shift", () => {
    const fastRow = openRow({ tier: "fast", breachAtUtc: "2026-04-23 08:00" });
    const ledger = { ...emptyLedger(), open: [fastRow] };
    const result = resolveSlaLedger({
      ledger,
      threads: [],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.ledger.headerCountsLine).toBe(
      "Open: 0 | Breached: 1 (fast: 1, normal: 0, slow: 0)",
    );
    expect(result.ledger.lastComputedLine).toContain("2026-04-23");
  });
});

// ---------------------------------------------------------------------------
// Follow-up re-open
// ---------------------------------------------------------------------------

describe("resolveSlaLedger — follow-up re-open", () => {
  test("Resolved row + external reply after resolvedAt → moves back to Open/Breached", () => {
    const resolved: ResolvedRow = {
      tier: "normal",
      owner: "business",
      from: `External Person <${EXTERNAL_ADDR}>`,
      subject: '"Follow-up"',
      messageId: MESSAGE_ID,
      receivedAt: "2026-04-18 13:15",
      resolvedAtUtc: "2026-04-19 10:00 UTC",
      resolvedBy: "thanh@emvn.co",
    };
    const ledger = { ...emptyLedger(), resolved: [resolved] };
    const result = resolveSlaLedger({
      ledger,
      threads: [thread(MESSAGE_ID, [
        { from: EXTERNAL_ADDR, to: "business@emvn.co", date: "2026-04-18T13:15:00Z" },
        { from: "thanh@emvn.co", to: EXTERNAL_ADDR, date: "2026-04-19T10:00:00Z" },
        // External follow-up AFTER resolution
        { from: EXTERNAL_ADDR, to: "business@emvn.co", date: "2026-04-22T11:00:00Z" },
      ])],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.reopenedIds).toEqual([MESSAGE_ID]);
    expect(result.ledger.resolved).toEqual([]);
    const reopened = result.ledger.breached.concat(result.ledger.open);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.messageId).toBe(MESSAGE_ID);
    expect(reopened[0]!.receivedAtUtc).toContain("2026-04-22");
  });

  test("Resolved row with no external follow-up stays resolved", () => {
    const resolved: ResolvedRow = {
      tier: "normal",
      owner: "business",
      from: `External <${EXTERNAL_ADDR}>`,
      subject: '"Q"',
      messageId: MESSAGE_ID,
      receivedAt: "2026-04-22 09:00",
      resolvedAtUtc: "2026-04-22 10:00 UTC",
      resolvedBy: "thanh@emvn.co",
    };
    const ledger = { ...emptyLedger(), resolved: [resolved] };
    const result = resolveSlaLedger({
      ledger,
      threads: [thread(MESSAGE_ID, [
        { from: EXTERNAL_ADDR, to: "business@emvn.co", date: "2026-04-22T09:00:00Z" },
        { from: "thanh@emvn.co", to: EXTERNAL_ADDR, date: "2026-04-22T10:00:00Z" },
      ])],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.reopenedIds).toEqual([]);
    expect(result.ledger.resolved).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Resolved retention (7 days)
// ---------------------------------------------------------------------------

describe("resolveSlaLedger — Resolved retention", () => {
  test("rows resolved > 7 days ago are trimmed", () => {
    const old: ResolvedRow = {
      tier: "normal",
      owner: "business",
      from: "Ancient Sender",
      subject: '"Old"',
      messageId: "msg_old",
      receivedAt: "2026-04-10 10:00",
      resolvedAtUtc: "2026-04-10 12:00 UTC",
      resolvedBy: "thanh@emvn.co",
    };
    const recent: ResolvedRow = { ...old, messageId: "msg_recent", resolvedAtUtc: "2026-04-20 12:00 UTC" };
    const ledger = { ...emptyLedger(), resolved: [old, recent] };
    const result = resolveSlaLedger({
      ledger,
      threads: [],
      identities: IDENTITIES,
      now: NOW,
    });
    const ids = result.ledger.resolved.map((r) => r.messageId);
    expect(ids).toEqual(["msg_recent"]);
  });
});

// ---------------------------------------------------------------------------
// Parse + serialize round-trip
// ---------------------------------------------------------------------------

const MINIMAL_LEDGER = `---
title: SLA Open Items
created: 2026-04-15
updated: 2026-04-23 10:00 UTC
tags: [emails, sla, ledger]
zone: business
---

# SLA Open Items

Last computed: 2026-04-23 10:00 UTC
Open: 1 | Breached: 1 (fast: 0, normal: 1, slow: 0)

## Breached
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Overdue | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|---------|--------|----------|
| normal | business | External <ext@x.com> | business@emvn.co | "Breached subject" | msg_b1 | 2026-04-18 13:15 | 2026-04-22 13:15 | ~1.0 bd | 🟠 breached | team-sla-at-risk |

## Open (within SLA)
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Remaining | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|-----------|--------|----------|
| normal | hr | Applicant <app@x.com> | hr@emvn.co | "Open subject" | msg_o1 | 2026-04-22 14:00 | 2026-04-24 14:00 | ~28.0h (~1.2 bd) | ⏳ open | team-sla-at-risk |

## Resolved (last 7 days, audit trail)
| Tier | Owner | From | Subject | Message ID | Received | Resolved (UTC) | Resolved by |
|------|-------|------|---------|------------|----------|----------------|-------------|
| normal | legal | Counsel <c@x.com> | "Re: Question" | msg_r1 | 2026-04-20 09:00 | 2026-04-22 15:00 UTC | thanh@emvn.co |
`;

describe("parseSlaLedger + serializeSlaLedger", () => {
  test("parses frontmatter, heading, counts, last-computed", () => {
    const parsed = parseSlaLedger(MINIMAL_LEDGER);
    expect(parsed.headingLine).toBe("# SLA Open Items");
    expect(parsed.headerCountsLine).toBe("Open: 1 | Breached: 1 (fast: 0, normal: 1, slow: 0)");
    expect(parsed.lastComputedLine).toBe("Last computed: 2026-04-23 10:00 UTC");
  });

  test("parses breached, open, resolved rows", () => {
    const parsed = parseSlaLedger(MINIMAL_LEDGER);
    expect(parsed.breached).toHaveLength(1);
    expect(parsed.breached[0]!.messageId).toBe("msg_b1");
    expect(parsed.open).toHaveLength(1);
    expect(parsed.open[0]!.messageId).toBe("msg_o1");
    expect(parsed.resolved).toHaveLength(1);
    expect(parsed.resolved[0]!.messageId).toBe("msg_r1");
  });

  test("round-trip: parse → serialize preserves structural content", () => {
    const parsed = parseSlaLedger(MINIMAL_LEDGER);
    const out = serializeSlaLedger(parsed);
    expect(out).toContain("# SLA Open Items");
    expect(out).toContain("## Breached");
    expect(out).toContain("## Open (within SLA)");
    expect(out).toContain("## Resolved");
    expect(out).toContain("msg_b1");
    expect(out).toContain("msg_o1");
    expect(out).toContain("msg_r1");
  });

  test("preserves HTML comment block between header counts and ## Breached", () => {
    const withComment = `---
title: SLA Open Items
created: 2026-04-15
updated: 2026-04-23 10:00 UTC
tags: [emails, sla, ledger]
zone: business
---

# SLA Open Items

Last computed: 2026-04-23 10:00 UTC
Open: 0 | Breached: 0 (fast: 0, normal: 0, slow: 0)

<!--
Audit migration note — preserved across round-trip.
-->

## Breached
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Overdue | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|---------|--------|----------|

## Open (within SLA)
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Remaining | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|-----------|--------|----------|

## Resolved (last 7 days, audit trail)
| Tier | Owner | From | Subject | Message ID | Received | Resolved (UTC) | Resolved by |
|------|-------|------|---------|------------|----------|----------------|-------------|
`;
    const parsed = parseSlaLedger(withComment);
    const out = serializeSlaLedger(parsed);
    expect(out).toContain("<!--");
    expect(out).toContain("Audit migration note — preserved across round-trip.");
    expect(out).toContain("-->");
  });
});

// ---------------------------------------------------------------------------
// Snapshot round-trip — real sla-open.md structure
// ---------------------------------------------------------------------------

describe("snapshot round-trip: tests/fixtures/sla-open-snapshot.md", () => {
  const fixturePath = join(import.meta.dir, "fixtures", "sla-open-snapshot.md");
  const content = readFileSync(fixturePath, "utf-8");

  test("parser recovers every table row by message ID", () => {
    const parsed = parseSlaLedger(content);
    // Verify at least some known IDs from the snapshot land in the right table.
    // Breached should contain known breaches by ID:
    const breachedIds = parsed.breached.map((r) => r.messageId);
    expect(breachedIds).toContain("19daec604f50608a");
    expect(breachedIds).toContain("19da0bbfa059d5c2");
    // Open should contain known open IDs:
    const openIds = parsed.open.map((r) => r.messageId);
    expect(openIds.length).toBeGreaterThan(0);
    // Resolved should contain at least the IDs with "all 4 guards met"
    const resolvedIds = parsed.resolved.map((r) => r.messageId);
    expect(resolvedIds).toContain("19db4b8000f802f3");
  });

  test("serializer preserves frontmatter, heading, HTML audit blocks", () => {
    const parsed = parseSlaLedger(content);
    const out = serializeSlaLedger(parsed);
    expect(out).toContain("title: SLA Open Items");
    expect(out).toContain("# SLA Open Items");
    expect(out).toContain("One-shot migration — 2026-04-22"); // HTML comment preserved
    expect(out).toContain("Resolution check 2026-04-23 04:00 UTC (run T04)"); // post-resolved block preserved
    expect(out).toContain("## Breached");
    expect(out).toContain("## Open (within SLA)");
    expect(out).toContain("## Resolved (last 7 days, audit trail)");
  });

  test("resolver with empty threads only recomputes counts/timestamp — all rows retained", () => {
    const parsed = parseSlaLedger(content);
    const result = resolveSlaLedger({
      ledger: parsed,
      threads: [],
      identities: IDENTITIES,
      now: new Date("2026-04-23T10:00:00Z"),
    });
    expect(result.resolvedIds).toEqual([]);
    expect(result.reopenedIds).toEqual([]);
    // Counts should match the new breakdown:
    expect(result.ledger.headerCountsLine).toMatch(/^Open: \d+ \| Breached: \d+/);
    // The 19da0bbfa059d5c2 (Emad) row stays breached (no thread data → no resolve).
    expect(result.ledger.breached.map((r) => r.messageId)).toContain("19da0bbfa059d5c2");
  });

  test("resolver with matching thread for Emad Yaghoubi (guard #4 Auto-Submitted='no') resolves", () => {
    // Regression coverage for the real-world bug captured at
    // sla-open.md:48 — "user says team replied but guard #4 rejected as
    // Auto-Submitted". The new raw-string type makes `Auto-Submitted: no` pass.
    const parsed = parseSlaLedger(content);
    const emadId = "19da0bbfa059d5c2";
    const simulatedThread: SlaThread = {
      message_id: emadId,
      thread_messages: [
        {
          from: "emadeyaghoubi@gmail.com",
          to: "business@emvn.co",
          date: "2026-04-18T13:15:00Z",
          auto_submitted: null,
        },
        {
          from: "business@emvn.co",
          to: "emadeyaghoubi@gmail.com",
          date: "2026-04-22T08:00:00Z",
          auto_submitted: "no", // was erroneously flagged by the boolean-cast fetcher
        },
      ],
    };
    const result = resolveSlaLedger({
      ledger: parsed,
      threads: [simulatedThread],
      identities: {
        me: new Set(["sonthanhdo2004@gmail.com", "thanh@emvn.co"]),
        teamDomains: new Set(["emvn.co", "melosy.net"]),
      },
      now: new Date("2026-04-23T10:00:00Z"),
    });
    expect(result.resolvedIds).toContain(emadId);
    expect(result.ledger.breached.map((r) => r.messageId)).not.toContain(emadId);
  });
});

// ---------------------------------------------------------------------------
// Empty ledger (zero rows)
// ---------------------------------------------------------------------------

describe("resolveSlaLedger — empty ledger", () => {
  test("no rows: resolver is a no-op except counts/timestamp line", () => {
    const result = resolveSlaLedger({
      ledger: emptyLedger(),
      threads: [],
      identities: IDENTITIES,
      now: NOW,
    });
    expect(result.ledger.breached).toEqual([]);
    expect(result.ledger.open).toEqual([]);
    expect(result.ledger.resolved).toEqual([]);
    expect(result.ledger.headerCountsLine).toBe(
      "Open: 0 | Breached: 0 (fast: 0, normal: 0, slow: 0)",
    );
    expect(result.ledger.lastComputedLine).toMatch(/^Last computed: 2026-04-23 10:00 UTC$/);
  });
});

// ---------------------------------------------------------------------------
// Guard-failure comment formatting
// ---------------------------------------------------------------------------

describe("formatGuardFailureComment", () => {
  test("empty failure list returns empty string", () => {
    expect(formatGuardFailureComment([], NOW)).toBe("");
  });

  test("formats one-line-per-failure with guard number + raw reason + candidate", () => {
    const out = formatGuardFailureComment(
      [
        {
          messageId: "msg_a",
          guardNumber: 4,
          rawReason: 'auto_submitted="auto-replied"',
          latestCandidate: { date: "2026-04-22T08:00:00Z", from: "business@emvn.co", to: EXTERNAL_ADDR },
        },
      ],
      NOW,
    );
    expect(out).toContain("SLA refresh guard-failure log");
    expect(out).toContain("msg_a");
    expect(out).toContain("guard #4");
    expect(out).toContain("auto-replied");
    expect(out).toContain("candidate reply 2026-04-22T08:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// validateSlaLedger — deterministic rule sweep
// ---------------------------------------------------------------------------

describe("validateSlaLedger", () => {
  test("empty ledger: no drops, unchanged", () => {
    const ledger = emptyLedger();
    const result = validateSlaLedger(ledger);
    expect(result.drops).toEqual([]);
    expect(result.ledger.breached).toEqual([]);
    expect(result.ledger.open).toEqual([]);
  });

  test("drops awareness rows from Breached", () => {
    const row = breachedRow({ category: "awareness" });
    const result = validateSlaLedger({ ...emptyLedger(), breached: [row] });
    expect(result.drops).toHaveLength(1);
    expect(result.drops[0]!.reasons).toContain("category=awareness in active ledger");
    expect(result.ledger.breached).toEqual([]);
  });

  test("drops awareness rows from Open", () => {
    const row = openRow({ category: "awareness" });
    const result = validateSlaLedger({ ...emptyLedger(), open: [row] });
    expect(result.drops).toHaveLength(1);
    expect(result.ledger.open).toEqual([]);
  });

  test.each<[string, string]>([
    ["noreply@mail.anthropic.com", "noreply"],
    ["no-reply@info.airwallex.com", "no-reply"],
    ["donotreply@interactivebrokers.com", "donotreply"],
    ["notifications@stripe.com", "notifications"],
    ["alerts@github.com", "alerts"],
    ["mailer-daemon@gmail.com", "mailer-daemon"],
  ])("drops automation-sender localpart from=%p", (addr, _lp) => {
    const row = openRow({ from: `Bot <${addr}>` });
    const result = validateSlaLedger({ ...emptyLedger(), open: [row] });
    expect(result.drops).toHaveLength(1);
    expect(result.drops[0]!.reasons.some((r) => r.includes("automation-sender"))).toBe(true);
    expect(result.ledger.open).toEqual([]);
  });

  test.each<string>([
    "billing@hetzner.com",
    "billing@stripe.com",
    "invoice@wise.com",
    "receipts@pandadoc.net",
    "accounts@pingpongx.com",
    "billing@e.fitbit.com",
  ])("drops billing-known localpart from=%p", (addr) => {
    const row = openRow({ from: `Vendor Billing <${addr}>` });
    const result = validateSlaLedger({ ...emptyLedger(), open: [row] });
    expect(result.drops).toHaveLength(1);
    expect(result.drops[0]!.reasons.some((r) => r.includes("billing-known"))).toBe(true);
  });

  test("drops invitation-subject rows — HR Interview Invitation (Yen Nhi case)", () => {
    const row = breachedRow({
      subject: '"Re: [EMVN] YouTube Channel Optimizer - Final Interview Invitation"',
      category: "team-sla-at-risk",
    });
    const result = validateSlaLedger({ ...emptyLedger(), breached: [row] });
    expect(result.drops).toHaveLength(1);
    expect(result.drops[0]!.reasons).toContain("invitation subject — awareness per taxonomy");
  });

  test("drops invitation-subject rows — bare 'Invitation:' prefix (calendar invite)", () => {
    const row = openRow({ subject: '"Invitation: Team Standup Apr 25"' });
    const result = validateSlaLedger({ ...emptyLedger(), open: [row] });
    expect(result.drops).toHaveLength(1);
  });

  test("keeps non-invitation business subjects with the word 'Invitation' in them", () => {
    // "Invitation to invest in Foo Corp" is business, not HR — no colon, no
    // "Interview Invitation" — keep.
    const row = openRow({ subject: '"Re: Invitation to invest in Foo Corp"' });
    const result = validateSlaLedger({ ...emptyLedger(), open: [row] });
    expect(result.drops).toEqual([]);
    expect(result.ledger.open).toHaveLength(1);
  });

  test("keeps team-sla-at-risk from normal senders", () => {
    const row = openRow({
      from: "External Person <external@example.com>",
      subject: '"Re: Clarification on Payments"',
      category: "team-sla-at-risk",
    });
    const result = validateSlaLedger({ ...emptyLedger(), open: [row] });
    expect(result.drops).toEqual([]);
    expect(result.ledger.open).toHaveLength(1);
  });

  test("collects multiple reasons when a row violates several invariants", () => {
    // Awareness + automation + billing — all three fire.
    const row = openRow({
      from: "Hetzner Billing <billing@hetzner.com>",
      category: "awareness",
    });
    const result = validateSlaLedger({ ...emptyLedger(), open: [row] });
    expect(result.drops).toHaveLength(1);
    expect(result.drops[0]!.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// formatSweepDropComment
// ---------------------------------------------------------------------------

describe("formatSweepDropComment", () => {
  test("empty drop list returns empty string", () => {
    expect(formatSweepDropComment([], NOW)).toBe("");
  });

  test("formats one-line-per-drop with messageId + subject + reasons", () => {
    const out = formatSweepDropComment(
      [
        {
          row: breachedRow({
            messageId: "msg_yn",
            subject: '"Re: [EMVN] - Final Interview Invitation"',
          }),
          reasons: ["invitation subject — awareness per taxonomy"],
        },
      ],
      NOW,
    );
    expect(out).toContain("SLA rule-sweep drop log");
    expect(out).toContain("msg_yn");
    expect(out).toContain("Interview Invitation");
    expect(out).toContain("awareness per taxonomy");
  });
});
