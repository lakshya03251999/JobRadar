import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config();
dotenv.config({ path: resolve(here, "../../../.env") });

const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? "";
const secretKey = process.env.LANGFUSE_SECRET_KEY ?? "";
const baseUrl = process.env.LANGFUSE_BASEURL ?? "https://cloud.langfuse.com";
console.log("publicKey:", publicKey.slice(0, 10) + "...", "baseUrl:", baseUrl);

const processor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl });
const provider = new NodeTracerProvider({ spanProcessors: [processor] });
provider.register();

const tracer = trace.getTracer("langfuse-test");
const span = tracer.startSpan("manual-test-trace");
span.setAttribute("langfuse.observation.type", "generation");
span.setAttribute("langfuse.observation.input", JSON.stringify("ping"));
span.setAttribute("langfuse.observation.output", JSON.stringify("pong"));
span.end();

console.log("flushing...");
await processor.forceFlush();
console.log("flushed. look for 'manual-test-trace' in the Langfuse dashboard.");
await processor.shutdown();
console.log("done.");
