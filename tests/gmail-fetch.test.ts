import { describe, test, expect } from "bun:test";
import { fetchUnreadEmails } from "../src/gmail-fetch.ts";

describe("gmail-fetch", () => {
  describe("dry-run", () => {
    test("returns empty array without calling API", async () => {
      const emails = await fetchUnreadEmails({ dryRun: true });
      expect(emails).toEqual([]);
    });

    test("logs dry-run messages", async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(" "));

      await fetchUnreadEmails({ dryRun: true });

      console.log = origLog;
      expect(logs.some((l) => l.includes("[dry-run]"))).toBe(true);
      expect(logs.some((l) => l.includes("is:unread in:inbox"))).toBe(true);
    });
  });
});
