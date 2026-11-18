"use client";

import { useEffect, useState } from "react";
import { api, type ReviewItem, type Stage } from "../lib/api";

const STAGES: Stage[] = ["Applied", "Assessment", "Interview", "Offer", "Rejected"];

function ReviewCard({ item, onDone }: { item: ReviewItem; onDone: () => void }) {
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [stage, setStage] = useState<Stage>("Applied");
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setErr(null);
    try {
      await api.confirmReview(item.id, {
        company,
        role,
        stage,
        deadlineIso: deadline ? new Date(deadline).toISOString() : null,
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    setBusy(true);
    setErr(null);
    try {
      await api.confirmReview(item.id, { dismiss: true });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-start justify-between gap-4">
        <div>
          <div className="font-semibold text-slate-800">{item.subject}</div>
          <div className="text-xs text-slate-500">{item.sender}</div>
        </div>
        <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
          {item.reviewReason}
        </span>
      </div>
      <p className="mb-3 line-clamp-3 text-sm text-slate-600">{item.snippet}</p>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <input
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          placeholder="Company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
        <input
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          placeholder="Role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
        <select
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          value={stage}
          onChange={(e) => setStage(e.target.value as Stage)}
        >
          {STAGES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <input
          type="datetime-local"
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
        />
      </div>

      <div className="mt-3 flex gap-2">
        <button
          disabled={busy || !company}
          onClick={confirm}
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          Confirm
        </button>
        <button
          disabled={busy}
          onClick={dismiss}
          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-600"
        >
          Not job-related
        </button>
      </div>

      {err && <p className="mt-2 text-sm text-red-600">Couldn&apos;t save: {err}</p>}
    </div>
  );
}

export default function ReviewPage() {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api
      .review()
      .then((d) => setItems(d.items))
      .catch((e) => setError(e.message));
  }
  useEffect(load, []);

  if (error) return <p className="text-red-600">Failed to load: {error}</p>;
  if (!items) return <p className="text-slate-500">Loading…</p>;

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">Needs review</h1>
      <p className="mb-4 text-sm text-slate-500">
        Emails where JobRadar wasn&apos;t confident. Confirm the details or mark as not job-related.
      </p>
      {items.length === 0 ? (
        <p className="text-slate-500">Nothing to review.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <ReviewCard key={item.id} item={item} onDone={load} />
          ))}
        </div>
      )}
    </div>
  );
}
