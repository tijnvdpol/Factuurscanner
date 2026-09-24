import { useCallback, useEffect, useRef, useState } from "react";
import {
  KOPPELING_INFO,
  KOPPELINGEN,
  SOORT_LABELS,
  TAAK_STATUS_LABELS,
  effectieveModus,
  type Koppeling,
  type KoppelingStatus,
  type KoppelingTaak,
  type Modus,
  type TaakStatus,
} from "../lib/koppelingen";
import {
  haalKoppelingInstellingenOp,
  haalKoppelingOverzichtOp,
  haalRecenteTakenOp,
  probeerTaakOpnieuw,
  stelKoppelingIn,
  testWachtrij,
} from "../lib/koppelingenApi";
import { datumTijd } from "../lib/audit";
import BoekhoudingInstellingen from "./BoekhoudingInstellingen";
import EmailInstellingen from "./EmailInstellingen";

interface Props {
  organisatieId: string;
  magBeheren: boolean;
}

const STATUS_KLASSEN: Record<TaakStatus, string> = {
  wachtrij: "bg-slate-100 text-slate-600",
  bezig: "bg-sky-100 text-sky-700",
  gelukt: "bg-emerald-100 text-emerald-700",
  opgegeven: "bg-red-100 text-red-700",
};

function foutTekst(err: unknown, standaard: string): string {
  return err instanceof Error && err.message ? err.message : standaard;
}

interface Overzicht {
  koppelingen: KoppelingStatus[];
  /** true = de server (Edge Function) was niet bereikbaar; alleen de instellingen uit de database. */
  alleenDatabase: boolean;
}

async function laadOverzicht(organisatieId: string): Promise<Overzicht> {
  try {
    return { koppelingen: await haalKoppelingOverzichtOp(organisatieId), alleenDatabase: false };
  } catch (err) {
    console.warn(err);
    const instellingen = await haalKoppelingInstellingenOp(organisatieId).catch(() => []);
    return {
      koppelingen: KOPPELINGEN.map((koppeling) => ({
        koppeling,
        ...effectieveModus(null, instellingen.find((i) => i.koppeling === koppeling)?.modus),
        ontbrekend: [],
        klaar: true,
        config: {},
      })),
      alleenDatabase: true,
    };
  }
}

