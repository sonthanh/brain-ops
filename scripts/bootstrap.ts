#!/usr/bin/env -S bun run
// bootstrap.ts — one-command setup of the brain automation stack on a fresh macOS machine.
//
// What it AUTOMATES (idempotent, safe to re-run):
//   1. verify the required toolchain (git, bun, node, gh, jq, claude)
//   2. clone the four repos into ~/work  (ai-brain, brain-ops, brain-os-plugin, brain-geo-analysis-plugin)
//   3. `bun install` in brain-ops
//   4. write ~/.brain-os/brain-os.config.md and a ~/.config/brain/env skeleton (never overwrites existing)
//   5. generate every launchd plist (agent automations + support jobs) from the committed configs
//   6. with --load: bootstrap + enable all launchd jobs
//
// What it CANNOT do (one-time manual, printed as a checklist at the end):
//   - `gh auth login`, `claude` login (interactive account auth)
//   - fill the Telegram secrets in ~/.config/brain/env
//   - copy the personal ~/.claude layer (CLAUDE.md, hooks, enabledPlugins) from the source Mac
// See MIGRATION.md for the full runbook.
//
// Usage:
//   bun run scripts/bootstrap.ts           # plumbing + generate plists, print checklist
//   bun run scripts/bootstrap.ts --load    # also load (bootstrap+enable) every launchd job

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { AUTOMATIONS } from "./automations.config.ts";
import { OPS_JOBS } from "./gen-ops-plists.ts";

export const GITHUB_OWNER = "sonthanh";
export const REQUIRED_BINS = ["git", "bun", "node", "gh", "jq", "claude"] as const;
/** Prereqs installable with `brew install <name>` (claude has its own installer). */
export const BREW_BINS = ["git", "bun", "node", "gh", "jq"] as const;

export interface RepoSpec {
  remote: string;
  dir: string;
}

/** The four repos the automation stack needs, cloned under ~/work. */
export function repoPlan(home: string): RepoSpec[] {
  const R = (name: string, dir: string): RepoSpec => ({
    remote: `git@github.com:${GITHUB_OWNER}/${name}.git`,
    dir: `${home}/work/${dir}`,
  });
  return [
    R("ai-brain", "brain"),
    R("brain-ops", "brain-ops"),
    R("brain-os-plugin", "brain-os-plugin"),
    R("brain-geo-analysis-plugin", "brain-geo-analysis-plugin"),
  ];
}

/** ~/.brain-os/brain-os.config.md — vault path + task repo the skills read at Step 0. */
export function renderBrainConfig(home: string): string {
  return `# Brain OS Configuration (personal — not in public plugin)

## Vault Path
\`\`\`
vault_path: ${home}/work/brain
\`\`\`

## GitHub Task Repo
\`\`\`
gh_task_repo: ${GITHUB_OWNER}/ai-brain
\`\`\`
`;
}

/** ~/.config/brain/env skeleton — Telegram alert creds run-automation.ts reads on failure. */
export function renderEnvSkeleton(): string {
  return `# Telegram alert credentials for failed automations (run-automation.ts reads these on non-zero claude exit).
# Fill both values, then this file is chmod 600. Get them from @BotFather / your alert chat.
TG_BOT_TOKEN=
TG_CHAT_ID=
`;
}

/** Which required binaries are absent, given a resolver (Bun.which in prod, a stub in tests). */
export function missingPrereqs(which: (bin: string) => string | null): string[] {
  return REQUIRED_BINS.filter((b) => !which(b));
}

/** True when settings.json enables any brain-os@<marketplace> plugin (the automations need it). */
export function brainOsEnabled(settingsRaw: string | null): boolean {
  if (!settingsRaw) return false;
  try {
    const enabled = (JSON.parse(settingsRaw)?.enabledPlugins ?? {}) as Record<string, unknown>;
    return Object.entries(enabled).some(([k, v]) => k.startsWith("brain-os@") && v === true);
  } catch {
    return false;
  }
}

/** Every launchd label this stack manages — agent automations plus the 5 support jobs. */
export function allLabels(): string[] {
  return [
    ...Object.keys(AUTOMATIONS).map((id) => `com.brain.automation.${id}`),
    ...OPS_JOBS.map((j) => `com.brain.${j.id}`),
  ];
}

function run(cmd: string[], cwd?: string): number {
  return Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit", ...(cwd ? { cwd } : {}) }).exitCode ?? 1;
}

