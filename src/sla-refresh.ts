import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseIdentities } from "./lib/identities.ts";
import { fetchSlaThreads } from "./gmail-fetch.ts";
import {
  formatGuardFailureComment,
  parseSlaLedger,
  resolveSlaLedger,
  serializeSlaLedger,
} from "./lib/sla-resolver.ts";
import type { SlaThread } from "./lib/types.ts";

interface Args {
  ledgerPath: string;
  gmailRulesPath: string;
  credentialsPath: string | undefined;
  threadsPath: string | undefined;
  dryRun: boolean;
}

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
  };
}

async function loadThreads(args: Args): Promise<SlaThread[]> {
  // Precedence:
  // 1. --threads <path> → read pre-fetched JSON (used by gmail-triage.yml post-step
  //    to reuse the same thread data the classifier saw — avoids a second API call).
  // 2. --credentials <path> → fetch threads live from Gmail API.
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
  const ledger = parseSlaLedger(original);
  const threads = await loadThreads(args);
  const identities = parseIdentities(args.gmailRulesPath);
  const now = new Date();

  const result = resolveSlaLedger({ ledger, threads, identities, now });
  const guardComment = formatGuardFailureComment(result.guardFailures, now);
  const updated = {
    ...result.ledger,
    afterResolvedBlock: result.ledger.afterResolvedBlock + guardComment,
  };
  const serialized = serializeSlaLedger(updated);

  if (serialized === original) {
    console.log("[sla-refresh] no changes — ledger byte-identical");
    return 0;
  }
  if (args.dryRun) {
    console.log("[sla-refresh] --dry-run: would write ledger");
    console.log(
      `[sla-refresh] resolved=${result.resolvedIds.length} reopened=${result.reopenedIds.length} guardFailures=${result.guardFailures.length}`,
    );
    return 0;
  }
  writeFileSync(args.ledgerPath, serialized, "utf-8");
  console.log(
    `[sla-refresh] updated ${args.ledgerPath}: resolved=${result.resolvedIds.length} reopened=${result.reopenedIds.length} guardFailures=${result.guardFailures.length}`,
  );
  if (result.resolvedIds.length > 0) console.log(`  resolved: ${result.resolvedIds.join(", ")}`);
  if (result.reopenedIds.length > 0) console.log(`  reopened: ${result.reopenedIds.join(", ")}`);
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
