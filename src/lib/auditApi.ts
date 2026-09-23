import type { AuditActie, AuditRegel } from "./audit";
import { vertaalFout } from "./facturenApi";
import { supabase } from "./supabase";

/** Historie van één factuur (factuur, btw-regels en signalen), oudste eerst. */
export async function haalFactuurHistorieOp(factuurId: string): Promise<AuditRegel[]> {
  const { data, error } = await supabase.rpc("factuur_historie", { p_factuur_id: factuurId });
  if (error) throw vertaalFout(error);
  return data as AuditRegel[];
}

export interface AuditFilter {
  /** JJJJ-MM-DD, inclusief */
  van: string;
  /** JJJJ-MM-DD, inclusief */
  tot: string;
  userId: string;
  actie: AuditActie | "";
  tabel: string;
}

export const MAX_AUDIT_REGELS = 1000;

function beginVanDag(datum: string, dagenErbij = 0): string {
  const d = new Date(`${datum}T00:00:00`);
  d.setDate(d.getDate() + dagenErbij);
  return d.toISOString();
}

/** Audit log van de organisatie, nieuwste eerst (maximaal MAX_AUDIT_REGELS regels). */
export async function haalAuditLogOp(organisatieId: string, filter: AuditFilter): Promise<AuditRegel[]> {
  let query = supabase.from("audit_log").select("*").eq("organisatie_id", organisatieId);
  if (filter.van) query = query.gte("created_at", beginVanDag(filter.van));
  if (filter.tot) query = query.lt("created_at", beginVanDag(filter.tot, 1));
  if (filter.userId) query = query.eq("user_id", filter.userId);
  if (filter.actie) query = query.eq("actie", filter.actie);
  if (filter.tabel) query = query.eq("tabel", filter.tabel);
  const { data, error } = await query.order("id", { ascending: false }).limit(MAX_AUDIT_REGELS);
  if (error) throw vertaalFout(error);
  return data as AuditRegel[];
}