function main(): void {
  const load = process.argv.includes("--load");
  const HOME = homedir();
  console.log("=== brain automation bootstrap (macOS) ===\n");

  // 1 — prerequisites
  const missing = missingPrereqs((b) => Bun.which(b));
  if (missing.length) {
    console.log(`Missing tools: ${missing.join(", ")}`);
    const brewFormulae = missing.filter((m) => (BREW_BINS as readonly string[]).includes(m));
    if (brewFormulae.length) {
      console.log(Bun.which("brew") ? `  → brew install ${brewFormulae.join(" ")}` : "  → install Homebrew (https://brew.sh), then brew install the above");
    }
    if (missing.includes("claude")) console.log("  → install Claude Code (https://docs.claude.com/en/docs/claude-code), then run `claude` once to log in");
    if (missing.includes("git") || missing.includes("bun")) {
      console.log("\ngit + bun are required to continue. Install them and re-run.\n");
      process.exit(1);
    }
    console.log("");
  } else {
    console.log("✓ toolchain present (git, bun, node, gh, jq, claude)\n");
  }

  // 2 — clone repos
  for (const { remote, dir } of repoPlan(HOME)) {
    if (existsSync(dir)) {
      console.log(`✓ ${dir} (exists — leaving as-is)`);
      continue;
    }
    console.log(`cloning ${remote} → ${dir}`);
    if (run(["git", "clone", remote, dir]) !== 0) {
      console.log(`  ! clone failed — ensure this machine's SSH key is added to GitHub and has access to ${remote}`);
    }
  }

  // 3 — install brain-ops deps
  const ops = `${HOME}/work/brain-ops`;
  if (existsSync(`${ops}/package.json`)) {
    console.log("\nbun install (brain-ops)…");
    run(["bun", "install"], ops);
  }

  // 4 — machine config (never clobber an existing file)
  const brainOsDir = `${HOME}/.brain-os`;
  mkdirSync(brainOsDir, { recursive: true });
  const cfg = `${brainOsDir}/brain-os.config.md`;
  if (existsSync(cfg)) {
    console.log(`✓ ${cfg} (exists — leaving as-is)`);
  } else {
    writeFileSync(cfg, renderBrainConfig(HOME));
    console.log(`wrote ${cfg}`);
  }

  const envDir = `${HOME}/.config/brain`;
  mkdirSync(envDir, { recursive: true });
  const envFile = `${envDir}/env`;
  if (existsSync(envFile)) {
    console.log(`✓ ${envFile} (exists — leaving as-is)`);
  } else {
    writeFileSync(envFile, renderEnvSkeleton());
    chmodSync(envFile, 0o600);
    console.log(`wrote ${envFile}  ← fill in TG_BOT_TOKEN + TG_CHAT_ID`);
  }

  // 5 — generate plists from the committed configs
  console.log("\ngenerating launchd plists…");
  run(["bun", "run", `${ops}/scripts/gen-automation-plists.ts`], ops);
  run(["bun", "run", `${ops}/scripts/gen-ops-plists.ts`], ops);

  // 6 — optionally load them
  if (load) {
    const uid = Bun.spawnSync(["id", "-u"]).stdout.toString().trim();
    console.log("\nloading launchd jobs…");
    for (const label of allLabels()) {
      const plist = `${HOME}/Library/LaunchAgents/${label}.plist`;
      if (!existsSync(plist)) {
        console.log(`  ! ${label}: plist missing (skipped)`);
        continue;
      }
      Bun.spawnSync(["launchctl", "bootout", `gui/${uid}`, plist]); // ignore if not loaded
      const ok = run(["launchctl", "bootstrap", `gui/${uid}`, plist]) === 0;
      if (ok) run(["launchctl", "enable", `gui/${uid}/${label}`]);
      console.log(`  ${ok ? "loaded" : "FAILED"} ${label}`);
    }
  }

  // final checklist
  const settingsPath = `${HOME}/.claude/settings.json`;
  const settingsRaw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  const brainOsLine = brainOsEnabled(settingsRaw)
    ? "enabled ✓"
    : "enable brain-os@brain-os-marketplace — see MIGRATION.md §\"Claude global layer\"";

  console.log(`
=== one-time manual steps (not automatable) ===
1. GitHub auth      : gh auth login                 (repo scope; access to ${GITHUB_OWNER}/*)
2. Claude login     : claude                        (log in once — subscription account)
3. Telegram secrets : edit ${HOME}/.config/brain/env  (TG_BOT_TOKEN, TG_CHAT_ID)
4. Claude layer     : copy ~/.claude/{CLAUDE.md,RTK.md,rules,hooks,settings.json,plugins} from the source Mac
                      → MIGRATION.md §"Claude global layer"
5. brain-os plugin  : ${brainOsLine}
6. Cutover (old Mac): disable its jobs so only one machine runs each — MIGRATION.md §Cutover
${load ? "" : "\nPlists are written but NOT loaded. After steps 1–5, load them:\n  bun run scripts/bootstrap.ts --load"}
`);
}

if (import.meta.main) main();
