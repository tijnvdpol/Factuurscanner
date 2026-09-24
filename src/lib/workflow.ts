// Statusregels als pure functies: welke actieknoppen een gebruiker ziet en waarom een actie
// geblokkeerd is. De database (public.wijzig_status) handhaaft dezelfde regels; dit is alleen de UI.

import type { Factuur, FactuurStatus, Rol } from "../types";
import { formatBedrag } from "./getallen";

export type Actie = "controleren" | "goedkeuren" | "betalen" | "afkeuren" | "heropenen";

interface ActieRegel {
  van: FactuurStatus[];
  naar: FactuurStatus;
  label: string;
  rollen: Rol[];
  /** Vraagt om een verplichte reden (afkeuren). */
  vraagtReden: boolean;
}

export const ACTIES: Record<Actie, ActieRegel> = {
  controleren: { van: ["gescand"], naar: "gecontroleerd", label: "Controleren", rollen: ["invoerder", "controller", "beheerder"], vraagtReden: false },
  goedkeuren: { van: ["gecontroleerd"], naar: "goedgekeurd", label: "Goedkeuren", rollen: ["goedkeurder", "controller", "beheerder"], vraagtReden: false },
  betalen: { van: ["goedgekeurd"], naar: "betaald", label: "Betaald", rollen: ["controller", "beheerder"], vraagtReden: false },
  afkeuren: { van: ["gescand", "gecontroleerd"], naar: "afgekeurd", label: "Afkeuren", rollen: ["goedkeurder", "controller", "beheerder"], vraagtReden: true },
  heropenen: { van: ["afgekeurd"], naar: "gescand", label: "Terug naar gescand", rollen: ["invoerder", "controller", "beheerder"], vraagtReden: false },
};

export const FUNCTIESCHEIDING_MELDING = "Functiescheiding niet mogelijk: organisatie heeft één lid";

export interface WorkflowContext {
  userId: string;
  rol: Rol;
  /** null = onbeperkt */
  goedkeuringslimiet: number | null;
  aantalLeden: number;
}

export interface MogelijkeActie {
  actie: Actie;
  label: string;
  naar: FactuurStatus;
  vraagtReden: boolean;
  /** null = uitvoerbaar; anders de reden waarom de actie geblokkeerd is. */
  geblokkeerd: string | null;
}

type WorkflowFactuur = Pick<Factuur, "status" | "totaal_incl" | "valuta" | "euro" | "signalen" | "codering" | "workflow">;

/** Bedrag in euro dat telt voor de goedkeuringslimiet; null = (nog) onbekend. Zelfde regel als intern.bedrag_in_euro. */
export function bedragInEuro(factuur: Pick<Factuur, "totaal_incl" | "valuta" | "euro">): number | null {
  const valuta = (factuur.valuta ?? "EUR").trim().toUpperCase();
  return valuta === "EUR" ? factuur.totaal_incl : factuur.euro.bedrag;
}

export function euro(bedrag: number): string {
  return `€ ${formatBedrag(bedrag, Number.isInteger(bedrag) ? 0 : 2)}`;
}

/** Waarom mag deze gebruiker de factuur niet goedkeuren? null = mag wel. */
export function goedkeurBlokkade(factuur: WorkflowFactuur, ctx: WorkflowContext): string | null {
  const enigLid = ctx.aantalLeden === 1;
  if (!enigLid && factuur.workflow.ingevoerd_door === ctx.userId) {
    return "Functiescheiding: je hebt deze factuur zelf ingevoerd";
  }
  if (!enigLid && factuur.workflow.gecontroleerd_door === ctx.userId) {
    return "Functiescheiding: je hebt deze factuur zelf gecontroleerd";
  }
  if (ctx.goedkeuringslimiet !== null) {
    if (factuur.totaal_incl === null) return "Totaalbedrag ontbreekt";
    const inEuro = bedragInEuro(factuur);
    if (inEuro === null) return "Wisselkoers nog niet bekend (wordt opgehaald)";
    if (inEuro > ctx.goedkeuringslimiet) {
      return `Boven je goedkeuringslimiet van ${euro(ctx.goedkeuringslimiet)}`;
    }
  }
  if (factuur.signalen.some((s) => s.ernst === "kritiek" && !s.opgelost)) {
    return "Er is nog een open kritiek signaal";
  }
  if (!factuur.codering.grootboekrekening_id) return "Kies eerst een grootboekrekening";
  return null;
}

