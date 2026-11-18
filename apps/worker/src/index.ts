import { config } from "./config.js";
import { createServer } from "./server.js";
import { startEmailWorker, closeQueue } from "./queue/index.js";
import { startCron, stopCron } from "./cron/index.js";
import { flushLangfuse } from "./observability/langfuse.js";
import { logger } from "./logger.js";

// One process runs the whole backend: the Express API, the BullMQ worker, and
// the cron loops. Bundling them keeps the free-tier deploy simple; at scale
// you'd split the API and worker into separate services.
async function main() {
  const app = createServer();
  const server = app.listen(config.port, () => {
    logger.info("boot", `API listening on :${config.port}`);
    logger.info("boot", `connect Gmail at http://localhost:${config.port}/auth/google`);
  });

  startEmailWorker();
  startCron();

  // Graceful shutdown so in-flight jobs finish and Redis connections close.
  const shutdown = async (sig: string) => {
    logger.info("boot", `${sig} received, shutting down`);
    stopCron();
    server.close();
    await closeQueue();
    await flushLangfuse();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("boot", `fatal: ${err.message}`, err.stack);
  process.exit(1);
});
