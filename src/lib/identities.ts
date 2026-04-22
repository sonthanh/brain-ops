import { readFileSync, existsSync } from "node:fs";

export interface Identities {
  me: Set<string>;
  teamDomains: Set<string>;
}

const ME_LINE_RE = /^-\s+(\S+@\S+)\s*$/;
const TEAM_LINE_RE = /^-\s+@([A-Za-z0-9.-]+)/;
const SUB_HEADING_RE = /^###\s+/;
const TOP_HEADING_RE = /^##\s+/;

function sectionLines(content: string, headingPattern: RegExp): string[] {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => headingPattern.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (SUB_HEADING_RE.test(line) || TOP_HEADING_RE.test(line)) break;
    out.push(line);
  }
  return out;
}

export function parseIdentities(rulesPath: string): Identities {
  if (!existsSync(rulesPath)) {
    throw new Error(
      `parseIdentities: gmail-rules file not found at ${rulesPath}. ` +
        `Set the gmail-rules-path input or create the file with ` +
        `'### Send-as identities' and '### Team domains (internal)' sections.`,
    );
  }
  const content = readFileSync(rulesPath, "utf-8");

  const meSection = sectionLines(content, /^###\s+Send-as identities/);
  const me = new Set<string>();
  for (const line of meSection) {
    const m = line.match(ME_LINE_RE);
    if (m && m[1]) me.add(m[1]);
  }
  if (me.size === 0) {
    throw new Error(
      `parseIdentities: Send-as identities section missing or empty in ${rulesPath}. ` +
        `Add '### Send-as identities' with '- email@domain' bullets ` +
        `(source: Gmail → Settings → Accounts → Send mail as).`,
    );
  }

  const teamSection = sectionLines(content, /^###\s+Team domains/);
  const teamDomains = new Set<string>();
  for (const line of teamSection) {
    const m = line.match(TEAM_LINE_RE);
    if (m && m[1]) teamDomains.add(m[1]);
  }
  if (teamDomains.size === 0) {
    throw new Error(
      `parseIdentities: Team domains (internal) section missing or empty in ${rulesPath}. ` +
        `Add '### Team domains (internal)' with '- @domain' bullets.`,
    );
  }

  return { me, teamDomains };
}
