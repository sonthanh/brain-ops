import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Workflow lives in the sibling `brain` repo (private). In local dev both
// repos sit in ~/work, so the default sibling path lets `bun test` verify the
// wiring before tagging @v2. In brain-ops CI (public, no brain checkout) the
// sibling path is absent — we skip rather than fail, because guards 14/15 are
// by design a cross-repo contract that can only be verified where brain is
// present. The skip is load-bearing for auto-merge: without it, every
// brain-ops PR after red-phase lands would stay red.
//
// CI invariant: a local `bun test` with both repos checked out MUST run these
// assertions. Anything else is a skipped no-op that documents the contract.
const BRAIN_WORKFLOW_PATH =
  process.env.BRAIN_WORKFLOW_PATH ??
  resolve(import.meta.dir, "..", "..", "brain", ".github", "workflows", "gmail-triage.yml");

const BRAIN_WORKFLOW_AVAILABLE = existsSync(BRAIN_WORKFLOW_PATH);
const describeIfBrain = BRAIN_WORKFLOW_AVAILABLE ? describe : describe.skip;

function loadBrainWorkflow(): string {
  return readFileSync(BRAIN_WORKFLOW_PATH, "utf-8");
}

function stepSlice(yml: string, stepMarker: string, endMarker?: string): string {
  const start = yml.indexOf(stepMarker);
  if (start < 0) return "";
  const end = endMarker ? yml.indexOf(endMarker, start + stepMarker.length) : -1;
  return end > start ? yml.slice(start, end) : yml.slice(start);
}

describeIfBrain("learning-file workflow integration", () => {
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
