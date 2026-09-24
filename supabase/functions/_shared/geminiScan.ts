// Een factuurbestand laten scannen door Gemini, met automatische modelkeuze en fallback. Gedeeld door
// scan-factuur (upload in de app) en verwerk-taken (bijlagen uit de mailbox), zodat beide exact dezelfde
// pipeline gebruiken. (Verhuisd uit scan-factuur/index.ts; het gedrag en de meldingen zijn gelijk.)
//
// Het model wordt automatisch gekozen: de functie vraagt bij Google op welke modellen beschikbaar zijn,
// probeert ze op volgorde en schakelt door bij een model dat niet bereikbaar is (bestaat niet/ingetrokken,
// limiet bereikt, overbelast, time-out). Optioneel secret GEMINI_MODELLEN (kommagescheiden voorkeursvolgorde).

import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import {
  type AiCodering,
  type FactuurData,
  maakPrompt,
  maakResponseSchema,
  normaliseerCodering,
  normaliseerFactuur,
  type Rekening,
} from "./gemini.ts";

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
// Voorkeur; daarna volgen automatisch de overige beschikbare stabiele Flash-modellen.
const VOORKEUR_MODELLEN = ["gemini-3.6-flash"];
// Alleen gebruikt als de lijst met beschikbare modellen niet opgevraagd kan worden.
const NOODLIJST = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
const MAX_MODELLEN = 4;
const CACHE_MS = 60 * 60 * 1000;
// Alleen Gemini-modellen, en niets dat het URL-pad kan manipuleren.
const MODEL_PATROON = /^gemini-[a-z0-9][a-z0-9.-]*$/;
// Stabiele (geen preview/experimentele) Flash-modellen, bijv. gemini-3.5-flash of gemini-3.5-flash-lite.
const STABIEL_FLASH = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/;
const MAX_POGING_MS = 60_000;
const MIN_POGING_MS = 10_000;

const MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

export function mimeTypeVoor(pad: string, blobType: string): string {
  if (blobType && blobType !== "application/octet-stream") return blobType;
  const extensie = pad.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[extensie] ?? "application/octet-stream";
}

// Per instantie van de functie gecachet (instanties worden hergebruikt tussen aanroepen).
let beschikbaarCache: { modellen: Set<string>; geldigTot: number } | null = null;
const overslaanTot = new Map<string, number>(); // model -> tijdstip; voor modellen die "niet beschikbaar" gaven

