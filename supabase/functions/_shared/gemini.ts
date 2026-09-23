// Gemini-prompt, responsschema en normalisatie van het antwoord (overgenomen uit de frontend).
// Houd FactuurData gelijk aan src/types.ts. Dit bestand heeft geen imports, zodat de frontend-tests
// (Vitest) het ook kunnen testen.

export interface BtwRegel {
  tarief: number | null;
  grondslag: number | null;
  btw_bedrag: number | null;
}

export interface FactuurData {
  leverancier: string | null;
  factuurnummer: string | null;
  factuurdatum: string | null;
  vervaldatum: string | null;
  bedrag_excl: number | null;
  btw_regels: BtwRegel[];
  totaal_incl: number | null;
  valuta: string | null;
  iban: string | null;
  btw_nummer: string | null;
  kvk_nummer: string | null;
}

/** Een actieve grootboekrekening waaruit Gemini een keuze mag maken. */
export interface Rekening {
  id: string;
  code: string;
  omschrijving: string;
}

/** Het AI-coderingsvoorstel: id van de gekozen rekening en de zekerheid (0–1). */
export interface AiCodering {
  grootboekrekening_id: string;
  zekerheid: number;
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    leverancier: { type: "STRING", nullable: true, description: "Naam van de leverancier/verkoper." },
    factuurnummer: { type: "STRING", nullable: true },
    factuurdatum: { type: "STRING", nullable: true, description: "Datum in formaat YYYY-MM-DD." },
    vervaldatum: {
      type: "STRING",
      nullable: true,
      description: "Uiterste betaaldatum in formaat YYYY-MM-DD, alleen als die als datum op de factuur staat.",
    },
    bedrag_excl: { type: "NUMBER", nullable: true, description: "Totaalbedrag exclusief BTW." },
    btw_regels: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          tarief: { type: "NUMBER", nullable: true, description: "BTW-tarief in procenten, bijv. 21." },
          grondslag: { type: "NUMBER", nullable: true, description: "Grondslag voor dit tarief." },
          btw_bedrag: { type: "NUMBER", nullable: true, description: "BTW-bedrag voor dit tarief." },
        },
        required: ["tarief", "grondslag", "btw_bedrag"],
      },
    },
    totaal_incl: { type: "NUMBER", nullable: true, description: "Totaalbedrag inclusief BTW." },
    valuta: { type: "STRING", nullable: true, description: "ISO valutacode, bijv. EUR." },
    iban: { type: "STRING", nullable: true, description: "IBAN van de leverancier waarop betaald moet worden." },
    btw_nummer: {
      type: "STRING",
      nullable: true,
      description: "BTW-identificatienummer van de leverancier, bijv. NL123456789B01.",
    },
    kvk_nummer: { type: "STRING", nullable: true, description: "KvK-nummer van de leverancier (8 cijfers)." },
  },
  required: [
    "leverancier",
    "factuurnummer",
    "factuurdatum",
    "vervaldatum",
    "bedrag_excl",
    "btw_regels",
    "totaal_incl",
    "valuta",
    "iban",
    "btw_nummer",
    "kvk_nummer",
  ],
} as const;

/** Responsschema; met rekeningen erbij ook een gekozen grootboekrekening en zekerheid. */
export function maakResponseSchema(rekeningen: Rekening[]) {
  if (rekeningen.length === 0) return RESPONSE_SCHEMA;
  return {
    ...RESPONSE_SCHEMA,
    properties: {
      ...RESPONSE_SCHEMA.properties,
      grootboek_code: {
        type: "STRING",
        nullable: true,
        description: "Code van de best passende grootboekrekening uit de lijst in de instructies, of null.",
      },
      grootboek_zekerheid: {
        type: "NUMBER",
        nullable: true,
        description: "Hoe zeker je bent van de gekozen grootboekrekening, van 0 (gok) tot 1 (zeker).",
      },
    },
    required: [...RESPONSE_SCHEMA.required, "grootboek_code", "grootboek_zekerheid"],
  };
}

