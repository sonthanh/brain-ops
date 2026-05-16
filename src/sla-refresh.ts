import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseIdentities } from "./lib/identities.ts";
import { fetchSlaThreads } from "./gmail-fetch.ts";
import { appendLearningIfAbsent } from "./lib/learnings.ts";
import {
  formatGuardFailureComment,
  formatSweepDropComment,
  parseSlaLedger,
  resolveSlaLedger,
  serializeSlaLedger,
  validateSlaLedger,
} from "./lib/sla-resolver.ts";
import type { ResolvedRow, SlaRow } from "./lib/sla-resolver.ts";
import type { SlaThread } from "./lib/types.ts";

interface Args {
  ledgerPath: string;
  gmailRulesPath: string;
  credentialsPath: string | undefined;
  threadsPath: string | undefined;
  dryRun: boolean;
  /**
   * Override target for sla-false-positive learning entries. When undefined,
   * defaults to the workspace-relative path that matches
   * `gmail-lifecycle-check`'s `CLASSIFY_LEARNINGS_PATH` env var so the
   * classifier sees both lifecycle and SLA signals from one file. The
   * gmail-triage workflow runs both actions from the vault root so the
   * relative path resolves identically.
   */
  classifyLearningsPath: string | undefined;
}

const USER_ASSERTED_PATTERN = /user-asserted/i;

function parseArgs(raw: string[]): Args {
  const get = (flag: string): string | undefined => {
    const withEq = raw.find((a) => a.startsWith(`${flag}=`));
    if (withEq) return withEq.slice(flag.length + 1);
    const idx = raw.indexOf(flag);
    if (idx >= 0 && idx + 1 < raw.length) return raw[idx + 1];
    return undefined;
  };
  return {
    ledgerPath: get("--ledger") ?? "business/intelligence/emails/sla-open.md",
    gmailRulesPath: get("--gmail-rules") ?? "business/intelligence/gmail-rules.md",
    credentialsPath: get("--credentials"),
    threadsPath: get("--threads"),
    dryRun: raw.includes("--dry-run"),
    classifyLearningsPath: get("--classify-learnings"),
  };
}

/**
 * Scan the post-refresh ledger for rows the user manually annotated with
 * `user-asserted ...` in the audit-trail cell — these are false positives the
 * resolver could not close via guard evidence. Each row becomes a deduped
 * learning entry so the classifier skips matching threads on the next run.
 *
 * Idempotent across runs: dedup keyed on `(threadId, type)` in
 * `appendLearningIfAbsent`. First refresh after the user edits the ledger
 * emits; subsequent refreshes no-op even though the row still sits in the
 * `## Resolved` table (rows persist for 7d trim, see `trimmedResolved`).
 *
 * Walks BOTH `## Resolved` and `## Auto-suppressed` because the user routes
 * mass-blast / portal / Zendesk false positives to either bucket depending on
 * whether they want the row to count as a closed thread or as a
 * never-should-have-tracked. Sweep-dropped rows do NOT pass through here —
 * those land in a comment block, handled by a separate pipeline.
 */
function captureSlaFalsePositives(
  resolved: ResolvedRow[],
  suppressed: SlaRow[],
  observedAt: string,
  learningsPath: string,
): number {
  let emitted = 0;
  for (const row of resolved) {
    if (!USER_ASSERTED_PATTERN.test(row.resolvedBy)) continue;
    const appended = appendLearningIfAbsent(learningsPath, {
      type: "sla-false-positive",
      threadId: row.messageId,
      subject: row.subject,
      sender: row.from,
      reason: row.resolvedBy,
      observedAt,
    });
    if (appended) emitted++;
  }
  for (const row of suppressed) {
    if (!USER_ASSERTED_PATTERN.test(row.replyReason)) continue;
    const appended = appendLearningIfAbsent(learningsPath, {
      type: "sla-false-positive",
      threadId: row.messageId,
      subject: row.subject,
      sender: row.from,
      reason: row.replyReason,
      observedAt,
    });
    if (appended) emitted++;
  }
  return emitted;
}

async function loadThreads(args: Args, teamDomains?: Set<string>): Promise<SlaThread[]> {
  // Precedence:
  // 1. --threads <path> → read pre-fetched JSON (used by gmail-triage.yml post-step
  //    to reuse the same thread data the classifier saw — avoids a second API call).
  // 2. --credentials <path> → fetch threads live from Gmail API (with cross-thread
  //    reply search when teamDomains is supplied).
  // 3. Neither → empty array (recompute-only mode: no resolution, just status + counts).
  if (args.threadsPath) {
    if (!existsSync(args.threadsPath)) {
      console.error(`[sla-refresh] --threads ${args.threadsPath} not found, treating as empty`);
      return [];
    }
    const raw = readFileSync(args.threadsPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`[sla-refresh] --threads file must contain a JSON array`);
    }
    return parsed as SlaThread[];
  }
  if (args.credentialsPath) {
    return await fetchSlaThreads({
      ledgerPath: args.ledgerPath,
      credentialsPath: args.credentialsPath,
      dryRun: args.dryRun,
      ...(teamDomains ? { teamDomains } : {}),
    });
  }
  console.error(`[sla-refresh] no --threads or --credentials — running in recompute-only mode`);
  return [];
}

