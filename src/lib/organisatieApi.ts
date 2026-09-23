import type { Lidmaatschap, OrgGebruiker, Rol } from "../types";
import { vertaalFout } from "./facturenApi";
import { supabase } from "./supabase";

interface LidmaatschapRij {
  organisatie_id: string;
  rol: Rol;
  goedkeuringslimiet: number | string | null;
  organisatie: { naam: string } | null;
}

/** Organisaties waarvan de gebruiker lid is (oudste lidmaatschap eerst). */
export async function haalLidmaatschappenOp(userId: string): Promise<Lidmaatschap[]> {
  const { data, error } = await supabase
    .from("organisatie_leden")
    .select("organisatie_id, rol, goedkeuringslimiet, created_at, organisatie:organisaties ( naam )")
    .eq("user_id", userId)
    .order("created_at");
  if (error) throw vertaalFout(error);
  return (data as unknown as LidmaatschapRij[]).map((r) => ({
    organisatie_id: r.organisatie_id,
    naam: r.organisatie?.naam ?? "Organisatie",
    rol: r.rol,
    goedkeuringslimiet: r.goedkeuringslimiet === null ? null : Number(r.goedkeuringslimiet),
  }));
}

/** Vangnet: maakt een persoonlijke organisatie aan als de gebruiker er nog geen heeft. */
export async function zorgVoorOrganisatie(): Promise<void> {
  const { error } = await supabase.rpc("zorg_voor_organisatie");
  if (error) throw vertaalFout(error);
}

export async function haalOrgGebruikersOp(organisatieId: string): Promise<OrgGebruiker[]> {
  const { data, error } = await supabase.rpc("org_gebruikers", { p_organisatie_id: organisatieId });
  if (error) throw vertaalFout(error);
  return (data as (Omit<OrgGebruiker, "goedkeuringslimiet"> & { goedkeuringslimiet: number | string | null })[]).map(
    (g) => ({ ...g, goedkeuringslimiet: g.goedkeuringslimiet === null ? null : Number(g.goedkeuringslimiet) }),
  );
}

export async function voegLidToe(organisatieId: string, email: string, rol: Rol, limiet: number | null): Promise<void> {
  const { error } = await supabase.rpc("voeg_lid_toe", {
    p_organisatie_id: organisatieId,
    p_email: email,
    p_rol: rol,
    p_goedkeuringslimiet: limiet,
  });
  if (error) throw vertaalFout(error);
}

export async function wijzigLid(organisatieId: string, userId: string, rol: Rol, limiet: number | null): Promise<void> {
  const { error } = await supabase.rpc("wijzig_lid", {
    p_organisatie_id: organisatieId,
    p_user_id: userId,
    p_rol: rol,
    p_goedkeuringslimiet: limiet,
  });
  if (error) throw vertaalFout(error);
}

export async function verwijderLid(organisatieId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc("verwijder_lid", { p_organisatie_id: organisatieId, p_user_id: userId });
  if (error) throw vertaalFout(error);
}

export async function hernoemOrganisatie(organisatieId: string, naam: string): Promise<void> {
  const schoon = naam.trim();
  if (!schoon) throw new Error("Vul een naam in.");
  const { error } = await supabase.from("organisaties").update({ naam: schoon }).eq("id", organisatieId);
  if (error) throw vertaalFout(error);
}
