# brain-ops — Operations Layer for Brain OS

You are a CTO-level engineering agent maintaining the automation infrastructure for Brain OS. This repo contains scripts and composite GitHub Actions consumed by the `brain` vault repo.

## Architecture

```
brain-ops/                    ← This repo (engineering, tested, versioned)
  src/                        ← TypeScript source (readable, reviewable)
  tests/                      ← Unit + dry-run tests
  .github/actions/            ← Composite actions (consumed by brain @v1)
  .github/workflows/          ← CI + release automation
  .claude/skills/             ← Development process skills
  scripts/                    ← Build scripts

brain (vault repo)            ← Consumer (references brain-ops@v1)
  .github/workflows/          ← Scheduled automation using our actions
```

## Development Principles

### 1. Every script must support `--dry-run`
All scripts that call external APIs accept a `--dry-run` flag. In dry-run mode:
- Parse and validate all inputs
- Log what WOULD happen
- Never make real API calls
- Exit 0 if everything looks correct

### 2. Tests are mandatory
Every script needs:
- **Unit tests**: Pure logic (parsing, validation, batching)
- **Dry-run tests**: End-to-end with `--dry-run` flag (validates input → output flow)

Run tests: `bun test`

### 3. One logical change per commit
Each commit should be independently revertable. Split:
- Renames from rewrites
- Test infrastructure from implementations
- Build changes from logic changes

### 4. TypeScript conventions
- Runtime: Bun
- Use `@googleapis/gmail` (not the full `googleapis` package)
- Shared utilities go in `src/lib/`
- No classes unless necessary — prefer functions
- Use explicit types for API contracts (interfaces for inputs/outputs)
- Handle errors at boundaries, not everywhere

### 5. Composite actions are thin wrappers
`action.yml` files should be minimal — just setup + run the bundled script. All logic lives in TypeScript source.

### 6. Bundling
CI bundles TypeScript source into single `.mjs` files in `.github/actions/*/dist/`.
- Source of truth: `src/*.ts`
- Bundle output: `.github/actions/*/dist/*.mjs`
- Never edit dist/ files directly
- Build: `bun run build`

## Commands

- `bun test` — Run all tests
- `bun run typecheck` — TypeScript type checking
- `bun run build` — Bundle scripts into action dist/
- `bun run lint:actions` — Lint GitHub Actions workflows (requires actionlint)

## Danger Patterns

These patterns in PRs require human review (CI labels them `needs-human-review`):
- `messages.delete`, `messages.batchDelete` — bulk email deletion
- `messages.trash` with no safeguard — potential mass trash
- New Gmail API scope additions
- Changes to action type mappings
- `--force`, `--hard`, destructive git operations

## Release Process

On merge to main:
1. CI auto-bumps patch version
2. Creates git tag `v0.1.x`
3. Updates floating `v1` tag
4. brain repo automatically picks up changes via `@v1`

## File Structure

```
src/
  gmail-fetch.ts              ← Fetch unread emails from Gmail API
  gmail-clean.ts              ← Execute triage actions (archive, star, label, etc.)
  lib/
    gmail-client.ts           ← Shared Gmail API client setup
    types.ts                  ← Shared type definitions
tests/
  gmail-fetch.test.ts
  gmail-clean.test.ts
.github/
  actions/
    gmail-fetch/
      action.yml              ← Composite action wrapper
      dist/gmail-fetch.mjs    ← Bundled script
    gmail-clean/
      action.yml
      dist/gmail-clean.mjs
    telegram-send/
      action.yml              ← Simple curl-based notification
  workflows/
    ci.yml                    ← PR gate: lint + typecheck + test + danger-scan
    release.yml               ← Auto-release on merge to main
scripts/
  build.ts                    ← Bundle src/ into action dist/
```
