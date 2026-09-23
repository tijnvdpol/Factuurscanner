// Edge Function scan-factuur: leest een factuurbestand uit Storage en laat Gemini de velden herkennen.
//
// POST { bestand_pad: string, organisatie_id?: string }
//   bestand_pad = {organisatie_id}/{factuur_id}/{bestand} (of het oude {user_id}/…); toegang bepalen de
//   Storage-policies. organisatie_id bepaalt uit welke grootboekrekeningen de AI kiest (standaard: de
//   eerste map van het pad).
//   200 { factuur: FactuurData, model: string, codering: AiCodering | null }
//       model = het model dat de scan heeft gedaan; codering = door de AI gekozen grootboekrekening
//       uit de actieve rekeningen van de gebruiker (met zekerheid 0–1), of null.
//   4xx/5xx { error: string }  (Nederlandse foutmelding voor de gebruiker)
//
// Het model wordt automatisch gekozen: de functie vraagt bij Google op welke modellen beschikbaar zijn,
// probeert ze op volgorde en schakelt door bij een model dat niet bereikbaar is (bestaat niet/ingetrokken,
// limiet bereikt, overbelast, time-out).
//
// Secrets: GEMINI_API_KEY (zelf instellen), optioneel GEMINI_MODELLEN (kommagescheiden voorkeursvolgorde).
// SUPABASE_URL en SUPABASE_ANON_KEY zet Supabase automatisch.

import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import {
  type FactuurData,
  maakPrompt,
  maakResponseSchema,
  normaliseerCodering,
  normaliseerFactuur,
  type Rekening,
} from "../_shared/gemini.ts";

const BUCKET = "facturen";
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
const MAX_BYTES = 15 * 1024 * 1024;
// Edge Functions hebben een maximale looptijd; binnen dit budget blijven voor alle pogingen samen.
const TIJDBUDGET_MS = 130_000;
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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function fout(status: number, melding: string): Response {
  return json(status, { error: melding });
}

function mimeTypeVoor(pad: string, blobType: string): string {
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

Deno.serve(async (req) => {
  const start = Date.now();
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return fout(405, "Methode niet toegestaan.");

  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? req.headers.get("apikey");
  if (!geminiKey || !supabaseUrl || !anonKey) {
    console.error("Configuratie ontbreekt", {
      GEMINI_API_KEY: !!geminiKey,
      SUPABASE_URL: !!supabaseUrl,
      SUPABASE_ANON_KEY: !!anonKey,
    });
    return fout(500, "De scanservice is niet goed geconfigureerd (ontbreekt de GEMINI_API_KEY?).");
  }

  // 1. JWT van de gebruiker controleren (via de Auth-server; werkt met oude én nieuwe JWT-sleutels)
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return fout(401, "Niet ingelogd.");

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: gebruikerData, error: authFout } = await supabase.auth.getUser(token);
  const gebruiker = gebruikerData?.user;
  if (authFout || !gebruiker) return fout(401, "Je sessie is verlopen. Log opnieuw in.");

  // 2. Invoer controleren
  let invoer: { bestand_pad?: unknown; organisatie_id?: unknown };
  try {
    invoer = await req.json();
  } catch {
    return fout(400, "Ongeldige aanvraag.");
  }

  const pad = invoer.bestand_pad;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const eersteMap = typeof pad === "string" ? pad.split("/")[0] : "";
  if (typeof pad !== "string" || !UUID.test(eersteMap) || pad.includes("..")) {
    return fout(403, "Geen toegang tot dit bestand.");
  }
  const organisatieId = typeof invoer.organisatie_id === "string" && UUID.test(invoer.organisatie_id)
    ? invoer.organisatie_id
    : eersteMap;

  // 3. Bestand ophalen met de rechten van de gebruiker (Storage-policies blijven gelden)
  const { data: blob, error: downloadFout } = await supabase.storage.from(BUCKET).download(pad);
  if (downloadFout || !blob) return fout(404, "Het bestand is niet gevonden in de opslag.");
  if (blob.size > MAX_BYTES) {
    return fout(413, "Bestand is groter dan 15 MB. Comprimeer het bestand en probeer opnieuw.");
  }

  // Actieve grootboekrekeningen van de organisatie (RLS: alleen als de gebruiker lid is).
  // Lukt dit niet, dan scannen we zonder voorstel.
  const { data: rekeningData, error: rekeningFout } = await supabase
    .from("grootboekrekeningen")
    .select("id, code, omschrijving")
    .eq("organisatie_id", organisatieId)
    .eq("actief", true)
    .order("code");
  if (rekeningFout) console.warn("Grootboekrekeningen ophalen mislukt:", rekeningFout.message);
  const rekeningen: Rekening[] = rekeningData ?? [];

  const base64 = encodeBase64(new Uint8Array(await blob.arrayBuffer()));
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: maakPrompt(rekeningen) }, { inline_data: { mime_type: mimeTypeVoor(pad, blob.type), data: base64 } }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: maakResponseSchema(rekeningen),
      temperature: 0,
    },
  };

  // 4. Gemini aanroepen; bij een onbereikbaar model automatisch het volgende proberen
  const mislukt: Array<Extract<Poging, { ok: false }> & { model: string }> = [];
  for (const model of await modelVolgorde(geminiKey)) {
    const resterend = TIJDBUDGET_MS - (Date.now() - start);
    if (resterend < MIN_POGING_MS) break;

    const poging = await scanMetModel(model, geminiKey, body, Math.min(MAX_POGING_MS, resterend));
    if (poging.ok) {
      if (mislukt.length > 0) console.warn(`Uitgeweken naar ${model} na ${mislukt.length} mislukte poging(en).`);
      return json(200, { factuur: poging.factuur, model, codering: normaliseerCodering(poging.ruw, rekeningen) });
    }

    console.error(`Gemini-fout bij ${model}`, poging.status, poging.melding);
    mislukt.push({ ...poging, model });
    if (poging.status === 404) overslaanTot.set(model, Date.now() + CACHE_MS);

    if (!poging.volgendeProberen) {
      if (poging.status === 401 || poging.status === 403 || /api key/i.test(poging.melding)) {
        return fout(500, "De Gemini API-sleutel van de scanservice is ongeldig of heeft geen toegang.");
      }
      return fout(502, poging.melding);
    }
  }

  if (mislukt.length > 0 && mislukt.every((p) => p.status === 429)) {
    return fout(429, "Alle Gemini-modellen hebben hun limiet bereikt. Wacht even en probeer het opnieuw.");
  }
  const redenen = mislukt.map((p) => `${p.model}: ${korteReden(p)}`).join("; ") || "tijdslimiet bereikt";
  return fout(502, `Geen enkel Gemini-model kon de factuur verwerken (${redenen}). Probeer het later opnieuw.`);
});
