import { createGmailClient } from "./lib/gmail-client.ts";
import { parseIdentities } from "./lib/identities.ts";
import { readLedger, writeLedger, removeProcessedRows } from "./lib/ledger.ts";
import { checkLifecycle } from "./lib/lifecycle.ts";
import { appendLearning } from "./lib/learnings.ts";

export interface LifecycleRunOptions {
  ledgerPath: string;
  rulesPath: string;
  classifyLearningsPath: string;
  draftLearningsPath: string;
  credentialsPath?: string;
  staleDays?: number;
  now?: Date;
}

export interface LifecycleRunCounts {
  processed: number;
  deleted: number;
  sentAsIs: number;
  sentEdited: number;
  teamHandled: number;
  stale: number;
  orphanDraftsDeleted: number;
  ledgerBefore: number;
  ledgerAfter: number;
}

export async function runLifecycleCheck(
  options: LifecycleRunOptions,
): Promise<LifecycleRunCounts> {
  const rows = readLedger(options.ledgerPath);
  if (rows.length === 0) {
    console.log("lifecycle-check: ledger empty, nothing to inspect");
    return {
      processed: 0,
      deleted: 0,
      sentAsIs: 0,
      sentEdited: 0,
      teamHandled: 0,
      stale: 0,
      orphanDraftsDeleted: 0,
      ledgerBefore: 0,
      ledgerAfter: 0,
    };
  }

  const identities = parseIdentities(options.rulesPath);
  const gmail = createGmailClient(options.credentialsPath);
  const result = await checkLifecycle({
    ledgerRows: rows,
    gmail,
    identities,
    now: options.now ?? new Date(),
    ...(options.staleDays !== undefined ? { staleDays: options.staleDays } : {}),
  });

  for (const signal of result.classifySignals) {
    appendLearning(options.classifyLearningsPath, signal);
  }
  for (const signal of result.draftSignals) {
    appendLearning(options.draftLearningsPath, signal);
  }

  const survivors = removeProcessedRows(rows, result.processedDraftIds);
  writeLedger(options.ledgerPath, survivors);

  const counts: LifecycleRunCounts = {
    processed: result.processedDraftIds.length,
    deleted: result.classifySignals.filter((s) => s.type === "deleted").length,
    sentAsIs: result.draftSignals.filter((s) => s.type === "sent-as-is").length,
    sentEdited: result.draftSignals.filter((s) => s.type === "sent-edited").length,
    teamHandled: result.classifySignals.filter((s) => s.type === "team-handled").length,
    stale: result.classifySignals.filter((s) => s.type === "stale").length,
    orphanDraftsDeleted: result.orphanDraftsDeleted.length,
    ledgerBefore: rows.length,
    ledgerAfter: survivors.length,
  };
  console.log(`lifecycle-check: ${JSON.stringify(counts)}`);
  return counts;
}

if (import.meta.main) {
  const env = process.env;
  const ledgerPath =
    env.DRAFTS_LEDGER_PATH ?? "business/intelligence/emails/drafts-outstanding.md";
  const rulesPath = env.GMAIL_RULES_PATH ?? "business/intelligence/gmail-rules.md";
  const classifyLearningsPath =
    env.CLASSIFY_LEARNINGS_PATH ?? "business/intelligence/gmail-classify-learnings.md";
  const draftLearningsPath =
    env.DRAFT_LEARNINGS_PATH ?? "business/intelligence/gmail-draft-learnings.md";
  const staleDaysStr = env.STALE_DAYS;
  const staleDays = staleDaysStr ? parseInt(staleDaysStr, 10) : undefined;

  runLifecycleCheck({
    ledgerPath,
    rulesPath,
    classifyLearningsPath,
    draftLearningsPath,
    ...(staleDays !== undefined && !Number.isNaN(staleDays) ? { staleDays } : {}),
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
