import { vertaalFout } from "./facturenApi";
import { slaKoppelingConfigOp } from "./koppelingenApi";
import { leesBetaalRekening, type Betaalbatch, type BetaalRekening } from "./betalingen";
import { supabase } from "./supabase";

function getal(w: unknown): number {
  return typeof w === "number" ? w : Number(w);
}

export async function haalBatchesOp(organisatieId: string, aantal = 30): Promise<Betaalbatch[]> {
  const { data, error } = await supabase
    .from("betaalbatches")
    .select("*, posten:betaalbatch_posten!betaalbatch_posten_batch_id_fkey (id, factuur_id, volgnummer, end_to_end_id, bedrag, naam, iban, omschrijving, status, reden)")
    .eq("organisatie_id", organisatieId)
    .order("aangemaakt_op", { ascending: false })
    .limit(aantal);
  if (error) throw vertaalFout(error);
  return (data as unknown as Betaalbatch[]).map((b) => ({
    ...b,
    totaal: getal(b.totaal),
    posten: [...b.posten].sort((x, y) => x.volgnummer - y.volgnummer).map((p) => ({ ...p, bedrag: getal(p.bedrag) })),
  }));
}

export async function haalBetaalRekeningOp(organisatieId: string): Promise<BetaalRekening> {
  const { data, error } = await supabase
    .from("koppeling_instellingen")
    .select("config")
    .eq("organisatie_id", organisatieId)
    .eq("koppeling", "betaling")
    .maybeSingle();
  if (error) throw vertaalFout(error);
  return leesBetaalRekening(data?.config);
}

export function slaBetaalRekeningOp(organisatieId: string, r: BetaalRekening): Promise<void> {
  return slaKoppelingConfigOp(organisatieId, "betaling", {
    naam: r.naam.trim(),
    iban: r.iban.replace(/\s/g, "").toUpperCase(),
    bic: r.bic.trim().toUpperCase(),
  });
}

async function rpc<T>(functie: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(functie, args);
  if (error) throw vertaalFout(error);
  return data as T;
}

export const maakBetaalbatch = (organisatieId: string, factuurIds: string[], uitvoerdatum: string) =>
  rpc<string>("maak_betaalbatch", { p_organisatie_id: organisatieId, p_factuur_ids: factuurIds, p_uitvoerdatum: uitvoerdatum });
export const logDownload = (batchId: string) => rpc<void>("log_betaalbestand_download", { p_batch_id: batchId });
export const markeerIngediend = (batchId: string) => rpc<void>("markeer_batch_ingediend", { p_batch_id: batchId });
export const bevestigBatch = (batchId: string) => rpc<number>("bevestig_betaalbatch", { p_batch_id: batchId });
export const annuleerBatch = (batchId: string, reden: string) => rpc<number>("annuleer_betaalbatch", { p_batch_id: batchId, p_reden: reden });
