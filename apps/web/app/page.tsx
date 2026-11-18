"use client";

import { useEffect, useState } from "react";
import { api, type AppCard, type Stage } from "./lib/api";

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Card({ app }: { app: AppCard }) {
  const overdueSoon =
    app.nextDeadline && new Date(app.nextDeadline).getTime() - Date.now() < 48 * 3600 * 1000;
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="font-semibold text-slate-800">{app.company}</div>
      {app.role && <div className="text-sm text-slate-500">{app.role}</div>}
      {app.nextDeadline ? (
        <div className={`mt-2 text-xs ${overdueSoon ? "font-semibold text-red-600" : "text-slate-500"}`}>
          ⏰ {fmtDate(app.nextDeadline)}
        </div>
      ) : app.followUpSuggested ? (
        <div className="mt-2 text-xs text-amber-600">↩︎ follow-up suggested</div>
      ) : null}
    </div>
  );
}

export default function PipelinePage() {
  const [data, setData] = useState<{ stages: Record<Stage, AppCard[]>; order: Stage[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api
        .applications()
        .then(setData)
        .catch((e) => setError(e.message));
    load();
    const t = setInterval(load, 30_000); // poll so the board stays current
    return () => clearInterval(t);
  }, []);

  if (error) return <p className="text-red-600">Failed to load: {error}</p>;
  if (!data) return <p className="text-slate-500">Loading…</p>;

  const total = Object.values(data.stages).reduce((n, arr) => n + arr.length, 0);
  if (total === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center">
        <p className="text-slate-600">No applications yet.</p>
        <p className="mt-1 text-sm text-slate-400">
          Connect Gmail and JobRadar reads recruiter emails to fill this board automatically.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">Pipeline</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        {data.order.map((stage) => (
          <div key={stage} className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-600">{stage}</h2>
              <span className="text-xs text-slate-400">{data.stages[stage].length}</span>
            </div>
            <div className="flex flex-col gap-2">
              {data.stages[stage].map((app) => (
                <Card key={app.id} app={app} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
