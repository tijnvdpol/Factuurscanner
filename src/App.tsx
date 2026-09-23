import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import UploadZone from "./components/UploadZone";
import FactuurFormulier from "./components/FactuurFormulier";
import FacturenTabel from "./components/FacturenTabel";
import SignalenBlok from "./components/SignalenBlok";
import CoderingVeld from "./components/CoderingVeld";
import GrootboekBeheer from "./components/GrootboekBeheer";
import { voorspelSignalen } from "./lib/signalen";
import { kiesCoderingsvoorstel } from "./lib/codering";
import { haalHistorieVoorstel, haalRekeningenOp } from "./lib/grootboekApi";
import { GeminiError, scanFactuur } from "./lib/gemini";
import { valideerFactuur } from "./lib/validatie";
import { supabase } from "./lib/supabase";
import { OpslagError, openOrigineel, uploadFactuurBestand, verwijderBestand } from "./lib/opslag";
import {
  DbError,
  haalFacturenOp,
  importeerLokaleFacturen,
  losSignaalOp,
  slaFactuurOp,
  verwijderFactuur,
} from "./lib/facturenApi";
import { downloadCsv } from "./lib/csv";
import {
  alleenFactuurData,
  GEEN_CODERING,
  legeFactuurData,
  type Codering,
  type Factuur,
  type FactuurData,
  type FactuurStatus,
  type Grootboekrekening,
} from "./types";

type Pagina = "facturen" | "grootboek";

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
      codering: GEEN_CODERING,
      status: "gecontroleerd",
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
  /** Leveranciersnaam bij het openen; bepaalt of IBAN e.d. van die leverancier overschreven mogen worden. */
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
}

export default function App({ sessie }: Props) {
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
  const [rekeningen, setRekeningen] = useState<Grootboekrekening[]>([]);
  const [pagina, setPagina] = useState<Pagina>("facturen");

  const vernieuwRekeningen = useCallback(async () => {
    setRekeningen(await haalRekeningenOp());
  }, []);

  useEffect(() => {
    haalRekeningenOp()
      .then(setRekeningen)
      .catch((err) => console.warn("Grootboekrekeningen laden mislukt:", err));
  }, []);

  const vernieuw = useCallback(async () => {
    try {
      setFacturen(await haalFacturenOp());
      setLaadFout(null);
    } catch (err) {
      setLaadFout(foutTekst(err, "De facturen konden niet worden geladen."));
    } finally {
      setLaden(false);
    }
  }, []);

  useEffect(() => {
    let actief = true;
    haalFacturenOp()
      .then((lijst) => actief && setFacturen(lijst))
      .catch((err) => actief && setLaadFout(foutTekst(err, "De facturen konden niet worden geladen.")))
      .finally(() => actief && setLaden(false));
    return () => {
      actief = false;
    };
  }, []);

  useEffect(() => {
    VEROUDERDE_OPSLAG.forEach((sleutel) => localStorage.removeItem(sleutel));
  }, []);

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
      { anderen: facturen.filter((f) => f.id !== concept.factuurId), bekendIban, limieten: [] },
    );
  }, [concept, conceptFactuur, facturen]);

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
      pad = await uploadFactuurBestand(sessie.user.id, factuurId, bestand);
      const { factuur: data, model: aiModel, codering: aiVoorstel } = await scanFactuur(pad);
      // Historie gaat vóór AI; lukt het ophalen niet, dan valt het voorstel terug op de AI.
      const historie = data.leverancier ? await haalHistorieVoorstel(data.leverancier).catch(() => null) : null;
      ruimConceptBestandOp(concept);
      setConcept({
        factuurId,
        bewerkId: null,
        bestandsnaam: bestand.name,
        bestandPad: pad,
        aiModel,
        status: "gecontroleerd",
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
      haalHistorieVoorstel(data.leverancier)
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
        data: concept.data,
        status: concept.status,
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
      const actueel = await haalFacturenOp();
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
      const { geimporteerd, duplicaten, mislukt } = await importeerLokaleFacturen(lokaleFacturen, sessie.user.id);
      if (mislukt.length === 0) localStorage.removeItem(LOKALE_FACTUREN);
      else localStorage.setItem(LOKALE_FACTUREN, JSON.stringify(mislukt));
      setLokaleFacturen(mislukt);

      const delen = [`${geimporteerd} factu${geimporteerd === 1 ? "ur" : "ren"} geïmporteerd`];
      if (duplicaten > 0) delen.push(`${duplicaten} overgeslagen omdat ze al bestonden`);
      setMelding(delen.join(", ") + ".");
      if (mislukt.length > 0) {
        setFoutmelding(`${mislukt.length} factu${mislukt.length === 1 ? "ur kon" : "ren konden"} niet worden geïmporteerd. Probeer het opnieuw.`);
      }
      await vernieuw();
    } finally {
      setImporteren(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Factuurscanner</h1>
            <p className="text-xs text-slate-400">Scan, controleer en exporteer facturen</p>
          </div>
          <nav className="flex items-center gap-1">
            {(
              [
                ["facturen", "Facturen"],
                ["grootboek", "Grootboekrekeningen"],
              ] as const
            ).map(([sleutel, label]) => (
              <button
                key={sleutel}
                type="button"
                onClick={() => setPagina(sleutel)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  pagina === sleutel ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <span className="hidden truncate text-xs text-slate-400 sm:inline">{sessie.user.email}</span>
            <button
              type="button"
              onClick={() => supabase.auth.signOut()}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Uitloggen
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        {pagina === "grootboek" && (
          <GrootboekBeheer rekeningen={rekeningen} magBeheren onGewijzigd={vernieuwRekeningen} />
        )}

        {pagina === "facturen" && (
        <>
        <UploadZone onFile={verwerkBestand} bezig={bezig} />

        {foutmelding && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {foutmelding}
          </div>
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
            status={concept.status}
            onStatusChange={(status) => setConcept((huidig) => (huidig ? { ...huidig, status } : huidig))}
            onOpslaan={slaConceptOp}
            onAnnuleren={annuleerConcept}
            opslaan={opslaan}
          >
            <CoderingVeld
              codering={concept.codering}
              rekeningen={rekeningen}
              onChange={(codering) => setConcept((huidig) => (huidig ? { ...huidig, codering } : huidig))}
            />
            <SignalenBlok
              signalen={conceptFactuur?.signalen ?? []}
              voorspeld={voorspeldeSignalen}
              leverancier={concept.data.leverancier}
              onOplossen={losSignaalOpEnVernieuw}
            />
          </FactuurFormulier>
        )}

        {lokaleFacturen.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span>
              Er staan nog {lokaleFacturen.length} factu{lokaleFacturen.length === 1 ? "ur" : "ren"} alleen lokaal in
              deze browser. Importeer ze naar je account zodat ze overal beschikbaar zijn.
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
          laden={laden}
          exporteren={exporteren}
          onBewerken={bewerkRij}
          onVerwijderen={verwijderRij}
          onBekijken={bekijkOrigineel}
          onExporteren={exporteerCsv}
        />
        </>
        )}
      </main>
    </div>
  );
}
