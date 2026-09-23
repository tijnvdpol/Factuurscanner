import type { Grootboekrekening } from "../types";
import type { HistorieVoorstel } from "./codering";
import { DbError, vertaalFout } from "./facturenApi";
import { supabase } from "./supabase";

export async function haalRekeningenOp(): Promise<Grootboekrekening[]> {
  const { data, error } = await supabase
    .from("grootboekrekeningen")
    .select("id, code, omschrijving, actief")
    .order("code");
  if (error) throw vertaalFout(error);
  return data;
}

export interface RekeningInvoer {
  code: string;
  omschrijving: string;
  actief: boolean;
}

function controleer(invoer: RekeningInvoer): RekeningInvoer {
  const code = invoer.code.trim();
  const omschrijving = invoer.omschrijving.trim();
  if (!/^[0-9A-Za-z.-]{1,12}$/.test(code)) {
    throw new DbError("De code mag alleen letters, cijfers, punten en streepjes bevatten (max. 12 tekens).");
  }
  if (!omschrijving) throw new DbError("Vul een omschrijving in.");
  return { code, omschrijving, actief: invoer.actief };
}

function rekeningFout(error: Parameters<typeof vertaalFout>[0]): DbError {
  return error.code === "23505" ? new DbError("Er bestaat al een rekening met deze code.", error.code) : vertaalFout(error);
}

export async function voegRekeningToe(invoer: RekeningInvoer): Promise<void> {
  const { error } = await supabase.from("grootboekrekeningen").insert(controleer(invoer));
  if (error) throw rekeningFout(error);
}

export async function wijzigRekening(id: string, invoer: RekeningInvoer): Promise<void> {
  const { error } = await supabase.from("grootboekrekeningen").update(controleer(invoer)).eq("id", id);
  if (error) throw rekeningFout(error);
}

/** Meest gebruikte handmatig bevestigde rekening voor deze leverancier, of null. */
export async function haalHistorieVoorstel(leverancier: string): Promise<HistorieVoorstel | null> {
  const { data, error } = await supabase.rpc("stel_codering_voor", { p_leverancier: leverancier });
  if (error) throw vertaalFout(error);
  const rij = (data as { grootboekrekening_id: string; zekerheid: number | string }[] | null)?.[0];
  return rij ? { grootboekrekening_id: rij.grootboekrekening_id, zekerheid: Number(rij.zekerheid) } : null;
}
