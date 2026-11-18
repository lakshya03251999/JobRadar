import express, { Router } from "express";
import { prisma, type Stage } from "@jobradar/db";
import { scheduleReminderFor } from "../reminders/scheduler.js";
import { incrementalSync, fetchRawByMsgId } from "../gmail/ingest.js";
import { enqueueEmails } from "../queue/index.js";
import { processEmail } from "../pipeline/processEmail.js";
import { logger } from "../logger.js";

// REST API for the Next.js dashboard. This MVP is single-user, so "current user"
// is just the first connected user; a multi-user build would read it from a
// session or JWT.
export const apiRouter: express.Router = Router();

async function currentUser() {
  return prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
}

const PIPELINE_STAGES: Stage[] = [
  "Applied",
  "Assessment",
  "Interview",
  "Offer",
  "Rejected",
  "Ghosted",
];

/** Connection status, drives the "Reconnect Gmail" banner. */
apiRouter.get("/status", async (_req, res) => {
  const user = await currentUser();
  res.json({
    connected: !!user,
    email: user?.email ?? null,
    needsReconnect: user?.needsReconnect ?? false,
  });
});

/**
 * Re-run the extraction pipeline on everything currently in the review queue.
 * Useful after a prompt/rules change. Bodies aren't stored, so each email is
 * re-fetched from Gmail and pushed back through processEmail.
 */
apiRouter.post("/reprocess", async (_req, res) => {
  const user = await currentUser();
  if (!user) return res.status(400).json({ error: "no user connected" });
  if (user.needsReconnect) return res.status(409).json({ error: "reconnect required" });

  const inReview = await prisma.email.findMany({
    where: { userId: user.id, status: "review" },
  });

  let reprocessed = 0;
  for (const email of inReview) {
    try {
      const raw = await fetchRawByMsgId(user.id, email.gmailMsgId);
      if (!raw) continue;
      await prisma.email.update({
        where: { id: email.id },
        data: { status: "pending", reviewReason: null },
      });
      await processEmail(email.id, raw);
      reprocessed++;
    } catch (err) {
      logger.error("api", `reprocess failed for ${email.gmailMsgId}: ${(err as Error).message}`);
    }
  }

  logger.info("api", `reprocessed ${reprocessed}/${inReview.length} review emails`);
  res.json({ reprocessed, total: inReview.length });
});

/** Manually trigger a Gmail sync (same work the 5-min cron does). */
apiRouter.post("/sync", async (_req, res) => {
  const user = await currentUser();
  if (!user) return res.status(400).json({ error: "no user connected" });
  if (user.needsReconnect) return res.status(409).json({ error: "reconnect required" });

  try {
    const fetched = await incrementalSync(user.id);
    await enqueueEmails(fetched);
    logger.info("api", `manual sync: ${fetched.length} new emails for ${user.email}`);
    res.json({ fetched: fetched.length });
  } catch (err) {
    logger.error("api", `manual sync failed: ${(err as Error).message}`);
    res.status(500).json({ error: "sync failed" });
  }
});

/** Pipeline board: applications grouped by stage. */
apiRouter.get("/applications", async (_req, res) => {
  const user = await currentUser();
  if (!user) return res.json({ stages: {} });

  const apps = await prisma.application.findMany({
    where: { userId: user.id },
    orderBy: { lastActivityAt: "desc" },
    include: {
      events: {
        where: { dueAt: { not: null } },
        orderBy: { dueAt: "asc" },
        take: 1,
      },
    },
  });

  const byStage: Record<string, unknown[]> = {};
  for (const s of PIPELINE_STAGES) byStage[s] = [];
  for (const a of apps) {
    const next = a.events[0];
    byStage[a.stage].push({
      id: a.id,
      company: a.company,
      role: a.role,
      stage: a.stage,
      lastActivityAt: a.lastActivityAt,
      nextDeadline: next?.dueAt ?? null,
      followUpSuggested: next ? next.followUpSuggested : false,
    });
  }
  res.json({ stages: byStage, order: PIPELINE_STAGES });
});

/** Upcoming deadlines (validated, future, sorted). */
apiRouter.get("/deadlines", async (_req, res) => {
  const user = await currentUser();
  if (!user) return res.json({ deadlines: [] });

  const events = await prisma.event.findMany({
    where: {
      dueAt: { gte: new Date() },
      application: { userId: user.id },
    },
    orderBy: { dueAt: "asc" },
    include: { application: true },
    take: 50,
  });

  res.json({
    deadlines: events.map((e) => ({
      id: e.id,
      company: e.application.company,
      role: e.application.role,
      stage: e.application.stage,
      type: e.type,
      dueAt: e.dueAt,
      confidence: e.confidence,
      evidenceText: e.evidenceText,
    })),
  });
});

/** Review queue: emails the system wasn't confident about. */
apiRouter.get("/review", async (_req, res) => {
  const user = await currentUser();
  if (!user) return res.json({ items: [] });

  const emails = await prisma.email.findMany({
    where: { userId: user.id, status: "review" },
    orderBy: { receivedAt: "desc" },
    take: 50,
  });

  res.json({
    items: emails.map((e) => ({
      id: e.id,
      sender: e.sender,
      subject: e.subject,
      snippet: e.snippet,
      receivedAt: e.receivedAt,
      reviewReason: e.reviewReason,
    })),
  });
});

// User confirms or corrects a reviewed email, supplying the right company, role,
// stage and deadline; we build the application and event from that. Good spot to
// later capture a test fixture for improving the prompt.
apiRouter.post("/review/:emailId/confirm", async (req, res) => {
  const user = await currentUser();
  if (!user) return res.status(400).json({ error: "no user" });

  const email = await prisma.email.findFirst({
    where: { id: req.params.emailId, userId: user.id },
  });
  if (!email) return res.status(404).json({ error: "email not found" });

  const { company, role, stage, deadlineIso, dismiss } = req.body as {
    company?: string;
    role?: string;
    stage?: Stage;
    deadlineIso?: string | null;
    dismiss?: boolean;
  };

  // user said "not job related", so just clear it from the queue
  if (dismiss) {
    await prisma.email.update({
      where: { id: email.id },
      data: { status: "processed", reviewReason: null },
    });
    return res.json({ ok: true, dismissed: true });
  }

  if (!company || !stage) {
    return res.status(400).json({ error: "company and stage are required" });
  }

  const app = await prisma.application.create({
    data: {
      userId: user.id,
      company,
      role: role || null,
      stage,
      lastActivityAt: email.receivedAt,
    },
  });

  if (deadlineIso) {
    const dueAt = new Date(deadlineIso);
    const event = await prisma.event.create({
      data: {
        applicationId: app.id,
        type: "deadline",
        dueAt,
        confidence: 1, // user-confirmed
        evidenceText: "user-confirmed",
        sourceEmailId: email.id,
      },
    });
    await scheduleReminderFor(event.id, dueAt);
  }

  await prisma.email.update({
    where: { id: email.id },
    data: { status: "processed", reviewReason: null },
  });

  res.json({ ok: true, applicationId: app.id });
});
