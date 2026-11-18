import { DateTime } from "luxon";
import { prisma } from "@jobradar/db";
import { config } from "../config.js";
import { incrementalSync } from "../gmail/ingest.js";
import { enqueueEmails } from "../queue/index.js";
import { sweepDueReminders } from "../reminders/scheduler.js";
import { logger } from "../logger.js";

// Time-driven work runs as interval loops instead of per-item timers, so a
// restart just resumes from the DB state. All of these are idempotent:
// poll Gmail, sweep due reminders, and flag stale applications as ghosted.
// At larger scale we'd switch polling to Gmail push (Pub/Sub) and use BullMQ
// repeatable jobs.

const timers: NodeJS.Timeout[] = [];

/** Poll Gmail for every connected, healthy user and enqueue new mail. */
export async function pollAllUsers(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { refreshToken: { not: null }, needsReconnect: false },
  });
  for (const user of users) {
    try {
      const newMail = await incrementalSync(user.id);
      await enqueueEmails(newMail);
    } catch (err) {
      // Transient errors just get logged; the next cycle resumes from the same
      // historyId so nothing is skipped.
      logger.error("cron", `poll failed for user ${user.id}: ${(err as Error).message}`);
    }
  }
}

/** Mark applications with no activity for GHOSTED_AFTER_DAYS as Ghosted. */
export async function markGhosted(): Promise<void> {
  const cutoff = DateTime.now().minus({ days: config.ghostedAfterDays }).toJSDate();
  const res = await prisma.application.updateMany({
    where: {
      lastActivityAt: { lt: cutoff },
      stage: { notIn: ["Offer", "Rejected", "Ghosted"] },
    },
    data: { stage: "Ghosted" },
  });
  if (res.count) logger.info("cron", `marked ${res.count} applications as Ghosted`);
}

export function startCron(): void {
  const pollMs = config.pollIntervalMinutes * 60_000;

  // run once at boot, then on interval
  void pollAllUsers();
  timers.push(setInterval(() => void pollAllUsers(), pollMs));
  timers.push(setInterval(() => void sweepDueReminders(), 60_000));
  timers.push(setInterval(() => void markGhosted(), 60 * 60_000));

  logger.info("cron", `started (poll every ${config.pollIntervalMinutes}m, reminders every 1m, ghosted hourly)`);
}

export function stopCron(): void {
  for (const t of timers) clearInterval(t);
}
