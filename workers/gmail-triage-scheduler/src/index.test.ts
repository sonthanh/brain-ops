import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  alertText,
  dispatchRequest,
  dispatchTriage,
  type Env,
  type FetchFn,
  isRetryable,
  onSchedule,
  RETRY_DELAYS_MS,
} from "./index";

type Call = { url: string; init: RequestInit };

/** Fake fetch: answers GitHub with `statuses` in order (a number, or "throw"); Telegram always 200. */
function fakeFetch(statuses: Array<number | "throw">): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith("https://api.telegram.org/")) return new Response("{}", { status: 200 });
    const s = statuses[Math.min(i++, statuses.length - 1)];
    if (s === "throw") throw new Error("network down");
    return new Response(s === 204 ? null : `{"message":"status ${s}"}`, { status: s });
  };
  return { fetchFn, calls };
}

const noSleep = async () => {};
const env: Env = { GH_TOKEN: "tok", TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_CHAT_ID: "42" };

describe("dispatchRequest", () => {
  test("POSTs workflow_dispatch for gmail-triage.yml on main, with auth + User-Agent", () => {
    const { url, init } = dispatchRequest("tok");
    expect(url).toBe("https://api.github.com/repos/sonthanh/ai-brain/actions/workflows/gmail-triage.yml/dispatches");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ ref: "main" });
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer tok");
    expect(h["User-Agent"]).toBeTruthy();
  });
});

describe("isRetryable", () => {
  test("network errors, 429 and 5xx retry; auth/permission/validation errors do not", () => {
    for (const s of [0, 429, 500, 502, 503]) expect(isRetryable(s)).toBe(true);
    for (const s of [401, 403, 404, 422]) expect(isRetryable(s)).toBe(false);
  });
});

describe("dispatchTriage", () => {
  test("204 on first try → ok, one call", async () => {
    const { fetchFn, calls } = fakeFetch([204]);
    expect(await dispatchTriage("tok", fetchFn, noSleep)).toMatchObject({ ok: true, attempts: 1 });
    expect(calls.length).toBe(1);
  });

  test("a 502 blip then 204 → ok on attempt 2, waited the first retry delay", async () => {
    const { fetchFn } = fakeFetch([502, 204]);
    const waits: number[] = [];
    const r = await dispatchTriage("tok", fetchFn, async (ms) => void waits.push(ms));
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(waits).toEqual([RETRY_DELAYS_MS[0]!]);
  });

  test("network keeps failing → gives up after all attempts", async () => {
    const { fetchFn, calls } = fakeFetch(["throw"]);
    const r = await dispatchTriage("tok", fetchFn, noSleep);
    expect(r).toMatchObject({ ok: false, status: 0, attempts: RETRY_DELAYS_MS.length + 1 });
    expect(r.detail).toContain("network down");
    expect(calls.length).toBe(RETRY_DELAYS_MS.length + 1);
  });

  test("401 (expired token) → no retry", async () => {
    const { fetchFn, calls } = fakeFetch([401]);
    expect(await dispatchTriage("tok", fetchFn, noSleep)).toMatchObject({ ok: false, status: 401, attempts: 1 });
    expect(calls.length).toBe(1);
  });
});

describe("onSchedule", () => {
  test("success sends no Telegram message", async () => {
    const { fetchFn, calls } = fakeFetch([204]);
    await onSchedule("23 5 * * *", env, fetchFn, noSleep);
    expect(calls.some((c) => c.url.includes("telegram"))).toBe(false);
  });

  test("failure → Telegram alert with the token hint, then throws so Cloudflare logs the tick as failed", async () => {
    const { fetchFn, calls } = fakeFetch([401]);
    await expect(onSchedule("23 5 * * *", env, fetchFn, noSleep)).rejects.toThrow("HTTP 401");
    const tg = calls.find((c) => c.url === "https://api.telegram.org/botbot/sendMessage");
    expect(tg).toBeDefined();
    const body = JSON.parse(String(tg!.init.body));
    expect(body.chat_id).toBe("42");
    expect(body.text).toContain("--rotate-token");
  });

  test("failure without Telegram secrets still throws (no crash on the missing alert)", async () => {
    const { fetchFn, calls } = fakeFetch([500]);
    await expect(onSchedule("23 5 * * *", { GH_TOKEN: "tok" }, fetchFn, noSleep)).rejects.toThrow("HTTP 500");
    expect(calls.some((c) => c.url.includes("telegram"))).toBe(false);
  });
});

describe("alertText", () => {
  test("non-auth failure points at the Cloudflare logs", () => {
    const t = alertText({ ok: false, attempts: 3, status: 0, detail: "network down" }, "23 7 * * *");
    expect(t).toContain("no response");
    expect(t).toContain("wrangler tail");
  });
});

describe("config", () => {
  test("wrangler.toml cron keeps the 8 triage slots (UTC 05,07,09,11,13,15,18,23 at :23)", () => {
    const toml = readFileSync(join(import.meta.dir, "..", "wrangler.toml"), "utf8");
    expect(toml).toContain(`crons = ["23 5,7,9,11,13,15,18,23 * * *"]`);
  });
});
