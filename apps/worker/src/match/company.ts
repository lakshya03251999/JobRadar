import { prisma, type Application, type Stage } from "@jobradar/db";
import { senderDomain } from "../extract/prefilter.js";
import type { RawEmail } from "../gmail/ingest.js";

// Decide which Application an email belongs to, creating one if nothing matches.
// We try thread id first, then sender domain + company name, then a fuzzy name match.

// Stages only move forward, except Rejected which can arrive from anywhere.
// Ghosted is set by cron, never by an email.
const STAGE_ORDER: Record<Stage, number> = {
  Applied: 0,
  Assessment: 1,
  Interview: 2,
  Offer: 3,
  Rejected: 99, // terminal, reachable from anywhere
  Ghosted: 98,
};

/** Levenshtein-ratio similarity in [0,1]. Good enough for short company names. */
function similarity(a: string, b: string): number {
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  const dist = dp[m][n];
  return 1 - dist / Math.max(m, n);
}

export interface MatchInput {
  userId: string;
  email: RawEmail;
  company: string;
  role: string;
  stage: Stage;
}

/** Find or create the application, then advance its stage if this email is newer. */
export async function matchOrCreateApplication(input: MatchInput): Promise<Application> {
  const { userId, email, company, role, stage } = input;
  const domain = senderDomain(email.sender);

  // 1. same Gmail thread means same application
  const byThread = await prisma.event.findFirst({
    where: { sourceEmail: { threadId: email.threadId, userId } },
    include: { application: true },
    orderBy: { createdAt: "desc" },
  });
  let app = byThread?.application ?? null;

  // 2. same sender domain plus a similar company name
  if (!app && domain) {
    const candidates = await prisma.application.findMany({
      where: { userId, senderDomain: domain },
    });
    app = candidates.find((c) => similarity(c.company, company) > 0.6) ?? null;
  }

  // 3. fuzzy company-name match across all of the user's applications
  if (!app && company) {
    const all = await prisma.application.findMany({ where: { userId } });
    app =
      all
        .map((c) => ({ c, score: similarity(c.company, company) }))
        .filter((x) => x.score > 0.85)
        .sort((a, b) => b.score - a.score)[0]?.c ?? null;
  }

  // 4. nothing matched, create a new application
  if (!app) {
    return prisma.application.create({
      data: {
        userId,
        company: company || "Unknown",
        role: role || null,
        stage,
        senderDomain: domain || null,
        lastActivityAt: email.receivedAt,
      },
    });
  }

  // existing application: advance the stage only if it moves forward
  // (app.stage is a plain string column on SQLite, so we treat it as a Stage)
  const currentStage = app.stage as Stage;
  const nextStage = STAGE_ORDER[stage] > STAGE_ORDER[currentStage] ? stage : currentStage;
  return prisma.application.update({
    where: { id: app.id },
    data: {
      stage: nextStage,
      role: app.role || role || null,
      lastActivityAt:
        email.receivedAt > app.lastActivityAt ? email.receivedAt : app.lastActivityAt,
    },
  });
}
