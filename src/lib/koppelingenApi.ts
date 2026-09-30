import { FunctionsFetchError, FunctionsHttpError } from "@supabase/supabase-js";
import { vertaalFout } from "./facturenApi";
import type { Koppeling, KoppelingStatus, KoppelingTaak, KoppelingTaakStatus, Modus } from "./koppelingen";
import { supabase } from "./supabase";

export class KoppelingError extends Error {}

async function functieFout(error: unknown): Promise<KoppelingError> {
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response;
    try {
      const body = await response.json();
      if (typeof body?.error === "string") return new KoppelingError(body.error);
    } catch {
      // geen JSON
    }
    return new KoppelingError(`De koppelingsservice gaf een fout (${response.status}).`);
  }
  if (error instanceof FunctionsFetchError) {
    return new KoppelingError(
      "Kon de koppelingsservice niet bereiken. Is de Edge Function 'koppeling-actie' gedeployed?",
    );
  }
  return new KoppelingError("Onbekende fout bij de koppelingsservice.");
}

export async function koppelingActie<T>(actie: string, organisatieId: string, extra: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("koppeling-actie", {
    body: { actie, organisatie_id: organisatieId, ...extra },
  });
  if (error || !data) throw await functieFout(error);
  return data;
}

/** Modus per koppeling (env gaat voor) en welke secrets voor live ontbreken. */
export async function haalKoppelingOverzichtOp(organisatieId: string): Promise<KoppelingStatus[]> {
  return (await koppelingActie<{ koppelingen: KoppelingStatus[] }>("overzicht", organisatieId)).koppelingen;
}

/** Alleen de instellingen uit de database (terugval als de Edge Function niet bereikbaar is). */
export async function haalKoppelingInstellingenOp(organisatieId: string): Promise<{ koppeling: Koppeling; modus: Modus }[]> {
  const { data, error } = await supabase
    .from("koppeling_instellingen")
    .select("koppeling, modus")
    .eq("organisatie_id", organisatieId);
  if (error) throw vertaalFout(error);
  return data as { koppeling: Koppeling; modus: Modus }[];
}

export async function stelKoppelingIn(organisatieId: string, koppeling: Koppeling, modus: Modus): Promise<void> {
  const { error } = await supabase.rpc("stel_koppeling_in", {
    p_organisatie_id: organisatieId,
    p_koppeling: koppeling,
    p_modus: modus,
    p_config: null,
  });
  if (error) throw vertaalFout(error);
}

/**
 * Slaat de (niet-geheime) config van een koppeling op en laat de modus in de database ongemoeid, ook als een
 * env-variabele hem vastzet (anders zou de vastgezette modus in de database belanden).
 */
export async function slaKoppelingConfigOp(organisatieId: string, koppeling: Koppeling, config: Record<string, unknown>): Promise<void> {
  const { data: huidig, error: leesFout } = await supabase
    .from("koppeling_instellingen")
    .select("modus")
    .eq("organisatie_id", organisatieId)
    .eq("koppeling", koppeling)
    .maybeSingle();
  if (leesFout) throw vertaalFout(leesFout);
  const { error } = await supabase.rpc("stel_koppeling_in", {
    p_organisatie_id: organisatieId,
    p_koppeling: koppeling,
    p_modus: huidig?.modus ?? "mock",
    p_config: config,
  });
  if (error) throw vertaalFout(error);
}

/** Zet een testtaak in de wachtrij en maakt de worker wakker. */
export async function testWachtrij(organisatieId: string): Promise<string> {
  return (await koppelingActie<{ taak_id: string }>("test_wachtrij", organisatieId)).taak_id;
}

export async function haalRecenteTakenOp(organisatieId: string, aantal = 25): Promise<KoppelingTaak[]> {
  const { data, error } = await supabase
    .from("koppeling_taken")
    .select("id, soort, factuur_id, status, pogingen, max_pogingen, volgende_poging_op, laatste_fout, resultaat, created_at, bijgewerkt_op")
    .eq("organisatie_id", organisatieId)
    .order("created_at", { ascending: false })
    .limit(aantal);
  if (error) throw vertaalFout(error);
  return data as KoppelingTaak[];
}

/** Laatste taak per factuur en soort, voor de badges in de factuurlijst. */
export async function haalKoppelingStatusOp(organisatieId: string): Promise<KoppelingTaakStatus[]> {
  const { data, error } = await supabase
    .from("factuur_koppelingstatus")
    .select("factuur_id, soort, taak_id, status, pogingen, max_pogingen, volgende_poging_op, laatste_fout, bijgewerkt_op")
    .eq("organisatie_id", organisatieId);
  if (error) throw vertaalFout(error);
  return data as KoppelingTaakStatus[];
}

export async function probeerTaakOpnieuw(taakId: string): Promise<void> {
  const { error } = await supabase.rpc("probeer_taak_opnieuw", { p_taak_id: taakId });
  if (error) throw vertaalFout(error);
}
