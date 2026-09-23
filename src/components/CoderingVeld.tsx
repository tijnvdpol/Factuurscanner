import type { Codering, Grootboekrekening } from "../types";
import { handmatigeCodering, rekeningNaam, voorstelLabel } from "../lib/codering";

interface Props {
  codering: Codering;
  rekeningen: Grootboekrekening[];
  onChange: (codering: Codering) => void;
}

/** Keuze van de grootboekrekening, met het voorstel (historie/AI) en een knop om het te bevestigen. */
export default function CoderingVeld({ codering, rekeningen, onChange }: Props) {
  const label = voorstelLabel(codering);
  const keuzes = rekeningen.filter((r) => r.actief || r.id === codering.grootboekrekening_id);

  return (
    <div className="mt-5">
      <h3 className="mb-2 text-xs font-semibold text-slate-600">Codering</h3>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={codering.grootboekrekening_id ?? ""}
          onChange={(e) => onChange(handmatigeCodering(e.target.value || null))}
          aria-label="Grootboekrekening"
          className={`min-w-0 flex-1 rounded-md border px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20 sm:max-w-sm ${
            label ? "border-amber-300 bg-amber-50" : "border-slate-300 bg-white"
          }`}
        >
          <option value="">— Kies een grootboekrekening —</option>
          {keuzes.map((r) => (
            <option key={r.id} value={r.id}>
              {rekeningNaam(r)}
              {r.actief ? "" : " (inactief)"}
            </option>
          ))}
        </select>
        {label && (
          <>
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">{label}</span>
            <button
              type="button"
              onClick={() => onChange(handmatigeCodering(codering.grootboekrekening_id))}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Bevestigen
            </button>
          </>
        )}
        {codering.bron === "handmatig" && <span className="text-xs text-emerald-700">✓ Bevestigd</span>}
      </div>
      {!codering.grootboekrekening_id && (
        <p className="mt-1 text-xs text-slate-400">Een grootboekrekening is nodig om de factuur te kunnen goedkeuren.</p>
      )}
    </div>
  );
}
