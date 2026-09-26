import { describe, test, expect } from "bun:test";
import {
  BODY_MAX_CHARS,
  BODY_MESSAGES_PER_THREAD,
  bodyTextFromPayload,
  extractPlainText,
  keepBodiesOnLatest,
  stripQuotedHistory,
} from "../src/lib/email-body.ts";
import type { gmail_v1 } from "@googleapis/gmail";

const b64 = (s: string): string => Buffer.from(s, "utf-8").toString("base64url");

describe("extractPlainText — MIME walk", () => {
  test("prefers text/plain over text/html in multipart/alternative", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64("<p>HTML version</p>") } },
        { mimeType: "text/plain", body: { data: b64("Plain version") } },
      ],
    };
    expect(extractPlainText(payload)).toBe("Plain version");
  });

  test("finds text/plain nested under multipart/mixed (attachments present)", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain", body: { data: b64("Nested body") } }],
        },
        { mimeType: "application/pdf", filename: "statement.pdf", body: { attachmentId: "att1" } },
      ],
    };
    expect(extractPlainText(payload)).toBe("Nested body");
  });

  test("falls back to HTML with tags, scripts and entities removed", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/html",
      body: { data: b64("<style>p{}</style><div>Could you send&nbsp;the file?<br>Thanks &amp; regards</div>") },
    };
    expect(extractPlainText(payload)).toBe("Could you send the file?\nThanks & regards");
  });

  test("decodes UTF-8 (Vietnamese) from base64url", () => {
    const text = "Nhờ Quý đối tác xem và confirm giúp.";
    expect(extractPlainText({ mimeType: "text/plain", body: { data: b64(text) } })).toBe(text);
  });

  test("returns empty string when there is no text part", () => {
    expect(extractPlainText({ mimeType: "application/pdf", body: { attachmentId: "x" } })).toBe("");
    expect(extractPlainText(undefined)).toBe("");
  });
});

describe("stripQuotedHistory — keep only what the sender wrote", () => {
  test("cuts an English 'On … wrote:' header, even when it wraps onto two lines", () => {
    const text = [
      "Could you kindly let us know the expected payment date?",
      "",
      "On Tue, Aug 4, 2026 at 12:55 AM EMVN Accounting Team <",
      "accounting at example> wrote:",
      "> Dear partner, we are sending the royalty report.",
    ].join("\n");
    expect(stripQuotedHistory(text)).toBe("Could you kindly let us know the expected payment date?");
  });

  test("cuts a Vietnamese 'Vào … đã viết:' header", () => {
    const text = "Bên mình up lên chưa ạ\n\nVào Thứ 6, 17 thg 7, 2026 lúc 15:47 Support Team đã viết:\nXin chào, cảm ơn bạn đã gửi sản phẩm";
    expect(stripQuotedHistory(text)).toBe("Bên mình up lên chưa ạ");
  });

  test("cuts a Korean '…작성:' header (Gmail KR locale)", () => {
    const text = "Could you let us know the payment status?\n\nBest regards,\nPartner\n\n2026년 8월 4일 (화) 오후 1:54, EMVN Accounting Team님이 작성:\n\n> Dear partner";
    expect(stripQuotedHistory(text)).toBe("Could you let us know the payment status?\n\nBest regards,\nPartner");
  });

  test("cuts a French 'Le … a écrit :' header", () => {
    const text = "Yes, I have received it thanks a lot.\n\nLe mar. 28 avr. 2026 à 16:48, Accounting a écrit :\n> Dear";
    expect(stripQuotedHistory(text)).toBe("Yes, I have received it thanks a lot.");
  });

  test("cuts an Outlook '____ / From: / Sent:' block", () => {
    const text = "Please reimburse the fees to this account.\n\nPartner\n\n________________________________\nFrom: EMVN Legal\nSent: Tuesday, June 23, 2026 10:20\nTo: Partner";
    expect(stripQuotedHistory(text)).toBe("Please reimburse the fees to this account.\n\nPartner");
  });

  test("cuts a bare 'From: / Date:' block (Zendesk / Apple Mail replies)", () => {
    const text = "It would be best if you could resend that album in full.\n\nThank you!\n\nFrom: EMVN Network (EMVN Support)\nDate: Thursday, 27 August 2026 at 09:57\nTo: Partner";
    expect(stripQuotedHistory(text)).toBe("It would be best if you could resend that album in full.\n\nThank you!");
  });

  test("drops '>'-quoted lines left in the body", () => {
    expect(stripQuotedHistory("Agreed, thanks.\n> older line\n>> older still")).toBe("Agreed, thanks.");
  });

  test("keeps the whole text when nothing is quoted", () => {
    const text = "Hi team,\nWe re-ingested two albums. Please download the updates.";
    expect(stripQuotedHistory(text)).toBe(text);
  });

  test("a pure forward (nothing above the marker) keeps the forwarded text instead of returning empty", () => {
    const text = "---------- Forwarded message ---------\nFrom: Tax office\nDate: Mon, 24 Aug 2026\n\nPlease provide the 2025 PIT declaration.";
    expect(stripQuotedHistory(text)).toContain("Please provide the 2025 PIT declaration.");
  });
});

describe("bodyTextFromPayload — the field the classifier sees", () => {
  test("strips history, collapses blank-line runs and caps length", () => {
    const long = "x".repeat(BODY_MAX_CHARS + 500);
    const out = bodyTextFromPayload({ mimeType: "text/plain", body: { data: b64(`${long}\n\nOn Mon, X wrote:\n> q`) } });
    expect(out.length).toBe(BODY_MAX_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
    expect(bodyTextFromPayload({ mimeType: "text/plain", body: { data: b64("a\n\n\n\n\nb") } })).toBe("a\n\nb");
  });
});

describe("keepBodiesOnLatest — bound prompt size on long threads", () => {
  test(`keeps body_text on the latest ${BODY_MESSAGES_PER_THREAD} messages only, snippets stay on all`, () => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({ snippet: `s${i}`, body_text: `b${i}` }));
    const out = keepBodiesOnLatest(msgs);
    expect(out.map((m) => m.snippet)).toEqual(msgs.map((m) => m.snippet));
    expect(out.filter((m) => "body_text" in m).map((m) => m.body_text)).toEqual(["b3", "b4", "b5", "b6", "b7"]);
  });
});
