import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import UploadZone from "./UploadZone";
import FactuurFormulier from "./FactuurFormulier";
import FacturenTabel from "./FacturenTabel";
import SignalenBlok from "./SignalenBlok";
import CoderingVeld from "./CoderingVeld";
import HistorieTijdlijn from "./HistorieTijdlijn";
import type { WeergaveContext } from "../lib/audit";
import { voorspelSignalen } from "../lib/signalen";
import { kiesCoderingsvoorstel } from "../lib/codering";
import { haalHistorieVoorstel } from "../lib/grootboekApi";
import { GeminiError, scanFactuur } from "../lib/gemini";
import { valideerFactuur } from "../lib/validatie";
import { OpslagError, openOrigineel, uploadFactuurBestand, verwijderBestand } from "../lib/opslag";
import {
  DbError,
  haalFacturenOp,
  importeerLokaleFacturen,
  losSignaalOp,
  slaFactuurOp,
  verwijderFactuur,
  wijzigStatus,
} from "../lib/facturenApi";
import { probeerTaakOpnieuw } from "../lib/koppelingenApi";
import {
  FUNCTIESCHEIDING_MELDING,
  valtTerugNaGewijzigd,
  type MogelijkeActie,
  type WorkflowContext,
} from "../lib/workflow";
import { downloadCsv } from "../lib/csv";
import {
  alleenFactuurData,
  GEEN_CODERING,
  LEGE_WORKFLOW,
  STATUS_LABELS,
  legeFactuurData,
  type Codering,
  type Factuur,
  type FactuurData,
  type FactuurStatus,
  type Grootboekrekening,
  type Lidmaatschap,
  type OrgGebruiker,
} from "../types";

// Facturen van vóór de Supabase-koppeling; alleen nog gelezen voor de eenmalige import.
const LOKALE_FACTUREN = "factuurscanner_facturen";
// Uit de tijd dat de API-sleutel en het model in de browser stonden; worden opgeruimd.
const VEROUDERDE_OPSLAG = ["factuurscanner_api_key", "factuurscanner_model"];

function laadLokaleFacturen(): Factuur[] {
  try {
    const ruw = localStorage.getItem(LOKALE_FACTUREN);
    const facturen = ruw ? (JSON.parse(ruw) as Factuur[]) : [];
    return facturen.map((f) => ({
      ...legeFactuurData(),
      ...f,
      bestand_pad: f.bestand_pad ?? null,
      leverancier_iban: null,
      signalen: [],
      koppelingen: [],
      codering: GEEN_CODERING,
      workflow: LEGE_WORKFLOW,
      status: "gescand",
      ai_model: null,
    }));
  } catch {
    return [];
  }
}

function foutTekst(err: unknown, standaard: string): string {
  return err instanceof DbError || err instanceof GeminiError || err instanceof OpslagError ? err.message : standaard;
}

interface Concept {
  factuurId: string;
  bewerkId: string | null;
  bestandsnaam: string | null;
  bestandPad: string | null;
  aiModel: string | null;
  status: FactuurStatus;
  /** Leveranciersnaam bij het openen; bepaalt of btw-/KvK-nummer van die leverancier bijgewerkt mogen worden. */
  origineleLeverancier: string | null;
  data: FactuurData;
  codering: Codering;
}

/** Ruimt het geüploade bestand op van een nieuw concept dat niet wordt opgeslagen. */
function ruimConceptBestandOp(concept: Concept | null) {
  if (concept && !concept.bewerkId && concept.bestandPad) {
    verwijderBestand(concept.bestandPad).catch((err) => console.warn(err));
  }
}

interface Props {
  sessie: Session;
  lidmaatschap: Lidmaatschap;
  rekeningen: Grootboekrekening[];
  gebruikers: OrgGebruiker[];
  weergave: WeergaveContext;
}

function datum(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("nl-NL", { dateStyle: "medium" }) : "";
}

