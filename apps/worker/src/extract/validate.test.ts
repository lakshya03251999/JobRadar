import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { validate, resolveDeadline } from "./validate.js";
import { prefilter } from "./prefilter.js";
import type { RawEmail } from "../gmail/ingest.js";
import type { Extraction } from "./llm.js";

// Load the anonymized fixtures from tests/fixtures.
import relative48h from "../../../../tests/fixtures/relative-48h.json" with { type: "json" };
import noDeadline from "../../../../tests/fixtures/no-deadline-damco.json" with { type: "json" };
import hallucinated from "../../../../tests/fixtures/hallucinated-deadline.json" with { type: "json" };
import rejection from "../../../../tests/fixtures/rejection.json" with { type: "json" };
import lowConfidence from "../../../../tests/fixtures/low-confidence.json" with { type: "json" };

type Fixture = { email: Omit<RawEmail, "receivedAt"> & { receivedAt: string }; extraction: Extraction };

function toRaw(f: Fixture): RawEmail {
  return { ...f.email, receivedAt: new Date(f.email.receivedAt) };
}

describe("validate()", () => {
  it("accepts a relative deadline and computes the absolute IST instant", () => {
    const f = relative48h as unknown as Fixture;
    const res = validate(f.extraction, toRaw(f));
    expect(res.decision.kind).toBe("accepted");
    if (res.decision.kind === "accepted") {
      // received 2026-11-10T09:00Z + 48h = 2026-11-12T09:00Z
      const expected = new Date("2026-11-12T09:00:00.000Z").getTime();
      expect(res.decision.deadlineAt!.getTime()).toBe(expected);
    }
    expect(res.evidenceText).toBe("within 48 hours");
  });

  it("flags follow-up (not a reminder) when the email has no deadline", () => {
    const f = noDeadline as unknown as Fixture;
    const res = validate(f.extraction, toRaw(f));
    expect(res.decision.kind).toBe("follow_up");
  });

  it("catches a hallucinated deadline not present verbatim in the email", () => {
    const f = hallucinated as unknown as Fixture;
    const res = validate(f.extraction, toRaw(f));
    expect(res.decision.kind).toBe("review");
    if (res.decision.kind === "review") {
      expect(res.decision.reason).toMatch(/not found verbatim/);
    }
  });

  it("routes low-confidence extractions to review", () => {
    const f = lowConfidence as unknown as Fixture;
    const res = validate(f.extraction, toRaw(f));
    expect(res.decision.kind).toBe("review");
    if (res.decision.kind === "review") {
      expect(res.decision.reason).toMatch(/low confidence/);
    }
  });

  it("handles a rejection: job-related with no deadline, follow-up only", () => {
    const f = rejection as unknown as Fixture;
    const res = validate(f.extraction, toRaw(f));
    expect(res.decision.kind).toBe("follow_up");
  });
});

describe("resolveDeadline()", () => {
  const anchor = new Date("2026-11-10T09:00:00.000Z"); // Tue

  function ext(partial: Partial<Extraction>): Extraction {
    return {
      is_job_related: true,
      company: "X",
      role: "Y",
      stage: "Assessment",
      deadline_text: "",
      deadline_iso: "",
      links: [],
      confidence: 0.9,
      ...partial,
    };
  }

  it("resolves 'within 48 hours'", () => {
    const d = resolveDeadline(ext({ deadline_text: "within 48 hours" }), anchor);
    expect(d!.toISOString()).toBe("2026-11-12T09:00:00.000Z");
  });

  it("resolves 'by Friday' to the next Friday end-of-day IST", () => {
    const d = resolveDeadline(ext({ deadline_text: "by Friday" }), anchor);
    const dt = DateTime.fromJSDate(d!, { zone: "Asia/Kolkata" });
    expect(dt.weekdayLong).toBe("Friday");
    expect(dt > DateTime.fromJSDate(anchor)).toBe(true);
  });

  it("trusts an explicit absolute deadline_iso", () => {
    const d = resolveDeadline(ext({ deadline_iso: "2026-12-01T17:00:00+05:30" }), anchor);
    expect(d!.toISOString()).toBe("2026-12-01T11:30:00.000Z");
  });

  it("returns null for an unparseable phrase", () => {
    const d = resolveDeadline(ext({ deadline_text: "asap-ish whenever" }), anchor);
    expect(d).toBeNull();
  });
});

describe("prefilter()", () => {
  function raw(partial: Partial<RawEmail>): RawEmail {
    return {
      gmailMsgId: "x",
      threadId: "t",
      sender: "a@b.com",
      subject: "",
      snippet: "",
      body: "",
      receivedAt: new Date(),
      ...partial,
    };
  }

  it("passes ATS-domain mail even without keywords", () => {
    const r = prefilter(raw({ sender: "Recruiter <r@greenhouse.io>", body: "hello" }));
    expect(r.jobRelated).toBe(true);
    expect(r.fromAtsDomain).toBe(true);
  });

  it("passes mail with job keywords", () => {
    const r = prefilter(raw({ subject: "Your interview invitation" }));
    expect(r.jobRelated).toBe(true);
  });

  it("rejects obvious non-job mail", () => {
    const r = prefilter(raw({ subject: "50% off shoes!", body: "Shop our sale today." }));
    expect(r.jobRelated).toBe(false);
  });
});