export async function runRefresh(args: Args): Promise<number> {
  if (!existsSync(args.ledgerPath)) {
    console.error(`[sla-refresh] ledger not found at ${args.ledgerPath} — nothing to refresh`);
    return 0;
  }
  const original = readFileSync(args.ledgerPath, "utf-8");
  const parsed = parseSlaLedger(original);

  // Identities are loaded first because thread-fetch uses teamDomains for
  // the cross-thread reply search (catches Zendesk / forked-thread team
  // replies). Without teamDomains, the fetch is single-thread only.
  const identities = parseIdentities(args.gmailRulesPath);
  const threads = await loadThreads(args, identities.teamDomains);
  const now = new Date();

  // Rule-sweep pass (deterministic invariants). Drops awareness / automation /
  // billing / invitation / portal / mass-blast rows that shouldn't be in the
  // active ledger. Runs BEFORE resolveSlaLedger so the resolver sees a clean
  // row set.
  const validation = validateSlaLedger(parsed, { threads });

  const result = resolveSlaLedger({
    ledger: validation.ledger,
    threads,
    identities,
    now,
  });
  const guardComment = formatGuardFailureComment(result.guardFailures, now);
  const sweepComment = formatSweepDropComment(validation.drops, now);
  const updated = {
    ...result.ledger,
    afterResolvedBlock:
      result.ledger.afterResolvedBlock + guardComment + sweepComment,
  };
  const serialized = serializeSlaLedger(updated);

  // Learning-capture pass — emits one entry per user-asserted false positive
  // into the classify-learnings file the classifier loads next pre-classify
  // run. Dedup-keyed on threadId so re-running this refresh is idempotent.
  // Path resolution mirrors gmail-lifecycle-check.ts so both writers share
  // one file (the classifier prompt loads only one path).
  //
  // Runs BEFORE the byte-identical early return because a user-asserted row
  // typically arrives via direct vault edit — the next refresh produces an
  // identical ledger (the rule sweep / resolver doesn't touch Resolved-row
  // text) yet still needs to surface the new row to the classifier exactly
  // once. Dedup in `appendLearningIfAbsent` makes subsequent ticks no-op.
  //
  // Dry-run skips emission entirely so dry-run remains side-effect-free.
  if (!args.dryRun) {
    const learningsPath =
      args.classifyLearningsPath ??
      process.env.CLASSIFY_LEARNINGS_PATH ??
      "business/intelligence/gmail-classify-learnings.md";
    const observedAt = now.toISOString();
    const emitted = captureSlaFalsePositives(
      result.ledger.resolved,
      result.ledger.suppressed,
      observedAt,
      learningsPath,
    );
    if (emitted > 0) {
      process.stdout.write(
        `[sla-refresh] captured ${emitted} sla-false-positive learning entr${emitted === 1 ? "y" : "ies"} -> ${learningsPath}\n`,
      );
    }
  }

  if (serialized === original) {
    console.log("[sla-refresh] no changes — ledger byte-identical");
    return 0;
  }
  if (args.dryRun) {
    console.log("[sla-refresh] --dry-run: would write ledger");
    console.log(
      `[sla-refresh] resolved=${result.resolvedIds.length} reopened=${result.reopenedIds.length} sweepDropped=${validation.drops.length} guardFailures=${result.guardFailures.length}`,
    );
    return 0;
  }
  writeFileSync(args.ledgerPath, serialized, "utf-8");
  console.log(
    `[sla-refresh] updated ${args.ledgerPath}: resolved=${result.resolvedIds.length} reopened=${result.reopenedIds.length} sweepDropped=${validation.drops.length} guardFailures=${result.guardFailures.length}`,
  );
  if (result.resolvedIds.length > 0) console.log(`  resolved: ${result.resolvedIds.join(", ")}`);
  if (result.reopenedIds.length > 0) console.log(`  reopened: ${result.reopenedIds.join(", ")}`);
  if (validation.drops.length > 0) {
    console.log(
      `  sweep-dropped: ${validation.drops.map((d) => d.row.messageId).join(", ")}`,
    );
  }
  return 0;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  runRefresh(args)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error("[sla-refresh] fatal:", e);
      process.exit(1);
    });
}
