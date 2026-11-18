import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { config } from "../config.js";
import { logger } from "../logger.js";

// Optional LLM tracing. Langfuse v4 ingests traces over OpenTelemetry, so we
// register a span processor once at startup. With no keys this stays null and
// the app behaves exactly as before.
let spanProcessor: LangfuseSpanProcessor | null = null;

if (config.langfuse.enabled) {
  spanProcessor = new LangfuseSpanProcessor({
    publicKey: config.langfuse.publicKey,
    secretKey: config.langfuse.secretKey,
    baseUrl: config.langfuse.baseUrl,
  });
  const provider = new NodeTracerProvider({ spanProcessors: [spanProcessor] });
  provider.register();
  logger.info("langfuse", `tracing enabled (${config.langfuse.baseUrl})`);
}

export const langfuseEnabled = config.langfuse.enabled;

// Call before the process exits so buffered spans actually get sent.
export async function flushLangfuse(): Promise<void> {
  await spanProcessor?.forceFlush();
}
