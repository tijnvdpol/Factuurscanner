import { useCallback, useEffect, useState } from "react";
import type { Rol } from "../types";
import {
  BERICHT_STATUS_LABELS,
  BIJLAGE_STATUS_LABELS,
  echtheid,
  grootte,
  redenBeoordeling,
  type BerichtStatus,
  type BijlageStatus,
  type InboxAfzender,
  type InboxBericht,
} from "../lib/inbox";
import {
  beoordeelBericht,
  haalAfzendersOp,
  haalInboxOp,
  haalOntvangstadresOp,
  probeerBijlageOpnieuw,
  simuleerTestmail,
  stelOntvangstadresIn,
  verwijderAfzender,
  voegAfzenderToe,
} from "../lib/inboxApi";
import { haalKoppelingOverzichtOp } from "../lib/koppelingenApi";
import { openOrigineel } from "../lib/opslag";
import { datumTijd } from "../lib/audit";

interface Props {
  organisatieId: string;
  rol: Rol;
  naamVan: (userId: string) => string | undefined;
}

const invoerKlasse =
  "rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20";
const knopKlasse = "rounded-md px-3 py-1.5 text-sm font-medium";

const BERICHT_KLASSEN: Record<BerichtStatus, string> = {
  te_beoordelen: "bg-amber-100 text-amber-800",
  geaccepteerd: "bg-emerald-100 text-emerald-700",
  geweigerd: "bg-slate-100 text-slate-500",
};

const BIJLAGE_KLASSEN: Record<BijlageStatus, string> = {
  wacht: "bg-amber-100 text-amber-800",
  wachtrij: "bg-sky-100 text-sky-700",
  verwerkt: "bg-emerald-100 text-emerald-700",
  duplicaat: "bg-slate-100 text-slate-600",
  mislukt: "bg-red-100 text-red-700",
  genegeerd: "bg-slate-100 text-slate-400",
};

function foutTekst(err: unknown, standaard: string): string {
  return err instanceof Error && err.message ? err.message : standaard;
}

