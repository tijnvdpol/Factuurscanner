// Edge Function scan-factuur: leest een factuurbestand uit Storage en laat Gemini de velden herkennen.
//
// POST { bestand_pad: string, model?: string }
//   200 { factuur: FactuurData, model: string }
//   4xx/5xx { error: string }  (Nederlandse foutmelding voor de gebruiker)
//
// Secrets: GEMINI_API_KEY (zelf instellen). SUPABASE_URL en SUPABASE_ANON_KEY zet Supabase automatisch.

import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { normaliseerFactuur, PROMPT, RESPONSE_SCHEMA } from "../_shared/gemini.ts";

const BUCKET = "facturen";
const STANDAARD_MODEL = "gemini-3.6-flash";
// Alleen Gemini-modellen, en niets dat het URL-pad kan manipuleren.
const MODEL_PATROON = /^gemini-[a-z0-9][a-z0-9.-]*$/;
const MAX_BYTES = 15 * 1024 * 1024;

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

Deno.serve(async (req) => {
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
  let invoer: { bestand_pad?: unknown; model?: unknown };
  try {
    invoer = await req.json();
  } catch {
    return fout(400, "Ongeldige aanvraag.");
  }

  const pad = invoer.bestand_pad;
  if (typeof pad !== "string" || !pad.startsWith(`${gebruiker.id}/`) || pad.includes("..")) {
    return fout(403, "Geen toegang tot dit bestand.");
  }

  const model = invoer.model == null || invoer.model === "" ? STANDAARD_MODEL : invoer.model;
  if (typeof model !== "string" || !MODEL_PATROON.test(model)) {
    return fout(400, "Ongeldige modelnaam. Gebruik bijvoorbeeld gemini-3.6-flash.");
  }

  // 3. Bestand ophalen met de rechten van de gebruiker (Storage-policies blijven gelden)
  const { data: blob, error: downloadFout } = await supabase.storage.from(BUCKET).download(pad);
  if (downloadFout || !blob) return fout(404, "Het bestand is niet gevonden in de opslag.");
  if (blob.size > MAX_BYTES) {
    return fout(413, "Bestand is groter dan 15 MB. Comprimeer het bestand en probeer opnieuw.");
  }

  const base64 = encodeBase64(new Uint8Array(await blob.arrayBuffer()));
  const mimeType = mimeTypeVoor(pad, blob.type);

  // 4. Gemini aanroepen
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

  let response: Response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("Gemini niet bereikbaar", err);
    return fout(502, "Kon geen verbinding maken met de Gemini API. Probeer het later opnieuw.");
  }

  if (!response.ok) {
    let melding = `Gemini API-fout (${response.status}).`;
    try {
      const data = await response.json();
      if (data?.error?.message) melding = data.error.message;
    } catch {
      // negeren, gebruik generieke melding
    }
    console.error("Gemini-fout", response.status, melding);
    if (response.status === 404) return fout(400, `Model "${model}" bestaat niet of is niet beschikbaar.`);
    if (response.status === 429) return fout(429, "Gemini-limiet bereikt. Wacht even en probeer het opnieuw.");
    return fout(502, melding);
  }

  const data = await response.json();
  const parts: Array<{ text?: string; thought?: boolean }> = data?.candidates?.[0]?.content?.parts ?? [];
  const tekst = parts.find((p) => typeof p.text === "string" && !p.thought)?.text;
  if (!tekst) {
    const reden = data?.candidates?.[0]?.finishReason;
    return fout(
      502,
      reden ? `Geen resultaat ontvangen van Gemini (reden: ${reden}).` : "Geen resultaat ontvangen van Gemini.",
    );
  }

  let geparsed: unknown;
  try {
    geparsed = JSON.parse(tekst);
  } catch {
    return fout(502, "Antwoord van Gemini kon niet worden gelezen als JSON.");
  }

  return json(200, { factuur: normaliseerFactuur(geparsed), model });
});
