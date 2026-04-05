---
name: review
description: Multi-dimensional code review — security, quality, patterns, correctness
autoApply: false
---

# /review — Code Review

Review changes in brain-ops across multiple dimensions. Uses the **code-review-excellence** global skill as a foundation, extended with brain-ops-specific checks.

## Reference skills (auto-loaded globally)
- **code-review-excellence** — Review methodology, constructive feedback, systematic analysis
- **typescript-expert** — TypeScript anti-patterns, type safety, performance
- **github-actions-docs** — Workflow correctness, security best practices

## Dimensions

### 1. Correctness
- Does the code do what it claims?
- Edge cases handled? (empty arrays, missing files, API 404s)
- Does `--dry-run` accurately reflect real execution?
- Off-by-one errors, race conditions, unclosed resources?

### 2. Security
- **Credentials**: Read from env/file, never logged, never committed?
- **Gmail API scope**: Adding or changing scopes? → `needs-human-review`
- **Destructive ops**: `delete`, `batchDelete`, `trash` without safeguards? → `needs-human-review`
- **Injection**: User inputs sanitized in shell commands or API calls?

### 3. TypeScript quality (consult `typescript-expert`)
- No `any` types?
- `noUncheckedIndexedAccess` respected (use `!` only when truly safe)?
- Explicit interfaces for API contracts?
- Functions over classes unless state management needed?

### 4. GitHub Actions quality (consult `github-actions-docs`)
- Workflow syntax valid? (actionlint would pass?)
- `timeout-minutes` set on all jobs?
- `concurrency` groups to prevent duplicate runs?
- Secrets accessed safely? (no inline `echo`, use `printenv`?)
- Permissions scoped to minimum needed?

### 5. Testing
- Every new function has tests?
- Dry-run tests cover happy path?
- Edge cases tested?
- Tests don't depend on network?
- Temp files cleaned up?

### 6. Conventions (CLAUDE.md)
- Exported function with options object?
- CLI entry point at bottom?
- `--dry-run` support for API calls?
- One logical change per commit?

## Output

```markdown
## Review Summary

**Verdict**: APPROVE | REQUEST_CHANGES | NEEDS_HUMAN_REVIEW

### Findings

#### Critical (blocks merge)
- [finding + file:line + fix]

#### Warning (should fix)
- [finding + file:line + fix]

#### Nit (optional)
- [finding]

### Danger flags
- [ ] Destructive operations → needs-human-review
- [ ] New API scopes → needs-human-review
- [ ] Action type mapping changes → needs-human-review
```

If ANY critical → REQUEST_CHANGES.
If danger flags → NEEDS_HUMAN_REVIEW.
Focus on bugs and security, not style.
