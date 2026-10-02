import { describe, expect, test } from "bun:test";
import { isLoggedIn, parseSecretNames, plan } from "./setup-gmail-triage-scheduler";

describe("plan", () => {
  test("fresh setup without Telegram env: deploy, store token, warn about alerts", () => {
    expect(plan({ existingSecrets: [], rotateToken: false, telegramInEnv: false })).toEqual([
      "deploy",
      "put-gh-token",
      "warn-no-telegram",
    ]);
  });

  test("re-run with everything set: only redeploy (idempotent)", () => {
    const existingSecrets = ["GH_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
    expect(plan({ existingSecrets, rotateToken: false, telegramInEnv: false })).toEqual(["deploy"]);
  });

  test("--rotate-token replaces an existing token", () => {
    const existingSecrets = ["GH_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"];
    expect(plan({ existingSecrets, rotateToken: true, telegramInEnv: false })).toEqual(["deploy", "put-gh-token"]);
  });

  test("Telegram secrets in env and not yet stored → store them", () => {
    expect(plan({ existingSecrets: ["GH_TOKEN"], rotateToken: false, telegramInEnv: true })).toEqual([
      "deploy",
      "put-telegram",
    ]);
  });
});

describe("parseSecretNames", () => {
  test("reads names from wrangler's JSON list", () => {
    expect(parseSecretNames(`[{"name":"GH_TOKEN","type":"secret_text"}]`)).toEqual(["GH_TOKEN"]);
  });

  test("worker not deployed yet (error text, not JSON) → no secrets", () => {
    expect(parseSecretNames("✘ [ERROR] This Worker does not exist on your account.")).toEqual([]);
  });
});

describe("isLoggedIn", () => {
  test("detects wrangler's logged-out message", () => {
    expect(isLoggedIn("You are not authenticated. Please run `wrangler login`.")).toBe(false);
  });

  test("detects a logged-in whoami", () => {
    expect(isLoggedIn("You are logged in with an OAuth Token, associated with the email x@y.z.\n│ Account Name │ Account ID │")).toBe(true);
  });
});
