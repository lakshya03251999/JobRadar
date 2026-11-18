"use client";

import { useEffect, useState } from "react";
import { api, type Deadline } from "../lib/api";
import { StageBadge } from "../components/StageBadge";

function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return "overdue";
  const hours = Math.round(ms / 3600000);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export default function DeadlinesPage() {
  const [items, setItems] = useState<Deadline[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .deadlines()
      .then((d) => setItems(d.deadlines))
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="text-red-600">Failed to load: {error}</p>;
  if (!items) return <p className="text-slate-500">Loading…</p>;

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">Upcoming deadlines</h1>
      {items.length === 0 ? (
        <p className="text-slate-500">No upcoming deadlines.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">Stage</th>
                <th className="px-4 py-2 font-medium">Due</th>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-medium text-slate-800">
                    {d.company}
                    {d.role && <span className="block text-xs text-slate-400">{d.role}</span>}
                  </td>
                  <td className="px-4 py-2">
                    <StageBadge stage={d.stage} />
                  </td>
                  <td className="px-4 py-2 text-slate-700">
                    {new Date(d.dueAt).toLocaleString("en-IN", {
                      day: "numeric",
                      month: "short",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{timeUntil(d.dueAt)}</td>
                  <td className="px-4 py-2 text-xs italic text-slate-400" title={d.evidenceText ?? ""}>
                    {d.evidenceText ? `"${d.evidenceText}"` : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-400">
        Every deadline shows the exact email text it came from, so you can verify it yourself.
      </p>
    </div>
  );
}