export default function FacturenPagina({ sessie, lidmaatschap, rekeningen, gebruikers, weergave }: Props) {
  const organisatieId = lidmaatschap.organisatie_id;
  const [bezigId, setBezigId] = useState<string | null>(null);
  const [facturen, setFacturen] = useState<Factuur[]>([]);
  const [laden, setLaden] = useState(true);
  const [laadFout, setLaadFout] = useState<string | null>(null);
  const [lokaleFacturen, setLokaleFacturen] = useState<Factuur[]>(laadLokaleFacturen);
  const [importeren, setImporteren] = useState(false);
  const [exporteren, setExporteren] = useState(false);
  const [bezig, setBezig] = useState(false);
  const [opslaan, setOpslaan] = useState(false);
  const [foutmelding, setFoutmelding] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);
  const [concept, setConcept] = useState<Concept | null>(null);

  const naamVan = weergave.naamVan;

  const vernieuw = useCallback(async () => {
    try {
      setFacturen(await haalFacturenOp(organisatieId));
      setLaadFout(null);
    } catch (err) {
      setLaadFout(foutTekst(err, "De facturen konden niet worden geladen."));
    } finally {
      setLaden(false);
    }
  }, [organisatieId]);

  useEffect(() => {
    let actief = true;
    haalFacturenOp(organisatieId)
      .then((lijst) => actief && setFacturen(lijst))
      .catch((err) => actief && setLaadFout(foutTekst(err, "De facturen konden niet worden geladen.")))
      .finally(() => actief && setLaden(false));
    return () => {
      actief = false;
    };
  }, [organisatieId]);

  useEffect(() => {
    try {
      VEROUDERDE_OPSLAG.forEach((sleutel) => localStorage.removeItem(sleutel));
    } catch {
      // geen toegang tot localStorage: niets op te ruimen
    }
  }, []);

  const leden = gebruikers.filter((g) => g.is_lid);
  const context: WorkflowContext = {
    userId: sessie.user.id,
    rol: lidmaatschap.rol,
    goedkeuringslimiet: lidmaatschap.goedkeuringslimiet,
    // Zolang de leden nog niet geladen zijn: niet uitgaan van "één lid" (dan zouden alle knoppen verschijnen).
    aantalLeden: leden.length || 2,
  };

  const conceptFouten = useMemo(() => (concept ? valideerFactuur(concept.data) : {}), [concept]);

  const conceptFactuur = concept?.bewerkId ? facturen.find((f) => f.id === concept.bewerkId) : undefined;

  const voorspeldeSignalen = useMemo(() => {
    if (!concept) return [];
    const naam = concept.data.leverancier?.trim().toLowerCase();
    const zelfdeLeverancier = (f: Factuur) => !!naam && f.leverancier?.trim().toLowerCase() === naam;
    // Het bekende IBAN: van de factuur zelf als de leverancier niet veranderd is, anders van een andere factuur.
    const bekendIban =
      (conceptFactuur && zelfdeLeverancier(conceptFactuur) ? conceptFactuur.leverancier_iban : null) ??
      facturen.find((f) => f.id !== concept.factuurId && zelfdeLeverancier(f))?.leverancier_iban ??
      null;
    return voorspelSignalen(
      { ...concept.data, id: concept.factuurId },
      {
        anderen: facturen.filter((f) => f.id !== concept.factuurId),
        bekendIban,
        // Goedkeuringslimieten van leden die mogen goedkeuren (voor "net onder limiet")
        limieten: gebruikers
          .filter((g) => g.is_lid && (g.rol === "goedkeurder" || g.rol === "controller" || g.rol === "beheerder"))
          .map((g) => g.goedkeuringslimiet),
      },
    );
  }, [concept, conceptFactuur, facturen, gebruikers]);

  const voerActieUit = async (factuur: Factuur, actie: MogelijkeActie) => {
    let reden: string | undefined;
    if (actie.vraagtReden) {
      const invoer = window.prompt(`Reden van afkeuren (verplicht) voor ${factuur.factuurnummer ?? "deze factuur"}:`);
      if (invoer === null) return;
      if (!invoer.trim()) {
        setFoutmelding("Afkeuren kan alleen met een reden.");
        return;
      }
      reden = invoer.trim();
    }
    setFoutmelding(null);
    setMelding(null);
    setBezigId(factuur.id);
    try {
      const resultaat = await wijzigStatus(factuur.id, actie.naar, reden);
      const wat = [factuur.leverancier, factuur.factuurnummer].filter(Boolean).join(" – ") || "Factuur";
      setMelding(`${wat}: status is nu ${STATUS_LABELS[actie.naar].toLowerCase()}.${resultaat ? ` ${resultaat}.` : ""}`);
      await vernieuw();
    } catch (err) {
      setFoutmelding(foutTekst(err, "De status kon niet worden gewijzigd."));
    } finally {
      setBezigId(null);
    }
  };

  const probeerKoppelingOpnieuw = async (taakId: string) => {
    setFoutmelding(null);
    setMelding(null);
    try {
      await probeerTaakOpnieuw(taakId);
      setMelding("De koppeling wordt opnieuw geprobeerd.");
      await vernieuw();
    } catch (err) {
      setFoutmelding(foutTekst(err, "Opnieuw proberen is mislukt."));
    }
  };

  const losSignaalOpEnVernieuw = async (signaalId: string, toelichting: string, ibanOvernemen: boolean) => {
    await losSignaalOp(signaalId, toelichting, ibanOvernemen);
    await vernieuw();
  };

  const verwerkBestand = async (bestand: File) => {
    setFoutmelding(null);
    setMelding(null);
    setBezig(true);
    const factuurId = crypto.randomUUID();
    let pad: string | null = null;
    try {
      pad = await uploadFactuurBestand(organisatieId, factuurId, bestand);
      const { factuur: data, model: aiModel, codering: aiVoorstel } = await scanFactuur(pad, organisatieId);
      // Historie gaat vóór AI; lukt het ophalen niet, dan valt het voorstel terug op de AI.
      const historie = data.leverancier
        ? await haalHistorieVoorstel(organisatieId, data.leverancier).catch(() => null)
        : null;
      ruimConceptBestandOp(concept);
      setConcept({
        factuurId,
        bewerkId: null,
        bestandsnaam: bestand.name,
        bestandPad: pad,
        aiModel,
        status: "gescand",
        origineleLeverancier: null,
        data,
        codering: kiesCoderingsvoorstel(historie, aiVoorstel ?? null, rekeningen),
      });
    } catch (err) {
      if (pad) verwijderBestand(pad).catch((e) => console.warn(e));
      setFoutmelding(foutTekst(err, "Onbekende fout tijdens het scannen."));
    } finally {
      setBezig(false);
    }
  };

  const bewerkRij = (id: string) => {
    const factuur = facturen.find((f) => f.id === id);
    if (!factuur) return;
    const { bestandsnaam, bestand_pad, status, ai_model } = factuur;
    const data = alleenFactuurData(factuur);
    ruimConceptBestandOp(concept);
    setFoutmelding(null);
    setConcept({
      factuurId: id,
      bewerkId: id,
      bestandsnaam,
      bestandPad: bestand_pad,
      aiModel: ai_model,
      status,
      origineleLeverancier: data.leverancier,
      data,
      codering: factuur.codering,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
    // Nog niet gecodeerd: voorstel uit de historie van deze leverancier ophalen.
    if (!factuur.codering.grootboekrekening_id && data.leverancier) {
      haalHistorieVoorstel(organisatieId, data.leverancier)
        .then((historie) => {
          const voorstel = kiesCoderingsvoorstel(historie, null, rekeningen);
          if (!voorstel.grootboekrekening_id) return;
          setConcept((huidig) =>
            huidig?.bewerkId === id && !huidig.codering.grootboekrekening_id ? { ...huidig, codering: voorstel } : huidig,
          );
        })
        .catch((err) => console.warn(err));
    }
  };

  const verwijderRij = async (id: string) => {
    const factuur = facturen.find((f) => f.id === id);
    if (!factuur) return;
    const omschrijving = [factuur.leverancier, factuur.factuurnummer].filter(Boolean).join(" – ") || "deze factuur";
    if (!window.confirm(`Weet je zeker dat je ${omschrijving} wilt verwijderen? Dit kan niet ongedaan worden gemaakt.`)) {
      return;
    }
    setFoutmelding(null);
    try {
      await verwijderFactuur(factuur);
      setFacturen((huidig) => huidig.filter((f) => f.id !== id));
      if (concept?.bewerkId === id) setConcept(null);
    } catch (err) {
      setFoutmelding(foutTekst(err, "Verwijderen is mislukt."));
    }
  };

  const annuleerConcept = () => {
    ruimConceptBestandOp(concept);
    setConcept(null);
    setFoutmelding(null);
  };

  const bekijkOrigineel = (pad: string) => {
    setFoutmelding(null);
    openOrigineel(pad).catch((err) => setFoutmelding(foutTekst(err, "Kon het originele bestand niet openen.")));
  };

  const slaConceptOp = async () => {
    if (!concept) return;
    setFoutmelding(null);
    setOpslaan(true);
    try {
      const zelfdeLeverancier =
        (concept.origineleLeverancier ?? "").trim().toLowerCase() ===
        (concept.data.leverancier ?? "").trim().toLowerCase();
      await slaFactuurOp({
        id: concept.factuurId,
        organisatieId,
        data: concept.data,
        bestandPad: concept.bestandPad,
        bestandsnaam: concept.bestandsnaam,
        aiModel: concept.aiModel,
        codering: concept.codering,
        leverancierBijwerken: concept.bewerkId !== null && zelfdeLeverancier,
      });
      setConcept(null);
      await vernieuw();
    } catch (err) {
      setFoutmelding(foutTekst(err, "Opslaan is mislukt."));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setOpslaan(false);
    }
  };

  const exporteerCsv = async () => {
    setFoutmelding(null);
    setExporteren(true);
    try {
      const actueel = await haalFacturenOp(organisatieId);
      setFacturen(actueel);
      downloadCsv(actueel, rekeningen);
    } catch (err) {
      setFoutmelding(foutTekst(err, "Exporteren is mislukt."));
    } finally {
      setExporteren(false);
    }
  };

  const importeerLokaal = async () => {
    setFoutmelding(null);
    setMelding(null);
    setImporteren(true);
    try {
      const { geimporteerd, duplicaten, mislukt } = await importeerLokaleFacturen(
        lokaleFacturen,
        sessie.user.id,
        organisatieId,
      );
      try {
        if (mislukt.length === 0) localStorage.removeItem(LOKALE_FACTUREN);
        else localStorage.setItem(LOKALE_FACTUREN, JSON.stringify(mislukt));
      } catch {
        // localStorage niet beschikbaar: de lijst in het geheugen is wel bijgewerkt
      }
      setLokaleFacturen(mislukt);

      const delen = [`${geimporteerd} factu${geimporteerd === 1 ? "ur" : "ren"} geïmporteerd`];
      if (duplicaten > 0) delen.push(`${duplicaten} overgeslagen omdat ze al bestonden`);
      setMelding(delen.join(", ") + ".");
      if (mislukt.length > 0) {
        setFoutmelding(
          `${mislukt.length} factu${mislukt.length === 1 ? "ur kon" : "ren konden"} niet worden geïmporteerd. Probeer het opnieuw.`,
        );
      }
      await vernieuw();
    } finally {
      setImporteren(false);
    }
  };

  const conceptStatus = conceptFactuur?.status ?? concept?.status ?? "gescand";
  const wf = conceptFactuur?.workflow;
  const statusInfo = wf ? (
    <>
      {[
        wf.ingevoerd_door && `Ingevoerd door ${naamVan(wf.ingevoerd_door) ?? "onbekend"}`,
        wf.gecontroleerd_door && `gecontroleerd door ${naamVan(wf.gecontroleerd_door) ?? "onbekend"} op ${datum(wf.gecontroleerd_op)}`,
        wf.goedgekeurd_door && `goedgekeurd door ${naamVan(wf.goedgekeurd_door) ?? "onbekend"} op ${datum(wf.goedgekeurd_op)}`,
        wf.betaald_op && `betaald op ${datum(wf.betaald_op)}`,
      ]
        .filter(Boolean)
        .join(" · ")}
      {conceptStatus === "afgekeurd" && wf.afkeur_reden && (
        <div className="text-red-600">Afgekeurd: {wf.afkeur_reden}</div>
      )}
    </>
  ) : undefined;
  const terugvalWaarschuwing =
    concept && conceptFactuur && valtTerugNaGewijzigd(conceptFactuur.status, conceptFactuur, concept.data)
      ? `Let op: na opslaan gaat de status terug van ${STATUS_LABELS[conceptFactuur.status].toLowerCase()} naar gescand. De factuur moet dan opnieuw worden gecontroleerd en goedgekeurd.`
      : null;

  return (
    <>
      {leden.length === 1 && (
        <div className="rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
          {FUNCTIESCHEIDING_MELDING}. Je kunt alle stappen zelf uitvoeren; dit wordt vastgelegd in de historie. Voeg
          collega's toe via Leden om taken te scheiden.
        </div>
      )}

      <UploadZone onFile={verwerkBestand} bezig={bezig} />

      {foutmelding && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{foutmelding}</div>
      )}

      {melding && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {melding}
        </div>
      )}

      {concept && (
        <FactuurFormulier
          key={concept.factuurId}
          factuur={concept.data}
          fouten={conceptFouten}
          bewerken={concept.bewerkId !== null}
          bestandsnaam={concept.bestandsnaam ?? undefined}
          aiModel={concept.aiModel ?? undefined}
          onBekijkOrigineel={concept.bestandPad ? () => bekijkOrigineel(concept.bestandPad!) : undefined}
          onChange={(data) => setConcept((huidig) => (huidig ? { ...huidig, data } : huidig))}
          status={conceptStatus}
          statusInfo={statusInfo}
          waarschuwing={terugvalWaarschuwing}
          alleenLezen={conceptStatus === "betaald"}
          historie={
            conceptFactuur ? (
              <HistorieTijdlijn
                factuurId={conceptFactuur.id}
                weergave={weergave}
                // opnieuw laden na elke wijziging (status, signalen, inhoud)
                versie={`${conceptFactuur.status}|${conceptFactuur.signalen.filter((s) => s.opgelost).length}|${JSON.stringify(alleenFactuurData(conceptFactuur))}`}
              />
            ) : undefined
          }
          onOpslaan={slaConceptOp}
          onAnnuleren={annuleerConcept}
          opslaan={opslaan}
        >
          <CoderingVeld
            codering={concept.codering}
            rekeningen={rekeningen}
            disabled={conceptStatus === "betaald"}
            onChange={(codering) => setConcept((huidig) => (huidig ? { ...huidig, codering } : huidig))}
          />
          <SignalenBlok
            signalen={conceptFactuur?.signalen ?? []}
            voorspeld={voorspeldeSignalen}
            leverancier={concept.data.leverancier}
            naamVan={naamVan}
            onOplossen={losSignaalOpEnVernieuw}
          />
        </FactuurFormulier>
      )}

      {lokaleFacturen.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>
            Er staan nog {lokaleFacturen.length} factu{lokaleFacturen.length === 1 ? "ur" : "ren"} alleen lokaal in deze
            browser. Importeer ze naar {lidmaatschap.naam} zodat ze overal beschikbaar zijn.
          </span>
          <button
            type="button"
            onClick={importeerLokaal}
            disabled={importeren}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {importeren ? "Importeren…" : "Lokale facturen importeren"}
          </button>
        </div>
      )}

      {laadFout && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{laadFout}</span>
          <button
            type="button"
            onClick={() => {
              setLaden(true);
              void vernieuw();
            }}
            className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Opnieuw proberen
          </button>
        </div>
      )}

      <FacturenTabel
        facturen={facturen}
        context={context}
        onActie={voerActieUit}
        onKoppelingOpnieuw={probeerKoppelingOpnieuw}
        bezigId={bezigId}
        laden={laden}
        exporteren={exporteren}
        onBewerken={bewerkRij}
        onVerwijderen={verwijderRij}
        onBekijken={bekijkOrigineel}
        onExporteren={exporteerCsv}
      />
    </>
  );
}