const BASIS_PROMPT = `Je bent een assistent die factuurgegevens extraheert uit een afbeelding of PDF van een factuur.

Geef uitsluitend de gevraagde velden terug volgens het schema.
Regels:
- Als een veld onleesbaar, onduidelijk of niet aanwezig is: geef null terug. Gok NOOIT een waarde.
- factuurdatum en vervaldatum altijd in formaat YYYY-MM-DD (converteer vanuit het formaat op de factuur).
- vervaldatum alleen invullen als er een concrete uiterste betaaldatum op de factuur staat; bij alleen een betaaltermijn (bijv. "binnen 30 dagen") geef je null.
- Bedragen als getal met een punt als decimaalteken (geen duizendtal-scheiding, geen valutasymbool).
- btw_regels bevat één item per BTW-tarief dat op de factuur voorkomt, met de grondslag en het BTW-bedrag voor dat tarief.
- Als er geen aparte BTW-specificatie op de factuur staat, geef een lege array terug voor btw_regels.
- iban, btw_nummer en kvk_nummer zijn die van de LEVERANCIER (de verkoper die de factuur stuurt), nooit die van de klant/afnemer.`;

/** Tekens die de prompt kunnen verstoren uit door de gebruiker ingevoerde omschrijvingen halen. */
function veiligeTekst(tekst: string): string {
  return tekst.replace(/[\r\n`]/g, " ").slice(0, 100);
}

/** Prompt; met rekeningen erbij ook de opdracht om een grootboekrekening te kiezen. */
export function maakPrompt(rekeningen: Rekening[]): string {
  if (rekeningen.length === 0) return BASIS_PROMPT;
  const lijst = rekeningen.map((r) => `- ${veiligeTekst(r.code)}: ${veiligeTekst(r.omschrijving)}`).join("\n");
  return `${BASIS_PROMPT}

Kies daarnaast de grootboekrekening (kostensoort) die het best past bij wat er op deze factuur is gekocht.
Kies uitsluitend een code uit deze lijst:
${lijst}
- grootboek_code: de code uit de lijst, of null als geen enkele rekening past.
- grootboek_zekerheid: 0 tot 1. Gebruik een lage waarde als de factuur meerdere soorten kosten bevat of onduidelijk is.`;
}

/** Zet de gekozen code om naar een rekening uit de lijst; onbekende codes worden genegeerd. */
export function normaliseerCodering(geparsed: unknown, rekeningen: Rekening[]): AiCodering | null {
  const r = (geparsed ?? {}) as Record<string, unknown>;
  const code = typeof r.grootboek_code === "string" ? r.grootboek_code.trim() : "";
  const rekening = rekeningen.find((x) => x.code === code);
  if (!rekening) return null;
  const zekerheid = typeof r.grootboek_zekerheid === "number" && Number.isFinite(r.grootboek_zekerheid)
    ? Math.min(1, Math.max(0, Math.round(r.grootboek_zekerheid * 100) / 100))
    : 0;
  return { grootboekrekening_id: rekening.id, zekerheid };
}

function tekstOfNull(waarde: unknown): string | null {
  return typeof waarde === "string" && waarde.trim() !== "" ? waarde.trim() : null;
}

function getalOfNull(waarde: unknown): number | null {
  return typeof waarde === "number" && Number.isFinite(waarde) ? waarde : null;
}

/** Zet het (ongetypeerde) Gemini-antwoord om naar FactuurData; ontbrekende of verkeerde velden worden null. */
export function normaliseerFactuur(geparsed: unknown): FactuurData {
  const r = (geparsed ?? {}) as Record<string, unknown>;
  return {
    leverancier: tekstOfNull(r.leverancier),
    factuurnummer: tekstOfNull(r.factuurnummer),
    factuurdatum: tekstOfNull(r.factuurdatum),
    vervaldatum: tekstOfNull(r.vervaldatum),
    bedrag_excl: getalOfNull(r.bedrag_excl),
    btw_regels: Array.isArray(r.btw_regels)
      ? r.btw_regels.map((regel) => {
          const x = (regel ?? {}) as Record<string, unknown>;
          return {
            tarief: getalOfNull(x.tarief),
            grondslag: getalOfNull(x.grondslag),
            btw_bedrag: getalOfNull(x.btw_bedrag),
          };
        })
      : [],
    totaal_incl: getalOfNull(r.totaal_incl),
    valuta: tekstOfNull(r.valuta),
    iban: tekstOfNull(r.iban),
    btw_nummer: tekstOfNull(r.btw_nummer),
    kvk_nummer: tekstOfNull(r.kvk_nummer),
  };
}
