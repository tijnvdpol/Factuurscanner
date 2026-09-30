import { useCallback, useEffect, useState } from "react";
import type { KoppelingStatus } from "../lib/koppelingen";
import {
  PAKKET_NAMEN,
  PAKKETTEN,
  STANDAARD_TARIEVEN,
  leesBoekhoudConfig,
  stelBtwVoor,
  stelGrootboekVoor,
  type BoekhoudMapping,
  type ExternItem,
  type MappingSoort,
  type Pakket,
} from "../lib/boekhouding";
import {
  haalBoekhoudOptiesOp,
  haalLeveranciersOp,
  haalMappingsOp,
  planExports,
  slaBoekhoudConfigOp,
  slaMappingOp,
  telTeExporteren,
  type BoekhoudOpties,
} from "../lib/boekhoudingApi";
import { haalRekeningenOp } from "../lib/grootboekApi";
import type { Grootboekrekening } from "../types";

interface Props {
  organisatieId: string;
  /** Beheerder: pakket en automatisch exporteren instellen. Mappings en exporteren: controller en beheerder. */
  magBeheren: boolean;
  status: KoppelingStatus;
  onOpgeslagen: () => Promise<void>;
}

const selectKlasse =
  "w-full max-w-xs rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20 disabled:bg-slate-50";
const knopKlasse = "rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300";

function foutTekst(err: unknown, standaard: string): string {
  return err instanceof Error && err.message ? err.message : standaard;
}

function label(e: Pick<ExternItem, "code" | "naam">): string {
  return e.code ? `${e.code} ${e.naam}` : e.naam;
}

/** Keuzelijst met de items uit het pakket; zonder opgehaalde opties alleen de huidige mapping. */
function MappingKeuze({
  mapping,
  opties,
  bezig,
  onKies,
  aria,
}: {
  mapping: BoekhoudMapping | undefined;
  opties: ExternItem[] | null;
  bezig: boolean;
  onKies: (item: ExternItem | null) => void;
  aria: string;
}) {
  if (!opties) {
    return <span className={mapping ? "text-slate-700" : "text-slate-400"}>{mapping ? (mapping.extern_naam ?? mapping.extern_id) : "niet gekoppeld"}</span>;
  }
  const bekend = !mapping || opties.some((o) => o.id === mapping.extern_id);
  return (
    <select
      aria-label={aria}
      value={mapping?.extern_id ?? ""}
      disabled={bezig}
      onChange={(e) => onKies(opties.find((o) => o.id === e.target.value) ?? null)}
      className={selectKlasse}
    >
      <option value="">— niet gekoppeld —</option>
      {!bekend && mapping && <option value={mapping.extern_id}>{mapping.extern_naam ?? mapping.extern_id} (bestaat niet meer?)</option>}
      {opties.map((o) => (
        <option key={o.id} value={o.id}>
          {label(o)}
        </option>
      ))}
    </select>
  );
}

