// Typed fetch helpers for the JobRadar backend.
// Base URL comes from NEXT_PUBLIC_API_URL at build time.

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export const API_BASE = BASE;

// Types mirrored from the backend responses.
export type Stage = "Applied" | "Assessment" | "Interview" | "Offer" | "Rejected" | "Ghosted";

export interface AppCard {
  id: string;
  company: string;
  role: string | null;
  stage: Stage;
  lastActivityAt: string;
  nextDeadline: string | null;
  followUpSuggested: boolean;
}

export interface Deadline {
  id: string;
  company: string;
  role: string | null;
  stage: Stage;
  type: string;
  dueAt: string;
  confidence: number;
  evidenceText: string | null;
}

export interface ReviewItem {
  id: string;
  sender: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  reviewReason: string | null;
}

export interface Status {
  connected: boolean;
  email: string | null;
  needsReconnect: boolean;
}

export const api = {
  status: () => get<Status>("/api/status"),
  sync: () => post<{ fetched: number }>("/api/sync", {}),
  applications: () => get<{ stages: Record<Stage, AppCard[]>; order: Stage[] }>("/api/applications"),
  deadlines: () => get<{ deadlines: Deadline[] }>("/api/deadlines"),
  review: () => get<{ items: ReviewItem[] }>("/api/review"),
  confirmReview: (
    emailId: string,
    body: { company?: string; role?: string; stage?: Stage; deadlineIso?: string | null; dismiss?: boolean },
  ) => post<{ ok: boolean }>(`/api/review/${emailId}/confirm`, body),
};
