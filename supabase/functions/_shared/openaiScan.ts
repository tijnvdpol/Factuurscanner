// Een factuurbestand laten scannen door OpenAI (ChatGPT API, Responses API met Structured Outputs), met
// automatische modelkeuze en fallback. Gedeeld door scan-factuur (upload in de app) en verwerk-taken
// (bijlagen uit de mailbox), zodat beide exact dezelfde pipeline gebruiken.
//
// Het model wordt automatisch gekozen: de functie probeert de modellen op volgorde en schakelt door bij een
// model dat niet bereikbaar is (bestaat niet/geen toegang, limiet bereikt, overbelast, time-out).
// Optioneel secret OPENAI_MODELLEN (kommagescheiden voorkeursvolgorde).

import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import {
  type AiCodering,
  type FactuurData,
  maakPrompt,
  maakResponseSchema,
  normaliseerCodering,
  normaliseerFactuur,
  type Rekening,
} from "./scanSchema.ts";

const OPENAI_API = "https://api.openai.com/v1";
// Standaardvolgorde (alle drie ondersteunen afbeeldingen, PDF en gestructureerde uitvoer).
const STANDAARD_MODELLEN = ["gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"];
const MAX_MODELLEN = 4;
const CACHE_MS = 60 * 60 * 1000;
// Niets dat het verzoek kan manipuleren; alleen gebruikelijke modelnamen.
const MODEL_PATROON = /^[a-z0-9][a-z0-9._:-]*$/i;
const MAX_POGING_MS = 90_000;
const MIN_POGING_MS = 10_000;

const MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
};
// OpenAI accepteert deze afbeeldingsformaten (HEIC/HEIF dus niet).
const AFBEELDING_OK = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function mimeTypeVoor(pad: string, blobType: string): string {
  if (blobType && blobType !== "application/octet-stream") return blobType;
  const extensie = pad.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[extensie] ?? "application/octet-stream";
}

const overslaanTot = new Map<string, number>(); // model -> tijdstip; voor modellen die "niet beschikbaar" gaven

