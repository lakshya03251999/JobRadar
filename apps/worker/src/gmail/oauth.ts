import { google } from "googleapis";
import { config } from "../config.js";
import { decrypt } from "../crypto.js";

// googleapis OAuth2 client type, so we don't depend on google-auth-library directly
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

// read-only scope, so we can't send or delete mail
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

/** A bare OAuth client for building the consent URL and exchanging the code. */
export function makeOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
}

/** URL we send the user to so they grant Gmail read access. */
export function buildConsentUrl(): string {
  const client = makeOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline", // needed to get a refresh_token
    prompt: "consent", // forces a refresh_token even on re-auth
    scope: GMAIL_SCOPES,
  });
}

/** Build an authenticated client from a user's (decrypted-on-use) refresh token. */
export function clientFromRefreshToken(encryptedRefreshToken: string): OAuth2Client {
  const client = makeOAuthClient();
  client.setCredentials({ refresh_token: decrypt(encryptedRefreshToken) });
  return client;
}
