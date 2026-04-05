import { describe, test, expect, spyOn } from "bun:test";
import { fetchUnreadEmails } from "../src/gmail-fetch.ts";

describe("gmail-fetch", () => {
  describe("dry-run", () => {
    test("returns empty array without calling API", async () => {
      const emails = await fetchUnreadEmails({ dryRun: true });
      expect(emails).toEqual([]);
    });

    test("logs dry-run messages", async () => {
      const spy = spyOn(console, "log").mockImplementation(() => {});
      try {
        await fetchUnreadEmails({ dryRun: true });
        const logs = spy.mock.calls.map((args) => args.join(" "));
        expect(logs.some((l) => l.includes("[dry-run]"))).toBe(true);
        expect(logs.some((l) => l.includes("is:unread in:inbox"))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
