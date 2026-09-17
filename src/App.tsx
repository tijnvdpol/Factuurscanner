import { useEffect, useMemo, useState } from "react";
import UploadZone from "./components/UploadZone";
import FactuurFormulier from "./components/FactuurFormulier";
import FacturenTabel from "./components/FacturenTabel";
import InstellingenModal from "./components/InstellingenModal";
import { GeminiError, scanFactuur } from "./lib/gemini";
import { valideerFactuur } from "./lib/validatie";
import type { Factuur, FactuurData } from "./types";

const OPSLAG_FACTUREN = "factuurscanner_facturen";
const OPSLAG_API_KEY = "factuurscanner_api_key";
const OPSLAG_MODEL = "factuurscanner_model";
const STANDAARD_MODEL = "gemini-3.6-flash";

function laadFacturen(): Factuur[] {
  try {
    const ruw = localStorage.getItem(OPSLAG_FACTUREN);
    return ruw ? (JSON.parse(ruw) as Factuur[]) : [];
  } catch {
    return [];
  }
}

interface Concept {
  sleutel: string;
  bewerkId: string | null;
  bestandsnaam: string;
  data: FactuurData;
}

export default function App() {
  const [facturen, setFacturen] = useState<Factuur[]>(laadFacturen);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(OPSLAG_API_KEY) ?? "");
  const [model, setModel] = useState(() => localStorage.getItem(OPSLAG_MODEL) ?? STANDAARD_MODEL);
  const [toonInstellingen, setToonInstellingen] = useState(false);
  const [bezig, setBezig] = useState(false);
  const [foutmelding, setFoutmelding] = useState<string | null>(null);
  const [concept, setConcept] = useState<Concept | null>(null);

  useEffect(() => {
    localStorage.setItem(OPSLAG_FACTUREN, JSON.stringify(facturen));
  }, [facturen]);

  useEffect(() => {
    localStorage.setItem(OPSLAG_API_KEY, apiKey);
  }, [apiKey]);

  useEffect(() => {
    localStorage.setItem(OPSLAG_MODEL, model);
  }, [model]);

  const conceptFouten = useMemo(() => (concept ? valideerFactuur(concept.data) : {}), [concept]);

  const verwerkBestand = async (bestand: File) => {
    setFoutmelding(null);
    if (!apiKey) {
      setToonInstellingen(true);
      setFoutmelding("Stel eerst je Gemini API-sleutel in via Instellingen.");
      return;
    }
    setBezig(true);
    try {
      const data = await scanFactuur(bestand, apiKey, model);
      setConcept({ sleutel: crypto.randomUUID(), bewerkId: null, bestandsnaam: bestand.name, data });
    } catch (err) {
      setFoutmelding(err instanceof GeminiError ? err.message : "Onbekende fout tijdens het scannen.");
    } finally {
      setBezig(false);
    }
  };

  const bewerkRij = (id: string) => {
    const factuur = facturen.find((f) => f.id === id);
    if (!factuur) return;
    const { id: _id, bestandsnaam, aangemaaktOp: _a, ...data } = factuur;
    setConcept({ sleutel: id, bewerkId: id, bestandsnaam, data });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const verwijderRij = (id: string) => {
    setFacturen((huidig) => huidig.filter((f) => f.id !== id));
  };

  const slaConceptOp = () => {
    if (!concept) return;
    if (concept.bewerkId) {
      setFacturen((huidig) =>
        huidig.map((f) => (f.id === concept.bewerkId ? { ...f, ...concept.data } : f)),
      );
    } else {
      const nieuw: Factuur = {
        ...concept.data,
        id: crypto.randomUUID(),
        bestandsnaam: concept.bestandsnaam,
        aangemaaktOp: new Date().toISOString(),
      };
      setFacturen((huidig) => [...huidig, nieuw]);
    }
    setConcept(null);
  };

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Factuurscanner</h1>
            <p className="text-xs text-slate-400">Scan, controleer en exporteer facturen</p>
          </div>
          <button
            type="button"
            onClick={() => setToonInstellingen(true)}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Instellingen
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        <UploadZone onFile={verwerkBestand} bezig={bezig} />

        {foutmelding && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {foutmelding}
          </div>
        )}

        {concept && (
          <FactuurFormulier
            key={concept.sleutel}
            factuur={concept.data}
            fouten={conceptFouten}
            bewerken={concept.bewerkId !== null}
            bestandsnaam={concept.bestandsnaam}
            onChange={(data) => setConcept((huidig) => (huidig ? { ...huidig, data } : huidig))}
            onOpslaan={slaConceptOp}
            onAnnuleren={() => setConcept(null)}
          />
        )}

        <FacturenTabel facturen={facturen} onBewerken={bewerkRij} onVerwijderen={verwijderRij} />
      </main>

      {toonInstellingen && (
        <InstellingenModal
          apiKey={apiKey}
          model={model}
          onSluiten={() => setToonInstellingen(false)}
          onOpslaan={(nieuweKey, nieuwModel) => {
            setApiKey(nieuweKey);
            setModel(nieuwModel);
            setToonInstellingen(false);
          }}
        />
      )}
    </div>
  );
}