/** Overzicht en instellingen van de koppelingen, plus de takenwachtrij. */
export default function KoppelingenPagina({ organisatieId, magBeheren }: Props) {
  const [overzicht, setOverzicht] = useState<Overzicht | null>(null);
  const [taken, setTaken] = useState<KoppelingTaak[] | null>(null);
  const [fout, setFout] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);
  const [bezig, setBezig] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);
  const koppelingen = overzicht?.koppelingen ?? null;
  const alleenDatabase = overzicht?.alleenDatabase ?? false;

  const laadKoppelingen = useCallback(async () => {
    setOverzicht(await laadOverzicht(organisatieId));
  }, [organisatieId]);

  const laadTaken = useCallback(async () => {
    try {
      setTaken(await haalRecenteTakenOp(organisatieId));
    } catch (err) {
      setFout(foutTekst(err, "De wachtrij kon niet worden geladen."));
    }
  }, [organisatieId]);

  useEffect(() => {
    let actief = true;
    laadOverzicht(organisatieId).then((o) => actief && setOverzicht(o));
    haalRecenteTakenOp(organisatieId)
      .then((lijst) => actief && setTaken(lijst))
      .catch((err) => actief && setFout(foutTekst(err, "De wachtrij kon niet worden geladen.")));
    return () => {
      actief = false;
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, [organisatieId]);

  const wijzigModus = async (koppeling: Koppeling, modus: Modus) => {
    setFout(null);
    setMelding(null);
    setBezig(koppeling);
    try {
      await stelKoppelingIn(organisatieId, koppeling, modus);
      setMelding(`${KOPPELING_INFO[koppeling].naam} staat nu op ${modus}.`);
      await laadKoppelingen();
    } catch (err) {
      setFout(foutTekst(err, "De modus kon niet worden gewijzigd."));
    } finally {
      setBezig(null);
    }
  };

  const test = async () => {
    setFout(null);
    setMelding(null);
    setBezig("test");
    try {
      const taakId = await testWachtrij(organisatieId);
      setMelding("Testtaak in de wachtrij gezet. Binnen een minuut hoort de status 'Gelukt' te zijn.");
      await laadTaken();
      // Een halve minuut elke 3 seconden verversen, of tot de testtaak klaar is.
      let rondes = 0;
      if (pollTimer.current) window.clearInterval(pollTimer.current);
      pollTimer.current = window.setInterval(async () => {
        rondes++;
        const lijst = await haalRecenteTakenOp(organisatieId).catch(() => null);
        if (lijst) setTaken(lijst);
        const klaar = lijst?.find((t) => t.id === taakId && (t.status === "gelukt" || t.status === "opgegeven"));
        if ((klaar || rondes >= 10) && pollTimer.current) {
          window.clearInterval(pollTimer.current);
          pollTimer.current = null;
        }
      }, 3000);
    } catch (err) {
      setFout(foutTekst(err, "De testtaak kon niet worden aangemaakt."));
    } finally {
      setBezig(null);
    }
  };

  const opnieuw = async (taakId: string) => {
    setFout(null);
    setMelding(null);
    try {
      await probeerTaakOpnieuw(taakId);
      setMelding("De taak wordt opnieuw geprobeerd.");
      await laadTaken();
    } catch (err) {
      setFout(foutTekst(err, "Opnieuw proberen is mislukt."));
    }
  };

  return (
    <div className="space-y-6">
      {fout && <p className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">{fout}</p>}
      {melding && <p className="rounded-md bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{melding}</p>}

      <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-800">Koppelingen</h2>
          <p className="text-xs text-slate-400">
            Elke koppeling werkt in <strong>mock</strong> (testdata, geen externe accounts nodig) of <strong>live</strong>.
            {magBeheren ? " Een modus die via de server is vastgezet, kun je hier niet wijzigen." : " Alleen een beheerder kan de modus wijzigen."}
          </p>
        </div>
        {alleenDatabase && (
          <p className="border-b border-slate-100 bg-amber-50 px-5 py-2 text-xs text-amber-800">
            De koppelingsservice is niet bereikbaar (is de Edge Function 'koppeling-actie' gedeployed?). Hieronder staan
            alleen de instellingen uit de database; of de server de modus vastzet en of de secrets compleet zijn, is onbekend.
          </p>
        )}
        {!koppelingen && <p className="px-5 py-6 text-center text-sm text-slate-400">Laden…</p>}
        {koppelingen && (
          <ul className="divide-y divide-slate-100">
            {koppelingen.map((k) => {
              const info = KOPPELING_INFO[k.koppeling];
              return (
                <li key={k.koppeling} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800">{info.naam}</p>
                    <p className="text-xs text-slate-500">{info.omschrijving}</p>
                    {info.live && <p className="text-xs text-slate-400">Live: {info.live}</p>}
                    {k.modus === "live" && k.ontbrekend.length > 0 && (
                      <p className="mt-1 text-xs text-red-700">
                        Niet klaar voor live: stel in de Supabase secrets in: {k.ontbrekend.join(", ")}.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {k.vastgezet ? (
                      <span
                        title="Ingesteld via een env-variabele in de Supabase secrets"
                        className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
                      >
                        {k.modus === "live" ? "Live" : "Mock"} · vastgezet door server
                      </span>
                    ) : magBeheren ? (
                      <select
                        value={k.modus}
                        disabled={bezig === k.koppeling}
                        onChange={(e) => wijzigModus(k.koppeling, e.target.value as Modus)}
                        aria-label={`Modus van ${info.naam}`}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20"
                      >
                        <option value="mock">Mock</option>
                        <option value="live">Live</option>
                      </select>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                        {k.modus === "live" ? "Live" : "Mock"}
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        k.klaar ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                      }`}
                    >
                      {k.klaar ? "Klaar" : "Niet klaar"}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {koppelingen && !alleenDatabase && (
        <BoekhoudingInstellingen
          key={JSON.stringify(koppelingen.find((k) => k.koppeling === "boekhouding")?.config ?? {})}
          organisatieId={organisatieId}
          magBeheren={magBeheren}
          status={koppelingen.find((k) => k.koppeling === "boekhouding")!}
          onOpgeslagen={laadKoppelingen}
        />
      )}

      {koppelingen && !alleenDatabase && (
        <EmailInstellingen
          key={JSON.stringify(koppelingen.find((k) => k.koppeling === "email")?.config ?? {})}
          organisatieId={organisatieId}
          magBeheren={magBeheren}
          status={koppelingen.find((k) => k.koppeling === "email")!}
          onOpgeslagen={laadKoppelingen}
        />
      )}

      <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Wachtrij</h2>
            <p className="text-xs text-slate-400">
              De laatste taken van de koppelingen. Mislukte taken worden automatisch opnieuw geprobeerd (na 1 min, 5 min,
              30 min, 2 uur en 12 uur).
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={laadTaken}
              className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Vernieuwen
            </button>
            <button
              type="button"
              onClick={test}
              disabled={bezig === "test"}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Test de wachtrij
            </button>
          </div>
        </div>
        {!taken && <p className="px-5 py-6 text-center text-sm text-slate-400">Laden…</p>}
        {taken && taken.length === 0 && <p className="px-5 py-6 text-center text-sm text-slate-400">Nog geen taken.</p>}
        {taken && taken.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                  <th className="px-5 py-2.5">Aangemaakt</th>
                  <th className="px-5 py-2.5">Soort</th>
                  <th className="px-5 py-2.5">Status</th>
                  <th className="px-5 py-2.5">Pogingen</th>
                  <th className="px-5 py-2.5">Toelichting</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {taken.map((t) => (
                  <tr key={t.id} className="border-b border-slate-50 align-top last:border-0">
                    <td className="whitespace-nowrap px-5 py-2.5 text-xs text-slate-500">{datumTijd(t.created_at)}</td>
                    <td className="px-5 py-2.5 text-slate-700">{SOORT_LABELS[t.soort] ?? t.soort}</td>
                    <td className="px-5 py-2.5">
                      <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_KLASSEN[t.status]}`}>
                        {TAAK_STATUS_LABELS[t.status]}
                      </span>
                    </td>
                    <td className="px-5 py-2.5 text-xs tabular-nums text-slate-500">
                      {t.pogingen}/{t.max_pogingen}
                    </td>
                    <td className="px-5 py-2.5 text-xs text-slate-600">
                      {t.status === "wachtrij" && t.pogingen > 0 && `Nieuwe poging ${datumTijd(t.volgende_poging_op)}. `}
                      {t.laatste_fout ??
                        (typeof t.resultaat?.bericht === "string" ? t.resultaat.bericht : null) ??
                        (typeof t.resultaat?.omschrijving === "string" ? t.resultaat.omschrijving : "")}
                    </td>
                    <td className="px-5 py-2 text-right">
                      {t.status === "opgegeven" && (
                        <button
                          type="button"
                          onClick={() => opnieuw(t.id)}
                          className="rounded-md px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                        >
                          Opnieuw proberen
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