/** Inkomende mail: ontvangstadres, vertrouwde afzenders en de wachtrij met mail van onbekende afzenders. */
export default function InboxPagina({ organisatieId, rol, naamVan }: Props) {
  const magBeoordelen = rol === "controller" || rol === "beheerder";
  const [berichten, setBerichten] = useState<InboxBericht[] | null>(null);
  const [alleenTeBeoordelen, setAlleenTeBeoordelen] = useState(magBeoordelen);
  const [adres, setAdres] = useState<string | null>(null);
  const [adresInvoer, setAdresInvoer] = useState("");
  const [afzenders, setAfzenders] = useState<InboxAfzender[]>([]);
  const [nieuweAfzender, setNieuweAfzender] = useState("");
  const [mock, setMock] = useState<boolean | null>(null);
  const [fout, setFout] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);
  const [bezig, setBezig] = useState<string | null>(null);

  const laadBerichten = useCallback(async () => {
    setBerichten(await haalInboxOp(organisatieId, alleenTeBeoordelen));
  }, [organisatieId, alleenTeBeoordelen]);

  const laadInstellingen = useCallback(async () => {
    const [a, lijst] = await Promise.all([haalOntvangstadresOp(organisatieId), haalAfzendersOp(organisatieId)]);
    setAdres(a);
    setAdresInvoer(a ?? "");
    setAfzenders(lijst);
  }, [organisatieId]);

  useEffect(() => {
    let actief = true;
    haalInboxOp(organisatieId, alleenTeBeoordelen)
      .then((lijst) => actief && setBerichten(lijst))
      .catch((err) => actief && setFout(foutTekst(err, "De inbox kon niet worden geladen.")));
    return () => {
      actief = false;
    };
  }, [organisatieId, alleenTeBeoordelen]);

  useEffect(() => {
    let actief = true;
    Promise.all([haalOntvangstadresOp(organisatieId), haalAfzendersOp(organisatieId)])
      .then(([a, lijst]) => {
        if (!actief) return;
        setAdres(a);
        setAdresInvoer(a ?? "");
        setAfzenders(lijst);
      })
      .catch((err) => actief && setFout(foutTekst(err, "De instellingen konden niet worden geladen.")));
    haalKoppelingOverzichtOp(organisatieId)
      .then((k) => actief && setMock(k.find((x) => x.koppeling === "mailbox")?.modus === "mock"))
      .catch(() => actief && setMock(null));
    return () => {
      actief = false;
    };
  }, [organisatieId]);

  const voerUit = async (sleutel: string, actie: () => Promise<string | void>, standaardFout: string) => {
    setFout(null);
    setMelding(null);
    setBezig(sleutel);
    try {
      const tekst = await actie();
      if (tekst) setMelding(tekst);
    } catch (err) {
      setFout(foutTekst(err, standaardFout));
    } finally {
      setBezig(null);
    }
  };

  const slaAdresOp = () =>
    voerUit("adres", async () => {
      await stelOntvangstadresIn(organisatieId, adresInvoer);
      await laadInstellingen();
      return adresInvoer.trim() ? "Ontvangstadres opgeslagen." : "Ontvangstadres verwijderd.";
    }, "Het ontvangstadres kon niet worden opgeslagen.");

  const voegToe = (patroon: string, omschrijving: string | null = null) =>
    voerUit("afzender", async () => {
      await voegAfzenderToe(organisatieId, patroon, omschrijving);
      setNieuweAfzender("");
      await laadInstellingen();
      return `${patroon} staat nu bij de vertrouwde afzenders.`;
    }, "De afzender kon niet worden toegevoegd.");

  const verwijder = (a: InboxAfzender) => {
    if (!window.confirm(`${a.patroon} verwijderen uit de vertrouwde afzenders? Nieuwe mail van dit adres komt dan ter beoordeling.`)) return;
    voerUit(`verwijder-${a.id}`, async () => {
      await verwijderAfzender(a.id);
      await laadInstellingen();
    }, "De afzender kon niet worden verwijderd.");
  };

  const verwerk = (b: InboxBericht) => {
    // Alleen het exacte adres vertrouwen: een heel domein (bijv. @gmail.com) voeg je bewust toe bij "Vertrouwde afzenders".
    const vertrouw = echtheid(b).ok && window.confirm(
      `Mail van ${b.van} verwerken?\n\nOK = verwerken én dit adres vertrouwen (volgende mails komen direct binnen).\nAnnuleren = kies daarna of je alleen deze mail wilt verwerken.`,
    );
    if (!vertrouw && !window.confirm(`Alleen deze mail van ${b.van} verwerken (zonder de afzender te vertrouwen)?`)) return;
    voerUit(`bericht-${b.id}`, async () => {
      const n = await beoordeelBericht(b.id, "verwerken", vertrouw, null);
      await Promise.all([laadBerichten(), laadInstellingen()]);
      return `${n} bijlage${n === 1 ? " wordt" : "n worden"} gescand. De facturen verschijnen binnen een minuut in het overzicht.`;
    }, "De mail kon niet worden verwerkt.");
  };

  const weiger = (b: InboxBericht) => {
    const reden = window.prompt(`Reden om de mail van ${b.van} te weigeren (verplicht):`);
    if (reden === null) return;
    if (!reden.trim()) {
      setFout("Weigeren kan alleen met een reden.");
      return;
    }
    voerUit(`bericht-${b.id}`, async () => {
      await beoordeelBericht(b.id, "weigeren", false, reden.trim());
      await laadBerichten();
      return "Mail geweigerd.";
    }, "De mail kon niet worden geweigerd.");
  };

  const simuleer = (soort: "bekend" | "onbekend") =>
    voerUit(`simuleer-${soort}`, async () => {
      const tekst = await simuleerTestmail(organisatieId, soort);
      await Promise.all([laadBerichten(), laadInstellingen()]);
      return tekst;
    }, "De testmail kon niet worden gesimuleerd.");

  const opnieuw = (bijlageId: string) =>
    voerUit(`bijlage-${bijlageId}`, async () => {
      await probeerBijlageOpnieuw(bijlageId);
      await laadBerichten();
      return "De bijlage wordt opnieuw verwerkt.";
    }, "Opnieuw proberen is mislukt.");

  const bekijk = (pad: string) => {
    setFout(null);
    openOrigineel(pad).catch((err) => setFout(foutTekst(err, "De bijlage kon niet worden geopend.")));
  };

  return (
    <div className="space-y-6">
      {fout && <p className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">{fout}</p>}
      {melding && <p className="rounded-md bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{melding}</p>}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">Ontvangstadres</h2>
          <p className="mb-3 text-xs text-slate-400">
            Facturen die naar dit adres worden gemaild, komen automatisch binnen. Pdf's en foto's worden gescand en
            doorlopen dezelfde controles als een upload.
          </p>
          {rol === "beheerder" ? (
            <div className="flex gap-2">
              <input
                type="email"
                value={adresInvoer}
                onChange={(e) => setAdresInvoer(e.target.value)}
                placeholder="facturen@inbox.jouwbedrijf.nl"
                aria-label="Ontvangstadres"
                className={`${invoerKlasse} min-w-0 flex-1`}
              />
              <button
                type="button"
                onClick={slaAdresOp}
                disabled={bezig === "adres" || adresInvoer.trim().toLowerCase() === (adres ?? "")}
                className={`${knopKlasse} bg-slate-900 text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300`}
              >
                Opslaan
              </button>
            </div>
          ) : (
            <p className="text-sm text-slate-700">{adres ?? "Nog niet ingesteld (door een beheerder)."}</p>
          )}

          {mock && magBeoordelen && (
            <div className="mt-4 rounded-md bg-sky-50 p-3 text-xs text-sky-900">
              <p className="mb-2">
                <strong>Mock-modus:</strong> echte mail wordt niet verwerkt. Simuleer een mail met een PDF-factuur; die
                doorloopt dezelfde verwerking.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => simuleer("bekend")}
                  disabled={!adres || bezig !== null}
                  className={`${knopKlasse} bg-white text-sky-900 ring-1 ring-sky-200 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  Testmail van bekende afzender
                </button>
                <button
                  type="button"
                  onClick={() => simuleer("onbekend")}
                  disabled={!adres || bezig !== null}
                  className={`${knopKlasse} bg-white text-sky-900 ring-1 ring-sky-200 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  Testmail van onbekende afzender
                </button>
              </div>
              {!adres && <p className="mt-2 text-sky-700">Stel eerst een ontvangstadres in (mag in mock-modus elk adres zijn).</p>}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-800">Vertrouwde afzenders</h2>
          <p className="mb-3 text-xs text-slate-400">
            Mail van deze adressen of domeinen wordt direct verwerkt, als de afzender echt is (SPF of DKIM geslaagd).
            Andere mail komt hieronder ter beoordeling.
          </p>
          <ul className="mb-3 divide-y divide-slate-100 text-sm">
            {afzenders.length === 0 && <li className="py-1.5 text-slate-400">Nog geen vertrouwde afzenders.</li>}
            {afzenders.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="min-w-0 truncate">
                  <span className="font-medium text-slate-800">{a.patroon}</span>
                  {a.omschrijving && <span className="text-xs text-slate-400"> · {a.omschrijving}</span>}
                </span>
                {magBeoordelen && (
                  <button
                    type="button"
                    onClick={() => verwijder(a)}
                    disabled={bezig !== null}
                    className="text-xs text-slate-500 hover:text-red-600"
                  >
                    Verwijderen
                  </button>
                )}
              </li>
            ))}
          </ul>
          {magBeoordelen && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (nieuweAfzender.trim()) voegToe(nieuweAfzender.trim());
              }}
            >
              <input
                value={nieuweAfzender}
                onChange={(e) => setNieuweAfzender(e.target.value)}
                placeholder="facturen@leverancier.nl of @leverancier.nl"
                aria-label="Nieuwe vertrouwde afzender"
                className={`${invoerKlasse} min-w-0 flex-1`}
              />
              <button
                type="submit"
                disabled={bezig !== null || !nieuweAfzender.trim()}
                className={`${knopKlasse} bg-slate-900 text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300`}
              >
                Toevoegen
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Ontvangen mail</h2>
            <p className="text-xs text-slate-400">
              {magBeoordelen
                ? "Mail van onbekende afzenders wacht op jouw beoordeling: verwerken of weigeren."
                : "Mail van onbekende afzenders wordt beoordeeld door een controller of beheerder."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input type="checkbox" checked={alleenTeBeoordelen} onChange={(e) => setAlleenTeBeoordelen(e.target.checked)} />
              Alleen te beoordelen
            </label>
            <button type="button" onClick={() => laadBerichten().catch((e) => setFout(foutTekst(e, "Laden mislukt.")))} className={`${knopKlasse} text-slate-600 hover:bg-slate-100`}>
              Vernieuwen
            </button>
          </div>
        </div>

        {!berichten && <p className="px-5 py-6 text-center text-sm text-slate-400">Laden…</p>}
        {berichten && berichten.length === 0 && (
          <p className="px-5 py-6 text-center text-sm text-slate-400">
            {alleenTeBeoordelen ? "Er wacht geen mail op beoordeling." : "Nog geen mail ontvangen."}
          </p>
        )}
        <ul className="divide-y divide-slate-100">
          {berichten?.map((b) => {
            const echt = echtheid(b);
            const reden = redenBeoordeling(b);
            return (
              <li key={b.id} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800">
                      {b.onderwerp || "(geen onderwerp)"}
                      {b.bron === "mock" && <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs font-normal text-sky-700">test</span>}
                    </p>
                    <p className="text-xs text-slate-500">
                      {b.van_naam ? `${b.van_naam} <${b.van}>` : b.van} · {datumTijd(b.ontvangen_op)}
                    </p>
                    <p className={`text-xs ${echt.ok ? "text-emerald-700" : "text-red-700"}`}>{echt.tekst}</p>
                    {reden && <p className="text-xs text-amber-800">{reden}</p>}
                    {b.beoordeeld_op && (
                      <p className="text-xs text-slate-400">
                        {BERICHT_STATUS_LABELS[b.status]} door {b.beoordeeld_door ? (naamVan(b.beoordeeld_door) ?? "onbekend") : "onbekend"} op{" "}
                        {datumTijd(b.beoordeeld_op)}
                        {b.toelichting && ` — “${b.toelichting}”`}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${BERICHT_KLASSEN[b.status]}`}>
                      {BERICHT_STATUS_LABELS[b.status]}
                    </span>
                    {b.status === "te_beoordelen" && magBeoordelen && (
                      <>
                        <button
                          type="button"
                          onClick={() => verwerk(b)}
                          disabled={bezig !== null || !b.afgerond}
                          className={`${knopKlasse} bg-emerald-600 text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-300`}
                        >
                          Verwerken
                        </button>
                        <button
                          type="button"
                          onClick={() => weiger(b)}
                          disabled={bezig !== null}
                          className={`${knopKlasse} text-red-700 hover:bg-red-50`}
                        >
                          Weigeren
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {b.tekst && <p className="mt-2 line-clamp-3 whitespace-pre-line text-xs text-slate-500">{b.tekst}</p>}
                {b.bijlagen.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {b.bijlagen.map((x) => (
                      <li key={x.id} className="flex flex-wrap items-center gap-2 text-xs">
                        {x.pad ? (
                          <button type="button" onClick={() => bekijk(x.pad!)} className="font-medium text-slate-700 underline decoration-slate-300 hover:decoration-slate-700">
                            {x.bestandsnaam}
                          </button>
                        ) : (
                          <span className="text-slate-500">{x.bestandsnaam}</span>
                        )}
                        <span className="text-slate-400">{grootte(x.grootte)}</span>
                        <span className={`rounded-full px-2 py-0.5 font-medium ${BIJLAGE_KLASSEN[x.status]}`}>{BIJLAGE_STATUS_LABELS[x.status]}</span>
                        {x.reden && <span className="text-slate-500">{x.reden}</span>}
                        {x.status === "mislukt" && (
                          <button type="button" onClick={() => opnieuw(x.id)} disabled={bezig !== null} className="text-slate-600 underline hover:text-slate-900">
                            Opnieuw proberen
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
