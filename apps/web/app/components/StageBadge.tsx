import type { Stage } from "../lib/api";

const STAGE_STYLES: Record<Stage, string> = {
  Applied: "bg-slate-100 text-slate-700",
  Assessment: "bg-amber-100 text-amber-800",
  Interview: "bg-indigo-100 text-indigo-800",
  Offer: "bg-emerald-100 text-emerald-800",
  Rejected: "bg-red-100 text-red-700",
  Ghosted: "bg-slate-200 text-slate-500",
};

export function StageBadge({ stage }: { stage: Stage }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_STYLES[stage]}`}>
      {stage}
    </span>
  );
}
