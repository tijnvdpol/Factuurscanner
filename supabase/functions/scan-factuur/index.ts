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
// De Gemini-aanroep (modelkeuze met automatische fallback) staat in _shared/geminiScan.ts, zodat de
// mailbox-import (verwerk-taken) exact dezelfde pipeline gebruikt.
//
// Secrets: GEMINI_API_KEY (zelf instellen), optioneel GEMINI_MODELLEN (kommagescheiden voorkeursvolgorde).
// SUPABASE_URL en SUPABASE_ANON_KEY zet Supabase automatisch.

import { createClient } from "npm:@supabase/supabase-js@2";
import type { Rekening } from "../_shared/gemini.ts";
import { mimeTypeVoor, scanMetGemini } from "../_shared/geminiScan.ts";

const BUCKET = "facturen";
const MAX_BYTES = 15 * 1024 * 1024;
// Edge Functions hebben een maximale looptijd; binnen dit budget blijven voor alle pogingen samen.
const TIJDBUDGET_MS = 130_000;

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

  // 4. Gemini aanroepen; bij een onbereikbaar model automatisch het volgende proberen
  const uitkomst = await scanMetGemini({
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType: mimeTypeVoor(pad, blob.type),
    rekeningen,
    geminiKey,
    start,
    tijdbudgetMs: TIJDBUDGET_MS,
  });
  if (!uitkomst.ok) return fout(uitkomst.status, uitkomst.melding);
  return json(200, { factuur: uitkomst.factuur, model: uitkomst.model, codering: uitkomst.codering });
});
