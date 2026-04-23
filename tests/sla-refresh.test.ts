import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runRefresh } from "../src/sla-refresh.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-sla-refresh");

const RULES_FIXTURE = `# Gmail Rules

## Custom Rules

### Team domains (internal)
- @emvn.co — EMVN team
- @melosy.net — Melosy team

### Send-as identities (outbound authorship)
- sonthanhdo2004@gmail.com
- thanh@emvn.co
`;

const LEDGER_FIXTURE = `---
title: SLA Open Items
created: 2026-04-15
updated: 2026-04-23 09:00 UTC
tags: [emails, sla, ledger]
zone: business
---

# SLA Open Items

Last computed: 2026-04-23 09:00 UTC
Open: 1 | Breached: 1 (fast: 0, normal: 1, slow: 0)

## Breached
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Overdue | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|---------|--------|----------|
| normal | business | External <ext@x.com> | business@emvn.co | "Breached" | msg_b1 | 2026-04-18 13:15 | 2026-04-22 13:15 | ~1.0 bd | 🟠 breached | team-sla-at-risk |

## Open (within SLA)
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Remaining | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|-----------|--------|----------|
| normal | hr | Applicant <app@x.com> | hr@emvn.co | "Open" | msg_o1 | 2026-04-22 14:00 | 2026-04-30 14:00 | ~5d | ⏳ open | team-sla-at-risk |

## Resolved (last 7 days, audit trail)
| Tier | Owner | From | Subject | Message ID | Received | Resolved (UTC) | Resolved by |
|------|-------|------|---------|------------|----------|----------------|-------------|
`;

const THREADS_RESOLVING_B1 = JSON.stringify([
  {
    message_id: "msg_b1",
    thread_messages: [
      { from: "ext@x.com", to: "business@emvn.co", date: "2026-04-18T13:15:00Z", auto_submitted: null },
      { from: "thanh@emvn.co", to: "ext@x.com", date: "2026-04-22T08:00:00Z", auto_submitted: "no" },
    ],
  },
]);

const EMPTY_THREADS = "[]";

describe("sla-refresh CLI — end-to-end", () => {
  let rulesPath: string;
  let ledgerPath: string;
  let threadsPath: string;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    rulesPath = join(TEST_DIR, "gmail-rules.md");
    ledgerPath = join(TEST_DIR, "sla-open.md");
    threadsPath = join(TEST_DIR, "sla-threads.json");
    writeFileSync(rulesPath, RULES_FIXTURE);
    writeFileSync(ledgerPath, LEDGER_FIXTURE);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("resolves breached row when thread data shows team reply with Auto-Submitted='no'", async () => {
    writeFileSync(threadsPath, THREADS_RESOLVING_B1);
    const code = await runRefresh({
      ledgerPath,
      gmailRulesPath: rulesPath,
      credentialsPath: undefined,
      threadsPath,
      dryRun: false,
    });
    expect(code).toBe(0);
    const updated = readFileSync(ledgerPath, "utf-8");
    // b1 should no longer be in Breached table, should be in Resolved.
    expect(updated).not.toMatch(/\|\s*normal\s*\|\s*business\s*\|\s*External[^|]+\|\s*business@emvn\.co\s*\|\s*"Breached"\s*\|\s*msg_b1/);
    expect(updated).toMatch(/##\s+Resolved[\s\S]*msg_b1/);
    expect(updated).toMatch(/thanh@emvn\.co/);
  });

  test("empty threads + breach crossover: open row promoted to breached", async () => {
    writeFileSync(threadsPath, EMPTY_THREADS);
    // Replace fixture: open row with breach_at past now.
    const ledgerWithPastBreach = LEDGER_FIXTURE.replace(
      /2026-04-30 14:00 \| ~5d \| ⏳ open/,
      "2026-04-20 14:00 | ~10h | ⏳ open",
    );
    writeFileSync(ledgerPath, ledgerWithPastBreach);
    const code = await runRefresh({
      ledgerPath,
      gmailRulesPath: rulesPath,
      credentialsPath: undefined,
      threadsPath,
      dryRun: false,
    });
    expect(code).toBe(0);
    const updated = readFileSync(ledgerPath, "utf-8");
    // msg_o1 should have moved to Breached.
    const breachedSection = updated.split("## Open (within SLA)")[0]!;
    expect(breachedSection).toContain("msg_o1");
  });

  test("--dry-run does not modify the ledger file", async () => {
    writeFileSync(threadsPath, THREADS_RESOLVING_B1);
    const before = readFileSync(ledgerPath, "utf-8");
    const code = await runRefresh({
      ledgerPath,
      gmailRulesPath: rulesPath,
      credentialsPath: undefined,
      threadsPath,
      dryRun: true,
    });
    expect(code).toBe(0);
    const after = readFileSync(ledgerPath, "utf-8");
    expect(after).toBe(before);
  });

  test("missing ledger file: exits 0 with message, no error", async () => {
    writeFileSync(threadsPath, EMPTY_THREADS);
    rmSync(ledgerPath);
    const code = await runRefresh({
      ledgerPath,
      gmailRulesPath: rulesPath,
      credentialsPath: undefined,
      threadsPath,
      dryRun: false,
    });
    expect(code).toBe(0);
  });

  test("guard-failure comment appended to ledger when guard fails", async () => {
    // Provide a thread with Auto-Submitted=auto-replied to force guard #4 fail.
    const threadsFailing = JSON.stringify([
      {
        message_id: "msg_b1",
        thread_messages: [
          { from: "ext@x.com", to: "business@emvn.co", date: "2026-04-18T13:15:00Z", auto_submitted: null },
          { from: "thanh@emvn.co", to: "ext@x.com", date: "2026-04-22T08:00:00Z", auto_submitted: "auto-replied" },
        ],
      },
    ]);
    writeFileSync(threadsPath, threadsFailing);
    const code = await runRefresh({
      ledgerPath,
      gmailRulesPath: rulesPath,
      credentialsPath: undefined,
      threadsPath,
      dryRun: false,
    });
    expect(code).toBe(0);
    const updated = readFileSync(ledgerPath, "utf-8");
    expect(updated).toContain("SLA refresh guard-failure log");
    expect(updated).toContain("guard #4");
    expect(updated).toContain("auto-replied");
  });
});
