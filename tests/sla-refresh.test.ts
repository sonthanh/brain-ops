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

  // TODO: hardcoded fixture dates (2026-04) age past the 7-day Resolved trim
  // and breach-recompute thresholds, causing date-drift failures. Re-anchor
  // fixtures to NOW-relative dates or stub Date inside runRefresh, then
  // unskip. Tracked at: brain-ops issue — gmail-triage CI date-bound flake.
  test.skip("resolves breached row when thread data shows team reply with Auto-Submitted='no'", async () => {
    writeFileSync(threadsPath, THREADS_RESOLVING_B1);
    const code = await runRefresh({
      ledgerPath,
      gmailRulesPath: rulesPath,
      credentialsPath: undefined,
      threadsPath,
      dryRun: false,
      classifyLearningsPath: undefined,
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
      classifyLearningsPath: undefined,
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
      classifyLearningsPath: undefined,
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
      classifyLearningsPath: undefined,
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
      classifyLearningsPath: undefined,
    });
    expect(code).toBe(0);
    const updated = readFileSync(ledgerPath, "utf-8");
    expect(updated).toContain("SLA refresh guard-failure log");
    expect(updated).toContain("guard #4");
    expect(updated).toContain("auto-replied");
  });

  // TODO: same date-bound flake — fixture's open-row breach_at (2026-04-30)
  // is now in the past, so `msg_ok` gets promoted to Breached before the
  // assertion that finds it in Open can run. Re-anchor fixture dates first,
  // then unskip.
  test.skip("rule sweep drops awareness / automation / invitation rows and logs them", async () => {
    // Ledger with 3 violator rows: (1) awareness category, (2) automation
    // sender, (3) Interview Invitation subject. Sweep must drop all three and
    // append a `SLA rule-sweep drop log` block.
    const violatorLedger = `---
title: SLA Open Items
created: 2026-04-15
updated: 2026-04-23 09:00 UTC
tags: [emails, sla, ledger]
zone: business
---

# SLA Open Items

Last computed: 2026-04-23 09:00 UTC
Open: 2 | Breached: 2 (fast: 0, normal: 2, slow: 0)

## Breached
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Overdue | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|---------|--------|----------|
| normal | hr | Anna Candidate <anna@gmail.com> | hr@emvn.co | "Re: [EMVN] Final Interview Invitation" | msg_yn | 2026-04-21 06:41 | 2026-04-23 06:41 | ~12h | 🟠 breached | team-sla-at-risk |
| normal | business | Hetzner <billing@hetzner.com> | business@emvn.co | "Credit card charge failed" | msg_ht | 2026-04-20 10:00 | 2026-04-22 10:00 | ~28h | 🟠 breached | team-sla-at-risk |

## Open (within SLA)
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Remaining | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|-----------|--------|----------|
| normal | hr | Bot <noreply@info.airwallex.com> | business@emvn.co | "Action required: verify account" | msg_aw | 2026-04-22 14:00 | 2026-04-30 14:00 | ~5d | ⏳ open | awareness |
| normal | business | Legit External <ext@real.com> | business@emvn.co | "Re: Quarterly numbers" | msg_ok | 2026-04-22 14:00 | 2026-04-30 14:00 | ~5d | ⏳ open | team-sla-at-risk |

## Resolved (last 7 days, audit trail)
| Tier | Owner | From | Subject | Message ID | Received | Resolved (UTC) | Resolved by |
|------|-------|------|---------|------------|----------|----------------|-------------|
`;
    writeFileSync(ledgerPath, violatorLedger);
    writeFileSync(threadsPath, EMPTY_THREADS);
    const code = await runRefresh({
      ledgerPath,
      gmailRulesPath: rulesPath,
      credentialsPath: undefined,
      threadsPath,
      dryRun: false,
      classifyLearningsPath: undefined,
    });
    expect(code).toBe(0);
    const updated = readFileSync(ledgerPath, "utf-8");
    // 3 violators dropped from the Breached/Open tables.
    const breachedSection = updated.split("## Open (within SLA)")[0]!;
    const openSection = updated.split("## Open (within SLA)")[1]!.split("## Resolved")[0]!;
    expect(breachedSection).not.toContain("msg_yn");
    expect(breachedSection).not.toContain("msg_ht");
    expect(openSection).not.toContain("msg_aw");
    // Legitimate row survives.
    expect(openSection).toContain("msg_ok");
    // Audit comment present.
    expect(updated).toContain("SLA rule-sweep drop log");
    expect(updated).toContain("msg_yn");
    expect(updated).toContain("msg_ht");
    expect(updated).toContain("msg_aw");
    expect(updated).toContain("invitation subject");
    expect(updated).toContain("billing-known");
    expect(updated).toContain("automation-sender");
  });
});

