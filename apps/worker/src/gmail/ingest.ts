import { google, type gmail_v1 } from "googleapis";
import { prisma } from "@jobradar/db";
import { clientFromRefreshToken } from "./oauth.js";
import { logger } from "../logger.js";

// Gmail ingestion: backfill on first connect, then incremental syncs off the History API.
// Messages are stored keyed on a unique gmailMsgId, so re-fetching one is a no-op.

export interface RawEmail {
  gmailMsgId: string;
  threadId: string;
  sender: string;
  subject: string;
  snippet: string;
  /** Full plain-text body, passed to extraction but not stored. */
  body: string;
  receivedAt: Date;
}

class ReconnectRequired extends Error {}
export class RetryableGmailError extends Error {}

function isAuthError(err: unknown): boolean {
  const code = (err as { response?: { status?: number } })?.response?.status;
  const msg = (err as Error)?.message ?? "";
  return code === 401 || /invalid_grant|unauthorized|token has been expired or revoked/i.test(msg);
}

function isTransient(err: unknown): boolean {
  const code = (err as { response?: { status?: number } })?.response?.status;
  return code === 429 || (typeof code === "number" && code >= 500);
}

async function gmailFor(userId: string): Promise<{ gmail: gmail_v1.Gmail; refreshToken: string }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.refreshToken) throw new ReconnectRequired("No refresh token on file");
  const auth = clientFromRefreshToken(user.refreshToken);
  return { gmail: google.gmail({ version: "v1", auth }), refreshToken: user.refreshToken };
}

/** Walk a MIME payload and return the first text/plain part. */
function extractPlainText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  const decode = (data?: string | null) =>
    data ? Buffer.from(data, "base64url").toString("utf8") : "";

  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decode(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    const found = extractPlainText(part);
    if (found) return found;
  }
  // last resort: strip tags from text/html
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decode(payload.body.data).replace(/<[^>]+>/g, " ");
  }
  return "";
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  const h = msg.payload?.headers?.find(
    (x) => x.name?.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? "";
}

async function fetchMessage(gmail: gmail_v1.Gmail, id: string): Promise<RawEmail> {
  const { data } = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const body = extractPlainText(data.payload) || data.snippet || "";
  const internalMs = data.internalDate ? Number(data.internalDate) : Date.now();
  return {
    gmailMsgId: data.id!,
    threadId: data.threadId!,
    sender: header(data, "From"),
    subject: header(data, "Subject"),
    snippet: (data.snippet ?? "").slice(0, 300),
    body,
    receivedAt: new Date(internalMs),
  };
}

/** Persist a raw email (idempotent on gmailMsgId). Returns the DB id, or null if it's a dup. */
async function persistEmail(userId: string, raw: RawEmail): Promise<string | null> {
  try {
    const row = await prisma.email.create({
      data: {
        userId,
        gmailMsgId: raw.gmailMsgId,
        threadId: raw.threadId,
        sender: raw.sender,
        subject: raw.subject,
        snippet: raw.snippet, // body is intentionally left out
        receivedAt: raw.receivedAt,
        status: "pending",
      },
    });
    return row.id;
  } catch (err) {
    // unique violation on gmailMsgId means we already have it
    if ((err as { code?: string }).code === "P2002") return null;
    throw err;
  }
}

/** Re-fetch one message's full body from Gmail (for reprocessing a stored email). */
export async function fetchRawByMsgId(userId: string, gmailMsgId: string): Promise<RawEmail | null> {
  try {
    const { gmail } = await gmailFor(userId);
    return await fetchMessage(gmail, gmailMsgId);
  } catch (err) {
    if (isAuthError(err)) {
      await markReconnect(userId);
      return null;
    }
    if (isTransient(err)) throw new RetryableGmailError((err as Error).message);
    throw err;
  }
}

async function markReconnect(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { needsReconnect: true } });
  logger.warn("gmail", `user ${userId} needs to reconnect Gmail`);
}

/**
 * First-time backfill. Returns new DB email ids plus their raw bodies for the pipeline,
 * and stamps the user's current historyId so the next incremental sync has a cursor.
 */
export async function backfill(
  userId: string,
  limit = 50,
): Promise<Array<{ emailId: string; raw: RawEmail }>> {
  try {
    const { gmail } = await gmailFor(userId);
    const list = await gmail.users.messages.list({
      userId: "me",
      maxResults: limit,
      q: "category:primary OR category:updates", // skip promo/social noise
    });
    const out: Array<{ emailId: string; raw: RawEmail }> = [];
    let newestHistoryId: string | undefined;

    for (const m of list.data.messages ?? []) {
      const raw = await fetchMessage(gmail, m.id!);
      const emailId = await persistEmail(userId, raw);
      if (emailId) out.push({ emailId, raw });
    }

    // use the mailbox's current historyId as our starting cursor
    const profile = await gmail.users.getProfile({ userId: "me" });
    newestHistoryId = profile.data.historyId ?? undefined;
    if (newestHistoryId) {
      await prisma.user.update({
        where: { id: userId },
        data: { lastHistoryId: newestHistoryId, needsReconnect: false },
      });
    }

    logger.info("gmail", `backfill ${userId}: ${out.length} new of ${list.data.messages?.length ?? 0}`);
    return out;
  } catch (err) {
    if (isAuthError(err)) {
      await markReconnect(userId);
      return [];
    }
    if (isTransient(err)) throw new RetryableGmailError((err as Error).message);
    throw err;
  }
}

/**
 * Incremental sync via the History API. Resumes from user.lastHistoryId, fetches only
 * messages added since, and updates the cursor at the end so progress survives a crash.
 */
export async function incrementalSync(
  userId: string,
): Promise<Array<{ emailId: string; raw: RawEmail }>> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.lastHistoryId) {
    // no cursor yet, so backfill instead
    return backfill(userId);
  }

  try {
    const { gmail } = await gmailFor(userId);
    const out: Array<{ emailId: string; raw: RawEmail }> = [];
    let pageToken: string | undefined;
    let latestHistoryId = user.lastHistoryId;
    const seen = new Set<string>();

    do {
      const { data } = await gmail.users.history.list({
        userId: "me",
        startHistoryId: user.lastHistoryId,
        historyTypes: ["messageAdded"],
        pageToken,
      });
      if (data.historyId) latestHistoryId = data.historyId;

      for (const h of data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          const id = added.message?.id;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const raw = await fetchMessage(gmail, id);
          const emailId = await persistEmail(userId, raw);
          if (emailId) out.push({ emailId, raw });
        }
      }
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);

    // advance the cursor only after everything above is persisted
    await prisma.user.update({
      where: { id: userId },
      data: { lastHistoryId: latestHistoryId, needsReconnect: false },
    });

    logger.info("gmail", `sync ${userId}: ${out.length} new messages`);
    return out;
  } catch (err) {
    // a 404 on history.list means the startHistoryId is too old, so re-backfill
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      logger.warn("gmail", `historyId too old for ${userId}, re-backfilling`);
      await prisma.user.update({ where: { id: userId }, data: { lastHistoryId: null } });
      return backfill(userId);
    }
    if (isAuthError(err)) {
      await markReconnect(userId);
      return [];
    }
    if (isTransient(err)) throw new RetryableGmailError((err as Error).message);
    throw err;
  }
}
