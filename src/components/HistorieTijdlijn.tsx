import { useEffect, useState } from "react";
import { BRON_LABELS, datumTijd, omschrijving, wijzigingen, type AuditRegel, type WeergaveContext } from "../lib/audit";
import { haalFactuurHistorieOp } from "../lib/auditApi";

interface Props {
  factuurId: string;
  weergave: WeergaveContext;
  /** Verandert na elke wijziging aan de factuur, zodat de tijdlijn opnieuw laadt. */
  versie: string;
}

const PUNT_KLASSEN: Record<AuditRegel["actie"], string> = {
  insert: "bg-emerald-500",
  update: "bg-slate-400",
  delete: "bg-red-500",
  statuswijziging: "bg-indigo-500",
  import: "bg-teal-500",
  verrijking: "bg-teal-500",
  export: "bg-teal-500",
  betaling: "bg-teal-500",
  notificatie: "bg-teal-500",
};

/** Tijdlijn van een factuur: wie, wat, wanneer, van → naar. */
export default function HistorieTijdlijn({ factuurId, weergave, versie }: Props) {
  const [regels, setRegels] = useState<AuditRegel[] | null>(null);
  const [fout, setFout] = useState<string | null>(null);

  useEffect(() => {
    let actief = true;
    haalFactuurHistorieOp(factuurId)
      .then((lijst) => actief && setRegels(lijst))
      .catch((err) => actief && setFout(err instanceof Error ? err.message : "De historie kon niet worden geladen."));
    return () => {
      actief = false;
    };
  }, [factuurId, versie]);

  if (fout) return <p className="text-sm text-red-600">{fout}</p>;
  if (!regels) return <p className="text-sm text-slate-400">Historie laden…</p>;
  if (regels.length === 0) {
    return (
      <p className="text-sm text-slate-400">
        Nog geen historie. Wijzigingen worden vastgelegd vanaf de invoering van de audit trail.
      </p>
    );
  }

  return (
    <ol className="relative space-y-4 border-l border-slate-200 pl-5">
      {[...regels].reverse().map((r) => {
        const details = wijzigingen(r, weergave);
        const wie = r.user_id ? (weergave.naamVan(r.user_id) ?? "onbekende gebruiker") : "systeem";
        return (
          <li key={r.id} className="relative">
            <span className={`absolute -left-[1.6rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white ${PUNT_KLASSEN[r.actie]}`} />
            <p className="text-xs text-slate-400">
              {datumTijd(r.created_at)} · {wie}
              {r.bron !== "app" && r.bron !== "systeem" && ` · via ${BRON_LABELS[r.bron] ?? r.bron}`}
            </p>
            <p className="text-sm font-medium text-slate-800">{omschrijving(r, weergave)}</p>
            {r.toelichting && <p className="text-xs italic text-slate-600">“{r.toelichting}”</p>}
            {details.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                {details.map((w) => (
                  <li key={w.veld}>
                    <span className="text-slate-500">{w.label}:</span>{" "}
                    {r.actie === "insert" ? (
                      w.naar
                    ) : r.actie === "delete" ? (
                      <span className="line-through">{w.van}</span>
                    ) : (
                      <>
                        <span className="text-slate-400 line-through">{w.van}</span> → {w.naar}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
