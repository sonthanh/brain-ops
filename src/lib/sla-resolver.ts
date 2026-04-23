import type { Identities } from "./identities.ts";
import type { SlaThread } from "./types.ts";

export type SlaTier = "fast" | "normal" | "slow";
export type SlaStatus = "breached" | "open";

export interface SlaRow {
  tier: SlaTier;
  owner: string;
  from: string;
  to: string;
  subject: string;
  messageId: string;
  receivedAtUtc: string;
  breachAtUtc: string;
  overdueOrRemaining: string;
  statusCell: string;
  category: string;
}

export interface ResolvedRow {
  tier: string;
  owner: string;
  from: string;
  subject: string;
  messageId: string;
  receivedAt: string;
  resolvedAtUtc: string;
  resolvedBy: string;
}

export interface SlaLedger {
  frontmatter: string;
  headingLine: string;
  headingTrailingBlank: string;
  lastComputedLine: string;
  headerCountsLine: string;
  preBreachedBlock: string;
  breached: SlaRow[];
  betweenBreachedAndOpenBlock: string;
  open: SlaRow[];
  betweenOpenAndResolvedBlock: string;
  resolved: ResolvedRow[];
  afterResolvedBlock: string;
}

export interface GuardFailure {
  messageId: string;
  guardNumber: 1 | 2 | 3 | 4;
  rawReason: string;
  latestCandidate: { date: string; from: string; to: string } | null;
}

export interface ResolveOptions {
  ledger: SlaLedger;
  threads: SlaThread[];
  identities: Identities;
  now: Date;
}

export interface ResolveResult {
  ledger: SlaLedger;
  resolvedIds: string[];
  reopenedIds: string[];
  guardFailures: GuardFailure[];
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const BREACHED_HEADING_RE = /^##\s+Breached\s*$/;
const OPEN_HEADING_RE = /^##\s+Open\s*\(within SLA\)\s*$/;
const RESOLVED_HEADING_RE = /^##\s+Resolved(\s+\(.+\))?\s*$/;
const TABLE_ROW_RE = /^\|/;
const TABLE_SEP_RE = /^\|\s*-+/;
const HEADER_COUNTS_RE = /^Open:\s+/;
const LAST_COMPUTED_RE = /^Last computed:/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function looksLikeHeaderRow(cells: string[]): boolean {
  const first = (cells[0] ?? "").toLowerCase();
  return first === "tier" || first.startsWith("tier");
}

function parseRow(cells: string[]): SlaRow | null {
  if (cells.length < 11) return null;
  const tier = cells[0] as SlaTier;
  if (tier !== "fast" && tier !== "normal" && tier !== "slow") return null;
  return {
    tier,
    owner: cells[1] ?? "",
    from: cells[2] ?? "",
    to: cells[3] ?? "",
    subject: cells[4] ?? "",
    messageId: cells[5] ?? "",
    receivedAtUtc: cells[6] ?? "",
    breachAtUtc: cells[7] ?? "",
    overdueOrRemaining: cells[8] ?? "",
    statusCell: cells[9] ?? "",
    category: cells[10] ?? "",
  };
}

function parseResolvedRow(cells: string[]): ResolvedRow | null {
  if (cells.length < 8) return null;
  return {
    tier: cells[0] ?? "",
    owner: cells[1] ?? "",
    from: cells[2] ?? "",
    subject: cells[3] ?? "",
    messageId: cells[4] ?? "",
    receivedAt: cells[5] ?? "",
    resolvedAtUtc: cells[6] ?? "",
    resolvedBy: cells[7] ?? "",
  };
}

function extractTable(
  lines: string[],
  startIdx: number,
): { rows: string[]; rowsStart: number; rowsEnd: number; headerEnd: number } {
  let i = startIdx;
  // Skip to first table row (header)
  while (i < lines.length && !TABLE_ROW_RE.test(lines[i] ?? "")) {
    if (/^##\s/.test(lines[i] ?? "")) break;
    i++;
  }
  const headerStart = i;
  // Collect header + separator
  let headerEnd = headerStart;
  while (headerEnd < lines.length && TABLE_ROW_RE.test(lines[headerEnd] ?? "")) {
    const line = lines[headerEnd] ?? "";
    headerEnd++;
    if (TABLE_SEP_RE.test(line)) break;
  }
  // Collect data rows
  const rows: string[] = [];
  let j = headerEnd;
  while (j < lines.length && TABLE_ROW_RE.test(lines[j] ?? "")) {
    rows.push(lines[j] ?? "");
    j++;
  }
  return { rows, rowsStart: headerStart, rowsEnd: j, headerEnd };
}

export function parseSlaLedger(content: string): SlaLedger {
  const lines = content.split("\n");

  // Frontmatter
  let frontmatterEnd = 0;
  if (lines[0] === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "---") {
        frontmatterEnd = i + 1;
        break;
      }
    }
  }
  // Find "# SLA Open Items"
  let headingIdx = -1;
  for (let i = frontmatterEnd; i < lines.length; i++) {
    if ((lines[i] ?? "").startsWith("# ")) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx < 0) {
    throw new Error(`parseSlaLedger: missing "# SLA Open Items" heading`);
  }
  const headingLine = lines[headingIdx] ?? "";

