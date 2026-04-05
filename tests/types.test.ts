import { describe, test, expect } from "bun:test";
import { parseTriageActions } from "../src/lib/types.ts";

describe("parseTriageActions", () => {
  test("parses valid actions", () => {
    const result = parseTriageActions([
      { action: "archive", id: "1", from: "a@test.com", subject: "Test" },
      { action: "label:work", id: "2", from: "b@test.com", subject: "Test 2" },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]!.action).toBe("archive");
    expect(result[1]!.action).toBe("label:work");
  });

  test("preserves reply_hint when present", () => {
    const result = parseTriageActions([
      { action: "needs-reply", id: "1", from: "a@test.com", subject: "Test", reply_hint: "Thanks" },
    ]);
    expect(result[0]!.reply_hint).toBe("Thanks");
  });

  test("throws on non-array input", () => {
    expect(() => parseTriageActions("not array")).toThrow("Expected array");
    expect(() => parseTriageActions(null)).toThrow("Expected array");
    expect(() => parseTriageActions({})).toThrow("Expected array");
  });

  test("throws on invalid action type", () => {
    expect(() =>
      parseTriageActions([{ action: "bogus", id: "1", from: "a", subject: "s" }]),
    ).toThrow('invalid action "bogus"');
  });

  test("throws on missing id", () => {
    expect(() =>
      parseTriageActions([{ action: "archive", from: "a", subject: "s" }]),
    ).toThrow("missing id");
  });

  test("throws on non-object item", () => {
    expect(() => parseTriageActions(["string"])).toThrow("expected object");
  });
});
