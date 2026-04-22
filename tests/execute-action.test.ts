import { describe, test, expect } from "bun:test";
import { executeAction } from "../src/gmail-clean.ts";
import type { gmail_v1 } from "@googleapis/gmail";
import type { TriageAction } from "../src/lib/types.ts";

function mockGmail(overrides: Record<string, unknown> = {}) {
  return {
    users: {
      messages: {
        modify: overrides.modify ?? (() => Promise.resolve({})),
        trash: overrides.trash ?? (() => Promise.resolve({})),
        get: overrides.get ?? (() => Promise.resolve({ data: {} })),
      },
      labels: {
        create: overrides.labelsCreate ?? (() => Promise.resolve({ data: { id: "L123" } })),
        list: overrides.labelsList ?? (() => Promise.resolve({ data: { labels: [] } })),
      },
      settings: {
        filters: {
          create: overrides.filtersCreate ?? (() => Promise.resolve({})),
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
}

function action(type: string, id = "msg1"): TriageAction {
  return { action: type as TriageAction["action"], id, from: "a@test.com", subject: "Test" };
}

describe("executeAction", () => {
  test("archive removes INBOX label", async () => {
    let called = false;
    const gmail = mockGmail({
      modify: (params: { requestBody: { removeLabelIds: string[] } }) => {
        called = true;
        expect(params.requestBody.removeLabelIds).toContain("INBOX");
        return Promise.resolve({});
      },
    });
    const result = await executeAction(gmail, action("archive"), new Map());
    expect(result.ok).toBe(true);
    expect(called).toBe(true);
  });

  test("star adds STARRED label", async () => {
    let addedLabels: string[] = [];
    const gmail = mockGmail({
      modify: (params: { requestBody: { addLabelIds: string[] } }) => {
        addedLabels = params.requestBody.addLabelIds;
        return Promise.resolve({});
      },
    });
    const result = await executeAction(gmail, action("star"), new Map());
    expect(result.ok).toBe(true);
    expect(addedLabels).toContain("STARRED");
  });

  test("delete trashes the message", async () => {
    let trashedId: string | undefined;
    const gmail = mockGmail({
      trash: (params: { id: string }) => {
        trashedId = params.id;
        return Promise.resolve({});
      },
    });
    const result = await executeAction(gmail, action("delete"), new Map());
    expect(result.ok).toBe(true);
    expect(trashedId).toBe("msg1");
  });

  test("label: creates label if not cached", async () => {
    let createdName: string | undefined;
    const cache = new Map<string, string>();
    const gmail = mockGmail({
      labelsCreate: (params: { requestBody: { name: string } }) => {
        createdName = params.requestBody.name;
        return Promise.resolve({ data: { id: "new-label-id" } });
      },
    });
    const result = await executeAction(gmail, action("label:work"), cache);
    expect(result.ok).toBe(true);
    expect(createdName).toBe("work");
    expect(cache.get("work")).toBe("new-label-id");
  });

  test("label: uses cached label ID", async () => {
    let createCalled = false;
    const cache = new Map([["work", "cached-id"]]);
    const gmail = mockGmail({
      labelsCreate: () => {
        createCalled = true;
        return Promise.resolve({ data: { id: "new" } });
      },
    });
    const result = await executeAction(gmail, action("label:work"), cache);
    expect(result.ok).toBe(true);
    expect(createCalled).toBe(false);
  });

  test("needs-reply stars message + removes UNREAD (atomic with draft step)", async () => {
    let addedLabels: string[] = [];
    let removedLabels: string[] = [];
    const gmail = mockGmail({
      modify: (params: {
        requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] };
      }) => {
        addedLabels = params.requestBody.addLabelIds ?? [];
        removedLabels = params.requestBody.removeLabelIds ?? [];
        return Promise.resolve({});
      },
    });
    const result = await executeAction(gmail, action("needs-reply"), new Map());
    expect(result.ok).toBe(true);
    expect(addedLabels).toContain("STARRED");
    expect(removedLabels).toContain("UNREAD");
  });

  test("read removes UNREAD only (stays in inbox)", async () => {
    let addedLabels: string[] = [];
    let removedLabels: string[] = [];
    const gmail = mockGmail({
      modify: (params: {
        requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] };
      }) => {
        addedLabels = params.requestBody.addLabelIds ?? [];
        removedLabels = params.requestBody.removeLabelIds ?? [];
        return Promise.resolve({});
      },
    });
    const result = await executeAction(gmail, action("read"), new Map());
    expect(result.ok).toBe(true);
    expect(addedLabels).toHaveLength(0);
    expect(removedLabels).toContain("UNREAD");
    expect(removedLabels).not.toContain("INBOX");
  });

  test("unknown action returns error", async () => {
    const gmail = mockGmail();
    const result = await executeAction(gmail, action("bogus"), new Map());
    expect(result).toEqual({ ok: false, reason: "unknown: bogus" });
  });

  test("404 error returns not found instead of throwing", async () => {
    const gmail = mockGmail({
      modify: () => {
        const err = new Error("Not found") as Error & { code: number };
        err.code = 404;
        return Promise.reject(err);
      },
    });
    const result = await executeAction(gmail, action("archive"), new Map());
    expect(result).toEqual({ ok: false, reason: "not found" });
  });

  test("non-404 error is rethrown", async () => {
    const gmail = mockGmail({
      modify: () => Promise.reject(new Error("Server error")),
    });
    expect(executeAction(gmail, action("archive"), new Map())).rejects.toThrow("Server error");
  });
});
