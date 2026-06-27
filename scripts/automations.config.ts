// automations.config.ts — declarative registry of brain automations run headlessly via
// `claude -p` under launchd (the post-2026-06-27 model; see run-automation.ts header).
//
// Each entry is DATA (prompt + schedule + gates); run-automation.ts is the LOGIC. Schedules
// here are the source of truth that gen-automation-plists.ts renders into launchd plists.
//
// Prompts are ported from the former Orca automations with the Orca-specific teardown stripped
// (no `orca terminal close`, no "don't close your terminal" notes) — `claude -p` exits on its
// own with a real exit code, so there is nothing to tear down and nothing to mislabel.

export type DedupKey = "day" | "hour" | "none";

export interface AutomationSpec {
  /** Stable id — used for state dir, log file, launchd label suffix. */
  id: string;
  /** Human label for logs/alerts. */
  label: string;
  /** Model for `claude --model`. sonnet = mechanical/cheap; opus = judgment/content. */
  model: "sonnet" | "opus" | "haiku";
  /** Absolute working directory the skill runs from (the repo it operates on). */
  workdir: string;
  /** The full `claude -p` prompt — normally a `/goal …` task with an explicit done-condition. */
  prompt: string;
  /** launchd schedule: array of {Hour, Minute, [Weekday]} calendar entries (local tz). */
  schedule: { Hour: number; Minute: number; Weekday?: number }[];
  /** Defensive double-fire guard granularity. Daily jobs → "day"; multi-per-day → "hour". */
  dedup: DedupKey;
  /** Skip the run when weekly subscription usage is at/over threshold (protects quota). */
  quotaGate: boolean;
  /** Optional precheck shell command; non-zero exit ⇒ record a skipped run and don't invoke claude. */
  precheck?: string;
  /** Telegram-alert on non-zero claude exit (uses ~/.config/brain/env creds). */
  alertOnFail: boolean;
}

const HOME = process.env.HOME ?? "";
const BRAIN = `${HOME}/work/brain`;
const BUN_BIN = "/opt/homebrew/bin/bun";

const GEO = `${HOME}/work/brain-geo-analysis-plugin`;
const PLUGIN = `${HOME}/work/brain-os-plugin`;

