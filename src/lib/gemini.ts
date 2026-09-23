import { FunctionsFetchError, FunctionsHttpError } from "@supabase/supabase-js";
import type { FactuurData } from "../types";
import type { AiVoorstel } from "./codering";
import { supabase } from "./supabase";

// De Gemini-aanroep (prompt, schema, API-sleutel en modelkeuze met automatische fallback) draait
// server-side in de Edge Function supabase/functions/scan-factuur. Hier alleen de aanroep vanuit de frontend.

export class GeminiError extends Error {}

interface ScanAntwoord {
  factuur: FactuurData;
  model: string;
  /** Door de AI gekozen grootboekrekening (alleen als de functie rekeningen kon ophalen). */
  codering?: AiVoorstel | null;
}

async function foutmeldingUit(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response;
    try {
      const body = await response.json();
      if (typeof body?.error === "string") return body.error;
    } catch {
      // geen JSON, gebruik generieke melding
    }
    if (response.status === 404) return "De scanfunctie is niet gevonden. Is de Edge Function gedeployed?";
    return `De scanservice gaf een fout (${response.status}).`;
  }
  if (error instanceof FunctionsFetchError) {
    // Ook een niet-gedeployde functie komt hier uit: de 404 van de gateway faalt op CORS.
    return "Kon de scanservice niet bereiken. Controleer je internetverbinding en of de Edge Function 'scan-factuur' is gedeployed.";
  }
  return "Onbekende fout tijdens het scannen.";
}

/** Laat de Edge Function het (al geüploade) bestand scannen en geeft de herkende velden + gebruikte model terug. */
export async function scanFactuur(bestandPad: string, organisatieId: string): Promise<ScanAntwoord> {
  const { data, error } = await supabase.functions.invoke<ScanAntwoord>("scan-factuur", {
    body: { bestand_pad: bestandPad, organisatie_id: organisatieId },
  });
  if (error || !data) {
    throw new GeminiError(await foutmeldingUit(error));
  }
  return data;
}
