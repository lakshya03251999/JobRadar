import { prisma } from "@jobradar/db";
import type { RawEmail } from "../gmail/ingest.js";
import { prefilter } from "../extract/prefilter.js";
import { extractWithRetry, LLMExtractionError } from "../extract/llm.js";
import { validate } from "../extract/validate.js";
import { matchOrCreateApplication } from "../match/company.js";
import { scheduleReminderFor } from "../reminders/scheduler.js";
import { logger } from "../logger.js";

// Turn a raw email into tracked state: prefilter, LLM extract, validate, match an
// application, then record the event and reminder. On failure a mail lands in review
// rather than being dropped, and re-running is safe thanks to the unique Email row.
export async function processEmail(emailId: string, raw: RawEmail): Promise<void> {
  const email = await prisma.email.findUnique({ where: { id: emailId } });
  if (!email) {
    logger.warn("pipeline", `email ${emailId} vanished before processing`);
    return;
  }
  if (email.status === "processed") return;

  // 1. cheap rule pre-filter so non-job mail never reaches the LLM
  const pre = prefilter(raw);
  if (!pre.jobRelated) {
    await prisma.email.update({
      where: { id: emailId },
      data: { status: "processed", reviewReason: null },
    });
    logger.debug("pipeline", `skipped non-job mail ${email.gmailMsgId}: ${pre.reason}`);
    return;
  }

  // 2. LLM extraction, with retries. If it fails outright the email goes to the review queue.
  let extraction;
  try {
    extraction = await extractWithRetry(raw);
  } catch (err) {
    if (err instanceof LLMExtractionError) {
      await toReview(emailId, `llm_failed: ${err.message}`);
      logger.warn("pipeline", `LLM failed for ${email.gmailMsgId}, sent to review`);
      return;
    }
    throw err; // unexpected, let the queue retry with backoff
  }

  // the model itself may decide this isn't job-related
  if (!extraction.is_job_related) {
    await prisma.email.update({
      where: { id: emailId },
      data: { status: "processed", reviewReason: null },
    });
    return;
  }

  // 3. validate: evidence check, relative-deadline resolution, confidence gate
  const result = validate(extraction, raw);
  if (result.decision.kind === "review") {
    await toReview(emailId, result.decision.reason);
    return;
  }

  // 4. attach to an application, creating one or advancing its stage
  const app = await matchOrCreateApplication({
    userId: email.userId,
    email: raw,
    company: extraction.company,
    role: extraction.role,
    // "None" only appears on non-job mail (dropped above); default to Applied if it slips through.
    stage: extraction.stage === "None" ? "Applied" : extraction.stage,
  });

  // 5. create the event and schedule a reminder, but only for validated deadlines
  if (result.decision.kind === "accepted") {
    const event = await prisma.event.create({
      data: {
        applicationId: app.id,
        type: "deadline",
        dueAt: result.decision.deadlineAt,
        confidence: result.decision.confidence,
        evidenceText: result.evidenceText,
        sourceEmailId: emailId,
        followUpSuggested: false,
      },
    });
    await scheduleReminderFor(event.id, result.decision.deadlineAt);
  } else if (result.decision.kind === "follow_up") {
    // no deadline, so just flag a follow-up and skip the reminder
    await prisma.event.create({
      data: {
        applicationId: app.id,
        type: "deadline",
        dueAt: null,
        confidence: extraction.confidence,
        evidenceText: null,
        sourceEmailId: emailId,
        followUpSuggested: true,
      },
    });
  }

  await prisma.email.update({
    where: { id: emailId },
    data: { status: "processed", reviewReason: null },
  });
  logger.info("pipeline", `processed ${email.gmailMsgId} -> ${app.company} [${app.stage}]`);
}

async function toReview(emailId: string, reason: string): Promise<void> {
  await prisma.email.update({
    where: { id: emailId },
    data: { status: "review", reviewReason: reason },
  });
}
