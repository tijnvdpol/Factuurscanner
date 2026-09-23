import { useState } from "react";
import type { Signaal } from "../types";
import { ERNST_LABELS, ERNST_VOLGORDE, SIGNAAL_LABELS, type SignaalVoorstel } from "../lib/signalen";
import { ERNST_KLASSEN } from "../lib/stijl";

interface Props {
  /** Opgeslagen signalen van de factuur. */
  signalen: Signaal[];
  /** Signalen die bij opslaan (nog) zullen ontstaan, op basis van de huidige invoer. */
  voorspeld: SignaalVoorstel[];
  leverancier: string | null;
  /** Naam van een gebruiker (voor "opgelost door"); undefined = onbekend. */
  naamVan?: (userId: string) => string | undefined;
  onOplossen: (signaalId: string, toelichting: string, ibanOvernemen: boolean) => Promise<void>;
}

function datumTijd(iso: string): string {
  return new Date(iso).toLocaleString("nl-NL", { dateStyle: "medium", timeStyle: "short" });
}

function SignaalRij({
  signaal,
  leverancier,
  naamVan,
  onOplossen,
}: {
  signaal: Signaal;
  leverancier: string | null;
  naamVan?: (userId: string) => string | undefined;
  onOplossen: Props["onOplossen"];
}) {
  const [open, setOpen] = useState(false);
  const [toelichting, setToelichting] = useState("");
  const [ibanOvernemen, setIbanOvernemen] = useState(false);
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);

  const nieuwIban = typeof signaal.details.factuur_iban === "string" ? signaal.details.factuur_iban : null;

  const bevestig = async () => {
    if (!toelichting.trim()) {
      setFout("Vul een toelichting in: wat heb je gecontroleerd?");
      return;
    }
    setBezig(true);
    setFout(null);
    try {
      await onOplossen(signaal.id, toelichting.trim(), ibanOvernemen);
      setOpen(false);
    } catch (err) {
      setFout(err instanceof Error ? err.message : "Oplossen is mislukt.");
    } finally {
      setBezig(false);
    }
  };

  return (
    <li className={`rounded-md border px-3 py-2 ${signaal.opgelost ? "border-slate-100 bg-slate-50" : "border-slate-200 bg-white"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${signaal.opgelost ? "bg-slate-200 text-slate-500" : ERNST_KLASSEN[signaal.ernst]}`}>
              {signaal.opgelost ? "Opgelost" : ERNST_LABELS[signaal.ernst]}
            </span>
            <span className={`text-xs font-semibold ${signaal.opgelost ? "text-slate-500" : "text-slate-800"}`}>
              {SIGNAAL_LABELS[signaal.type]}
            </span>
          </div>
          <p className={`mt-1 text-xs ${signaal.opgelost ? "text-slate-400" : "text-slate-600"}`}>{signaal.bericht}</p>
          {signaal.opgelost && signaal.opgelost_op && (
            <p className="mt-1 text-xs text-slate-500">
              {datumTijd(signaal.opgelost_op)}
              {signaal.opgelost_door && naamVan?.(signaal.opgelost_door) && ` door ${naamVan(signaal.opgelost_door)}`}:{" "}
              <span className="italic">“{signaal.toelichting}”</span>
            </p>
          )}
        </div>
        {!signaal.opgelost && !open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Oplossen
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-2 border-t border-slate-100 pt-2">
          <label className="block text-xs font-medium text-slate-600">
            Toelichting (verplicht)
            <textarea
              value={toelichting}
              onChange={(e) => setToelichting(e.target.value)}
              rows={2}
              placeholder="Bijv. nagebeld met de leverancier via het bekende telefoonnummer"
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20"
            />
          </label>
          {signaal.type === "iban_afwijkend" && nieuwIban && (
            <label className="flex items-start gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={ibanOvernemen}
                onChange={(e) => setIbanOvernemen(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Nieuw IBAN <span className="font-mono">{nieuwIban}</span> opslaan als bekend IBAN van{" "}
                {leverancier ?? "de leverancier"}
              </span>
            </label>
          )}
          {fout && <p className="text-xs text-red-600">{fout}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setFout(null);
              }}
              disabled={bezig}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              Annuleren
            </button>
            <button
              type="button"
              onClick={bevestig}
              disabled={bezig}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:bg-slate-300"
            >
              {bezig ? "Bezig…" : "Signaal oplossen"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Signalen van een factuur, met "Oplossen" (toelichting verplicht). */
export default function SignalenBlok({ signalen, voorspeld, leverancier, naamVan, onOplossen }: Props) {
  const gesorteerd = [...signalen].sort(
    (a, b) => Number(a.opgelost) - Number(b.opgelost) || ERNST_VOLGORDE[a.ernst] - ERNST_VOLGORDE[b.ernst],
  );
  // Alleen voorspellingen tonen van typen die nog niet als signaal bestaan.
  const bekendeTypes = new Set(signalen.map((s) => s.type));
  const nieuw = voorspeld.filter((v) => !bekendeTypes.has(v.type));

  if (gesorteerd.length === 0 && nieuw.length === 0) return null;

  return (
    <div className="mt-5">
      <h3 className="mb-2 text-xs font-semibold text-slate-600">Signalen</h3>
      {gesorteerd.length > 0 && (
        <ul className="space-y-2">
          {gesorteerd.map((s) => (
            <SignaalRij key={s.id} signaal={s} leverancier={leverancier} naamVan={naamVan} onOplossen={onOplossen} />
          ))}
        </ul>
      )}
      {nieuw.length > 0 && (
        <div className="mt-2 rounded-md border border-dashed border-slate-300 px-3 py-2">
          <p className="text-xs font-medium text-slate-500">Bij opslaan verwacht:</p>
          <ul className="mt-1 space-y-1">
            {nieuw.map((v, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-slate-600">
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${ERNST_KLASSEN[v.ernst]}`}>
                  {ERNST_LABELS[v.ernst]}
                </span>
                <span>
                  <span className="font-medium">{SIGNAAL_LABELS[v.type]}:</span> {v.bericht}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
