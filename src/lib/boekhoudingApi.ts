import { vertaalFout } from "./facturenApi";
import { koppelingActie, slaKoppelingConfigOp } from "./koppelingenApi";
import type { BoekhoudConfig, BoekhoudMapping, ExternItem, MappingSoort, Pakket } from "./boekhouding";
import type { Modus } from "./koppelingen";
import { supabase } from "./supabase";

export interface BoekhoudOpties {
  pakket: Pakket;
  naam: string;
  modus: Modus;
  grootboekrekeningen: ExternItem[];
  btw_codes: ExternItem[];
}

/** Grootboekrekeningen en btw-codes uit het pakket (ook een verbindingstest). */
export function haalBoekhoudOptiesOp(organisatieId: string): Promise<BoekhoudOpties> {
  return koppelingActie<BoekhoudOpties>("boekhouding_opties", organisatieId);
}

export async function haalMappingsOp(organisatieId: string, provider: Pakket): Promise<BoekhoudMapping[]> {
  const { data, error } = await supabase
    .from("boekhoud_mappings")
    .select("id, provider, soort, intern, extern_id, extern_naam, automatisch")
    .eq("organisatie_id", organisatieId)
    .eq("provider", provider);
  if (error) throw vertaalFout(error);
  return data as BoekhoudMapping[];
}

/** Mapping instellen; externId leeg = verwijderen. */
export async function slaMappingOp(
  organisatieId: string,
  provider: Pakket,
  soort: MappingSoort,
  intern: string,
  externId: string,
  externNaam: string | null,
): Promise<void> {
  const { error } = await supabase.rpc("stel_boekhoud_mapping_in", {
    p_organisatie_id: organisatieId,
    p_provider: provider,
    p_soort: soort,
    p_intern: intern,
    p_extern_id: externId,
    p_extern_naam: externNaam,
  });
  if (error) throw vertaalFout(error);
}

export function slaBoekhoudConfigOp(organisatieId: string, config: BoekhoudConfig): Promise<void> {
  return slaKoppelingConfigOp(organisatieId, "boekhouding", { ...config });
}

/** Aantal goedgekeurde (of betaalde) facturen dat nog niet is geëxporteerd. */
export async function telTeExporteren(organisatieId: string): Promise<number> {
  const { count, error } = await supabase
    .from("facturen")
    .select("id", { count: "exact", head: true })
    .eq("organisatie_id", organisatieId)
    .in("status", ["goedgekeurd", "betaald"])
    .is("geexporteerd_op", null);
  if (error) throw vertaalFout(error);
  return count ?? 0;
}

/** Plant de export van alle (of de opgegeven) goedgekeurde, nog niet geëxporteerde facturen. */
export async function planExports(organisatieId: string, factuurIds: string[] | null = null): Promise<number> {
  const { data, error } = await supabase.rpc("plan_exports", { p_organisatie_id: organisatieId, p_factuur_ids: factuurIds });
  if (error) throw vertaalFout(error);
  return data as number;
}

export async function haalLeveranciersOp(organisatieId: string): Promise<{ id: string; naam: string }[]> {
  const { data, error } = await supabase.from("leveranciers").select("id, naam").eq("organisatie_id", organisatieId).order("naam");
  if (error) throw vertaalFout(error);
  return data as { id: string; naam: string }[];
}
