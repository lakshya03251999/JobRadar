import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { apiRouter } from "./routes/api.js";
import { logger } from "./logger.js";

/** Builds the Express app: health, OAuth, and the dashboard REST API. */
export function createServer(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cors({ origin: config.webOrigin, credentials: true }));

  app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

  app.use("/auth", authRouter);
  app.use("/api", apiRouter);

  // Central error handler so a thrown route never crashes the process.
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error("server", err.message, err.stack);
      res.status(500).json({ error: "internal error" });
    },
  );

  return app;
}
