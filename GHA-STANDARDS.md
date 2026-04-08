# GitHub Actions Workflow Standards

All workflows in repos using brain-ops follow these conventions. **Before committing any workflow change, run `actionlint` locally** — CI will reject invalid workflows.

## Required structure (every workflow must have all of these)

```yaml
permissions: {}                    # Default deny at top level

concurrency:
  group: <workflow-name>           # Or ci-${{ github.head_ref || github.run_id }} for CI
  cancel-in-progress: true         # false for destructive workflows (gmail-clean)

jobs:
  job-name:
    runs-on: ubuntu-latest
    timeout-minutes: 10            # Mandatory on every job
    permissions:
      contents: read               # Grant only what's needed per job
```

## Shell script rules in `run: |` blocks
- **YAML indentation**: All lines inside `run: |` must be indented to the block scalar level (10+ spaces). Multiline string continuations at column 0 break YAML parsing silently.
- **Secrets via env vars**: Pass secrets through `env:`, never as shell arguments
- **Quote variables**: Always `"$GITHUB_OUTPUT"`, `"$VARIABLE"` — unquoted vars fail shellcheck
- **`find` over `ls`**: Use `find dir/ -maxdepth 1 -name '*.ext'` instead of `ls dir/*.ext`
- **Git author**: Use `github-actions[bot]` as committer name/email in workflows that push

## Failure notifications (every workflow)
```yaml
    - name: Notify on failure
      if: failure()
      uses: sonthanh/brain-ops/actions/telegram-send@v0
      with:
        bot-token: ${{ secrets.TELEGRAM_BOT_TOKEN }}
        chat-id: ${{ secrets.TELEGRAM_CHAT_ID }}
        message: "<Workflow> failed. Check https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

## Composite actions
Use brain-ops composite actions (`sonthanh/brain-ops/actions/*@v0`) for reusable operations instead of inlining complex logic. Available: `gmail-fetch`, `gmail-clean`, `telegram-send`.
