/**
 * Deterministic prefilter for SLA tier assignment.
 *
 * Catches mechanical false positives where a SaaS platform sends notification
 * emails that Sonnet-based classifiers otherwise tag as `normal` (requiring reply).
 *
 * Scope is intentionally narrow — only the "X via PLATFORM" sender name pattern
 * (where PLATFORM is a known SaaS). Broader patterns (cold outreach, compliance
 * forms) are handled in the LLM classifier via rules-prose in gmail-rules.md.
 */

const PLATFORM_TOKENS = [
  "airtable",
  "sourceaudio",
  "linkedin",
  "asana",
  "notion",
  "slack",
  "github",
  "typeform",
  "framer",
  "substack",
  "stripe",
  "zendesk",
  "hubspot",
  "intercom",
] as const;

const VIA_PLATFORM_RE = new RegExp(
  `\\bvia\\s+(${PLATFORM_TOKENS.join("|")})\\b`,
  "i",
);

/**
 * Returns "none" when the From header indicates a SaaS-platform automation
 * (name portion contains "via <platform>"), otherwise null.
 *
 * Example matches (→ "none"):
 *   "hanh.nguyen@emvn.co via Airtable"
 *   "MCV 17 via SourceAudio <license@emvn.co>"
 *   "John Doe via LinkedIn <notifications@linkedin.com>"
 *
 * Example non-matches (→ null):
 *   "Sennheiser <via support@melosy.net>"   (via is the delivery alias)
 *   "Chris Noxx <chris@fnmpg.com>"          (normal human sender)
 *   "billing@hetzner.com"                   (vendor billing — may still need SLA)
 */
export function detectSlaPrefilter(from: string): "none" | null {
  const namePortion = (from.split("<")[0] ?? from).trim();
  return VIA_PLATFORM_RE.test(namePortion) ? "none" : null;
}