  // Preserve blank line(s) between frontmatter close and heading as part of
  // the frontmatter block so serialization round-trips the leading whitespace.
  const frontmatter = lines.slice(0, headingIdx).join("\n") +
    (headingIdx > 0 ? "\n" : "");

  let i = headingIdx + 1;
  let headingTrailingBlank = "";
  while (i < lines.length && isBlank(lines[i] ?? "")) {
    headingTrailingBlank += "\n";
    i++;
  }

  let lastComputedLine = "";
  let headerCountsLine = "";
  if (i < lines.length && LAST_COMPUTED_RE.test(lines[i] ?? "")) {
    lastComputedLine = lines[i] ?? "";
    i++;
  }
  if (i < lines.length && HEADER_COUNTS_RE.test(lines[i] ?? "")) {
    headerCountsLine = lines[i] ?? "";
    i++;
  }

  // preBreachedBlock — everything up to ## Breached
  let preBreachedStart = i;
  let breachedIdx = -1;
  for (let k = i; k < lines.length; k++) {
    if (BREACHED_HEADING_RE.test(lines[k] ?? "")) {
      breachedIdx = k;
      break;
    }
  }
  if (breachedIdx < 0) {
    throw new Error(`parseSlaLedger: missing "## Breached" heading`);
  }
  const preBreachedBlock = lines.slice(preBreachedStart, breachedIdx + 1).join("\n") + "\n";

  // Breached table
  const breachedTable = extractTable(lines, breachedIdx + 1);
  const breached: SlaRow[] = [];
  for (const r of breachedTable.rows) {
    const cells = splitRow(r);
    if (looksLikeHeaderRow(cells) || TABLE_SEP_RE.test(r)) continue;
    const row = parseRow(cells);
    if (row) {
      breached.push({ ...row, statusCell: row.statusCell || "🔴 breached" });
    }
  }

  // betweenBreachedAndOpenBlock — from rowsEnd up to ## Open
  let openIdx = -1;
  for (let k = breachedTable.rowsEnd; k < lines.length; k++) {
    if (OPEN_HEADING_RE.test(lines[k] ?? "")) {
      openIdx = k;
      break;
    }
  }
  if (openIdx < 0) {
    throw new Error(`parseSlaLedger: missing "## Open (within SLA)" heading`);
  }
  const betweenBreachedAndOpenBlock = lines
    .slice(breachedTable.rowsEnd, openIdx + 1)
    .join("\n") + "\n";

  // Open table
  const openTable = extractTable(lines, openIdx + 1);
  const open: SlaRow[] = [];
  for (const r of openTable.rows) {
    const cells = splitRow(r);
    if (looksLikeHeaderRow(cells) || TABLE_SEP_RE.test(r)) continue;
    const row = parseRow(cells);
    if (row) open.push({ ...row, statusCell: row.statusCell || "⏳ open" });
  }

