---
name: develop
description: Execute a planned task — write TypeScript source and tests following brain-ops conventions
autoApply: false
---

# /develop — Execute a Development Task

You are a senior engineer executing a task in brain-ops. The plan comes from a /grill session or direct user instruction.

## Reference skills (auto-loaded globally)
- **typescript-expert** — TypeScript patterns, type-level programming, tooling
- **github-actions-docs** — Official GitHub Actions syntax, triggers, runners, secrets
- **github-actions-templates** — Reusable workflow patterns

Consult these skills when writing TypeScript or GitHub Actions YAML. They contain up-to-date documentation and best practices.

## Before writing any code

1. **Read CLAUDE.md** — architecture, conventions, danger patterns
2. **Read the plan** — follow the /grill session output or user instructions exactly
3. **Read existing code** — match patterns in `src/` and `tests/`
4. **Read `src/lib/types.ts`** — shared interfaces

## Writing source code (`src/`)

1. **Match existing patterns** — study `gmail-fetch.ts` and `gmail-clean.ts`
2. **Export testable functions** with an options object:
   ```typescript
   export async function doThing(options: {
     dryRun?: boolean;
     credentialsPath?: string;
   }): Promise<ResultType> {
   ```
3. **Always support `--dry-run`** for any external API calls:
   - Check `options.dryRun` at the top
   - Log what WOULD happen with `[dry-run]` prefix
   - Return a valid result shape without real API calls
4. **Shared code** → `src/lib/`
5. **CLI entry point** at the bottom of the file
6. **Errors** caught at CLI boundary, not in business logic
7. **Use `typescript-expert` skill** patterns for types, generics, and error handling

## Writing GitHub Actions (`action.yml`, workflows)

1. **Consult `github-actions-docs` skill** for syntax — never guess at YAML fields
2. **Consult `github-actions-templates` skill** for reusable patterns
3. **Composite actions are thin** — setup + run bundled script, all logic in TypeScript
4. **Always set `timeout-minutes`** on jobs
5. **Always set `concurrency`** groups on workflows
6. **Use `shell: bash`** explicitly in composite action steps

## Writing tests (`tests/`)

1. **Every source file gets a test file** — `src/foo.ts` → `tests/foo.test.ts`
2. **Required test groups:**
   ```typescript
   describe("feature-name", () => {
     describe("dry-run", () => { /* MUST: no real API calls */ });
     describe("input validation", () => { /* MUST: edge cases */ });
     describe("business logic", () => { /* Pure logic tests */ });
   });
   ```
3. **Temp files** — create in `beforeEach`, clean in `afterEach`
4. **No mocks for external APIs** — use `--dry-run` instead
5. **Test contracts, not implementations**

## Verification (run before finishing)

```bash
bun test              # All tests pass
bun run typecheck     # No type errors
bun run build         # Bundles compile
```

All three MUST pass. Fix any failures before proceeding to /review or /ship.
