import { gmail_v1, auth } from "@googleapis/gmail";
import { readFileSync } from "fs";

const DEFAULT_CREDENTIALS_PATH = ".credentials.json";

export function createGmailClient(
  credentialsPath = process.env.GMAIL_CREDENTIALS_PATH || DEFAULT_CREDENTIALS_PATH,
): gmail_v1.Gmail {
  const raw = JSON.parse(readFileSync(credentialsPath, "utf-8"));
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid credentials file: expected JSON object`);
  }
  const { client_id, client_secret, refresh_token, access_token } = raw;
  if (typeof client_id !== "string" || typeof client_secret !== "string") {
    throw new Error(`Credentials missing required fields: client_id, client_secret`);
  }
  if (typeof refresh_token !== "string" && typeof access_token !== "string") {
    throw new Error(`Credentials must include refresh_token or access_token`);
  }
  const oauth2 = new auth.OAuth2(client_id, client_secret, "http://localhost:3000/callback");
  oauth2.setCredentials({
    refresh_token: typeof refresh_token === "string" ? refresh_token : undefined,
    access_token: typeof access_token === "string" ? access_token : undefined,
  });
  return new gmail_v1.Gmail({ auth: oauth2 });
}
