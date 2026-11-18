import type { RawEmail } from "../gmail/ingest.js";

// Cheap deterministic first pass: is this email worth spending an LLM call on?
// Deliberately lenient. A false positive just wastes one call, but a false
// negative would drop a real deadline, so when in doubt we let it through.

const JOB_KEYWORDS = [
  "interview",
  "assessment",
  "application",
  "applied",
  "hiring",
  "recruit",
  "offer",
  "offer letter",
  "shortlist",
  "candidate",
  "position",
  "role",
  "job",
  "opening",
  "coding challenge",
  "take-home",
  "screening",
  "regret",
  "unfortunately",
  "not moving forward",
  "talent acquisition",
  "hr team",
];

// Transactional / promotional noise. If one of these shows up and there's no
// strong job signal, skip the LLM: it's a bank alert, a loan pitch, etc.
const NEGATIVE_PHRASES = [
  "transaction alert",
  "debited from your",
  "credited to your",
  "spent on your",
  "e-statement",
  "mini statement",
  "personal loan",
  "credit card ending",
  " emi ",
  "policy no",
  "warranty",
  "one time password",
  "your otp",
];

// Strong signals that this really is recruiting mail, even if a negative phrase
// also appears. These override the negative list.
const STRONG_JOB_SIGNALS = [
  "interview",
  "assessment",
  "offer letter",
  "shortlist",
  "recruit",
  "hiring",
  "coding challenge",
  "take-home",
  "talent acquisition",
  "job description",
];

// known ATS / recruiting domains
const ATS_DOMAINS = [
  "greenhouse.io",
  "lever.co",
  "naukri.com",
  "workday.com",
  "myworkday.com",
  "ashbyhq.com",
  "smartrecruiters.com",
  "icims.com",
  "taleo.net",
  "jobvite.com",
  "workable.com",
  "indeed.com",
  "linkedin.com",
  "hire.lever.co",
];

export interface PrefilterResult {
  jobRelated: boolean;
  reason: string;
  matchedKeywords: string[];
  fromAtsDomain: boolean;
}

export function senderDomain(sender: string): string {
  // sender can be "Aditi Arora <aditi@damcogroup.com>" or just "aditi@damcogroup.com"
  const match = sender.match(/<([^>]+)>/);
  const addr = (match ? match[1] : sender).trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  return at >= 0 ? addr.slice(at + 1) : "";
}

export function prefilter(email: RawEmail): PrefilterResult {
  const haystack = `${email.subject}\n${email.snippet}\n${email.body}`.toLowerCase();
  const domain = senderDomain(email.sender);

  const fromAtsDomain = ATS_DOMAINS.some(
    (d) => domain === d || domain.endsWith(`.${d}`),
  );
  const matchedKeywords = JOB_KEYWORDS.filter((k) => haystack.includes(k));
  const strongJobSignal = fromAtsDomain || STRONG_JOB_SIGNALS.some((s) => haystack.includes(s));

  // Drop obvious bank/loan/transactional mail unless it carries a real job signal.
  if (!strongJobSignal && NEGATIVE_PHRASES.some((p) => haystack.includes(p))) {
    return {
      jobRelated: false,
      fromAtsDomain,
      matchedKeywords: [],
      reason: "looks transactional/promotional (bank, loan, insurance, etc.)",
    };
  }

  const jobRelated = fromAtsDomain || matchedKeywords.length > 0;

  return {
    jobRelated,
    fromAtsDomain,
    matchedKeywords,
    reason: fromAtsDomain
      ? `sender domain ${domain} is a known ATS`
      : matchedKeywords.length > 0
        ? `matched keywords: ${matchedKeywords.slice(0, 5).join(", ")}`
        : "no job keywords or ATS domain",
  };
}