/** Volgorde van te proberen modellen: OPENAI_MODELLEN, of de standaardlijst. */
function modelVolgorde(): string[] {
  const eigen = (Deno.env.get("OPENAI_MODELLEN") ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => MODEL_PATROON.test(m));
  const kandidaten = eigen.length > 0 ? eigen : STANDAARD_MODELLEN;
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
  | { ok: false; status: number; melding: string; code?: string; volgendeProberen: boolean };

/** Eén scanpoging met één model. volgendeProberen = true als een ander model het wél kan lukken. */
async function scanMetModel(model: string, openaiKey: string, body: Record<string, unknown>, timeoutMs: number): Promise<Poging> {
  let response: Response;
  try {
    response = await fetch(`${OPENAI_API}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({ ...body, model }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timeout = err instanceof DOMException && err.name === "TimeoutError";
    return {
      ok: false,
      status: timeout ? 504 : 502,
      melding: timeout ? "OpenAI reageerde niet op tijd." : "Kon geen verbinding maken met de OpenAI API.",
      volgendeProberen: true,
    };
  }

  if (!response.ok) {
    let melding = `OpenAI API-fout (${response.status}).`;
    let code: string | undefined;
    try {
      const data = await response.json();
      if (data?.error?.message) melding = data.error.message;
      if (typeof data?.error?.code === "string") code = data.error.code;
    } catch {
      // negeren, gebruik generieke melding
    }
    // 404: model bestaat niet of geen toegang; 408/429: time-out of limiet; 5xx: storing/overbelast;
    // 400 alleen als het aan het model ligt (niet-ondersteunde functie). Andere fouten (bijv. ongeldige
    // sleutel of onleesbaar bestand) gelden voor elk model. Geen tegoed (insufficient_quota) geldt voor alle.
    const geenTegoed = code === "insufficient_quota";
    const volgendeProberen = !geenTegoed && (
      response.status === 404 || response.status === 408 || response.status === 429 || response.status >= 500 ||
      (response.status === 400 && /model|unsupported/i.test(melding))
    );
    return { ok: false, status: response.status, melding, code, volgendeProberen };
  }

  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, status: 502, melding: "Onleesbaar antwoord van OpenAI.", volgendeProberen: true };
  }

  const items: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }> = data?.output ?? [];
  const delen = items.filter((i) => i.type === "message").flatMap((i) => i.content ?? []);
  const tekst = delen.find((d) => d.type === "output_text" && typeof d.text === "string")?.text;
  if (!tekst) {
    const weigering = delen.find((d) => d.type === "refusal")?.refusal;
    const reden = weigering ?? data?.incomplete_details?.reason;
    return {
      ok: false,
      status: 502,
      melding: reden ? `Geen resultaat ontvangen van OpenAI (reden: ${reden}).` : "Geen resultaat ontvangen van OpenAI.",
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
      melding: "Antwoord van OpenAI kon niet worden gelezen als JSON.",
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
export async function scanMetOpenAI(opties: {
  bytes: Uint8Array;
  mimeType: string;
  rekeningen: Rekening[];
  openaiKey: string;
  start: number;
  tijdbudgetMs: number;
}): Promise<ScanUitkomst> {
  const { rekeningen, openaiKey, start, tijdbudgetMs, mimeType } = opties;

  const isPdf = mimeType === "application/pdf";
  if (!isPdf && !AFBEELDING_OK.has(mimeType)) {
    const heic = /^image\/hei[cf]$/.test(mimeType);
    return {
      ok: false,
      status: 415,
      melding: heic
        ? "HEIC-foto's worden niet ondersteund door de scanservice. Zet de foto om naar JPG of PNG en probeer opnieuw."
        : "Dit bestandstype kan niet worden gescand. Gebruik een PDF, JPG, PNG of WEBP.",
    };
  }

  const dataUrl = `data:${mimeType};base64,${encodeBase64(opties.bytes)}`;
  const bestand = isPdf
    ? { type: "input_file", filename: "factuur.pdf", file_data: dataUrl }
    : { type: "input_image", image_url: dataUrl, detail: "high" };
  const body = {
    input: [{ role: "user", content: [{ type: "input_text", text: maakPrompt(rekeningen) }, bestand] }],
    text: { format: { type: "json_schema", name: "factuur", strict: true, schema: maakResponseSchema(rekeningen) } },
    store: false,
  };

  const mislukt: Array<Extract<Poging, { ok: false }> & { model: string }> = [];
  for (const model of modelVolgorde()) {
    const resterend = tijdbudgetMs - (Date.now() - start);
    if (resterend < MIN_POGING_MS) break;

    const poging = await scanMetModel(model, openaiKey, body, Math.min(MAX_POGING_MS, resterend));
    if (poging.ok) {
      if (mislukt.length > 0) console.warn(`Uitgeweken naar ${model} na ${mislukt.length} mislukte poging(en).`);
      return { ok: true, factuur: poging.factuur, model, codering: normaliseerCodering(poging.ruw, rekeningen) };
    }

    console.error(`OpenAI-fout bij ${model}`, poging.status, poging.melding);
    mislukt.push({ ...poging, model });
    if (poging.status === 404) overslaanTot.set(model, Date.now() + CACHE_MS);

    if (poging.code === "insufficient_quota") {
      return { ok: false, status: 402, melding: "Het OpenAI-tegoed van de scanservice is op. Vul het tegoed aan en probeer opnieuw." };
    }
    if (!poging.volgendeProberen) {
      if (poging.status === 401 || poging.status === 403) {
        return { ok: false, status: 500, melding: "De OpenAI API-sleutel van de scanservice is ongeldig of heeft geen toegang." };
      }
      return { ok: false, status: 502, melding: poging.melding };
    }
  }

  if (mislukt.length > 0 && mislukt.every((p) => p.status === 429)) {
    return { ok: false, status: 429, melding: "Alle OpenAI-modellen hebben hun limiet bereikt. Wacht even en probeer het opnieuw." };
  }
  const redenen = mislukt.map((p) => `${p.model}: ${korteReden(p)}`).join("; ") || "tijdslimiet bereikt";
  return {
    ok: false,
    status: 502,
    melding: `Geen enkel OpenAI-model kon de factuur verwerken (${redenen}). Probeer het later opnieuw.`,
  };
}
