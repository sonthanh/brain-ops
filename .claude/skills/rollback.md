---
name: rollback
description: Revert a release by moving the floating v0 tag back to the previous version
autoApply: false
---

# /rollback — Revert Release

Move the floating `v0` tag back to the previous working version. Brain repo immediately uses the old code.

## When to use
- Release broke the gmail pipeline in brain
- Production run failed after a new release
- User reports issues after deploy

## Process

### Step 1: Identify versions
```bash
git fetch --tags
git tag -l 'v0.*' --sort=-v:refname | head -5
```

### Step 2: Confirm with user
Show:
- Current `v0` points to: `<current tag>`
- Rolling back to: `<previous tag>`
- Changes being reverted: `git log <previous>..<current> --oneline`

### Step 3: Execute
```bash
PREV_TAG=<previous tag>
git tag -f v0 $PREV_TAG
git push -f origin v0
```

### Step 4: Create tracking issue
```bash
gh issue create \
  --title "Rollback: <current> reverted to <previous>" \
  --body "## Reason
<why>

## Reverted changes
<git log output>

## Action items
- [ ] Investigate root cause
- [ ] Fix and re-release"
```

### Step 5: Notify (if Telegram available)
Send rollback notification via Telegram.

## Key facts
- Rollback is instant — `@v0` resolves at runtime
- No changes needed in brain repo
- Old release tag preserved for investigation
- Always create tracking issue so fix isn't forgotten
