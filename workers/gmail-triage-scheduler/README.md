# gmail-triage-scheduler

Cloudflare Worker that starts **Gmail Triage** (`sonthanh/ai-brain` → `.github/workflows/gmail-triage.yml`) at fixed times.

**Why:** GitHub's built-in cron drops or delays scheduled runs. 2026-09-25 → 10-01 it started only 25 of 56 triage slots (45%), with a median delay of 99 min. Cloudflare cron triggers fire on time, and GitHub starts a requested run (`workflow_dispatch`) immediately.

**Schedule:** `wrangler.toml` → `[triggers] crons` (UTC). It is the only scheduler for Gmail triage: `gmail-triage.yml` has no `schedule:` of its own.

## Setup, redeploy, rotate token

```bash
bunx wrangler@4 login                                   # once per machine (opens browser)
# copy the GitHub token to the clipboard, then:
bun run scripts/setup-gmail-triage-scheduler.ts         # idempotent
bun run scripts/setup-gmail-triage-scheduler.ts --rotate-token   # when the token expires
```

GitHub token: fine-grained PAT, repository `sonthanh/ai-brain` only, permission **Actions: Read and write**. Create at <https://github.com/settings/personal-access-tokens/new>.

Optional failure alerts on Telegram: run the setup with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in the environment.

## Check it works

```bash
cd workers/gmail-triage-scheduler && bunx wrangler@4 tail      # live logs; wait for a :23 tick
gh run list --repo sonthanh/ai-brain --workflow gmail-triage.yml --limit 3   # event = workflow_dispatch at :23
```

## When it breaks

| Symptom | Cause | Fix |
|---|---|---|
| Telegram "Gmail triage was NOT started", HTTP 401/403 | Token expired or lost permission | New token → `--rotate-token` |
| No triage runs at :23, no alert | Worker not deployed / trigger removed | Re-run the setup script; check Cloudflare dashboard → Workers → Triggers |
