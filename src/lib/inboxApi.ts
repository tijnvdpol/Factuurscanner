import { vertaalFout } from "./facturenApi";
import type { InboxAfzender, InboxBericht } from "./inbox";
import { koppelingActie } from "./koppelingenApi";
import { supabase } from "./supabase";

export async function haalInboxOp(organisatieId: string, alleenTeBeoordelen: boolean, aantal = 50): Promise<InboxBericht[]> {
  let query = supabase
    .from("inbox_berichten")
    .select(`
      id, van, van_naam, aan, onderwerp, tekst, spf, dkim, spam, bekende_afzender, status, bron, afgerond, ontvangen_op,
      beoordeeld_door, beoordeeld_op, toelichting,
      bijlagen:inbox_bijlagen!inbox_bijlagen_bericht_id_fkey ( id, volgnummer, bestandsnaam, mime_type, grootte, pad, status, reden, factuur_id )
    `)
    .eq("organisatie_id", organisatieId);
  if (alleenTeBeoordelen) query = query.eq("status", "te_beoordelen");
  const { data, error } = await query.order("ontvangen_op", { ascending: false }).limit(aantal);
  if (error) throw vertaalFout(error);
  return (data as unknown as InboxBericht[]).map((b) => ({ ...b, bijlagen: [...b.bijlagen].sort((x, y) => x.volgnummer - y.volgnummer) }));
}

export async function haalOntvangstadresOp(organisatieId: string): Promise<string | null> {
  const { data, error } = await supabase.from("inbox_adressen").select("adres").eq("organisatie_id", organisatieId).maybeSingle();
  if (error) throw vertaalFout(error);
  return data?.adres ?? null;
}

export async function stelOntvangstadresIn(organisatieId: string, adres: string): Promise<void> {
  const { error } = await supabase.rpc("stel_inbox_adres_in", { p_organisatie_id: organisatieId, p_adres: adres });
  if (error) throw vertaalFout(error);
}

export async function haalAfzendersOp(organisatieId: string): Promise<InboxAfzender[]> {
  const { data, error } = await supabase
    .from("inbox_afzenders")
    .select("id, patroon, omschrijving, created_at")
    .eq("organisatie_id", organisatieId)
    .order("patroon");
  if (error) throw vertaalFout(error);
  return data as InboxAfzender[];
}

export async function voegAfzenderToe(organisatieId: string, patroon: string, omschrijving: string | null): Promise<void> {
  const { error } = await supabase.rpc("voeg_inbox_afzender_toe", {
    p_organisatie_id: organisatieId,
    p_patroon: patroon,
    p_omschrijving: omschrijving,
  });
  if (error) throw vertaalFout(error);
}

export async function verwijderAfzender(id: string): Promise<void> {
  const { error } = await supabase.rpc("verwijder_inbox_afzender", { p_id: id });
  if (error) throw vertaalFout(error);
}

export async function beoordeelBericht(
  berichtId: string,
  actie: "verwerken" | "weigeren",
  vertrouwAfzender: boolean,
  toelichting: string | null,
): Promise<number> {
  const { data, error } = await supabase.rpc("beoordeel_inbox_bericht", {
    p_bericht_id: berichtId,
    p_actie: actie,
    p_vertrouw_afzender: vertrouwAfzender,
    p_toelichting: toelichting,
  });
  if (error) throw vertaalFout(error);
  return data as number;
}

/** Een mislukte bijlage opnieuw laten verwerken. */
export async function probeerBijlageOpnieuw(bijlageId: string): Promise<void> {
  const { data: taakId, error } = await supabase.rpc("taak_van_inbox_bijlage", { p_bijlage_id: bijlageId });
  if (error) throw vertaalFout(error);
  if (!taakId) throw new Error("Er is geen taak voor deze bijlage gevonden.");
  const { error: opnieuwFout } = await supabase.rpc("probeer_taak_opnieuw", { p_taak_id: taakId });
  if (opnieuwFout) throw vertaalFout(opnieuwFout);
}

/** Mock-modus: een testmail (bekende of onbekende afzender) door de echte verwerking sturen. */
export async function simuleerTestmail(organisatieId: string, soort: "bekend" | "onbekend"): Promise<string> {
  return (await koppelingActie<{ melding: string }>("simuleer_mail", organisatieId, { soort })).melding;
}
