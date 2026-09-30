// Boekhoudpakket in de frontend: pakketten, config en het automatisch voorstellen van mappings.

export {
  PAKKET_NAMEN,
  PAKKETTEN,
  type ExternItem,
  type Pakket,
} from "../../supabase/functions/_shared/koppelingen/boekhouding.ts";
import type { ExternItem, Pakket } from "../../supabase/functions/_shared/koppelingen/boekhouding.ts";

export type MappingSoort = "grootboek" | "btw" | "leverancier";

export interface BoekhoudMapping {
  id: string;
  provider: Pakket;
  soort: MappingSoort;
  intern: string;
  extern_id: string;
  extern_naam: string | null;
  automatisch: boolean;
}

export interface BoekhoudConfig {
  provider: Pakket;
  /** Na goedkeuren automatisch exporteren (standaard aan). */
  automatisch: boolean;
}

/** De btw-tarieven die altijd gekoppeld moeten kunnen worden (Nederland). */
export const STANDAARD_TARIEVEN = ["21", "9", "0"];

export function leesBoekhoudConfig(config: Record<string, unknown> | null | undefined): BoekhoudConfig {
  const provider = config?.provider;
  return {
    provider: provider === "exact" || provider === "snelstart" || provider === "moneybird" ? provider : "moneybird",
    automatisch: config?.automatisch !== false,
  };
}

function normaliseer(naam: string): string {
  return naam.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export interface Voorstel {
  intern: string;
  extern: ExternItem;
}

/**
 * Voorstel voor nog niet gekoppelde grootboekrekeningen: eerst dezelfde code, dan dezelfde naam. Een bestaande
 * mapping wordt nooit overschreven.
 */
export function stelGrootboekVoor(
  intern: { id: string; code: string; omschrijving: string }[],
  extern: ExternItem[],
  bestaand: Pick<BoekhoudMapping, "soort" | "intern">[],
): Voorstel[] {
  const gekoppeld = new Set(bestaand.filter((m) => m.soort === "grootboek").map((m) => m.intern));
  return intern
    .filter((r) => !gekoppeld.has(r.id))
    .flatMap((r) => {
      const treffer = extern.find((e) => e.code !== null && e.code === r.code) ??
        extern.find((e) => normaliseer(e.naam) === normaliseer(r.omschrijving));
      return treffer ? [{ intern: r.id, extern: treffer }] : [];
    });
}

/** Voorstel voor nog niet gekoppelde btw-tarieven: de eerste btw-code met hetzelfde percentage. */
export function stelBtwVoor(
  tarieven: string[],
  extern: ExternItem[],
  bestaand: Pick<BoekhoudMapping, "soort" | "intern">[],
): Voorstel[] {
  const gekoppeld = new Set(bestaand.filter((m) => m.soort === "btw").map((m) => m.intern));
  return tarieven
    .filter((t) => !gekoppeld.has(t))
    .flatMap((t) => {
      const treffer = extern.find((e) => e.percentage !== null && e.percentage !== undefined && Number(e.percentage) === Number(t));
      return treffer ? [{ intern: t, extern: treffer }] : [];
    });
}
