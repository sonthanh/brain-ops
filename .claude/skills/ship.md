---
name: ship
description: Test, create PR, and ship changes through CI to release
autoApply: false
---

# /ship — Ship Changes

Ship a completed feature or fix. Handles testing through PR creation.

## Reference skills (auto-loaded globally)
- **github-actions-docs** — For any workflow file changes included in the PR

## Pre-flight (all must pass, in order)

1. **Test + typecheck + build:**
```bash
bun test              # Tests pass?
bun run typecheck     # Types clean?
bun run build         # Bundles compile?
```

2. **Simplify:** Run `/simplify` on all changed files. Fix any issues found, then re-run step 1.

Stop on any failure. Fix, then restart from the top.

## Branch

If on main, create a feature branch:
```bash
git checkout -b feat/<short-description>
```

## Commit

One logical change per commit. Split:
- Renames from rewrites
- Test infra from implementations
- Build changes from logic changes

Format:
```
<type>: <short description>

<optional why>
```
Types: `feat`, `fix`, `build`, `refactor`, `test`, `chore`

## Push and PR

```bash
git push -u origin HEAD
gh pr create --title "<type>: <description>" --body "$(cat <<'EOF'
## Summary
<what changed and why>

## Test plan
- [ ] `bun test` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run build` produces valid bundles
- [ ] dry-run tested for new API calls

## Danger check
- [ ] No destructive operations added
- [ ] No new API scopes
- [ ] No credential handling changes
EOF
)"
```

## After PR creation

CI runs automatically:
1. actionlint + typecheck + test + build + danger scan
2. All pass + no `needs-human-review` → auto-merge
3. CI fails → read error, fix, push
4. `needs-human-review` → notify user, wait

## Post-merge (automatic)

1. Patch version bumped
2. Git tag created (v0.1.x)
3. Floating `v0` tag updated
4. brain repo picks up via `@v0`
