import { gmail_v1, auth } from "@googleapis/gmail";
import { readFileSync } from "fs";

const DEFAULT_CREDENTIALS_PATH = ".credentials.json";

export function createGmailClient(
  credentialsPath = process.env.GMAIL_CREDENTIALS_PATH || DEFAULT_CREDENTIALS_PATH,
): gmail_v1.Gmail {
  const creds = JSON.parse(readFileSync(credentialsPath, "utf-8"));
  const oauth2 = new auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    "http://localhost:3000/callback",
  );
  oauth2.setCredentials({
    refresh_token: creds.refresh_token,
    access_token: creds.access_token,
  });
  return new gmail_v1.Gmail({ auth: oauth2 });
}
