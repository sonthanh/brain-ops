import { describe, test, expect, afterEach } from "bun:test";
import { createGmailClient } from "../src/lib/gmail-client.ts";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_DIR = join(import.meta.dir, ".tmp-client-test");

function writeCredentials(data: unknown): string {
  mkdirSync(TEST_DIR, { recursive: true });
  const path = join(TEST_DIR, "creds.json");
  writeFileSync(path, JSON.stringify(data));
  return path;
}

describe("createGmailClient", () => {
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("throws on missing file", () => {
    expect(() => createGmailClient("/nonexistent/creds.json")).toThrow();
  });

  test("throws on invalid JSON", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const path = join(TEST_DIR, "creds.json");
    writeFileSync(path, "not json");
    expect(() => createGmailClient(path)).toThrow();
  });

  test("throws on missing client_id", () => {
    const path = writeCredentials({ client_secret: "s", refresh_token: "r" });
    expect(() => createGmailClient(path)).toThrow("client_id");
  });

  test("throws on missing client_secret", () => {
    const path = writeCredentials({ client_id: "c", refresh_token: "r" });
    expect(() => createGmailClient(path)).toThrow("client_secret");
  });

  test("throws on missing tokens", () => {
    const path = writeCredentials({ client_id: "c", client_secret: "s" });
    expect(() => createGmailClient(path)).toThrow("refresh_token or access_token");
  });

  test("succeeds with valid credentials", () => {
    const path = writeCredentials({
      client_id: "c",
      client_secret: "s",
      refresh_token: "r",
    });
    const gmail = createGmailClient(path);
    expect(gmail).toBeDefined();
    expect(gmail.users).toBeDefined();
  });
});