/** Vraagt bij Google op welke modellen generateContent ondersteunen; null als dat niet lukt. */
async function beschikbareModellen(geminiKey: string): Promise<Set<string> | null> {
  if (beschikbaarCache && beschikbaarCache.geldigTot > Date.now()) return beschikbaarCache.modellen;
  try {
    const response = await fetch(`${GEMINI_API}/models?pageSize=1000`, {
      headers: { "x-goog-api-key": geminiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`ListModels ${response.status}`);
    const data = await response.json();
    const modellen = new Set<string>(
      (data?.models ?? [])
        .filter((m: { supportedGenerationMethods?: string[] }) =>
          m.supportedGenerationMethods?.includes("generateContent")
        )
        .map((m: { name?: string }) => String(m.name ?? "").replace(/^models\//, ""))
        .filter((naam: string) => MODEL_PATROON.test(naam)),
    );
    if (modellen.size === 0) throw new Error("ListModels gaf geen bruikbare modellen");
    beschikbaarCache = { modellen, geldigTot: Date.now() + CACHE_MS };
    return modellen;
  } catch (err) {
    console.warn("Beschikbare modellen opvragen mislukt, noodlijst wordt gebruikt:", err);
    return null;
  }
}

/** Sorteert stabiele Flash-modellen: nieuwste versie eerst, lite-varianten na de gewone. */
function sorteerFlash(a: string, b: string): number {
  const [, versieA, liteA] = a.match(STABIEL_FLASH)!;
  const [, versieB, liteB] = b.match(STABIEL_FLASH)!;
  if (!!liteA !== !!liteB) return liteA ? 1 : -1;
  return Number(versieB) - Number(versieA);
}

/** Volgorde van te proberen modellen: voorkeur (of GEMINI_MODELLEN), aangevuld met beschikbare Flash-modellen. */
async function modelVolgorde(geminiKey: string): Promise<string[]> {
  const eigen = (Deno.env.get("GEMINI_MODELLEN") ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => MODEL_PATROON.test(m));
  const voorkeur = eigen.length > 0 ? eigen : VOORKEUR_MODELLEN;

  const beschikbaar = await beschikbareModellen(geminiKey);
  const kandidaten = beschikbaar
    ? [
        ...voorkeur.filter((m) => beschikbaar.has(m)),
        ...[...beschikbaar].filter((m) => STABIEL_FLASH.test(m) && !voorkeur.includes(m)).sort(sorteerFlash),
      ]
    : [...new Set([...voorkeur, ...NOODLIJST])];

  const nu = Date.now();
  const bruikbaar = kandidaten.filter((m) => (overslaanTot.get(m) ?? 0) <= nu);
  // Als alles tijdelijk overgeslagen wordt, toch opnieuw proberen i.p.v. direct op te geven.
  return (bruikbaar.length > 0 ? bruikbaar : kandidaten).slice(0, MAX_MODELLEN);
}

/** Korte Nederlandse reden per mislukte poging, voor de samenvattende foutmelding. */
function korteReden(poging: { status: number; melding: string }): string {
  if (poging.status === 404) return "niet (meer) beschikbaar";
  if (poging.status === 429) return "limiet bereikt";
  if (poging.status === 504 || poging.status === 408) return "reageerde niet op tijd";
  if (poging.status >= 500 && poging.status !== 502) return "overbelast of storing";
  return poging.melding;
}

type Poging =
  | { ok: true; factuur: FactuurData; ruw: unknown }
  | { ok: false; status: number; melding: string; volgendeProberen: boolean };

/** Eén scanpoging met één model. volgendeProberen = true als een ander model het wél kan lukken. */
async function scanMetModel(model: string, geminiKey: string, body: unknown, timeoutMs: number): Promise<Poging> {
  let response: Response;
  try {
    response = await fetch(`${GEMINI_API}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timeout = err instanceof DOMException && err.name === "TimeoutError";
    return {
      ok: false,
      status: timeout ? 504 : 502,
      melding: timeout ? "Gemini reageerde niet op tijd." : "Kon geen verbinding maken met de Gemini API.",
      volgendeProberen: true,
    };
  }

  if (!response.ok) {
    let melding = `Gemini API-fout (${response.status}).`;
    try {
      const data = await response.json();
      if (data?.error?.message) melding = data.error.message;
    } catch {
      // negeren, gebruik generieke melding
    }
    // 404: model bestaat niet (meer); 408/429: time-out of limiet; 5xx: storing/overbelast.
    // Andere fouten (bijv. ongeldige sleutel of onleesbaar bestand) gelden voor elk model.
    const volgendeProberen =
      response.status === 404 || response.status === 408 || response.status === 429 || response.status >= 500;
    return { ok: false, status: response.status, melding, volgendeProberen };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, status: 502, melding: "Onleesbaar antwoord van Gemini.", volgendeProberen: true };
  }

  const parts: Array<{ text?: string; thought?: boolean }> = data?.candidates?.[0]?.content?.parts ?? [];
  const tekst = parts.find((p) => typeof p.text === "string" && !p.thought)?.text;
  if (!tekst) {
    const reden = data?.candidates?.[0]?.finishReason;
    return {
      ok: false,
      status: 502,
      melding: reden ? `Geen resultaat ontvangen van Gemini (reden: ${reden}).` : "Geen resultaat ontvangen van Gemini.",
      volgendeProberen: true,
    };
  }

  try {
    const ruw: unknown = JSON.parse(tekst);
    return { ok: true, factuur: normaliseerFactuur(ruw), ruw };
  } catch {
    return {
      ok: false,
      status: 502,
      melding: "Antwoord van Gemini kon niet worden gelezen als JSON.",
      volgendeProberen: true,
    };
  }
}

export type ScanUitkomst =
  | { ok: true; factuur: FactuurData; model: string; codering: AiCodering | null }
  | { ok: false; status: number; melding: string };

/**
 * Scant het bestand; probeert zo nodig meerdere modellen binnen het tijdbudget (gerekend vanaf `start`).
 * Bij een fout: status en Nederlandse melding (zoals scan-factuur die aan de gebruiker teruggeeft).
 */
export async function scanMetGemini(opties: {
  bytes: Uint8Array;
  mimeType: string;
  rekeningen: Rekening[];
  geminiKey: string;
  start: number;
  tijdbudgetMs: number;
}): Promise<ScanUitkomst> {
  const { rekeningen, geminiKey, start, tijdbudgetMs } = opties;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: maakPrompt(rekeningen) },
          { inline_data: { mime_type: opties.mimeType, data: encodeBase64(opties.bytes) } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: maakResponseSchema(rekeningen),
      temperature: 0,
    },
  };

  const mislukt: Array<Extract<Poging, { ok: false }> & { model: string }> = [];
  for (const model of await modelVolgorde(geminiKey)) {
    const resterend = tijdbudgetMs - (Date.now() - start);
    if (resterend < MIN_POGING_MS) break;

    const poging = await scanMetModel(model, geminiKey, body, Math.min(MAX_POGING_MS, resterend));
    if (poging.ok) {
      if (mislukt.length > 0) console.warn(`Uitgeweken naar ${model} na ${mislukt.length} mislukte poging(en).`);
      return { ok: true, factuur: poging.factuur, model, codering: normaliseerCodering(poging.ruw, rekeningen) };
    }

    console.error(`Gemini-fout bij ${model}`, poging.status, poging.melding);
    mislukt.push({ ...poging, model });
    if (poging.status === 404) overslaanTot.set(model, Date.now() + CACHE_MS);

    if (!poging.volgendeProberen) {
      if (poging.status === 401 || poging.status === 403 || /api key/i.test(poging.melding)) {
        return { ok: false, status: 500, melding: "De Gemini API-sleutel van de scanservice is ongeldig of heeft geen toegang." };
      }
      return { ok: false, status: 502, melding: poging.melding };
    }
  }

  if (mislukt.length > 0 && mislukt.every((p) => p.status === 429)) {
    return { ok: false, status: 429, melding: "Alle Gemini-modellen hebben hun limiet bereikt. Wacht even en probeer het opnieuw." };
  }
  const redenen = mislukt.map((p) => `${p.model}: ${korteReden(p)}`).join("; ") || "tijdslimiet bereikt";
  return {
    ok: false,
    status: 502,
    melding: `Geen enkel Gemini-model kon de factuur verwerken (${redenen}). Probeer het later opnieuw.`,
  };
}