/** Pakket, automatisch exporteren, mappings (grootboek, btw, leveranciers) en exporteren (pagina Koppelingen). */
export default function BoekhoudingInstellingen({ organisatieId, magBeheren, status, onOpgeslagen }: Props) {
  const config = leesBoekhoudConfig(status.config);
  const [pakket, setPakket] = useState<Pakket>(config.provider);
  const [automatisch, setAutomatisch] = useState(config.automatisch);
  const [opties, setOpties] = useState<BoekhoudOpties | null>(null);
  const [mappings, setMappings] = useState<BoekhoudMapping[]>([]);
  const [rekeningen, setRekeningen] = useState<Grootboekrekening[]>([]);
  const [leveranciers, setLeveranciers] = useState<{ id: string; naam: string }[]>([]);
  const [teExporteren, setTeExporteren] = useState<number | null>(null);
  const [bezig, setBezig] = useState<string | null>(null);
  const [melding, setMelding] = useState<{ ok: boolean; tekst: string } | null>(null);

  const laadMappings = useCallback(async () => {
    setMappings(await haalMappingsOp(organisatieId, config.provider));
  }, [organisatieId, config.provider]);

  useEffect(() => {
    let actief = true;
    Promise.all([
      haalMappingsOp(organisatieId, config.provider),
      haalRekeningenOp(organisatieId),
      haalLeveranciersOp(organisatieId),
      telTeExporteren(organisatieId),
    ])
      .then(([m, r, l, n]) => {
        if (!actief) return;
        setMappings(m);
        setRekeningen(r);
        setLeveranciers(l);
        setTeExporteren(n);
      })
      .catch((err) => actief && setMelding({ ok: false, tekst: foutTekst(err, "De koppeling met het boekhoudpakket kon niet worden geladen.") }));
    return () => {
      actief = false;
    };
  }, [organisatieId, config.provider]);

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

  const slaConfigOp = () =>
    uitvoeren("config", async () => {
      await slaBoekhoudConfigOp(organisatieId, { provider: pakket, automatisch });
      setOpties(null);
      await onOpgeslagen();
      return `Boekhoudpakket: ${PAKKET_NAMEN[pakket]}${automatisch ? ", automatisch exporteren na goedkeuren" : ", exporteren via de knop"}.`;
    });

  const haalOpties = () =>
    uitvoeren("opties", async () => {
      const o = await haalBoekhoudOptiesOp(organisatieId);
      setOpties(o);
      return `Verbonden met ${o.naam}: ${o.grootboekrekeningen.length} grootboekrekeningen en ${o.btw_codes.length} btw-codes.`;
    });

  const koppel = (soort: MappingSoort, intern: string, item: ExternItem | null) =>
    uitvoeren(`${soort}:${intern}`, async () => {
      await slaMappingOp(organisatieId, config.provider, soort, intern, item?.id ?? "", item ? label(item) : null);
      await laadMappings();
    });

  const automatischKoppelen = () =>
    uitvoeren("auto", async () => {
      if (!opties) return;
      const voorstellen = [
        ...stelGrootboekVoor(rekeningen.filter((r) => r.actief), opties.grootboekrekeningen, mappings).map((v) => ({ soort: "grootboek" as const, ...v })),
        ...stelBtwVoor(tarieven, opties.btw_codes, mappings).map((v) => ({ soort: "btw" as const, ...v })),
      ];
      for (const v of voorstellen) {
        await slaMappingOp(organisatieId, config.provider, v.soort, v.intern, v.extern.id, label(v.extern));
      }
      await laadMappings();
      return voorstellen.length === 0
        ? "Niets automatisch te koppelen: alles is al gekoppeld, of er is geen rekening met dezelfde code of naam."
        : `${voorstellen.length} koppeling${voorstellen.length === 1 ? "" : "en"} gemaakt op code, naam of percentage. Controleer ze.`;
    });

  const exporteer = () =>
    uitvoeren("export", async () => {
      const n = await planExports(organisatieId);
      setTeExporteren(await telTeExporteren(organisatieId));
      return n === 0
        ? "Er staan geen nieuwe exports klaar (lopende exports worden niet dubbel ingepland)."
        : `${n} factu${n === 1 ? "ur" : "ren"} in de wachtrij voor export. Mislukte exports staan als "Export mislukt" bij de factuur.`;
    });

  const mappingVan = (soort: MappingSoort, intern: string) => mappings.find((m) => m.soort === soort && m.intern === intern);
  const tarieven = [...new Set([...STANDAARD_TARIEVEN, ...mappings.filter((m) => m.soort === "btw").map((m) => m.intern)])];
  const leverancierMappings = mappings.filter((m) => m.soort === "leverancier");
  const actieveRekeningen = rekeningen.filter((r) => r.actief || mappingVan("grootboek", r.id));
  const nietGekoppeld = actieveRekeningen.filter((r) => !mappingVan("grootboek", r.id)).length;
  const gewijzigd = pakket !== config.provider || automatisch !== config.automatisch;

  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-slate-800">Boekhoudpakket</h2>
        <p className="text-xs text-slate-400">
          Goedgekeurde facturen worden als inkoopfactuur geboekt, met het PDF als bijlage. Daarna is de factuur hier
          vergrendeld; correcties doe je in het pakket. Koppel eerst je grootboekrekeningen en btw-tarieven; leveranciers
          worden bij de eerste export gezocht (KvK, btw-nummer, naam) of aangemaakt.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4 border-b border-slate-100 px-5 py-4 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">Pakket</span>
          <select value={pakket} disabled={!magBeheren} onChange={(e) => setPakket(e.target.value as Pakket)} className={selectKlasse}>
            {PAKKETTEN.map((p) => (
              <option key={p} value={p}>
                {PAKKET_NAMEN[p]}
                {p !== "moneybird" ? " (alleen mock)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1">
          <input type="checkbox" checked={automatisch} disabled={!magBeheren} onChange={(e) => setAutomatisch(e.target.checked)} />
          <span>Na goedkeuren automatisch exporteren</span>
        </label>
        {magBeheren && (
          <button type="button" onClick={slaConfigOp} disabled={!gewijzigd || bezig !== null} className={knopKlasse}>
            Opslaan
          </button>
        )}
        {config.provider !== "moneybird" && status.modus === "live" && (
          <p className="w-full text-xs text-red-700">
            {PAKKET_NAMEN[config.provider]} is alleen als mock beschikbaar: exports mislukken zolang de koppeling op live staat.
          </p>
        )}
      </div>

      <div className="space-y-4 px-5 py-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={haalOpties}
            disabled={bezig !== null}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {opties ? "Opnieuw ophalen" : `Rekeningen ophalen uit ${PAKKET_NAMEN[config.provider]}`}
          </button>
          {opties && (
            <button type="button" onClick={automatischKoppelen} disabled={bezig !== null} className={knopKlasse}>
              Automatisch koppelen
            </button>
          )}
          <span className="text-xs text-slate-400">
            {nietGekoppeld > 0 ? `${nietGekoppeld} grootboekrekening${nietGekoppeld === 1 ? "" : "en"} nog niet gekoppeld` : "Alle grootboekrekeningen gekoppeld"}
          </span>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Grootboekrekeningen</h3>
            <ul className="space-y-1.5">
              {actieveRekeningen.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate text-slate-700">
                    {r.code} {r.omschrijving}
                  </span>
                  <MappingKeuze
                    aria={`Koppeling voor ${r.code} ${r.omschrijving}`}
                    mapping={mappingVan("grootboek", r.id)}
                    opties={opties?.grootboekrekeningen ?? null}
                    bezig={bezig === `grootboek:${r.id}`}
                    onKies={(item) => koppel("grootboek", r.id, item)}
                  />
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-6">
            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Btw-tarieven</h3>
              <ul className="space-y-1.5">
                {tarieven.map((t) => (
                  <li key={t} className="flex items-center justify-between gap-3">
                    <span className="text-slate-700">{t}%</span>
                    <MappingKeuze
                      aria={`Btw-code voor ${t}%`}
                      mapping={mappingVan("btw", t)}
                      opties={opties?.btw_codes ?? null}
                      bezig={bezig === `btw:${t}`}
                      onKies={(item) => koppel("btw", t, item)}
                    />
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">Leveranciers</h3>
              {leverancierMappings.length === 0 ? (
                <p className="text-xs text-slate-400">Nog geen leveranciers gekoppeld. Dat gebeurt bij de eerste export.</p>
              ) : (
                <ul className="space-y-1.5">
                  {leverancierMappings.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-slate-700">
                        {leveranciers.find((l) => l.id === m.intern)?.naam ?? "Onbekende leverancier"}
                        <span className="text-slate-400"> → {m.extern_naam ?? m.extern_id}</span>
                        {m.automatisch && <span className="ml-1 text-xs text-slate-400">(automatisch)</span>}
                      </span>
                      <button
                        type="button"
                        onClick={() => koppel("leverancier", m.intern, null)}
                        disabled={bezig !== null}
                        title="Bij de volgende export wordt de leverancier opnieuw gezocht of aangemaakt"
                        className="text-xs font-medium text-slate-500 hover:text-red-600"
                      >
                        Ontkoppelen
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <p className="text-slate-600">
            {teExporteren === null
              ? "…"
              : teExporteren === 0
                ? "Alle goedgekeurde facturen zijn geëxporteerd."
                : `${teExporteren} goedgekeurde factu${teExporteren === 1 ? "ur is" : "ren zijn"} nog niet geëxporteerd.`}
          </p>
          <button
            type="button"
            onClick={exporteer}
            disabled={bezig !== null || !teExporteren}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Nu exporteren
          </button>
        </div>
      </div>

      {melding && (
        <p className={`border-t border-slate-100 px-5 py-2 text-xs ${melding.ok ? "text-emerald-700" : "text-red-700"}`}>{melding.tekst}</p>
      )}
    </div>
  );
}
