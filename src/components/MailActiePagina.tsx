import { useEffect, useState } from "react";
import { bekijkMailActie, voerMailActieUit, type MailActieFactuur, type MailActieInfo } from "../lib/notificatiesApi";
import { ERNST_KLASSEN } from "../lib/stijl";
import { STATUS_LABELS, type FactuurStatus } from "../types";

interface Props {
  token: string;
  keuze: "goedkeuren" | "afkeuren" | null;
}

function bedrag(waarde: number | null, valuta = "EUR"): string {
  if (waarde === null) return "onbekend";
  try {
    return new Intl.NumberFormat("nl-NL", { style: "currency", currency: valuta }).format(waarde);
  } catch {
    return `${valuta} ${waarde.toFixed(2)}`;
  }
}

function datum(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("nl-NL");
}

function FactuurGegevens({ f }: { f: MailActieFactuur }) {
  const rijen: [string, string][] = [
    ["Leverancier", f.leverancier ?? "—"],
    ["Factuurnummer", f.factuurnummer ?? "—"],
    ["Factuurdatum", datum(f.factuurdatum)],
    ["Vervaldatum", datum(f.vervaldatum)],
    [
      "Bedrag incl. btw",
      f.valuta === "EUR" ? bedrag(f.totaal_incl) : `${bedrag(f.totaal_incl, f.valuta)} (≈ ${f.bedrag_eur === null ? "koers volgt" : bedrag(f.bedrag_eur)})`,
    ],
    ["Grootboekrekening", f.grootboekrekening ?? "nog niet gekozen"],
    ["Ingevoerd door", f.ingevoerd_door ?? (f.bron === "mailbox" ? "via de mailbox" : "—")],
    ["Gecontroleerd door", f.gecontroleerd_door ?? "—"],
    ["Status", STATUS_LABELS[f.status as FactuurStatus] ?? f.status],
  ];
  return (
    <div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {rijen.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-slate-900">{v}</dd>
          </div>
        ))}
      </dl>
      {f.signalen.length > 0 && (
        <ul className="mt-4 space-y-1">
          {f.signalen.map((s, i) => (
            <li key={i} className={`rounded-md px-3 py-1.5 text-xs ${ERNST_KLASSEN[s.ernst] ?? ""}`}>
              {s.bericht}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Pagina achter de knoppen in een goedkeuringsmail (#mail-actie=<token>&keuze=…). Zonder inloggen: het
 * ondertekende, eenmalige token is de toegang. Er is altijd een bevestiging nodig, zodat link-scanners van
 * mailprogramma's niets kunnen uitvoeren.
 */
export default function MailActiePagina({ token, keuze: startKeuze }: Props) {
  const [info, setInfo] = useState<MailActieInfo | null>(null);
  const [laadFout, setLaadFout] = useState<string | null>(null);
  const [keuze, setKeuze] = useState<"goedkeuren" | "afkeuren">(startKeuze ?? "goedkeuren");
  const [reden, setReden] = useState("");
  const [bezig, setBezig] = useState(false);
  const [uitkomst, setUitkomst] = useState<{ ok: boolean; melding: string } | null>(null);

  useEffect(() => {
    let actief = true;
    bekijkMailActie(token)
      .then((i) => actief && setInfo(i))
      .catch((err) => actief && setLaadFout(err instanceof Error ? err.message : "De link kon niet worden geladen."));
    return () => {
      actief = false;
    };
  }, [token]);

  const bevestig = async () => {
    setBezig(true);
    try {
      setUitkomst(await voerMailActieUit(token, keuze, keuze === "afkeuren" ? reden : null));
    } catch (err) {
      setUitkomst({ ok: false, melding: err instanceof Error ? err.message : "Er ging iets mis." });
    } finally {
      setBezig(false);
    }
  };

  const blokkade = info?.mogelijk?.[keuze] ?? null;
  const appUrl = `${window.location.origin}/`;

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-10">
      <div className="mx-auto max-w-lg rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs text-slate-400">Factuurscanner{info?.organisatie ? ` · ${info.organisatie}` : ""}</p>
        <h1 className="mb-4 text-lg font-semibold text-slate-900">
          {uitkomst?.ok ? (keuze === "goedkeuren" ? "Goedgekeurd" : "Afgekeurd") : "Factuur beoordelen"}
        </h1>

        {!info && !laadFout && <p className="py-6 text-center text-sm text-slate-400">Laden…</p>}
        {laadFout && <p className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">{laadFout}</p>}

        {info && !info.geldig && (
          <div className="space-y-4">
            <p className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900">{info.melding}</p>
            {info.gebruikt_actie && info.gebruikt_op && (
              <p className="text-sm text-slate-600">
                Je hebt deze factuur op {new Date(info.gebruikt_op).toLocaleString("nl-NL")}{" "}
                {info.gebruikt_actie === "goedkeuren" ? "goedgekeurd" : "afgekeurd"}.
              </p>
            )}
            {info.factuur && <FactuurGegevens f={info.factuur} />}
          </div>
        )}

        {info?.geldig && info.factuur && (
          <div className="space-y-5">
            <FactuurGegevens f={info.factuur} />

            {uitkomst ? (
              <p className={`rounded-md px-4 py-3 text-sm ${uitkomst.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
                {uitkomst.melding}
              </p>
            ) : (
              <div className="space-y-3 border-t border-slate-100 pt-4">
                <p className="text-sm text-slate-600">
                  Je {keuze === "goedkeuren" ? "keurt deze factuur goed" : "keurt deze factuur af"} als{" "}
                  <strong>{info.goedkeurder}</strong>.
                </p>
                {keuze === "afkeuren" && (
                  <label className="block text-sm">
                    <span className="text-slate-700">Reden (verplicht)</span>
                    <textarea
                      value={reden}
                      onChange={(e) => setReden(e.target.value)}
                      rows={3}
                      maxLength={1000}
                      className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20"
                    />
                  </label>
                )}
                {blokkade && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{blokkade}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={bevestig}
                    disabled={bezig || !!blokkade || (keuze === "afkeuren" && reden.trim() === "")}
                    className={`rounded-md px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300 ${
                      keuze === "goedkeuren" ? "bg-emerald-700 hover:bg-emerald-600" : "bg-red-700 hover:bg-red-600"
                    }`}
                  >
                    {bezig ? "Bezig…" : keuze === "goedkeuren" ? "Bevestig goedkeuren" : "Bevestig afkeuren"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setKeuze(keuze === "goedkeuren" ? "afkeuren" : "goedkeuren")}
                    className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
                  >
                    {keuze === "goedkeuren" ? "Toch afkeuren" : "Toch goedkeuren"}
                  </button>
                </div>
                {info.verloopt_op && (
                  <p className="text-xs text-slate-400">Deze link werkt één keer en is geldig tot {new Date(info.verloopt_op).toLocaleString("nl-NL")}.</p>
                )}
              </div>
            )}
          </div>
        )}

        <p className="mt-6 text-sm">
          <a href={appUrl} className="text-slate-600 underline hover:text-slate-900">
            Naar de app
          </a>
        </p>
      </div>
    </div>
  );
}
