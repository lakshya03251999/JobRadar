import express, { Router } from "express";
import { google } from "googleapis";
import { prisma } from "@jobradar/db";
import { config } from "../config.js";
import { buildConsentUrl, makeOAuthClient } from "../gmail/oauth.js";
import { encrypt } from "../crypto.js";
import { backfill } from "../gmail/ingest.js";
import { enqueueEmails } from "../queue/index.js";
import { logger } from "../logger.js";

/**
 * Google OAuth flow:
 *   GET /auth/google           redirects the user to Google consent
 *   GET /auth/google/callback  exchanges the code, stores the encrypted refresh token,
 *                                kick off a first backfill of recent mail.
 */
export const authRouter: express.Router = Router();

authRouter.get("/google", (_req, res) => {
  res.redirect(buildConsentUrl());
});

authRouter.get("/google/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) return res.status(400).send("Missing authorization code");

  try {
    const client = makeOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      // Happens if the user previously authorized and Google didn't re-issue one.
      return res
        .status(400)
        .send("No refresh token returned. Revoke JobRadar access in your Google account and retry.");
    }

    // Get the account email from Gmail itself, so we stay on the single
    // gmail.readonly scope (the userinfo endpoint would need its own scope).
    client.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth: client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress!;

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        refreshToken: encrypt(tokens.refresh_token),
        timezone: config.defaultTz,
        needsReconnect: false,
      },
      update: {
        refreshToken: encrypt(tokens.refresh_token),
        needsReconnect: false,
      },
    });

    // First backfill so the dashboard isn't empty, then enqueue for processing.
    const fetched = await backfill(user.id, 50);
    await enqueueEmails(fetched);

    logger.info("auth", `connected ${email}, backfilled ${fetched.length} mails`);
    res.redirect(`${config.webOrigin}/?connected=1`);
  } catch (err) {
    // Surface the real Google error (redirect_uri_mismatch, invalid_grant,
    // insufficient scopes, etc.) instead of just the generic message.
    const detail =
      (err as { response?: { data?: unknown } }).response?.data ?? (err as Error).message;
    logger.error("auth", `callback failed: ${JSON.stringify(detail)}`);
    res.status(500).send("OAuth failed. Check server logs.");
  }
});
