import { DateTime } from "luxon";
import { prisma } from "@jobradar/db";
import { config } from "../config.js";
import { logger } from "../logger.js";

// Reminders are persisted rows with a sendAt rather than in-process timers, so
// they survive restarts. A cron sweep picks up the due ones and flips the `sent`
// flag to keep it idempotent. Only validated deadlines get a reminder.

/** Create a reminder `REMINDER_LEAD_HOURS` before a deadline (default 24h). */
export async function scheduleReminderFor(eventId: string, deadlineAt: Date): Promise<void> {
  const sendAt = DateTime.fromJSDate(deadlineAt)
    .minus({ hours: config.reminderLeadHours })
    .toJSDate();

  // If the lead time has already passed (deadline is <24h away), fire ASAP.
  const effectiveSendAt = sendAt < new Date() ? new Date() : sendAt;

  await prisma.reminder.create({
    data: { eventId, sendAt: effectiveSendAt, channel: "log", sent: false },
  });
  logger.debug("reminder", `scheduled for event ${eventId} at ${effectiveSendAt.toISOString()}`);
}

/**
 * Pick up all reminders whose sendAt has passed and that haven't been handled.
 * Called by the reminder cron every minute. Marks each handled so it never repeats.
 */
export async function sweepDueReminders(): Promise<number> {
  const due = await prisma.reminder.findMany({
    where: { sent: false, sendAt: { lte: new Date() } },
    include: {
      event: { include: { application: true } },
    },
    take: 50,
  });

  for (const r of due) {
    const app = r.event.application;
    const dueLocal = r.event.dueAt
      ? DateTime.fromJSDate(r.event.dueAt).setZone(config.defaultTz).toFormat("dd LLL, h:mm a")
      : "soon";

    logger.info(
      "reminder",
      `due: ${app.company}${app.role ? ` (${app.role})` : ""}, stage ${app.stage}, deadline ${dueLocal} IST`,
    );
    await prisma.reminder.update({ where: { id: r.id }, data: { sent: true } });
  }

  if (due.length) logger.info("reminder", `swept ${due.length} due reminders`);
  return due.length;
}