/**
 * SLA false-positive learning capture (/audit 2026-05-16 finding B).
 *
 * When the user manually moves a row from `## Breached` to `## Resolved` with a
 * `user-asserted ...` audit note, the resolver has no thread evidence to act
 * on — the only signal that the row was a false positive is the user's note.
 * sla-refresh re-reads the post-edit ledger, detects matching `resolvedBy` /
 * `replyReason` strings, and emits a deduped `sla-false-positive` learning
 * entry. The classifier loads this file pre-classify so the same thread (or
 * matching sender / subject pattern) doesn't re-enter `Breached` next month.
 */
describe("sla-refresh CLI — SLA false-positive learning capture", () => {
  let rulesPath: string;
  let ledgerPath: string;
  let threadsPath: string;
  let learningsPath: string;

  // Ledger fixture variant: a single Resolved row already carries a
  // `user-asserted team-handled out-of-band` audit note (mirrors the actual
  // post-edit state of business/intelligence/emails/sla-open.md after the
  // user manually moved a false positive). Active sections are empty so the
  // resolver does nothing destructive — keeps the test focused on the
  // capture path alone.
  const LEDGER_WITH_USER_ASSERTED_RESOLVED = `---
title: SLA Open Items
created: 2026-04-15
updated: 2026-05-16 11:30 UTC
tags: [emails, sla, ledger]
zone: business
---

# SLA Open Items

Last computed: 2026-05-16 11:30 UTC
Open: 0 | Breached: 0 (fast: 0, normal: 0, slow: 0)

## Breached
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Overdue | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|---------|--------|----------|

## Open (within SLA)
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Remaining | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|-----------|--------|----------|

## Resolved (last 7 days, audit trail)
| Tier | Owner | From | Subject | Message ID | Received | Resolved (UTC) | Resolved by |
|------|-------|------|---------|------------|----------|----------------|-------------|
| normal | license | George Kolganov <via license@emvn.co> | "Relaxed Mind & Mediacube" | msg_user_asserted_1 | 2026-05-12 03:31 | 2026-05-16 11:30 UTC | user-asserted team-handled out-of-band 2026-05-16 (no Gmail trace) |
`;

  // Same shape but the Resolved row was closed by a real team reply — the
  // `resolvedBy` cell carries the team email address, not `user-asserted`.
  // The capture path must skip this row entirely (negative-fire test).
  const LEDGER_WITH_REAL_TEAM_RESOLVED = `---
title: SLA Open Items
created: 2026-04-15
updated: 2026-05-16 11:30 UTC
tags: [emails, sla, ledger]
zone: business
---

# SLA Open Items

Last computed: 2026-05-16 11:30 UTC
Open: 0 | Breached: 0 (fast: 0, normal: 0, slow: 0)

## Breached
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Overdue | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|---------|--------|----------|

## Open (within SLA)
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Remaining | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|-----------|--------|----------|

## Resolved (last 7 days, audit trail)
| Tier | Owner | From | Subject | Message ID | Received | Resolved (UTC) | Resolved by |
|------|-------|------|---------|------------|----------|----------------|-------------|
| normal | support | Ed Scott <ed@dabmusic.tv> | "Re: New Music — Dodged A Bullet" | msg_team_replied_1 | 2026-05-12 09:57 | 2026-05-16 10:27 UTC | accounting@emvn.co |
`;

  // Ledger fixture with a single Auto-suppressed row carrying a
  // `user-asserted ...` reply_reason (cells[12]). Mirrors the case where the
  // user routes a mass-blast / portal-notification false positive to the
  // suppressed bucket rather than Resolved.
  const LEDGER_WITH_USER_ASSERTED_SUPPRESSED = `---
title: SLA Open Items
created: 2026-04-15
updated: 2026-05-16 11:30 UTC
tags: [emails, sla, ledger]
zone: business
---

# SLA Open Items

Last computed: 2026-05-16 11:30 UTC
Open: 0 | Breached: 0 (fast: 0, normal: 0, slow: 0)

## Breached
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Overdue | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|---------|--------|----------|

## Open (within SLA)
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Remaining | Status | Category |
|------|-------|------|----|---------|------------|----------------|-----------------|-----------|--------|----------|

## Auto-suppressed (Reply Owed = false)
| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Age | Status | Category | Reply Owed | Reply Reason |
|------|-------|------|----|---------|------------|----------------|-----------------|-----|--------|----------|------------|--------------|
| normal | business | Nikki Butler <nikki@example.com> | business@emvn.co | "Mass-blast outreach" | msg_user_asserted_supp | 2026-05-10 14:00 | 2026-05-12 14:00 | ~6d | 🔇 suppressed | awareness | false | user-asserted mass-blast not a real ask 2026-05-16 |

## Resolved (last 7 days, audit trail)
| Tier | Owner | From | Subject | Message ID | Received | Resolved (UTC) | Resolved by |
|------|-------|------|---------|------------|----------|----------------|-------------|
`;

  function loadLearningEntries(): Array<Record<string, unknown>> {
    const content = readFileSync(learningsPath, "utf-8");
    const sep = "\n---\n";
    const idx = content.indexOf(sep);
    if (idx < 0) return [];
    return content
      .slice(idx + sep.length)
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    rulesPath = join(TEST_DIR, "gmail-rules.md");
    ledgerPath = join(TEST_DIR, "sla-open.md");
    threadsPath = join(TEST_DIR, "sla-threads.json");
    learningsPath = join(TEST_DIR, "gmail-classify-learnings.md");
    writeFileSync(rulesPath, RULES_FIXTURE);
    writeFileSync(threadsPath, EMPTY_THREADS);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("Resolved row with user-asserted note emits an sla-false-positive learning entry", async () => {
    writeFileSync(ledgerPath, LEDGER_WITH_USER_ASSERTED_RESOLVED);
    const code = await runRefresh({
      ledgerPath,
      gmailRulesPath: rulesPath,
      credentialsPath: undefined,
      threadsPath,
      dryRun: false,
      classifyLearningsPath: learningsPath,
    });
    expect(code).toBe(0);
    const entries = loadLearningEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("sla-false-positive");
    expect(entries[0]?.threadId).toBe("msg_user_asserted_1");
    expect(entries[0]?.subject).toContain("Relaxed Mind");
    expect(entries[0]?.sender).toContain("George Kolganov");
    expect(String(entries[0]?.reason)).toContain("user-asserted");
    expect(String(entries[0]?.reason)).toContain("team-handled out-of-band");
    expect(typeof entries[0]?.observedAt).toBe("string");
  });

  test("running refresh twice on the same ledger keeps exactly one learning entry (dedup by threadId)", async () => {
    writeFileSync(ledgerPath, LEDGER_WITH_USER_ASSERTED_RESOLVED);
    const firstCode = await runRefresh({
      ledgerPath,
      gmailRulesPath: rulesPath,
      credentialsPath: undefined,
      threadsPath,
      dryRun: false,
      classifyLearningsPath: learningsPath,
    });
    expect(firstCode).toBe(0);
    expect(loadLearningEntries()).toHaveLength(1);

    // Second run — same ledger state, same user-asserted row. The capture
    // pass MUST see the existing entry and skip the append.
    const secondCode = await runRefresh({
      ledgerPath,
      gmailRulesPath: rulesPath,
      credentialsPath: undefined,
      threadsPath,
      dryRun: false,
      classifyLearningsPath: learningsPath,
    });
    expect(secondCode).toBe(0);
    const entries = loadLearningEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.threadId).toBe("msg_user_asserted_1");
  });

  test("Resolved row with a real team-email resolvedBy emits NO learning entry", async () => {
    writeFileSync(ledgerPath, LEDGER_WITH_REAL_TEAM_RESOLVED);
    const code = await runRefresh({
      ledgerPath,
      gmailRulesPath: rulesPath,
      credentialsPath: undefined,
      threadsPath,
      dryRun: false,
      classifyLearningsPath: learningsPath,
    });
    expect(code).toBe(0);
    // Capture path must not have created the learnings file (no rows match).
    const entries = existsSyncOrEmpty(learningsPath);
    expect(entries).toHaveLength(0);
  });

  test("Auto-suppressed row with user-asserted reply_reason emits an sla-false-positive learning entry", async () => {
    writeFileSync(ledgerPath, LEDGER_WITH_USER_ASSERTED_SUPPRESSED);
    const code = await runRefresh({
      ledgerPath,
      gmailRulesPath: rulesPath,
      credentialsPath: undefined,
      threadsPath,
      dryRun: false,
      classifyLearningsPath: learningsPath,
    });
    expect(code).toBe(0);
    const entries = loadLearningEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("sla-false-positive");
    expect(entries[0]?.threadId).toBe("msg_user_asserted_supp");
    expect(String(entries[0]?.reason)).toContain("user-asserted");
    expect(String(entries[0]?.reason)).toContain("mass-blast");
  });

  function existsSyncOrEmpty(p: string): Array<Record<string, unknown>> {
    try {
      const content = readFileSync(p, "utf-8");
      const sep = "\n---\n";
      const idx = content.indexOf(sep);
      if (idx < 0) return [];
      return content
        .slice(idx + sep.length)
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  }
});
