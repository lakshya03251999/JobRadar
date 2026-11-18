import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The worker runs with its cwd at apps/worker, so load the monorepo-root .env
// explicitly. A local apps/worker/.env still wins if one exists.
const here = dirname(fileURLToPath(import.meta.url));
dotenv.config(); // apps/worker/.env, if present
dotenv.config({ path: resolve(here, "../../../.env") }); // repo-root .env

// Validated env config in one place. Importing it early fails fast with a clear
// message when something's missing, rather than a stray `undefined` surfacing
// deep in the Gmail or LLM code.

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}. See .env.example`);
  }
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: num("PORT", 4000),
  webOrigin: opt("WEB_ORIGIN", "http://localhost:3000"),
  defaultTz: opt("DEFAULT_TZ", "Asia/Kolkata"),

  databaseUrl: req("DATABASE_URL"),
  // Optional: when set, the queue uses BullMQ + Redis; when empty, an in-memory
  // queue is used so the app runs with zero external services.
  redisUrl: process.env.REDIS_URL ?? "",

  google: {
    clientId: req("GOOGLE_CLIENT_ID"),
    clientSecret: req("GOOGLE_CLIENT_SECRET"),
    redirectUri: req("GOOGLE_REDIRECT_URI"),
  },

  tokenEncKey: req("TOKEN_ENC_KEY"),

  // LLM via OpenRouter (OpenAI-compatible). Point LLM_MODEL at any OpenRouter
  // model slug, e.g. "openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet".
  llm: {
    apiKey: req("OPENROUTER_API_KEY"),
    baseUrl: opt("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    model: opt("LLM_MODEL", "openai/gpt-4o-mini"),
  },

  // Langfuse LLM tracing (optional). On only when both keys are set.
  langfuse: {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? "",
    secretKey: process.env.LANGFUSE_SECRET_KEY ?? "",
    baseUrl: opt("LANGFUSE_BASEURL", "https://cloud.langfuse.com"),
    enabled: !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
  },

  // Tunables
  pollIntervalMinutes: num("POLL_INTERVAL_MINUTES", 5),
  confidenceThreshold: num("CONFIDENCE_THRESHOLD", 0.7),
  ghostedAfterDays: num("GHOSTED_AFTER_DAYS", 14),
  reminderLeadHours: num("REMINDER_LEAD_HOURS", 24),
} as const;

export type Config = typeof config;