  // betweenOpenAndResolvedBlock — up to ## Resolved
  let resolvedIdx = -1;
  for (let k = openTable.rowsEnd; k < lines.length; k++) {
    if (RESOLVED_HEADING_RE.test(lines[k] ?? "")) {
      resolvedIdx = k;
      break;
    }
  }
  if (resolvedIdx < 0) {
    throw new Error(`parseSlaLedger: missing "## Resolved" heading`);
  }
  const betweenOpenAndResolvedBlock = lines
    .slice(openTable.rowsEnd, resolvedIdx + 1)
    .join("\n") + "\n";

  // Resolved table
  const resolvedTable = extractTable(lines, resolvedIdx + 1);
  const resolved: ResolvedRow[] = [];
  for (const r of resolvedTable.rows) {
    const cells = splitRow(r);
    if (looksLikeHeaderRow(cells) || TABLE_SEP_RE.test(r)) continue;
    const row = parseResolvedRow(cells);
    if (row) resolved.push(row);
  }

  // afterResolvedBlock — remainder
  const afterResolvedBlock = lines.slice(resolvedTable.rowsEnd).join("\n");

  return {
    frontmatter,
    headingLine,
    headingTrailingBlank,
    lastComputedLine,
    headerCountsLine,
    preBreachedBlock,
    breached,
    betweenBreachedAndOpenBlock,
    open,
    betweenOpenAndResolvedBlock,
    resolved,
    afterResolvedBlock,
  };
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

const BREACHED_HEADER =
  "| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Overdue | Status | Category |";
const OPEN_HEADER =
  "| Tier | Owner | From | To | Subject | Message ID | Received (UTC) | Breach At (UTC) | Remaining | Status | Category |";
const ROW_SEP =
  "|------|-------|------|----|---------|------------|----------------|-----------------|---------|--------|----------|";
const ROW_SEP_OPEN =
  "|------|-------|------|----|---------|------------|----------------|-----------------|-----------|--------|----------|";
const RESOLVED_HEADER =
  "| Tier | Owner | From | Subject | Message ID | Received | Resolved (UTC) | Resolved by |";
const RESOLVED_SEP =
  "|------|-------|------|---------|------------|----------|----------------|-------------|";

function serializeRow(r: SlaRow): string {
  const cells = [
    r.tier,
    r.owner,
    r.from,
    r.to,
    r.subject,
    r.messageId,
    r.receivedAtUtc,
    r.breachAtUtc,
    r.overdueOrRemaining,
    r.statusCell,
    r.category,
  ];
  return `| ${cells.join(" | ")} |`;
}

function serializeResolvedRow(r: ResolvedRow): string {
  const cells = [
    r.tier,
    r.owner,
    r.from,
    r.subject,
    r.messageId,
    r.receivedAt,
    r.resolvedAtUtc,
    r.resolvedBy,
  ];
  return `| ${cells.join(" | ")} |`;
}

export function serializeSlaLedger(ledger: SlaLedger): string {
  const parts: string[] = [];

  parts.push(ledger.frontmatter);
  parts.push(ledger.headingLine + "\n");
  parts.push(ledger.headingTrailingBlank || "\n");

  if (ledger.lastComputedLine) parts.push(ledger.lastComputedLine + "\n");
  if (ledger.headerCountsLine) parts.push(ledger.headerCountsLine + "\n");

  parts.push(ledger.preBreachedBlock);
  parts.push(BREACHED_HEADER + "\n");
  parts.push(ROW_SEP + "\n");
  for (const r of ledger.breached) parts.push(serializeRow(r) + "\n");

  parts.push(ledger.betweenBreachedAndOpenBlock);
  parts.push(OPEN_HEADER + "\n");
  parts.push(ROW_SEP_OPEN + "\n");
  for (const r of ledger.open) parts.push(serializeRow(r) + "\n");

  parts.push(ledger.betweenOpenAndResolvedBlock);
  parts.push(RESOLVED_HEADER + "\n");
  parts.push(RESOLVED_SEP + "\n");
  for (const r of ledger.resolved) parts.push(serializeResolvedRow(r) + "\n");

  parts.push(ledger.afterResolvedBlock);

  return parts.join("");
}

// ---------------------------------------------------------------------------
// Resolve — 4-guard rule + follow-up re-open + status recompute + trim
// ---------------------------------------------------------------------------

/**
 * Parse an email header address field (e.g. `"Name <addr@host>"`, `"addr@host"`,
 * `"addr@host, addr2@host"`) into the first address, lower-cased. Returns
 * empty string if no address can be extracted.
 */
export function extractAddress(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  // Prefer angle-bracket form
  const angle = s.match(/<([^>]+)>/);
  if (angle && angle[1]) return angle[1].trim().toLowerCase();
  // Fallback: first token with an @
  const first = s.split(",")[0]?.trim() ?? "";
  const tok = first.split(/\s+/).find((t) => t.includes("@")) ?? first;
  return tok.replace(/[<>]/g, "").toLowerCase();
}

export function classifySender(
  address: string,
  identities: Identities,
): "me" | "team" | "external" {
  if (!address) return "external";
  if (identities.me.has(address)) return "me";
  const at = address.indexOf("@");
  if (at < 0) return "external";
  const domain = address.slice(at + 1);
  return identities.teamDomains.has(domain) ? "team" : "external";
}

const AUTO_REPLY_VALUES = new Set(["auto-replied", "auto-generated"]);

/**
 * True when the Auto-Submitted header disqualifies a message from counting as
 * a human reply under guard #4. Treats `null`, `""`, `"no"`, and
 * `"auto-notified"` as human-sent (per spec). Unknown values are logged by the
 * caller — we return false here to be liberal (prefer re-open over stuck
 * breach; the ledger is cheap to re-resolve).
 */
export function isAutoReply(autoSubmitted: string | null): boolean {
  if (autoSubmitted === null) return false;
  const v = autoSubmitted.toLowerCase().trim();
  if (v === "" || v === "no" || v === "auto-notified") return false;
  return AUTO_REPLY_VALUES.has(v);
}

function parseEmailDateMs(dateStr: string): number {
  if (!dateStr) return NaN;
  const ms = Date.parse(dateStr);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Parse `YYYY-MM-DD HH:MM` (treated as UTC) from the ledger. Returns NaN on
 * malformed input.
 */
function parseLedgerUtcMs(s: string): number {
  const m = (s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  );
}

function formatUtcMinute(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function formatUtcMinuteWithSuffix(d: Date): string {
  return `${formatUtcMinute(d)} UTC`;
}

function formatOverdueOrRemaining(
  row: SlaRow,
  targetMs: number,
  nowMs: number,
): string {
  const diffHours = Math.abs(targetMs - nowMs) / 3_600_000;
  const hoursStr = `${diffHours.toFixed(1)}h`;
  const bdStr = `${(diffHours / 24).toFixed(1)} bd`;
  const isBreached = row.statusCell.includes("breached");
  if (row.tier === "fast") return `~${hoursStr}`;
  if (isBreached) return diffHours >= 24 ? `~${bdStr}` : `~${hoursStr}`;
  return diffHours < 24 ? `~${hoursStr}` : `~${hoursStr} (~${bdStr})`;
}

function statusCellFor(tier: SlaTier, isBreached: boolean): string {
  if (!isBreached) return "⏳ open";
  switch (tier) {
    case "fast":
      return "🔴 breached";
    case "normal":
      return "🟠 breached";
    case "slow":
      return "🟡 breached";
  }
}

interface GuardEvaluation {
  resolved: boolean;
  failure: GuardFailure | null;
  resolvedBy: string;
  resolvedAt: Date;
}

/**
 * Apply the 4-guard rule against a thread for a given open/breached row.
 * Finds the latest message after `receivedAt` that passes all four guards.
 */
function evaluateGuards(
  row: SlaRow,
  thread: SlaThread,
  identities: Identities,
): GuardEvaluation {
  const receivedAtMs = parseLedgerUtcMs(row.receivedAtUtc);
  if (Number.isNaN(receivedAtMs)) {
    return {
      resolved: false,
      resolvedBy: "",
      resolvedAt: new Date(0),
      failure: {
        messageId: row.messageId,
        guardNumber: 1,
        rawReason: `unparseable receivedAtUtc="${row.receivedAtUtc}"`,
        latestCandidate: null,
      },
    };
  }
  const externalAddr = extractAddress(row.from);

  // Walk thread messages in chronological order.
  const withMs = thread.thread_messages.map((m) => ({
    msg: m,
    ms: parseEmailDateMs(m.date),
  }));
  withMs.sort((a, b) => a.ms - b.ms);

  let latestCandidate: { date: string; from: string; to: string } | null = null;
  let anyAfter = false;

  // Track the most recent failure so that if no pass is found we surface the
  // failure that would have resolved the item (prefer guard numbers that come
  // later in the chain — they're more informative for the user).
  let lastFailure: GuardFailure | null = null;

  for (const { msg, ms } of withMs) {
    if (!Number.isFinite(ms) || ms <= receivedAtMs) continue;
    anyAfter = true;
    latestCandidate = { date: msg.date, from: msg.from, to: msg.to };

    const senderAddr = extractAddress(msg.from);
    const senderClass = classifySender(senderAddr, identities);
    // Guard #2: reply sender is me OR team
    if (senderClass === "external") {
      lastFailure = {
        messageId: row.messageId,
        guardNumber: 2,
        rawReason: `reply from=${senderAddr} classified as external`,
        latestCandidate,
      };
      continue;
    }

    // Guard #3: reply addressed TO the original external party (allow CC/BCC — the
    // "to" header alone is checked). Internal CC-only means to header doesn't
    // contain the external party.
    const toAddresses = (msg.to ?? "")
      .split(",")
      .map((s) => extractAddress(s))
      .filter(Boolean);
    if (externalAddr && toAddresses.length > 0 && !toAddresses.includes(externalAddr)) {
      lastFailure = {
        messageId: row.messageId,
        guardNumber: 3,
        rawReason: `reply from=${senderAddr}, to=${toAddresses.join(",")} (external party ${externalAddr} not in To)`,
        latestCandidate,
      };
      continue;
    }

    // Guard #4: reply does NOT carry Auto-Submitted=auto-replied|auto-generated
    if (isAutoReply(msg.auto_submitted)) {
      lastFailure = {
        messageId: row.messageId,
        guardNumber: 4,
        rawReason: `auto_submitted=${JSON.stringify(msg.auto_submitted)}`,
        latestCandidate,
      };
      continue;
    }

    // All guards passed.
    return {
      resolved: true,
      resolvedBy: msg.from,
      resolvedAt: new Date(ms),
      failure: null,
    };
  }

  // Guard #1: no reply after receivedAt.
  if (!anyAfter) {
    return {
      resolved: false,
      resolvedBy: "",
      resolvedAt: new Date(0),
      failure: {
        messageId: row.messageId,
        guardNumber: 1,
        rawReason: `no reply after ${row.receivedAtUtc} UTC`,
        latestCandidate,
      },
    };
  }

  return {
    resolved: false,
    resolvedBy: "",
    resolvedAt: new Date(0),
    failure: lastFailure,
  };
}

/**
 * Detect follow-up re-open — a Resolved row whose thread contains an external
 * reply newer than `resolvedAtUtc`. Those move back to Open/Breached with
 * `receivedAt = newExternalMessage.date` (still the original tier/owner).
 */
interface ReopenDecision {
  row: ResolvedRow;
  newReceivedAtUtc: string;
  newReceivedMs: number;
}

function detectReopen(
  resolved: ResolvedRow,
  thread: SlaThread,
  identities: Identities,
): ReopenDecision | null {
  const resolvedMs = (() => {
    const m = (resolved.resolvedAtUtc ?? "").match(
      /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+UTC$/,
    );
    if (!m) return NaN;
    return Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
    );
  })();
  if (!Number.isFinite(resolvedMs)) return null;

  const withMs = thread.thread_messages.map((m) => ({ msg: m, ms: parseEmailDateMs(m.date) }));
  withMs.sort((a, b) => a.ms - b.ms);
  for (const { msg, ms } of withMs) {
    if (!Number.isFinite(ms) || ms <= resolvedMs) continue;
    const senderClass = classifySender(extractAddress(msg.from), identities);
    if (senderClass === "external" && !isAutoReply(msg.auto_submitted)) {
      return {
        row: resolved,
        newReceivedAtUtc: formatUtcMinute(new Date(ms)),
        newReceivedMs: ms,
      };
    }
  }
  return null;
}

function computeBreachAtMs(receivedMs: number, tier: SlaTier): number {
  if (tier === "fast") {
    return receivedMs + 4 * 3_600_000;
  }
  // normal=2 bd, slow=5 bd; count only Mon–Fri wall-clock hours.
  const targetBd = tier === "normal" ? 2 : 5;
  // Simple model: add wall-clock days, but when landing on a weekend day,
  // push forward to Monday at the same time. Counted 24h blocks of weekday
  // time, skipping Sat/Sun.
  let cursor = new Date(receivedMs);
  let added = 0;
  const stepMs = 24 * 3_600_000;
  while (added < targetBd) {
    cursor = new Date(cursor.getTime() + stepMs);
    const day = cursor.getUTCDay(); // 0 Sun, 6 Sat
    if (day !== 0 && day !== 6) added++;
  }
  return cursor.getTime();
}

const ONE_DAY_MS = 24 * 3_600_000;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

export function resolveSlaLedger(opts: ResolveOptions): ResolveResult {
  const { ledger, threads, identities, now } = opts;
  const nowMs = now.getTime();
  const threadByMessageId = new Map(threads.map((t) => [t.message_id, t]));

  const resolvedIds: string[] = [];
  const reopenedIds: string[] = [];
  const guardFailures: GuardFailure[] = [];

  const resolvedOut: ResolvedRow[] = [];
  const reopenRows: SlaRow[] = [];

  // --- Re-open pass: check existing Resolved rows for external follow-ups. ---
  const keepResolved: ResolvedRow[] = [];
  for (const r of ledger.resolved) {
    const thread = threadByMessageId.get(r.messageId);
    const reopen = thread ? detectReopen(r, thread, identities) : null;
    if (reopen) {
      reopenedIds.push(r.messageId);
      // Reconstruct a row at same tier/owner — lift from original Resolved data.
      const tier = (r.tier === "fast" || r.tier === "normal" || r.tier === "slow")
        ? (r.tier as SlaTier)
        : "normal";
      const breachAtMs = computeBreachAtMs(reopen.newReceivedMs, tier);
      const breachAt = formatUtcMinute(new Date(breachAtMs));
      const isBreached = nowMs >= breachAtMs;
      const sc = statusCellFor(tier, isBreached);
      const synthetic: SlaRow = {
        tier,
        owner: r.owner,
        from: r.from,
        to: "",
        subject: r.subject,
        messageId: r.messageId,
        receivedAtUtc: reopen.newReceivedAtUtc,
        breachAtUtc: breachAt,
        overdueOrRemaining: "",
        statusCell: sc,
        category: "team-sla-at-risk",
      };
      synthetic.overdueOrRemaining = formatOverdueOrRemaining(
        synthetic,
        breachAtMs,
        nowMs,
      );
      reopenRows.push(synthetic);
    } else {
      keepResolved.push(r);
    }
  }

  // --- Resolution pass on active rows (breached + open). ---
  function processActive(rows: SlaRow[]): SlaRow[] {
    const out: SlaRow[] = [];
    for (const row of rows) {
      const thread = threadByMessageId.get(row.messageId);
      if (!thread) {
        // Thread data unavailable; leave row unchanged but recompute status vs clock.
        out.push(recomputeRowStatus(row, nowMs));
        continue;
      }
      const evaluation = evaluateGuards(row, thread, identities);
      if (evaluation.resolved) {
        resolvedIds.push(row.messageId);
        resolvedOut.push({
          tier: row.tier,
          owner: row.owner,
          from: row.from,
          subject: row.subject,
          messageId: row.messageId,
          receivedAt: row.receivedAtUtc,
          resolvedAtUtc: formatUtcMinuteWithSuffix(evaluation.resolvedAt),
          resolvedBy: evaluation.resolvedBy,
        });
        continue;
      }
      if (evaluation.failure) guardFailures.push(evaluation.failure);
      out.push(recomputeRowStatus(row, nowMs));
    }
    return out;
  }

  const breachedAfter = processActive(ledger.breached);
  const openAfter = processActive(ledger.open);

  // Combine re-opened rows into open or breached based on status.
  for (const r of reopenRows) {
    if (r.statusCell.includes("breached")) {
      breachedAfter.push(r);
    } else {
      openAfter.push(r);
    }
  }

  // Rows may have crossed the breach boundary — shift between lists.
  const newBreached: SlaRow[] = [];
  const newOpen: SlaRow[] = [];
  for (const r of [...breachedAfter, ...openAfter]) {
    if (r.statusCell.includes("breached")) newBreached.push(r);
    else newOpen.push(r);
  }

  // Stable sort: breached by tier urgency then oldest-first; open by breach_at.
  const TIER_ORDER: Record<SlaTier, number> = { fast: 0, normal: 1, slow: 2 };
  newBreached.sort((a, b) => {
    const t = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (t !== 0) return t;
    return (a.receivedAtUtc ?? "").localeCompare(b.receivedAtUtc ?? "");
  });
  newOpen.sort((a, b) => {
    return (a.breachAtUtc ?? "").localeCompare(b.breachAtUtc ?? "");
  });

  // Merge newly-resolved rows into keepResolved and trim to last 7 days.
  const mergedResolved = [...keepResolved, ...resolvedOut];
  const trimmedResolved = mergedResolved.filter((r) => {
    const m = (r.resolvedAtUtc ?? "").match(
      /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s+UTC$/,
    );
    if (!m) return true; // keep if unparseable — don't silently drop
    const ms = Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
    );
    return nowMs - ms <= SEVEN_DAYS_MS;
  });
  // Sort resolved by resolvedAt descending (newest first, matches existing convention).
  trimmedResolved.sort((a, b) => (b.resolvedAtUtc ?? "").localeCompare(a.resolvedAtUtc ?? ""));

  // Recompute header counts.
  const fastBreached = newBreached.filter((r) => r.tier === "fast").length;
  const normalBreached = newBreached.filter((r) => r.tier === "normal").length;
  const slowBreached = newBreached.filter((r) => r.tier === "slow").length;
  const headerCountsLine = `Open: ${newOpen.length} | Breached: ${newBreached.length} (fast: ${fastBreached}, normal: ${normalBreached}, slow: ${slowBreached})`;
  const lastComputedLine = `Last computed: ${formatUtcMinuteWithSuffix(now)}`;

  const updatedLedger: SlaLedger = {
    ...ledger,
    headerCountsLine,
    lastComputedLine,
    breached: newBreached,
    open: newOpen,
    resolved: trimmedResolved,
  };

  return { ledger: updatedLedger, resolvedIds, reopenedIds, guardFailures };
}

function recomputeRowStatus(row: SlaRow, nowMs: number): SlaRow {
  const breachMs = parseLedgerUtcMs(row.breachAtUtc);
  if (!Number.isFinite(breachMs)) {
    // Leave unchanged if we can't parse.
    return row;
  }
  const isBreached = nowMs >= breachMs;
  const statusCell = statusCellFor(row.tier, isBreached);
  const next: SlaRow = {
    ...row,
    statusCell,
  };
  next.overdueOrRemaining = formatOverdueOrRemaining(next, breachMs, nowMs);
  return next;
}

/**
 * Format a guard-failure comment block to append to the ledger for the
 * current refresh run. One line per failure, naming the guard number, raw
 * reason, and latest candidate (if any). This is the diagnostic surface
 * required by commands/gmail-triage.md §8 step 7.
 */
export function formatGuardFailureComment(
  failures: GuardFailure[],
  now: Date,
): string {
  if (failures.length === 0) return "";
  const stamp = formatUtcMinuteWithSuffix(now);
  const lines: string[] = [
    "",
    `<!-- SLA refresh guard-failure log — ${stamp} (${failures.length} row(s) STILL BREACHED):`,
  ];
  for (const f of failures) {
    const cand = f.latestCandidate
      ? ` — candidate reply ${f.latestCandidate.date} from=${f.latestCandidate.from} to=${f.latestCandidate.to}`
      : "";
    lines.push(`  - ${f.messageId}: guard #${f.guardNumber} fail — ${f.rawReason}${cand}`);
  }
  lines.push("-->");
  lines.push("");
  return lines.join("\n");
}