export const AUTOMATIONS: Record<string, AutomationSpec> = {
  "vault-lint": {
    id: "vault-lint",
    label: "Vault lint",
    model: "sonnet",
    workdir: BRAIN,
    schedule: [{ Hour: 3, Minute: 0 }],
    dedup: "day",
    quotaGate: true,
    alertOnFail: true,
    prompt:
      "/goal Run the /vault-lint skill to completion for the brain vault. Done means: broken wiki-links fixed, orphan pages detected, directory indexes synced, stale GH-issue tasks flagged, the maintenance report written under daily/organize-reports/, and all changes committed and pushed to main. If there is genuinely nothing to fix, still write the report noting that and push. Do not stop, and do not pause to ask for confirmation, until the report is written and the working tree is clean and pushed.",
  },

  "auto-journal": {
    id: "auto-journal",
    label: "Auto journal",
    model: "sonnet",
    workdir: BRAIN,
    schedule: [{ Hour: 8, Minute: 0 }],
    dedup: "day",
    quotaGate: true,
    alertOnFail: true,
    prompt:
      "/goal Run the /journal skill for yesterday to completion. Done means: yesterday's work across all repos is aggregated into a journal note under daily/journal/, written with all required sections, committed and pushed to main. If yesterday had no activity, record that briefly and stop. Do not stop or pause to ask for confirmation until the journal note exists and is pushed (or no-activity is confirmed).",
  },

  "improve-skills": {
    id: "improve-skills",
    label: "Improve skills",
    model: "opus",
    workdir: PLUGIN,
    schedule: [{ Hour: 20, Minute: 0 }],
    dedup: "day",
    quotaGate: true,
    alertOnFail: true,
    precheck: `${BUN_BIN} run ${HOME}/work/brain-ops/scripts/precheck-improve.ts`,
    prompt:
      "/goal Improve the highest-failure-rate brain-os skill end-to-end. Steps: (1) run /improve memory to triage feedback memories, reconcile the index, and expire stale memories; (2) run /improve to rank skills by failure rate and identify the single top candidate; (3) if a candidate qualifies, run /improve <candidate> through the full Phase 1-5 pipeline including the eval gate; (4) commit and push any skill changes. Done means the pipeline ran to completion for the top candidate (or you confirmed no candidate qualifies) and changes are pushed. Do not stop mid-pipeline or pause to ask for confirmation.",
  },

  "refactor-scan": {
    id: "refactor-scan",
    label: "Refactor scan",
    model: "opus",
    workdir: BRAIN,
    schedule: [{ Hour: 2, Minute: 0, Weekday: 0 }], // Sunday
    dedup: "day",
    quotaGate: true,
    alertOnFail: true,
    prompt:
      "/goal Run the /refactor system-level reorganization scan to completion in cron mode (skip the interactive /to-issues quiz). Done means: the scan for shallow modules, cross-skill duplication, unused code, and vault drift is complete, findings written to the refactor report under daily/, and GH issues for actionable findings filed in sonthanh/ai-brain. Report-only for code unless a fix is trivially safe. Do not stop or pause to ask for confirmation until the report is written.",
  },

  "story-doctor": {
    id: "story-doctor",
    label: "Story doctor",
    model: "opus",
    workdir: PLUGIN,
    schedule: [
      { Hour: 7, Minute: 0 },
      { Hour: 13, Minute: 0 },
      { Hour: 19, Minute: 0 },
    ],
    dedup: "hour",
    quotaGate: true,
    alertOnFail: true,
    prompt:
      "/goal Close the learn-fix-continue loop on stalled autonomous work in sonthanh/ai-brain. Steps: (1) FIND dead-ends: open issues labeled owner:human + status:ready whose comments contain 'AFK gave up after 3 ralph iters.' (verify each with gh issue view <N> --comments — the marker comment is mandatory; never touch human-origin issues without it). (2) LEARN + FIX (max 3 issues per run): for each dead-end, read the last failure and advisor verdict from the handoff comment, run /debug on that failure to get a root cause and /tdd fix plan, and let /debug file the fix issue; if the fix touches only leaf paths (NOT trunk: CLAUDE.md, RESOLVER.md, working-rules.md, hooks/, references/, skill-spec.md, plugin.json) label the fix issue owner:bot + status:ready so pickup-auto implements it on its next 2h tick; the fix issue body must reference the original child issue number. Retry cap: if an issue already has 2 prior doctor-filed fix issues referencing it, skip it and leave for /pickup. (3) RE-QUEUE: for any previously-doctored issue whose fix issue is now CLOSED but which is still owner:human + status:ready, flip it back to owner:bot + status:ready with a comment 'fix #<M> landed — re-queueing (doctor attempt <k>)' so the DAG continues. (4) CONTINUE: for each open type:plan parent whose children are ALL closed, close the parent and tick remaining checkboxes; parents with ready owner:bot children need no action (pickup-auto drains them). (5) LOG: append one outcome row to the vault at ~/work/brain/daily/skill-outcomes/story-doctor.log (format: date | story-doctor | doctor | sonthanh/ai-brain | <issues touched or none> | commit:- | pass/partial) and, only if any action was taken, a 5-line report comment on the affected parent story. Done means steps 1-5 completed (or you confirmed there are no dead-ends, no re-queue candidates, and no closable parents — then just append the log row and stop). Do not stop or pause to ask for confirmation.",
  },

  "weekday-audit": {
    id: "weekday-audit",
    label: "Weekday repo audit",
    model: "sonnet",
    workdir: PLUGIN,
    schedule: [1, 2, 3, 4, 5].map((Weekday) => ({ Hour: 9, Minute: 0, Weekday })),
    dedup: "day",
    quotaGate: true,
    alertOnFail: false,
    prompt:
      "Review the repository health. Check dependency updates, failing tests, lint/typecheck status, and risky open changes. Summarize findings and suggest the next action.",
  },

  "backlog-cleanup": {
    id: "backlog-cleanup",
    label: "Weekly issue-backlog cleanup",
    model: "opus",
    workdir: BRAIN,
    schedule: [{ Hour: 9, Minute: 0, Weekday: 1 }], // Monday
    dedup: "day",
    quotaGate: true,
    alertOnFail: true,
    prompt:
      "/goal Weekly GitHub issue-backlog cleanup for sonthanh/ai-brain. Reduce clutter by closing only issues that are genuinely DONE, OBSOLETE, or DUPLICATES. This backlog is ~94% human-gated — most issues must stay open. When in doubt, LEAVE IT. This task ONLY closes/comments GitHub issues via gh: make NO file edits and NO git commits in any repo. STEP 1 — list open issues: gh issue list --repo sonthanh/ai-brain --state open --limit 300 --json number,title,labels,updatedAt,body. STEP 2 — for each, VERIFY live state with `gh issue view <N>` (never trust a stale list), then close ONLY high-confidence cases: (a) ALREADY SHIPPED — a linked PR/commit merged, or the change clearly landed; (b) STALE ARTIFACT — an auto-generated report/log issue whose actionable content is already captured elsewhere; (c) SUPERSEDED / DUPLICATE — a newer issue or shipped decision replaces it (link the survivor in the comment); (d) ALREADY RESOLVED — e.g. a memory-triage issue whose source file is gone. Close via: bash ~/work/brain-os-plugin/scripts/gh-tasks/close-issue.sh <N> --comment \"<one-line reason — and 'reopen if I misjudged this'>\". STEP 3 — NEVER auto-close (leave them, post NO comment): strategic / EMVN / company work; creative music-lyric work; content/writing voice work; stories / plans needing decomposition (type:plan); anything with recent activity, an active human decision, or genuine open value. STEP 4 — conservatism is the whole point: if you are not HIGHLY confident an issue is done/obsolete/duplicate, do NOT close it. Closing zero issues is a valid, good outcome. Done means you finished with a summary: each issue closed + its one-line reason, and the count left open. Do not pause to ask for confirmation.",
  },

  "geo-dev": {
    id: "geo-dev",
    label: "Geo dev",
    model: "opus",
    workdir: GEO,
    schedule: [{ Hour: 7, Minute: 0 }],
    dedup: "day",
    quotaGate: true,
    alertOnFail: true,
    precheck: `${BUN_BIN} run ${GEO}/scripts/geo-dev-precheck.ts`,
    prompt:
      "/goal Run the daily /geo-dev self-development loop to completion. Plugin source = /Users/thanhdo/work/brain-geo-analysis-plugin. Vault + gh_task_repo are in ~/.brain-os/brain-os.config.md. Runs locally — no vault bootstrap. Read the skill spec at skills/geo-dev/SKILL.md and follow every phase exactly. The Phase-0 change-gate has already passed (precheck) — invoke the Workflow tool with scriptPath ABSOLUTE /Users/thanhdo/work/brain-geo-analysis-plugin/workflows/geo-dev.mjs and args {}; do NOT poll it with Bash/Monitor loops, wait for completion and read its returned summary. After it returns, advance the cursor: bun run scripts/geo-dev-precheck.ts --save, and confirm the Workflow wrote the report + the terminal outcome-log line; if it crashed before the Report phase, write a fail outcome line yourself (reason=workflow-crash). Rules: edit ONLY this source repo, never installed plugin copies; issues → sonthanh/ai-brain (labels geo-dev, status:ready), NEVER the plugin repo; every decided gap lands as a PR for human merge, never force-push to main; content gaps (essays/sources/prompts/framework) are OUT of scope — route to /geo-improve; zero decided gaps is a valid, SUCCESSFUL day. Done = an outcome-log row for today exists in {vault}/daily/skill-outcomes/geo-dev.log AND is committed+pushed to the vault. Do not stop until confirmed.",
  },

  "geo-digest": {
    id: "geo-digest",
    label: "Geo digest",
    model: "opus",
    workdir: BRAIN,
    schedule: [{ Hour: 8, Minute: 0, Weekday: 6 }], // Saturday
    dedup: "day",
    quotaGate: true,
    alertOnFail: true,
    prompt:
      "/goal Run the weekly /geo-digest for the current ISO week to completion on the brain vault. Vault root = /Users/thanhdo/work/brain. vault_path + gh_task_repo are in ~/.brain-os/brain-os.config.md (skill Step 0 reads it). Runs locally — NO vault bootstrap. Read the /geo-digest skill spec at /Users/thanhdo/work/brain-geo-analysis-plugin/skills/geo-digest/SKILL.md and execute ALL phases exactly, in order: Step 0 resolve config + started breadcrumb to daily/skill-outcomes/geo-digest.log; Phase 1 load state; Phase 2 scan sources (web/rss/x/fb-manual) for the past 7 days (WebSearch/WebFetch only); Phase 3 tag + cluster via the 6 framework dimensions; Phase 4 scorecard (US/CN/VN/CH x 8 determinants + internal stage + weekly delta); Phase 5 exec brief (~600 words) to weekly/YYYY-WW/brief.md; Phase 6 2-4 detail essays (1500-3000 words, Ly Xuan Hai analytical voice); Phase 7 email the brief via Gmail (fallback thanh@emvn.co; email failure is NON-BLOCKING/partial); Phase 8 file the /geo-quiz grill task as a GitHub issue on sonthanh/ai-brain; Phase 9 update state.json cursors, commit, push. Rules: NEVER edit installed plugin copies; light-week fallback (fewer than 2 essay-worthy themes → exec brief only); VN quotes verbatim with English gloss; email failure one-shot, do NOT retry; append exactly one terminal {pass|partial|fail} row to daily/skill-outcomes/geo-digest.log. Done = weekly/{ISO-WEEK}/brief.md exists, a terminal row is in the log, and the commit is pushed. Do not stop until all three are confirmed.",
  },

  "geo-improve": {
    id: "geo-improve",
    label: "Geo improve",
    model: "opus",
    workdir: GEO,
    schedule: [{ Hour: 21, Minute: 0, Weekday: 5 }], // Friday
    dedup: "day",
    quotaGate: true,
    alertOnFail: true,
    prompt:
      "/goal Run the weekly /geo-improve pass to completion. Vault root = /Users/thanhdo/work/brain. Plugin source = /Users/thanhdo/work/brain-geo-analysis-plugin (this worktree). vault_path + gh_task_repo are in ~/.brain-os/brain-os.config.md. Runs locally — no vault bootstrap. Read the /geo-improve skill spec at /Users/thanhdo/work/brain-geo-analysis-plugin/skills/geo-improve/SKILL.md and execute ALL phases: Phase 1 collect signals (geo-digest.log + geo-quiz.log + grill.md counter-takes + git diffs, past 7 days); Phase 2 classify Class 1 (auto-apply) vs Class 2 (email for approval) per the risk table; Phase 3 generate 3-5 candidate variants per target file, run evals, pick winner per the eval gate; Phase 4 Class 1 commit+push to the plugin source repo, Class 2 email diff for approval; Phase 5 write report to daily/improve-reports/{date}-geo.md; Phase 6 append outcome-log line to daily/skill-outcomes/geo-improve.log, commit+push that row even on a zero-signal run. Rules: NEVER edit installed plugin copies; Class 1 hard gates (prompt diff <=200 chars; non-primary source add/drop only; no change to SKILL.md required-structure lines); primary sources (Ly Xuan Hai, Thayer, ISEAS) are ALWAYS Class 2; eval gate non-negotiable; zero signals → log pass with class1=0 class2=0, commit+push, exit. Done = an outcome-log row exists in daily/skill-outcomes/geo-improve.log AND is committed+pushed. Do not stop until confirmed.",
  },
};
