import { DateTime } from "luxon";
import { config } from "../config.js";
import type { RawEmail } from "../gmail/ingest.js";
import type { Extraction } from "./llm.js";

// Turns a raw LLM extraction into a decision the pipeline can act on (accept,
// review, or follow-up). We only accept a deadline whose text actually shows up
// in the email, then resolve relative phrases to a concrete IST datetime.

export type ValidationDecision =
  | { kind: "accepted"; deadlineAt: Date; confidence: number }
  | { kind: "review"; reason: string }
  | { kind: "follow_up"; reason: string }; // no deadline, but worth a nudge

export interface ValidatedResult {
  decision: ValidationDecision;
  /** The evidence substring, when a deadline was accepted. */
  evidenceText: string | null;
}

/** Normalise whitespace so "within   48 hours\n" matches "within 48 hours". */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Does `needle` appear verbatim (whitespace-insensitive) in the email? */
function appearsVerbatim(needle: string, email: RawEmail): boolean {
  if (!needle.trim()) return false;
  const hay = normalize(`${email.subject} ${email.body}`);
  return hay.includes(normalize(needle));
}

/**
 * Resolve a deadline to an absolute Date in IST. Prefer the model's absolute ISO,
 * then fall back to relative phrases ("48 hours", "by Friday") anchored to received_at.
 * Returns null if nothing is parseable.
 */
export function resolveDeadline(ext: Extraction, receivedAt: Date): Date | null {
  const tz = config.defaultTz;

  // absolute ISO from the model
  if (ext.deadline_iso && ext.deadline_iso.trim()) {
    const dt = DateTime.fromISO(ext.deadline_iso, { zone: tz });
    if (dt.isValid) return dt.toJSDate();
  }

  const text = ext.deadline_text.toLowerCase();
  const anchor = DateTime.fromJSDate(receivedAt, { zone: tz });

  // "within N hours" / "N hours"
  const hours = text.match(/(\d+)\s*(hour|hr)s?/);
  if (hours) return anchor.plus({ hours: Number(hours[1]) }).toJSDate();

  // "within N days" / "N days"
  const days = text.match(/(\d+)\s*days?/);
  if (days) return anchor.plus({ days: Number(days[1]) }).toJSDate();

  // "tomorrow" / "end of day"
  if (/\btomorrow\b/.test(text)) {
    return anchor.plus({ days: 1 }).endOf("day").toJSDate();
  }
  if (/\b(eod|end of day|by today)\b/.test(text)) {
    return anchor.endOf("day").toJSDate();
  }

  // "by <weekday>": next occurrence of that weekday
  const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const wd = weekdays.findIndex((d) => text.includes(d));
  if (wd >= 0) {
    const targetIso = wd + 1; // luxon: Monday=1
    let dt = anchor;
    // advance to the next matching weekday (at least +1 day)
    do {
      dt = dt.plus({ days: 1 });
    } while (dt.weekday !== targetIso);
    return dt.endOf("day").toJSDate();
  }

  // an explicit date in the text, e.g. "October 20" / "20 Oct 2026"
  for (const fmt of ["LLLL d", "LLLL d yyyy", "d LLL yyyy", "d LLLL", "dd/MM/yyyy", "yyyy-MM-dd"]) {
    const dt = DateTime.fromFormat(ext.deadline_text.trim(), fmt, { zone: tz });
    if (dt.isValid) {
      // no year and in the past? assume next year
      const withYear = dt.year < anchor.year ? dt.set({ year: anchor.year }) : dt;
      return (withYear < anchor ? withYear.plus({ years: 1 }) : withYear).endOf("day").toJSDate();
    }
  }

  return null;
}

export function validate(ext: Extraction, email: RawEmail): ValidatedResult {
  // low confidence goes straight to review, regardless of deadline
  if (ext.confidence < config.confidenceThreshold) {
    return {
      decision: { kind: "review", reason: `low confidence ${ext.confidence.toFixed(2)}` },
      evidenceText: null,
    };
  }

  // no deadline stated, nothing to validate, so just suggest a follow-up
  if (!ext.deadline_text.trim()) {
    return {
      decision: { kind: "follow_up", reason: "no deadline found in email" },
      evidenceText: null,
    };
  }

  // the deadline phrase has to actually appear in the email, else treat it as made up
  if (!appearsVerbatim(ext.deadline_text, email)) {
    return {
      decision: {
        kind: "review",
        reason: `deadline "${ext.deadline_text}" not found verbatim in email (possible hallucination)`,
      },
      evidenceText: null,
    };
  }

  // Resolve to an absolute instant.
  const deadlineAt = resolveDeadline(ext, email.receivedAt);
  if (!deadlineAt) {
    // The phrase is in the email but isn't a concrete date ("at your earliest
    // convenience", "asap"). Don't block the application in review: track it
    // with a follow-up flag and skip the reminder.
    return {
      decision: { kind: "follow_up", reason: `no concrete deadline ("${ext.deadline_text}")` },
      evidenceText: null,
    };
  }

  return {
    decision: { kind: "accepted", deadlineAt, confidence: ext.confidence },
    evidenceText: ext.deadline_text,
  };
}
