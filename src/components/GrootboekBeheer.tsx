import { useState } from "react";
import type { Grootboekrekening } from "../types";
import { voegRekeningToe, wijzigRekening, type RekeningInvoer } from "../lib/grootboekApi";

interface Props {
  organisatieId: string;
  rekeningen: Grootboekrekening[];
  /** false = alleen bekijken (rol zonder beheerrechten). */
  magBeheren: boolean;
  onGewijzigd: () => Promise<void>;
}

const invoerKlasse =
  "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20";

function foutTekst(err: unknown): string {
  return err instanceof Error ? err.message : "Opslaan is mislukt.";
}

function RekeningRij({
  rekening,
  magBeheren,
  onGewijzigd,
}: {
  rekening: Grootboekrekening;
  magBeheren: boolean;
  onGewijzigd: () => Promise<void>;
}) {
  const [bewerken, setBewerken] = useState(false);
  const [invoer, setInvoer] = useState<RekeningInvoer>(rekening);
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);

  const opslaan = async (wijziging: RekeningInvoer) => {
    setBezig(true);
    setFout(null);
    try {
      await wijzigRekening(rekening.id, wijziging);
      await onGewijzigd();
      setBewerken(false);
    } catch (err) {
      setFout(foutTekst(err));
    } finally {
      setBezig(false);
    }
  };

  return (
    <tr className="border-b border-slate-50 align-top last:border-0">
      {bewerken ? (
        <>
          <td className="px-5 py-2">
            <input value={invoer.code} onChange={(e) => setInvoer({ ...invoer, code: e.target.value })} className={invoerKlasse} aria-label="Code" />
          </td>
          <td className="px-5 py-2">
            <input
              value={invoer.omschrijving}
              onChange={(e) => setInvoer({ ...invoer, omschrijving: e.target.value })}
              className={invoerKlasse}
              aria-label="Omschrijving"
            />
            {fout && <p className="mt-1 text-xs text-red-600">{fout}</p>}
          </td>
        </>
      ) : (
        <>
          <td className={`px-5 py-2.5 font-mono ${rekening.actief ? "text-slate-800" : "text-slate-400"}`}>{rekening.code}</td>
          <td className={`px-5 py-2.5 ${rekening.actief ? "text-slate-700" : "text-slate-400"}`}>
            {rekening.omschrijving}
            {fout && <p className="mt-1 text-xs text-red-600">{fout}</p>}
          </td>
        </>
      )}
      <td className="px-5 py-2.5">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            rekening.actief ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
          }`}
        >
          {rekening.actief ? "Actief" : "Inactief"}
        </span>
      </td>
      <td className="px-5 py-2 text-right">
        {magBeheren && (
          <div className="flex justify-end gap-1">
            {bewerken ? (
              <>
                <button
                  type="button"
                  disabled={bezig}
                  onClick={() => {
                    setBewerken(false);
                    setInvoer(rekening);
                    setFout(null);
                  }}
                  className="rounded p-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100"
                >
                  Annuleren
                </button>
                <button
                  type="button"
                  disabled={bezig}
                  onClick={() => opslaan(invoer)}
                  className="rounded bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:bg-slate-300"
                >
                  Opslaan
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setBewerken(true)}
                  className="rounded p-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                >
                  Wijzigen
                </button>
                <button
                  type="button"
                  disabled={bezig}
                  onClick={() => opslaan({ ...rekening, actief: !rekening.actief })}
                  className="rounded p-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                >
                  {rekening.actief ? "Deactiveren" : "Activeren"}
                </button>
              </>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/** Beheer van grootboekrekeningen: toevoegen, wijzigen en (de)activeren. */
export default function GrootboekBeheer({ organisatieId, rekeningen, magBeheren, onGewijzigd }: Props) {
  const [nieuw, setNieuw] = useState<RekeningInvoer>({ code: "", omschrijving: "", actief: true });
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);

  const toevoegen = async (e: React.FormEvent) => {
    e.preventDefault();
    setBezig(true);
    setFout(null);
    try {
      await voegRekeningToe(organisatieId, nieuw);
      await onGewijzigd();
      setNieuw({ code: "", omschrijving: "", actief: true });
    } catch (err) {
      setFout(foutTekst(err));
    } finally {
      setBezig(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-slate-800">Grootboekrekeningen</h2>
        <p className="text-xs text-slate-400">
          Kostenrekeningen waaruit de codering van facturen wordt gekozen. Een rekening die niet meer gebruikt wordt,
          deactiveer je; verwijderen kan niet, zodat oude facturen hun codering houden.
          {!magBeheren && " Alleen een controller of beheerder kan rekeningen wijzigen."}
        </p>
      </div>

      {magBeheren && (
        <form onSubmit={toevoegen} className="flex flex-wrap items-start gap-2 border-b border-slate-100 px-5 py-3">
          <input
            value={nieuw.code}
            onChange={(e) => setNieuw({ ...nieuw, code: e.target.value })}
            placeholder="Code, bijv. 4410"
            aria-label="Code"
            className={`${invoerKlasse} w-36`}
          />
          <input
            value={nieuw.omschrijving}
            onChange={(e) => setNieuw({ ...nieuw, omschrijving: e.target.value })}
            placeholder="Omschrijving"
            aria-label="Omschrijving"
            className={`${invoerKlasse} min-w-0 flex-1`}
          />
          <button
            type="submit"
            disabled={bezig || !nieuw.code.trim() || !nieuw.omschrijving.trim()}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Toevoegen
          </button>
          {fout && <p className="w-full text-xs text-red-600">{fout}</p>}
        </form>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
              <th className="w-32 px-5 py-2.5">Code</th>
              <th className="px-5 py-2.5">Omschrijving</th>
              <th className="px-5 py-2.5">Status</th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rekeningen.map((r) => (
              // key met actief/omschrijving: na opslaan start de rij met de nieuwe waarden
              <RekeningRij key={`${r.id}-${r.code}-${r.omschrijving}-${r.actief}`} rekening={r} magBeheren={magBeheren} onGewijzigd={onGewijzigd} />
            ))}
          </tbody>
        </table>
        {rekeningen.length === 0 && <p className="px-5 py-6 text-center text-sm text-slate-400">Nog geen rekeningen.</p>}
      </div>
    </div>
  );
}
