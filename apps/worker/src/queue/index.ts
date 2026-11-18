import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";
import type { RawEmail } from "../gmail/ingest.js";
import { processEmail } from "../pipeline/processEmail.js";
import { logger } from "../logger.js";

// Two queue backends behind the same three functions: BullMQ+Redis when
// REDIS_URL is set, otherwise an in-memory queue for local dev. Both do retries
// with backoff and a concurrency cap; the in-memory one loses pending jobs on a
// crash.

export interface ProcessEmailJob {
  emailId: string;
  raw: RawEmail;
}

const RETRY_ATTEMPTS = 4; // 1 try + 3 retries
const CONCURRENCY = 5;
const useRedis = !!config.redisUrl;

// Dedupe guard: process each gmail message id once, across poll cycles.
const seen = new Set<string>();

// --- BullMQ (Redis) backend ---
let emailQueue: Queue<ProcessEmailJob> | undefined;
let bullWorker: Worker<ProcessEmailJob> | undefined;

function redisConnection(): ConnectionOptions {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null }) as unknown as ConnectionOptions;
}

// --- In-memory backend ---
interface MemJob {
  data: ProcessEmailJob;
  attempts: number;
}
const memQueue: MemJob[] = [];
let active = 0;
let draining = false;

async function runMemJob(job: MemJob): Promise<void> {
  try {
    await processEmail(job.data.emailId, job.data.raw);
    logger.debug("queue", `(mem) job ${job.data.raw.gmailMsgId} done`);
  } catch (err) {
    job.attempts++;
    if (job.attempts < RETRY_ATTEMPTS) {
      const delay = 5_000 * 2 ** (job.attempts - 1); // 5s, 10s, 20s
      logger.warn("queue", `(mem) retry ${job.attempts} for ${job.data.raw.gmailMsgId} in ${delay}ms`);
      setTimeout(() => {
        memQueue.push(job);
        void pump();
      }, delay);
    } else {
      logger.error("queue", `(mem) job ${job.data.raw.gmailMsgId} failed permanently: ${(err as Error).message}`);
    }
  }
}

async function pump(): Promise<void> {
  if (draining) return;
  draining = true;
  while (memQueue.length > 0 && active < CONCURRENCY) {
    const job = memQueue.shift()!;
    active++;
    void runMemJob(job).finally(() => {
      active--;
      void pump();
    });
  }
  draining = false;
}

// --- Shared public API ---
export async function enqueueEmails(
  items: Array<{ emailId: string; raw: RawEmail }>,
): Promise<void> {
  const fresh = items.filter((it) => !seen.has(it.raw.gmailMsgId));
  for (const it of fresh) seen.add(it.raw.gmailMsgId);
  if (fresh.length === 0) return;

  if (useRedis) {
    emailQueue ??= new Queue<ProcessEmailJob>("email-processing", {
      connection: redisConnection(),
      defaultJobOptions: {
        attempts: RETRY_ATTEMPTS,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
    await emailQueue.addBulk(
      fresh.map((it) => ({
        name: "process",
        data: { emailId: it.emailId, raw: it.raw },
        opts: { jobId: `email:${it.raw.gmailMsgId}` },
      })),
    );
  } else {
    for (const it of fresh) memQueue.push({ data: { emailId: it.emailId, raw: it.raw }, attempts: 0 });
    void pump();
  }
  logger.info("queue", `enqueued ${fresh.length} emails (${useRedis ? "redis" : "in-memory"})`);
}

export function startEmailWorker(): void {
  if (!useRedis) {
    logger.info("queue", "in-memory queue active (no REDIS_URL set)");
    return; // mem pump runs inline, nothing to start here
  }
  bullWorker = new Worker<ProcessEmailJob>(
    "email-processing",
    async (job) => processEmail(job.data.emailId, job.data.raw),
    { connection: redisConnection(), concurrency: CONCURRENCY },
  );
  bullWorker.on("failed", (job, err) =>
    logger.error("queue", `job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`),
  );
  logger.info("queue", "BullMQ worker started (redis)");
}

export async function closeQueue(): Promise<void> {
  await bullWorker?.close();
  await emailQueue?.close();
}
