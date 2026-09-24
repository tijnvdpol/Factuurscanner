import { useCallback, useEffect, useMemo, useState } from "react";
import type { Factuur, Rol } from "../types";
import { datumTijd } from "../lib/audit";
import { formatBedrag } from "../lib/getallen";
import {
  BATCH_STATUS_LABELS,
  POST_STATUS_LABELS,
  betaalBlokkade,
  controleerBetaalRekening,
  sepaBestand,
  volgendeWerkdag,
  type BatchStatus,
  type Betaalbatch,
  type BetaalRekening,
  type PostStatus,
} from "../lib/betalingen";
import {
  annuleerBatch,
  bevestigBatch,
  haalBatchesOp,
  haalBetaalRekeningOp,
  logDownload,
  maakBetaalbatch,
  markeerIngediend,
  slaBetaalRekeningOp,
} from "../lib/betalingenApi";
import { haalFacturenOp } from "../lib/facturenApi";
import { haalKoppelingOverzichtOp } from "../lib/koppelingenApi";
import type { Modus } from "../lib/koppelingen";

interface Props {
  organisatieId: string;
  rol: Rol;
  naamVan: (userId: string) => string | undefined;
}

const BATCH_KLASSEN: Record<BatchStatus, string> = {
  aangemaakt: "bg-amber-100 text-amber-800",
  ingediend: "bg-sky-100 text-sky-700",
  verwerkt: "bg-emerald-100 text-emerald-700",
  geannuleerd: "bg-slate-100 text-slate-500",
};

const POST_KLASSEN: Record<PostStatus, string> = {
  open: "text-slate-500",
  betaald: "text-emerald-700",
  geweigerd: "text-red-700",
  geannuleerd: "text-slate-400",
};

const invoerKlasse =
  "rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20 disabled:bg-slate-50";
const knopKlasse = "rounded-md px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300";

function foutTekst(err: unknown, standaard: string): string {
  return err instanceof Error && err.message ? err.message : standaard;
}

function euro(bedrag: number | null): string {
  return bedrag === null ? "—" : `€ ${formatBedrag(bedrag)}`;
}

function datum(iso: string | null): string {
  return iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("nl-NL") : "—";
}

