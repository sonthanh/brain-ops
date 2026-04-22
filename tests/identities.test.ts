import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseIdentities } from "../src/lib/identities.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-identities-test");

const FIXTURE_RULES = `# Gmail Rules

## Always Important
- from:chris@themusicsupervisors.com — replied 16x

## Custom Rules

### Team domains (internal)
These are internal team addresses. Emails FROM these domains are outbound/team work:
- @emvn.co — EMVN team (all departments)
- @melosy.net — Melosy team
- @musicmaster.io — MusicMaster team
- @songgen.ai — Songgen team
- @tunebot.io — Tunebot team
- @cremi.ai — Cremi team

### Send-as identities (outbound authorship)
Addresses the user sends mail from. Used by gmail-lifecycle-check to distinguish "user replied" vs "team replied" vs "external continued" in thread lifecycle detection.

- sonthanhdo2004@gmail.com
- thanh@emvn.co
- thanh@melosy.net
- thanh@musicmaster.io
- thanh@songgen.ai
- thanh@tunebot.io
- thanh@cremi.ai

### Group addresses (team-routed)
Emails sent TO these addresses are team operations, forwarded via Google Groups:
- business@emvn.co, partners@emvn.co, support@emvn.co
- legal@emvn.co, accounting@emvn.co, hr@emvn.co
`;

describe("identities parser", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("Guard 17 — identity-parse-send-as", () => {
    test("returns exactly the 7 me-addresses from Send-as identities section", () => {
      const path = join(TEST_DIR, "gmail-rules.md");
      writeFileSync(path, FIXTURE_RULES);
      const result = parseIdentities(path);
      expect(result.me.size).toBe(7);
      expect(result.me.has("sonthanhdo2004@gmail.com")).toBe(true);
      expect(result.me.has("thanh@emvn.co")).toBe(true);
      expect(result.me.has("thanh@melosy.net")).toBe(true);
      expect(result.me.has("thanh@musicmaster.io")).toBe(true);
      expect(result.me.has("thanh@songgen.ai")).toBe(true);
      expect(result.me.has("thanh@tunebot.io")).toBe(true);
      expect(result.me.has("thanh@cremi.ai")).toBe(true);
    });

    test("addresses from other sections (Group addresses) are NOT treated as me", () => {
      const path = join(TEST_DIR, "gmail-rules.md");
      writeFileSync(path, FIXTURE_RULES);
      const result = parseIdentities(path);
      expect(result.me.has("business@emvn.co")).toBe(false);
      expect(result.me.has("partners@emvn.co")).toBe(false);
      expect(result.me.has("hr@emvn.co")).toBe(false);
    });

    test("reply-history 'from:xxx' lines in Always Important are NOT parsed as me", () => {
      const path = join(TEST_DIR, "gmail-rules.md");
      writeFileSync(path, FIXTURE_RULES);
      const result = parseIdentities(path);
      expect(result.me.has("chris@themusicsupervisors.com")).toBe(false);
    });
  });

  describe("Guard 18 — identity-parse-team-domains", () => {
    test("returns exactly the 6 team domains from Team domains section", () => {
      const path = join(TEST_DIR, "gmail-rules.md");
      writeFileSync(path, FIXTURE_RULES);
      const result = parseIdentities(path);
      expect(result.teamDomains.size).toBe(6);
      expect(result.teamDomains.has("emvn.co")).toBe(true);
      expect(result.teamDomains.has("melosy.net")).toBe(true);
      expect(result.teamDomains.has("musicmaster.io")).toBe(true);
      expect(result.teamDomains.has("songgen.ai")).toBe(true);
      expect(result.teamDomains.has("tunebot.io")).toBe(true);
      expect(result.teamDomains.has("cremi.ai")).toBe(true);
    });

    test("team domains are stored without the leading @", () => {
      const path = join(TEST_DIR, "gmail-rules.md");
      writeFileSync(path, FIXTURE_RULES);
      const result = parseIdentities(path);
      expect(result.teamDomains.has("@emvn.co")).toBe(false);
      expect(result.teamDomains.has("emvn.co")).toBe(true);
    });
  });

  describe("Guard 19 — identity-parse-fallback (fail loud)", () => {
    test("missing Send-as identities section throws with actionable error naming the section", () => {
      const path = join(TEST_DIR, "no-sendas.md");
      writeFileSync(
        path,
        `## Custom Rules

### Team domains (internal)
- @emvn.co
`,
      );
      expect(() => parseIdentities(path)).toThrow(/Send-as identities/);
    });

    test("empty Send-as identities section (header present, no bullets) throws", () => {
      const path = join(TEST_DIR, "empty-sendas.md");
      writeFileSync(
        path,
        `## Custom Rules

### Team domains (internal)
- @emvn.co

### Send-as identities (outbound authorship)
No addresses configured yet.
`,
      );
      expect(() => parseIdentities(path)).toThrow(/Send-as identities/);
    });

    test("missing Team domains section throws with actionable error naming the section", () => {
      const path = join(TEST_DIR, "no-teams.md");
      writeFileSync(
        path,
        `### Send-as identities (outbound authorship)
- me@me.com
`,
      );
      expect(() => parseIdentities(path)).toThrow(/Team domains/);
    });

    test("missing file throws with path in error message", () => {
      const path = join(TEST_DIR, "does-not-exist.md");
      expect(() => parseIdentities(path)).toThrow(/does-not-exist\.md/);
    });
  });
});
