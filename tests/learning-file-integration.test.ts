import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Workflow lives in the sibling `brain` repo. In local dev both repos sit in
// ~/work. For CI, point BRAIN_WORKFLOW_PATH at a checkout. If missing we fail
// loud (red phase) — there is no legitimate way for these guards to be green
// without a brain workflow on disk to inspect.
const BRAIN_WORKFLOW_PATH = resolve(
  process.env.BRAIN_WORKFLOW_PATH ??
    resolve(import.meta.dir, "..", "..", "brain", ".github", "workflows", "gmail-triage.yml"),
);

function loadBrainWorkflow(): string {
  if (!existsSync(BRAIN_WORKFLOW_PATH)) {
    throw new Error(
      `Brain workflow not found at ${BRAIN_WORKFLOW_PATH}. ` +
        `Set BRAIN_WORKFLOW_PATH env var to a gmail-triage.yml checkout. ` +
        `Guards 14+15 verify the brain workflow is wired to load gmail-classify-learnings.md ` +
        `and gmail-draft-learnings.md in the respective Claude prompt steps.`,
    );
  }
  return readFileSync(BRAIN_WORKFLOW_PATH, "utf-8");
}

function stepSlice(yml: string, stepMarker: string, endMarker?: string): string {
  const start = yml.indexOf(stepMarker);
  if (start < 0) return "";
  const end = endMarker ? yml.indexOf(endMarker, start + stepMarker.length) : -1;
  return end > start ? yml.slice(start, end) : yml.slice(start);
}

describe("learning-file workflow integration", () => {
  describe("Guard 14 — learnings-file-classify-integration", () => {
    test("classify-with-claude prompt step references gmail-classify-learnings.md", () => {
      const yml = loadBrainWorkflow();
      const classifyStep = stepSlice(yml, "Classify with Claude", "Run Gmail cleanup");
      expect(classifyStep).toContain("business/intelligence/gmail-classify-learnings.md");
    });

    test("gmail-classify-learnings.md is NOT referenced inside the draft-replies step", () => {
      // Classify learnings are for the classify agent only. Cross-contaminating
      // into the draft step would drift the files' audiences.
      const yml = loadBrainWorkflow();
      const draftStep = stepSlice(yml, "Draft replies with Claude", "Create Gmail drafts");
      expect(draftStep).not.toContain("gmail-classify-learnings.md");
    });
  });

  describe("Guard 15 — learnings-file-draft-integration", () => {
    test("draft-replies prompt step references gmail-draft-learnings.md", () => {
      const yml = loadBrainWorkflow();
      const draftStep = stepSlice(yml, "Draft replies with Claude", "Create Gmail drafts");
      expect(draftStep).toContain("business/intelligence/gmail-draft-learnings.md");
    });

    test("gmail-draft-learnings.md is NOT referenced inside the classify step", () => {
      const yml = loadBrainWorkflow();
      const classifyStep = stepSlice(yml, "Classify with Claude", "Run Gmail cleanup");
      expect(classifyStep).not.toContain("gmail-draft-learnings.md");
    });
  });

  describe("Guard 14+15 (sibling) — lifecycle-check step ordering", () => {
    test("workflow invokes sonthanh/brain-ops/actions/gmail-lifecycle-check@v2 (or later)", () => {
      const yml = loadBrainWorkflow();
      expect(yml).toMatch(/sonthanh\/brain-ops\/actions\/gmail-lifecycle-check@v\d+/);
    });

    test("lifecycle-check step runs BEFORE Classify with Claude (so learnings files exist for prompt load)", () => {
      const yml = loadBrainWorkflow();
      const lifecycleIdx = yml.indexOf("gmail-lifecycle-check");
      const classifyIdx = yml.indexOf("Classify with Claude");
      expect(lifecycleIdx).toBeGreaterThan(-1);
      expect(classifyIdx).toBeGreaterThan(-1);
      expect(lifecycleIdx).toBeLessThan(classifyIdx);
    });
  });
});
