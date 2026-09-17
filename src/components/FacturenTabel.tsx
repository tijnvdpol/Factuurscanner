import type { Factuur } from "../types";
import { formatBedrag } from "../lib/getallen";
import { heeftFouten, valideerFactuur } from "../lib/validatie";
import { downloadCsv } from "../lib/csv";

interface Props {
  facturen: Factuur[];
  onBewerken: (id: string) => void;
  onVerwijderen: (id: string) => void;
}

export default function FacturenTabel({ facturen, onBewerken, onVerwijderen }: Props) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Verzamelde facturen</h2>
          <p className="text-xs text-slate-400">{facturen.length} factu{facturen.length === 1 ? "ur" : "ren"}</p>
        </div>
        <button
          type="button"
          disabled={facturen.length === 0}
          onClick={() => downloadCsv(facturen)}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          Exporteren als CSV
        </button>
      </div>

      {facturen.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-400">
          Nog geen facturen toegevoegd. Scan een factuur om te beginnen.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2.5">Leverancier</th>
                <th className="px-5 py-2.5">Factuurnr.</th>
                <th className="px-5 py-2.5">Datum</th>
                <th className="px-5 py-2.5 text-right">Excl. BTW</th>
                <th className="px-5 py-2.5 text-right">Totaal</th>
                <th className="px-5 py-2.5">Valuta</th>
                <th className="px-5 py-2.5">Status</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {facturen.map((f) => {
                const fouten = valideerFactuur(f);
                const ongeldig = heeftFouten(fouten);
                return (
                  <tr key={f.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50">
                    <td className="px-5 py-2.5 text-slate-800">{f.leverancier ?? "—"}</td>
                    <td className="px-5 py-2.5 text-slate-600">{f.factuurnummer ?? "—"}</td>
                    <td className="px-5 py-2.5 text-slate-600">{f.factuurdatum ?? "—"}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-slate-600">
                      {formatBedrag(f.bedrag_excl)}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-slate-800">
                      {formatBedrag(f.totaal_incl)}
                    </td>
                    <td className="px-5 py-2.5 text-slate-600">{f.valuta ?? "—"}</td>
                    <td className="px-5 py-2.5">
                      {ongeldig ? (
                        <span
                          title={Object.values(fouten).join(" ")}
                          className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"
                        >
                          Controleren
                        </span>
                      ) : (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                          OK
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => onBewerken(f.id)}
                          className="rounded p-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                        >
                          Bewerken
                        </button>
                        <button
                          type="button"
                          onClick={() => onVerwijderen(f.id)}
                          className="rounded p-1.5 text-xs font-medium text-slate-500 hover:bg-red-50 hover:text-red-600"
                        >
                          Verwijderen
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
