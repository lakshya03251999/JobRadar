import { PrismaClient } from "@prisma/client";

// Single shared Prisma instance. In dev we cache it on globalThis so Next.js
// hot-reload / tsx watch don't open a new pool on every reload.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Re-export generated types so the rest of the monorepo imports from one place.
export * from "@prisma/client";

// SQLite has no native enums, so these "enum" columns are Strings in the schema.
// We export string-union types here so app code still gets compile-time safety.
export type Stage =
  | "Applied"
  | "Assessment"
  | "Interview"
  | "Offer"
  | "Rejected"
  | "Ghosted";
export type EmailStatus = "pending" | "processed" | "failed" | "review";
export type EventType = "deadline" | "interview" | "assessment";
export type Channel = "log";
