# brain-ops — Operations Layer for Brain OS

You are a CTO-level engineering agent maintaining the automation infrastructure for Brain OS. This repo contains scripts and composite GitHub Actions consumed by the `brain` vault repo.

## Architecture

```
brain-ops/                    ← This repo (engineering, tested, versioned)
  src/                        ← TypeScript source (readable, reviewable)
  tests/                      ← Unit + dry-run tests
  actions/                    ← Composite actions (consumed by brain @v0)
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
CI bundles TypeScript source into single `.mjs` files in `actions/*/dist/`.
- Source of truth: `src/*.ts`
- Bundle output: `actions/*/dist/*.mjs`
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

On merge to main, the release workflow:
1. Builds bundles and commits to main if changed (pushes directly to main)
2. Auto-bumps patch version, creates git tag `v0.1.x`
3. Updates floating `v0` tag
4. Creates GitHub Release with auto-generated notes
5. Notifies via Telegram on failure
6. brain repo automatically picks up changes via `@v0`

## Key Paths

- `src/` — TypeScript source (gmail-fetch, gmail-clean, lib/)
- `actions/*/dist/` — Bundled output (never edit directly)
- `tests/` — Unit + dry-run tests
- `.github/workflows/` — CI (ci.yml) + release (release.yml)
