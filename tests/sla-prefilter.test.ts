import { describe, test, expect } from "bun:test";
import { detectSlaPrefilter } from "../src/lib/sla-prefilter.ts";

describe("detectSlaPrefilter", () => {
  describe("matches platform-automation patterns", () => {
    test("Airtable access-request notification (bare address)", () => {
      expect(detectSlaPrefilter("hanh.nguyen@emvn.co via Airtable")).toBe("none");
    });

    test("SourceAudio license request with angle-bracket address", () => {
      expect(
        detectSlaPrefilter("MCV 17 via SourceAudio <license@emvn.co>"),
      ).toBe("none");
    });

    test("LinkedIn InMail notification", () => {
      expect(
        detectSlaPrefilter("Jane Recruiter via LinkedIn <notifications@linkedin.com>"),
      ).toBe("none");
    });

    test("GitHub notification via platform", () => {
      expect(
        detectSlaPrefilter("octocat via GitHub <noreply@github.com>"),
      ).toBe("none");
    });

    test("case insensitive — VIA AIRTABLE", () => {
      expect(detectSlaPrefilter("Someone VIA AIRTABLE")).toBe("none");
    });
  });

  describe("returns null for human senders", () => {
    test("plain human email — Chris Noxx", () => {
      expect(detectSlaPrefilter("Chris Noxx <chris@fnmpg.com>")).toBe(null);
    });

    test("bare email address", () => {
      expect(detectSlaPrefilter("billing@hetzner.com")).toBe(null);
    });

    test("vendor with display name", () => {
      expect(detectSlaPrefilter("Hetzner Online GmbH <billing@hetzner.com>")).toBe(null);
    });
  });

  describe("does NOT match 'via' delivery-alias pattern", () => {
    test("Sennheiser <via support@melosy.net> — 'via' is in address, not name", () => {
      expect(
        detectSlaPrefilter("Sennheiser <via support@melosy.net>"),
      ).toBe(null);
    });

    test("Alex Moore <via support@melosy.net> — cold outreach, handled by rules-prose", () => {
      expect(
        detectSlaPrefilter("Alex Moore <via support@melosy.net>"),
      ).toBe(null);
    });

    test("IP Corp compliance form — no 'via' at all", () => {
      expect(
        detectSlaPrefilter("IP Corp <ip_corp@yplawfirm.vn>"),
      ).toBe(null);
    });
  });

  describe("edge cases", () => {
    test("empty string", () => {
      expect(detectSlaPrefilter("")).toBe(null);
    });

    test("platform token as substring of another word does not match", () => {
      // "viable" contains "via" — must not match
      expect(detectSlaPrefilter("Viable Airtable Consulting <hello@viable.com>")).toBe(
        null,
      );
    });

    test("platform without 'via' prefix does not match", () => {
      // Just having "airtable" in the name is not enough — need "via airtable"
      expect(detectSlaPrefilter("Airtable Support <help@airtable.com>")).toBe(null);
    });
  });
});