/**
 * Acties die de gebruiker bij deze factuur ziet: alleen overgangen vanuit de huidige status die de
 * rol mag uitvoeren (in een organisatie met één lid: alle). Geblokkeerde acties hebben een reden.
 */
export function mogelijkeActies(factuur: WorkflowFactuur, ctx: WorkflowContext): MogelijkeActie[] {
  const enigLid = ctx.aantalLeden === 1;
  return (Object.keys(ACTIES) as Actie[])
    .filter((actie) => ACTIES[actie].van.includes(factuur.status))
    .filter((actie) => enigLid || ACTIES[actie].rollen.includes(ctx.rol))
    .map((actie) => {
      const regel = ACTIES[actie];
      return {
        actie,
        label: regel.label,
        naar: regel.naar,
        vraagtReden: regel.vraagtReden,
        geblokkeerd: actie === "goedkeuren" ? goedkeurBlokkade(factuur, ctx) : null,
      };
    });
}

/** Mag de gebruiker de factuur verwijderen? (beheerder altijd; anders eigen factuur in gescand/afgekeurd) */
export function magVerwijderen(factuur: Pick<Factuur, "status" | "workflow">, ctx: WorkflowContext): boolean {
  if (ctx.rol === "beheerder") return true;
  return factuur.workflow.ingevoerd_door === ctx.userId && (factuur.status === "gescand" || factuur.status === "afgekeurd");
}

/** Leidt een inhoudelijke wijziging tot terugval naar "gescand"? (zelfde velden als de databasetrigger) */
export function valtTerugNaGewijzigd(
  status: FactuurStatus,
  oud: Pick<Factuur, "leverancier" | "valuta" | "bedrag_excl" | "totaal_incl" | "iban" | "btw_regels">,
  nieuw: Pick<Factuur, "leverancier" | "valuta" | "bedrag_excl" | "totaal_incl" | "iban" | "btw_regels">,
): boolean {
  if (status !== "gecontroleerd" && status !== "goedgekeurd") return false;
  const norm = (s: string | null) => (s ?? "").replace(/\s/g, "").toUpperCase();
  return (
    (oud.leverancier ?? "").trim() !== (nieuw.leverancier ?? "").trim() ||
    norm(oud.valuta) !== norm(nieuw.valuta) ||
    oud.bedrag_excl !== nieuw.bedrag_excl ||
    oud.totaal_incl !== nieuw.totaal_incl ||
    norm(oud.iban) !== norm(nieuw.iban) ||
    JSON.stringify(oud.btw_regels) !== JSON.stringify(nieuw.btw_regels)
  );
}

export type Filter = "te_controleren" | "te_keuren" | "te_betalen" | "afgekeurd" | "alles";

export const FILTERS: { sleutel: Filter; label: string; status: FactuurStatus | null }[] = [
  { sleutel: "te_controleren", label: "Te controleren", status: "gescand" },
  { sleutel: "te_keuren", label: "Te keuren", status: "gecontroleerd" },
  { sleutel: "te_betalen", label: "Te betalen", status: "goedgekeurd" },
  { sleutel: "afgekeurd", label: "Afgekeurd", status: "afgekeurd" },
  { sleutel: "alles", label: "Alles", status: null },
];

export function filterFacturen<T extends Pick<Factuur, "status">>(facturen: T[], filter: Filter): T[] {
  const status = FILTERS.find((f) => f.sleutel === filter)?.status ?? null;
  return status === null ? facturen : facturen.filter((f) => f.status === status);
}
