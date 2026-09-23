import type { Codering, Grootboekrekening } from "../types";

/** Voorstel op basis van eerder handmatig gecodeerde facturen van dezelfde leverancier. */
export interface HistorieVoorstel {
  grootboekrekening_id: string;
  zekerheid: number;
}

/** Voorstel van de AI (Edge Function scan-factuur). */
export interface AiVoorstel {
  grootboekrekening_id: string;
  zekerheid: number;
}

/**
 * Kiest het coderingsvoorstel: historie gaat vóór AI. Een voorstel voor een rekening die niet
 * (meer) actief is, wordt genegeerd.
 */
export function kiesCoderingsvoorstel(
  historie: HistorieVoorstel | null,
  ai: AiVoorstel | null,
  rekeningen: Grootboekrekening[],
): Codering {
  const actief = (id: string) => rekeningen.some((r) => r.id === id && r.actief);
  if (historie && actief(historie.grootboekrekening_id)) {
    return { grootboekrekening_id: historie.grootboekrekening_id, bron: "historie", zekerheid: historie.zekerheid };
  }
  if (ai && actief(ai.grootboekrekening_id)) {
    return { grootboekrekening_id: ai.grootboekrekening_id, bron: "ai", zekerheid: ai.zekerheid };
  }
  return { grootboekrekening_id: null, bron: null, zekerheid: null };
}

/** Handmatige keuze (of bevestiging) door de gebruiker. */
export function handmatigeCodering(grootboekrekeningId: string | null): Codering {
  return grootboekrekeningId
    ? { grootboekrekening_id: grootboekrekeningId, bron: "handmatig", zekerheid: null }
    : { grootboekrekening_id: null, bron: null, zekerheid: null };
}

/** Label bij een (nog niet bevestigd) voorstel, bijv. "Voorgesteld (AI, 82%)"; null als bevestigd of leeg. */
export function voorstelLabel(codering: Codering): string | null {
  if (!codering.grootboekrekening_id || codering.bron === "handmatig" || codering.bron === null) return null;
  const bron = codering.bron === "ai" ? "AI" : "historie";
  const zekerheid = codering.zekerheid !== null ? `, ${Math.round(codering.zekerheid * 100)}%` : "";
  return `Voorgesteld (${bron}${zekerheid})`;
}

export function rekeningNaam(rekening: Pick<Grootboekrekening, "code" | "omschrijving">): string {
  return `${rekening.code} ${rekening.omschrijving}`;
}
