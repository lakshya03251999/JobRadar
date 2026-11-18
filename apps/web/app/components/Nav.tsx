"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, API_BASE, type Status } from "../lib/api";

const LINKS = [
  { href: "/", label: "Pipeline" },
  { href: "/deadlines", label: "Deadlines" },
  { href: "/review", label: "Review" },
];

export function Nav() {
  const pathname = usePathname();
  const [status, setStatus] = useState<Status | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    api.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  async function doSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await api.sync();
      if (r.fetched > 0) {
        setSyncMsg(`Fetched ${r.fetched} new, processing…`);
        // give the queue a moment to process, then refresh the page's data
        setTimeout(() => window.location.reload(), 1800);
      } else {
        setSyncMsg("Up to date");
      }
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-6">
          <span className="text-lg font-bold">
            Job<span className="text-indigo-600">Radar</span>
          </span>
          <nav className="flex gap-1">
            {LINKS.map((l) => {
              const active = pathname === l.href;
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                    active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-500">
          {status?.connected ? (
            <>
              {syncMsg && <span>{syncMsg}</span>}
              <button
                onClick={doSync}
                disabled={syncing || status.needsReconnect}
                className="rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
              >
                {syncing ? "Syncing…" : "Sync"}
              </button>
              <span>{status.email}</span>
            </>
          ) : (
            <a
              href={`${API_BASE}/auth/google`}
              className="rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-700"
            >
              Connect Gmail
            </a>
          )}
        </div>
      </div>

      {status?.needsReconnect && (
        <div className="bg-amber-50 px-4 py-2 text-center text-sm text-amber-800">
          ⚠️ Your Gmail connection expired.{" "}
          <a href={`${API_BASE}/auth/google`} className="font-semibold underline">
            Reconnect Gmail
          </a>{" "}
          to resume syncing.
        </div>
      )}
    </header>
  );
}
