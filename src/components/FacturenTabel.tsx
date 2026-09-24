import { useState } from "react";
import { STATUS_LABELS, type Factuur, type FactuurStatus } from "../types";
import { formatBedrag } from "../lib/getallen";
import { heeftFouten, valideerFactuur } from "../lib/validatie";
import {
  FILTERS,
  filterFacturen,
  magVerwijderen,
  vergrendeling,
  mogelijkeActies,
  type Filter,
  type MogelijkeActie,
  type WorkflowContext,
} from "../lib/workflow";
import SignaalBadges from "./SignaalBadges";
import KoppelingBadges from "./KoppelingBadges";

const STATUS_KLASSEN: Record<FactuurStatus, string> = {
  gescand: "bg-slate-100 text-slate-600",
  gecontroleerd: "bg-sky-100 text-sky-700",
  goedgekeurd: "bg-indigo-100 text-indigo-700",
  betaald: "bg-emerald-100 text-emerald-700",
  afgekeurd: "bg-red-100 text-red-700",
};

interface Props {
  facturen: Factuur[];
  context: WorkflowContext;
  onBewerken: (id: string) => void;
  onVerwijderen: (id: string) => void;
  onBekijken: (bestandPad: string) => void;
  onExporteren: () => void;
  onActie: (factuur: Factuur, actie: MogelijkeActie) => void;
  /** Een mislukte koppeling (bijv. export) opnieuw proberen. */
  onKoppelingOpnieuw: (taakId: string) => void;
  /** Id van de factuur waarvoor een statuswijziging loopt. */
  bezigId: string | null;
  laden: boolean;
  exporteren: boolean;
}

export default function FacturenTabel({
  facturen,
  context,
  onBewerken,
  onVerwijderen,
  onBekijken,
  onExporteren,
  onActie,
  onKoppelingOpnieuw,
  bezigId,
  laden,
  exporteren,
}: Props) {
  const [filter, setFilter] = useState<Filter>("alles");
  const zichtbaar = filterFacturen(facturen, filter);

  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Verzamelde facturen</h2>
          <p className="text-xs text-slate-400">
            {laden ? "Laden…" : `${facturen.length} factu${facturen.length === 1 ? "ur" : "ren"}`}
          </p>
        </div>
        <button
          type="button"
          disabled={laden || exporteren || facturen.length === 0}
          onClick={onExporteren}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {exporteren ? "Exporteren…" : "Exporteren als CSV"}
        </button>
      </div>

      <div role="tablist" className="flex flex-wrap gap-1 border-b border-slate-100 px-5 py-2">
        {FILTERS.map((f) => {
          const aantal = filterFacturen(facturen, f.sleutel).length;
          return (
            <button
              key={f.sleutel}
              type="button"
              role="tab"
              aria-selected={filter === f.sleutel}
              onClick={() => setFilter(f.sleutel)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                filter === f.sleutel ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {f.label}
              <span className={`ml-1.5 tabular-nums ${filter === f.sleutel ? "text-slate-300" : "text-slate-400"}`}>{aantal}</span>
            </button>
          );
        })}
      </div>

      {laden ? (
        <div className="flex items-center justify-center gap-3 px-5 py-8 text-sm text-slate-400">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-800" />
          Facturen laden…
        </div>
      ) : zichtbaar.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-400">
          {facturen.length === 0 ? "Nog geen facturen toegevoegd. Scan een factuur om te beginnen." : "Geen facturen in deze lijst."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5">Leverancier</th>
                <th className="px-4 py-2.5">Factuurnr.</th>
                <th className="px-4 py-2.5">Datum</th>
                <th className="px-4 py-2.5 text-right">Totaal</th>
                <th className="px-4 py-2.5">Controle</th>
                <th className="px-4 py-2.5">Signalen</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Acties</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {zichtbaar.map((f) => {
                const fouten = valideerFactuur(f);
                const ongeldig = heeftFouten(fouten);
                const acties = mogelijkeActies(f, context);
                const bezig = bezigId === f.id;
                return (
                  <tr key={f.id} className="border-b border-slate-50 align-top last:border-0 hover:bg-slate-50">
                    <td className="px-4 py-2.5 text-slate-800">
                      {f.leverancier ?? "—"}
                      {f.herkomst === "mailbox" && (
                        <span title="Binnengekomen via de mailbox" className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                          mail
                        </span>
                      )}
                      {f.geexporteerd_op && (
                        <span title="Geëxporteerd naar het boekhoudpakket" className="ml-1.5 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                          geboekt
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{f.factuurnummer ?? "—"}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">{f.factuurdatum ?? "—"}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-slate-800">
                      {f.totaal_incl !== null && f.valuta && f.valuta !== "EUR" ? `${f.valuta} ` : ""}
                      {formatBedrag(f.totaal_incl)}
                      {f.totaal_incl !== null && f.valuta && f.valuta !== "EUR" && (
                        <span
                          className="block text-xs text-slate-400"
                          title={
                            f.euro.koers !== null
                              ? `Koers ${f.euro.koers.toLocaleString("nl-NL")} per euro, ${f.euro.koers_datum} (${f.euro.bron === "ecb" ? "ECB" : "mock"})`
                              : "De wisselkoers wordt opgehaald"
                          }
                        >
                          {f.euro.bedrag !== null ? `≈ € ${formatBedrag(f.euro.bedrag)}` : "koers volgt"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {ongeldig ? (
                        <span
                          title={Object.values(fouten).join(" ")}
                          className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"
                        >
                          Controleren
                        </span>
                      ) : (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">OK</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <SignaalBadges signalen={f.signalen} />
                      <KoppelingBadges statussen={f.koppelingen} onOpnieuw={onKoppelingOpnieuw} />
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        title={f.status === "afgekeurd" ? `Reden: ${f.workflow.afkeur_reden ?? ""}` : undefined}
                        className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_KLASSEN[f.status]}`}
                      >
                        {STATUS_LABELS[f.status]}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-1">
                        {acties.map((a) => (
                          <button
                            key={a.actie}
                            type="button"
                            disabled={bezig || a.geblokkeerd !== null}
                            title={a.geblokkeerd ?? undefined}
                            onClick={() => onActie(f, a)}
                            className={`whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium disabled:cursor-not-allowed ${
                              a.actie === "afkeuren"
                                ? "border border-red-200 bg-white text-red-700 hover:bg-red-50 disabled:text-red-300"
                                : "bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-200 disabled:text-slate-400"
                            }`}
                          >
                            {a.label}
                          </button>
                        ))}
                      </div>
                      {acties
                        .filter((a) => a.geblokkeerd)
                        .map((a) => (
                          <p key={a.actie} className="mt-1 max-w-[16rem] text-[11px] leading-tight text-amber-700">
                            {a.label}: {a.geblokkeerd}
                          </p>
                        ))}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        {f.bestand_pad && (
                          <button
                            type="button"
                            onClick={() => onBekijken(f.bestand_pad!)}
                            className="rounded p-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                          >
                            Origineel
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onBewerken(f.id)}
                          className="rounded p-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                        >
                          {vergrendeling(f) ? "Bekijken" : "Bewerken"}
                        </button>
                        {magVerwijderen(f, context) && (
                          <button
                            type="button"
                            onClick={() => onVerwijderen(f.id)}
                            className="rounded p-1.5 text-xs font-medium text-slate-500 hover:bg-red-50 hover:text-red-600"
                          >
                            Verwijderen
                          </button>
                        )}
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
