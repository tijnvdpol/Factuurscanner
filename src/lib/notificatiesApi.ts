import { FunctionsHttpError } from "@supabase/supabase-js";
import { vertaalFout } from "./facturenApi";
import { koppelingActie, slaKoppelingConfigOp } from "./koppelingenApi";
import type { EmailConfig, Notificatie, NotificatieInhoud } from "./notificaties";
import { supabase } from "./supabase";

const KOLOMMEN = "id, soort, ontvanger_id, ontvanger_email, factuur_id, status, modus, onderwerp, reden, created_at, verzonden_op";

/** Mails van de organisatie. RLS: je eigen mails, of alle als controller/beheerder. */
export async function haalNotificatiesOp(organisatieId: string, alleenVan: string | null, aantal = 100): Promise<Notificatie[]> {
  let query = supabase.from("notificaties").select(KOLOMMEN).eq("organisatie_id", organisatieId);
  if (alleenVan) query = query.eq("ontvanger_id", alleenVan);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(aantal);
  if (error) throw vertaalFout(error);
  return data as Notificatie[];
}

/** De volledige mock-mail; alleen voor de ontvanger (RLS), anders null. */
export async function haalInhoudOp(notificatieId: string): Promise<NotificatieInhoud | null> {
  const { data, error } = await supabase
    .from("notificatie_inhoud")
    .select("notificatie_id, onderwerp, html, tekst")
    .eq("notificatie_id", notificatieId)
    .maybeSingle();
  if (error) throw vertaalFout(error);
  return data as NotificatieInhoud | null;
}

export async function stuurTestmail(organisatieId: string): Promise<string> {
  return (await koppelingActie<{ melding: string }>("testmail", organisatieId)).melding;
}

export async function slaEmailConfigOp(organisatieId: string, config: EmailConfig): Promise<void> {
  await slaKoppelingConfigOp(organisatieId, "email", { ...config });
}

// ---------------------------------------------------------------------------
// Mail-actie (zonder inloggen: het token is de toegang)
// ---------------------------------------------------------------------------

export interface MailActieFactuur {
  id: string;
  leverancier: string | null;
  factuurnummer: string | null;
  factuurdatum: string | null;
  vervaldatum: string | null;
  valuta: string;
  totaal_incl: number | null;
  bedrag_eur: number | null;
  status: string;
  grootboekrekening: string | null;
  ingevoerd_door: string | null;
  gecontroleerd_door: string | null;
  bron: string;
  signalen: { ernst: "kritiek" | "waarschuwing" | "info"; bericht: string }[];
}

export interface MailActieInfo {
  geldig: boolean;
  melding: string | null;
  /** null = kan; anders de reden waarom niet. */
  mogelijk?: { goedkeuren: string | null; afkeuren: string | null } | null;
  factuur?: MailActieFactuur | null;
  goedkeurder?: string | null;
  organisatie?: string | null;
  verloopt_op?: string;
  gebruikt_op?: string | null;
  gebruikt_actie?: "goedkeuren" | "afkeuren" | null;
}

async function mailActie<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("mail-actie", { body });
  if (error || !data) {
    if (error instanceof FunctionsHttpError) {
      const inhoud = await (error.context as Response).json().catch(() => null);
      if (typeof inhoud?.error === "string") throw new Error(inhoud.error);
    }
    throw new Error("De server is niet bereikbaar. Probeer het later opnieuw of gebruik de app.");
  }
  return data;
}

export function bekijkMailActie(token: string): Promise<MailActieInfo> {
  return mailActie({ actie: "bekijk", token });
}

export function voerMailActieUit(token: string, keuze: "goedkeuren" | "afkeuren", reden: string | null): Promise<{ ok: boolean; melding: string }> {
  return mailActie({ actie: "uitvoeren", token, keuze, reden });
}
