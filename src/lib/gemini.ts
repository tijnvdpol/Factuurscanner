import type { FactuurData } from "../types";

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    leverancier: { type: "STRING", nullable: true, description: "Naam van de leverancier/verkoper." },
    factuurnummer: { type: "STRING", nullable: true },
    factuurdatum: { type: "STRING", nullable: true, description: "Datum in formaat YYYY-MM-DD." },
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
  },
  required: ["leverancier", "factuurnummer", "factuurdatum", "bedrag_excl", "btw_regels", "totaal_incl", "valuta"],
} as const;

const PROMPT = `Je bent een assistent die factuurgegevens extraheert uit een afbeelding of PDF van een factuur.

Geef uitsluitend de gevraagde velden terug volgens het schema.
Regels:
- Als een veld onleesbaar, onduidelijk of niet aanwezig is: geef null terug. Gok NOOIT een waarde.
- factuurdatum altijd in formaat YYYY-MM-DD (converteer vanuit het formaat op de factuur).
- Bedragen als getal met een punt als decimaalteken (geen duizendtal-scheiding, geen valutasymbool).
- btw_regels bevat één item per BTW-tarief dat op de factuur voorkomt, met de grondslag en het BTW-bedrag voor dat tarief.
- Als er geen aparte BTW-specificatie op de factuur staat, geef een lege array terug voor btw_regels.`;

const MAX_BYTES = 15 * 1024 * 1024;

function bestandNaarBase64(bestand: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const resultaat = reader.result as string;
      const komma = resultaat.indexOf(",");
      resolve(komma >= 0 ? resultaat.slice(komma + 1) : resultaat);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Kon bestand niet lezen."));
    reader.readAsDataURL(bestand);
  });
}

export class GeminiError extends Error {}

export async function scanFactuur(
  bestand: File,
  apiKey: string,
  model: string,
): Promise<FactuurData> {
  if (!apiKey) {
    throw new GeminiError("Geen Gemini API-sleutel ingesteld. Voeg deze toe via Instellingen.");
  }
  if (bestand.size > MAX_BYTES) {
    throw new GeminiError("Bestand is groter dan 15 MB. Comprimeer het bestand en probeer opnieuw.");
  }

  const base64 = await bestandNaarBase64(bestand);
  const mimeType = bestand.type || "application/octet-stream";

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: base64 } }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GeminiError("Kon geen verbinding maken met de Gemini API. Controleer je internetverbinding.");
  }

  if (!response.ok) {
    let melding = `Gemini API-fout (${response.status}).`;
    try {
      const data = await response.json();
      if (data?.error?.message) melding = data.error.message;
    } catch {
      // negeren, gebruik generieke melding
    }
    throw new GeminiError(melding);
  }

  const data = await response.json();
  const tekst: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!tekst) {
    const reden = data?.candidates?.[0]?.finishReason;
    throw new GeminiError(
      reden ? `Geen resultaat ontvangen van Gemini (reden: ${reden}).` : "Geen resultaat ontvangen van Gemini.",
    );
  }

  let geparsed: unknown;
  try {
    geparsed = JSON.parse(tekst);
  } catch {
    throw new GeminiError("Antwoord van Gemini kon niet worden gelezen als JSON.");
  }

  const resultaat = geparsed as Partial<FactuurData>;
  return {
    leverancier: resultaat.leverancier ?? null,
    factuurnummer: resultaat.factuurnummer ?? null,
    factuurdatum: resultaat.factuurdatum ?? null,
    bedrag_excl: resultaat.bedrag_excl ?? null,
    btw_regels: Array.isArray(resultaat.btw_regels)
      ? resultaat.btw_regels.map((r) => ({
          tarief: r?.tarief ?? null,
          grondslag: r?.grondslag ?? null,
          btw_bedrag: r?.btw_bedrag ?? null,
        }))
      : [],
    totaal_incl: resultaat.totaal_incl ?? null,
    valuta: resultaat.valuta ?? null,
  };
}
