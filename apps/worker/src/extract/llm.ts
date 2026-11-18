import OpenAI from "openai";
import { z } from "zod";
import { config } from "../config.js";
import type { RawEmail } from "../gmail/ingest.js";
import { observeOpenAI } from "@langfuse/openai";
import { logger } from "../logger.js";
import { langfuseEnabled } from "../observability/langfuse.js";

// LLM extraction via OpenRouter (OpenAI-compatible). We force a single tool call
// so the model returns a fixed shape, then re-validate it with Zod.

export const STAGES = [
  "Applied",
  "Assessment",
  "Interview",
  "Offer",
  "Rejected",
] as const;

// The model returns "None" for mail that isn't a job application (bank alerts,
// loan offers, etc.). Those get dropped in the pipeline, never tracked. Allowing
// it here means non-job mail validates cleanly instead of failing the schema.
const EXTRACTION_STAGES = [...STAGES, "None"] as const;

// what we validate the model's JSON against
export const ExtractionSchema = z.object({
  is_job_related: z.boolean(),
  company: z.string(),
  role: z.string(),
  stage: z.enum(EXTRACTION_STAGES),
  /** The deadline phrase copied verbatim from the email, or "" if none. */
  deadline_text: z.string(),
  /** Absolute ISO-8601 if the model is confident, else "". Validation recomputes relative ones. */
  deadline_iso: z.string(),
  links: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

// JSON Schema handed to the API. Structured outputs need additionalProperties:false
// and a required list, and don't support min/maxLength (those stay in the Zod schema).
const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    is_job_related: {
      type: "boolean",
      description: "True only if this email is about a job application the recipient made.",
    },
    company: { type: "string", description: "Hiring company name. Empty string if unknown." },
    role: { type: "string", description: "Job title/role. Empty string if unknown." },
    stage: {
      type: "string",
      enum: [...EXTRACTION_STAGES],
      description:
        "Pipeline stage this email represents. 'Rejected' for regrets, 'Applied' for a plain acknowledgement. Use 'None' when is_job_related is false.",
    },
    deadline_text: {
      type: "string",
      description:
        "The EXACT substring stating a concrete deadline that has a date or a relative time (e.g. 'within 48 hours', 'by Friday 5pm', 'October 20'). Copy it VERBATIM, character for character. Return \"\" for vague urgency with no date/time such as 'at your earliest convenience', 'asap', 'quick response', or when the email states no deadline.",
    },
    deadline_iso: {
      type: "string",
      description:
        "Deadline as an absolute ISO-8601 datetime ONLY if the email gives an explicit calendar date/time. Empty string for relative deadlines like '48 hours' (those are computed later) or if no deadline.",
    },
    links: {
      type: "array",
      items: { type: "string" },
      description: "Assessment or meeting URLs found in the email. Empty array if none.",
    },
    confidence: {
      type: "number",
      description: "Your confidence (0..1) that company, role, stage and deadline are all correct.",
    },
  },
  required: [
    "is_job_related",
    "company",
    "role",
    "stage",
    "deadline_text",
    "deadline_iso",
    "links",
    "confidence",
  ],
} as const;

const SYSTEM_PROMPT = `You extract structured data from recruiting / job-application emails.
Rules you MUST follow:
- Only set is_job_related=true if the email concerns a job the recipient applied to (interview, assessment, offer, rejection, application acknowledgement). Bank and transaction alerts, loan or credit-card offers, insurance, warranties, newsletters, job alerts, and marketing are NOT job-related.
- When is_job_related is false, set stage to "None" and leave company, role and deadline empty.
- deadline_text MUST be copied verbatim, and ONLY when it names a concrete deadline with a date or a relative time ("within 48 hours", "by Friday", "October 20"). Vague urgency like "at your earliest convenience", "asap", or "quick response" is NOT a deadline: return "". Never paraphrase or invent one.
- deadline_iso: fill ONLY when the email contains an explicit absolute date/time. For relative deadlines, leave it "" since those are computed downstream.
- Set confidence honestly. If company/role/stage are ambiguous, lower it.
Return ONLY the structured object.`;

const client = new OpenAI({
  apiKey: config.llm.apiKey,
  baseURL: config.llm.baseUrl,
  // optional OpenRouter attribution headers
  defaultHeaders: {
    "HTTP-Referer": "https://github.com/jobradar",
    "X-Title": "JobRadar",
  },
});

const EXTRACTION_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "record_extraction",
    description: "Record the structured fields extracted from this recruiting email.",
    parameters: JSON_SCHEMA as unknown as Record<string, unknown>,
  },
};

export class LLMExtractionError extends Error {}

function buildUserContent(email: RawEmail): string {
  // cap the body so a giant email doesn't blow the token budget
  const body = email.body.slice(0, 8000);
  return [
    `From: ${email.sender}`,
    `Subject: ${email.subject}`,
    `Received: ${email.receivedAt.toISOString()}`,
    `--- EMAIL BODY ---`,
    body,
  ].join("\n");
}

/**
 * Call the model once and return the validated extraction.
 * Throws LLMExtractionError on malformed JSON or schema mismatch (caller retries).
 */
export async function extractWithLLM(email: RawEmail): Promise<Extraction> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserContent(email) },
  ];

  // When tracing is on, observeOpenAI wraps the client so this call is exported
  // to Langfuse (prompt, output, token usage, latency) over OpenTelemetry.
  const caller = langfuseEnabled
    ? observeOpenAI(client, {
        traceName: "extract-email",
        generationName: "openrouter",
        generationMetadata: {
          gmailMsgId: email.gmailMsgId,
          sender: email.sender,
          subject: email.subject,
        },
        tags: ["extraction"],
      })
    : client;

  let response;
  try {
    response = await caller.chat.completions.create({
      model: config.llm.model,
      max_tokens: 1024,
      messages,
      tools: [EXTRACTION_TOOL],
      // force the tool call so we always get structured output
      tool_choice: { type: "function", function: { name: "record_extraction" } },
    });
  } catch (err) {
    throw new LLMExtractionError(`OpenRouter API error: ${(err as Error).message}`);
  }

  const call = response.choices[0]?.message?.tool_calls?.[0];
  if (!call || call.type !== "function") {
    throw new LLMExtractionError("Model did not call the extraction tool");
  }

  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    throw new LLMExtractionError(
      `Model returned non-JSON arguments: ${call.function.arguments.slice(0, 200)}`,
    );
  }

  const parsed = ExtractionSchema.safeParse(args);
  if (!parsed.success) {
    throw new LLMExtractionError(`Schema mismatch: ${parsed.error.message}`);
  }

  logger.debug("llm", `extracted ${email.gmailMsgId}`, parsed.data);
  return parsed.data;
}

/** Retry wrapper: up to `attempts` tries before giving up (caller then sends it to the review queue). */
export async function extractWithRetry(
  email: RawEmail,
  attempts = 3,
): Promise<Extraction> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await extractWithLLM(email);
    } catch (err) {
      lastErr = err;
      logger.warn("llm", `extract attempt ${i}/${attempts} failed: ${(err as Error).message}`);
    }
  }
  throw new LLMExtractionError(
    `All ${attempts} extraction attempts failed: ${(lastErr as Error)?.message}`,
  );
}