function download(naam: string, inhoud: string) {
  const url = URL.createObjectURL(new Blob([inhoud], { type: "application/xml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = naam;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Betaalopdrachten: de betalende rekening, goedgekeurde facturen selecteren voor een SEPA-batch, en de batches
 * (bestand downloaden, bij de bank aangeboden, uitgevoerd, annuleren). Controller en beheerder.
 */
export default function BetalingenPagina({ organisatieId, rol, naamVan }: Props) {
  const magRekening = rol === "beheerder";
  const [rekening, setRekening] = useState<BetaalRekening>({ naam: "", iban: "", bic: "" });
  const [rekeningOpgeslagen, setRekeningOpgeslagen] = useState<BetaalRekening | null>(null);
  const [facturen, setFacturen] = useState<Factuur[] | null>(null);
  const [batches, setBatches] = useState<Betaalbatch[] | null>(null);
  const [modus, setModus] = useState<Modus | null>(null);
  const [gekozen, setGekozen] = useState<Set<string>>(new Set());
  const [uitvoerdatum, setUitvoerdatum] = useState(() => volgendeWerkdag(new Date()));
  const [open, setOpen] = useState<string | null>(null);
  const [bezig, setBezig] = useState<string | null>(null);
  const [melding, setMelding] = useState<{ ok: boolean; tekst: string } | null>(null);

  const laad = useCallback(async () => {
    const [f, b] = await Promise.all([haalFacturenOp(organisatieId), haalBatchesOp(organisatieId)]);
    setFacturen(f);
    setBatches(b);
  }, [organisatieId]);

  useEffect(() => {
    let actief = true;
    Promise.all([haalFacturenOp(organisatieId), haalBatchesOp(organisatieId), haalBetaalRekeningOp(organisatieId)])
      .then(([f, b, r]) => {
        if (!actief) return;
        setFacturen(f);
        setBatches(b);
        setRekening(r);
        setRekeningOpgeslagen(r);
      })
      .catch((err) => actief && setMelding({ ok: false, tekst: foutTekst(err, "De betalingen konden niet worden geladen.") }));
    haalKoppelingOverzichtOp(organisatieId)
      .then((o) => actief && setModus(o.find((k) => k.koppeling === "betaling")?.modus ?? null))
      .catch(() => undefined);
    return () => {
      actief = false;
    };
  }, [organisatieId]);

  // Mock: de gesimuleerde bank verwerkt een batch binnen een paar minuten; zolang er een loopt, elke 15 s verversen.
  const loopt = batches?.some((b) => (b.status === "aangemaakt" || b.status === "ingediend") && b.modus !== "live") ?? false;
  useEffect(() => {
    if (!loopt || modus !== "mock") return;
    const timer = window.setInterval(() => laad().catch(() => undefined), 15_000);
    return () => window.clearInterval(timer);
  }, [loopt, modus, laad]);

  const teBetalen = useMemo(
    () =>
      (facturen ?? [])
        .filter((f) => f.status === "goedgekeurd")
        .sort((a, b) => (a.vervaldatum ?? "9999").localeCompare(b.vervaldatum ?? "9999")),
    [facturen],
  );
  const betaalbaar = teBetalen.filter((f) => !betaalBlokkade(f));
  const selectie = betaalbaar.filter((f) => gekozen.has(f.id));
  const totaal = selectie.reduce((som, f) => som + (f.totaal_incl ?? 0), 0);
  const rekeningFout = rekeningOpgeslagen ? controleerBetaalRekening(rekeningOpgeslagen) : null;

  const uitvoeren = async (sleutel: string, actie: () => Promise<string | void>) => {
    setBezig(sleutel);
    setMelding(null);
    try {
      const tekst = await actie();
      if (tekst) setMelding({ ok: true, tekst });
    } catch (err) {
      setMelding({ ok: false, tekst: foutTekst(err, "Er ging iets mis.") });
    } finally {
      setBezig(null);
    }
  };

  const slaRekeningOp = () =>
    uitvoeren("rekening", async () => {
      const fout = controleerBetaalRekening(rekening);
      if (fout) throw new Error(fout);
      await slaBetaalRekeningOp(organisatieId, rekening);
      const opnieuw = await haalBetaalRekeningOp(organisatieId);
      setRekening(opnieuw);
      setRekeningOpgeslagen(opnieuw);
      return "Betalende rekening opgeslagen.";
    });

  const maakBatch = () =>
    uitvoeren("batch", async () => {
      await maakBetaalbatch(organisatieId, selectie.map((f) => f.id), uitvoerdatum);
      setGekozen(new Set());
      await laad();
      return modus === "mock"
        ? `Betaalbatch gemaakt (${selectie.length} factu${selectie.length === 1 ? "ur" : "ren"}). Mock: de gesimuleerde bank verwerkt hem binnen een paar minuten.`
        : `Betaalbatch gemaakt (${selectie.length} factu${selectie.length === 1 ? "ur" : "ren"}). Download het SEPA-bestand en upload het bij je bank.`;
    });

  const downloadBestand = (b: Betaalbatch) =>
    uitvoeren(`download:${b.id}`, async () => {
      download(`${b.nummer}.xml`, sepaBestand(b));
      await logDownload(b.id);
    });

  const batchActie = (b: Betaalbatch, soort: "ingediend" | "bevestig" | "annuleer") =>
    uitvoeren(`${soort}:${b.id}`, async () => {
      if (soort === "ingediend") {
        await markeerIngediend(b.id);
      } else if (soort === "bevestig") {
        if (!window.confirm(`Heeft de bank batch ${b.nummer} uitgevoerd? Alle ${b.aantal} facturen worden dan als betaald gemarkeerd.`)) return;
        await bevestigBatch(b.id);
      } else {
        const reden = window.prompt(`Waarom annuleer je batch ${b.nummer}? De facturen gaan terug naar "goedgekeurd".`);
        if (reden === null) return;
        await annuleerBatch(b.id, reden);
      }
      await laad();
      return soort === "ingediend" ? `Batch ${b.nummer} staat nu bij de bank.` : soort === "bevestig" ? `Batch ${b.nummer} is verwerkt.` : `Batch ${b.nummer} is geannuleerd.`;
    });

  const wissel = (id: string) =>
    setGekozen((huidig) => {
      const nieuw = new Set(huidig);
      if (nieuw.has(id)) nieuw.delete(id);
      else nieuw.add(id);
      return nieuw;
    });

  return (
    <div className="space-y-6">
      {melding && (
        <p className={`rounded-md px-4 py-2 text-sm ${melding.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>{melding.tekst}</p>
      )}
      {modus === "mock" && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          Betaalopdrachten staan op <strong>mock</strong>: een gesimuleerde bank "betaalt" de batch en de facturen worden als
          betaald gemarkeerd, zonder dat er echt geld wordt overgemaakt. Zet de koppeling op live voor echte betalingen.
        </p>
      )}

      <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-800">Betalende rekening</h2>
          <p className="text-xs text-slate-400">De rekening waar de betalingen vanaf gaan (staat in het SEPA-bestand).{magRekening ? "" : " Alleen een beheerder kan dit wijzigen."}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3 px-5 py-4 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">Naam rekeninghouder</span>
            <input value={rekening.naam} disabled={!magRekening} onChange={(e) => setRekening({ ...rekening, naam: e.target.value })} className={`${invoerKlasse} w-56`} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">IBAN</span>
            <input value={rekening.iban} disabled={!magRekening} onChange={(e) => setRekening({ ...rekening, iban: e.target.value })} className={`${invoerKlasse} w-64 font-mono`} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">BIC (optioneel)</span>
            <input value={rekening.bic} disabled={!magRekening} onChange={(e) => setRekening({ ...rekening, bic: e.target.value })} className={`${invoerKlasse} w-32 font-mono`} />
          </label>
          {magRekening && (
            <button type="button" onClick={slaRekeningOp} disabled={bezig !== null} className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
              Opslaan
            </button>
          )}
        </div>
        {rekeningFout && <p className="border-t border-slate-100 px-5 py-2 text-xs text-red-700">Nog niet ingesteld: {rekeningFout}</p>}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Te betalen</h2>
            <p className="text-xs text-slate-400">
              Goedgekeurde facturen, op vervaldatum. Een factuur met een ongeldig of buitenlands (niet-SEPA) IBAN, in vreemde
              valuta of met een open kritiek signaal kan niet in een batch.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-slate-500">Uitvoerdatum</span>
              <input type="date" value={uitvoerdatum} onChange={(e) => setUitvoerdatum(e.target.value)} className={invoerKlasse} />
            </label>
            <button
              type="button"
              onClick={maakBatch}
              disabled={bezig !== null || selectie.length === 0 || !!rekeningFout}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Maak betaalbatch{selectie.length > 0 ? ` (${selectie.length} · ${euro(totaal)})` : ""}
            </button>
          </div>
        </div>
        {!facturen && <p className="px-5 py-6 text-center text-sm text-slate-400">Laden…</p>}
        {facturen && teBetalen.length === 0 && <p className="px-5 py-6 text-center text-sm text-slate-400">Geen goedgekeurde facturen.</p>}
        {teBetalen.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                  <th className="px-5 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Alles selecteren"
                      checked={betaalbaar.length > 0 && selectie.length === betaalbaar.length}
                      onChange={(e) => setGekozen(new Set(e.target.checked ? betaalbaar.map((f) => f.id) : []))}
                    />
                  </th>
                  <th className="px-3 py-2.5">Leverancier</th>
                  <th className="px-3 py-2.5">Factuur</th>
                  <th className="px-3 py-2.5">Vervalt</th>
                  <th className="px-3 py-2.5 text-right">Bedrag</th>
                  <th className="px-3 py-2.5">IBAN</th>
                </tr>
              </thead>
              <tbody>
                {teBetalen.map((f) => {
                  const blokkade = betaalBlokkade(f);
                  return (
                    <tr key={f.id} className="border-b border-slate-50 align-top last:border-0">
                      <td className="px-5 py-2">
                        <input type="checkbox" aria-label={`Selecteer ${f.leverancier ?? "factuur"}`} disabled={!!blokkade} checked={gekozen.has(f.id) && !blokkade} onChange={() => wissel(f.id)} />
                      </td>
                      <td className="px-3 py-2 text-slate-800">
                        {f.leverancier ?? "—"}
                        {blokkade && <div className="text-xs text-amber-700">{blokkade}</div>}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{f.factuurnummer ?? "—"}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-slate-600">{datum(f.vervaldatum)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-slate-800">
                        {(f.valuta ?? "EUR") === "EUR" ? euro(f.totaal_incl) : `${f.valuta} ${formatBedrag(f.totaal_incl ?? 0)}`}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-600">{f.iban ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Betaalbatches</h2>
            <p className="text-xs text-slate-400">
              Live: download het SEPA-bestand (pain.001.001.03), upload het bij je bank en bevestig daarna dat de bank het heeft
              uitgevoerd. Annuleren zet de facturen terug naar goedgekeurd.
            </p>
          </div>
          <button type="button" onClick={() => uitvoeren("vernieuwen", laad)} className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
            Vernieuwen
          </button>
        </div>
        {!batches && <p className="px-5 py-6 text-center text-sm text-slate-400">Laden…</p>}
        {batches && batches.length === 0 && <p className="px-5 py-6 text-center text-sm text-slate-400">Nog geen betaalbatches.</p>}
        {batches && batches.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {batches.map((b) => {
              const actief = b.status === "aangemaakt" || b.status === "ingediend";
              return (
                <li key={b.id} className="px-5 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button type="button" onClick={() => setOpen(open === b.id ? null : b.id)} className="min-w-0 text-left">
                      <span className="font-medium text-slate-800">{b.nummer}</span>
                      <span className="text-slate-500">
                        {" "}· {b.aantal} factu{b.aantal === 1 ? "ur" : "ren"} · {euro(b.totaal)} · uitvoeren op {datum(b.uitvoerdatum)}
                      </span>
                      <div className="text-xs text-slate-400">
                        Gemaakt {datumTijd(b.aangemaakt_op)}
                        {b.aangemaakt_door && ` door ${naamVan(b.aangemaakt_door) ?? "onbekend"}`}
                        {b.bank_referentie && ` · bank: ${b.bank_referentie}`}
                        {b.toelichting && ` · ${b.toelichting}`}
                      </div>
                    </button>
                    <div className="flex flex-wrap items-center gap-1">
                      <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${BATCH_KLASSEN[b.status]}`}>
                        {BATCH_STATUS_LABELS[b.status]}
                        {b.modus === "mock" ? " · mock" : ""}
                      </span>
                      <button type="button" onClick={() => downloadBestand(b)} disabled={bezig !== null} className={knopKlasse}>
                        SEPA-bestand
                      </button>
                      {b.status === "aangemaakt" && b.modus !== "mock" && (
                        <button type="button" onClick={() => batchActie(b, "ingediend")} disabled={bezig !== null} className={knopKlasse}>
                          Bij de bank aangeboden
                        </button>
                      )}
                      {actief && b.modus !== "mock" && (
                        <button type="button" onClick={() => batchActie(b, "bevestig")} disabled={bezig !== null} className={knopKlasse}>
                          Uitgevoerd door de bank
                        </button>
                      )}
                      {actief && (
                        <button type="button" onClick={() => batchActie(b, "annuleer")} disabled={bezig !== null} className={`${knopKlasse} hover:text-red-600`}>
                          Annuleren
                        </button>
                      )}
                    </div>
                  </div>
                  {open === b.id && (
                    <table className="mt-2 w-full text-xs">
                      <tbody>
                        {b.posten.map((p) => (
                          <tr key={p.id} className="border-t border-slate-50">
                            <td className="py-1 pr-3 font-mono text-slate-400">{p.end_to_end_id}</td>
                            <td className="py-1 pr-3 text-slate-700">{p.naam}</td>
                            <td className="py-1 pr-3 text-slate-500">{p.omschrijving}</td>
                            <td className="py-1 pr-3 font-mono text-slate-500">{p.iban}</td>
                            <td className="py-1 pr-3 text-right tabular-nums text-slate-700">{euro(p.bedrag)}</td>
                            <td className={`py-1 ${POST_KLASSEN[p.status]}`}>
                              {POST_STATUS_LABELS[p.status]}
                              {p.reden && `: ${p.reden}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
