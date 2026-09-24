// Betaalopdrachten in de frontend: batches, de betaalbare facturen (zelfde regels als intern.betaal_blokkade) en het
// SEPA-bestand (dezelfde generator als de worker gebruikt).

import { naarSepaBatch, type BatchRij } from "../../supabase/functions/_shared/koppelingen/bank.ts";
import { isGeldigeBic, maakPain001 } from "../../supabase/functions/_shared/koppelingen/sepa.ts";
import type { Factuur } from "../types";
import { controleerIban } from "./veldvalidatie";

export type BatchStatus = "aangemaakt" | "ingediend" | "verwerkt" | "geannuleerd";
export type PostStatus = "open" | "betaald" | "geweigerd" | "geannuleerd";

export interface Betaalpost {
  id: string;
  factuur_id: string | null;
  volgnummer: number;
  end_to_end_id: string;
  bedrag: number;
  naam: string;
  iban: string;
  omschrijving: string;
  status: PostStatus;
  reden: string | null;
}

export interface Betaalbatch {
  id: string;
  organisatie_id: string;
  nummer: string;
  status: BatchStatus;
  uitvoerdatum: string;
  debiteur_naam: string;
  debiteur_iban: string;
  debiteur_bic: string | null;
  aantal: number;
  totaal: number;
  modus: "live" | "mock" | null;
  bank_referentie: string | null;
  aangemaakt_door: string | null;
  aangemaakt_op: string;
  ingediend_op: string | null;
  verwerkt_op: string | null;
  geannuleerd_op: string | null;
  toelichting: string | null;
  posten: Betaalpost[];
}

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  aangemaakt: "Klaar voor de bank",
  ingediend: "Bij de bank",
  verwerkt: "Verwerkt",
  geannuleerd: "Geannuleerd",
};

export const POST_STATUS_LABELS: Record<PostStatus, string> = {
  open: "Open",
  betaald: "Betaald",
  geweigerd: "Geweigerd",
  geannuleerd: "Geannuleerd",
};

/** Zelfde lijst als intern.is_sepa_land. */
export const SEPA_LANDEN = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV",
  "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK", "IS", "LI", "NO", "CH", "GB", "MC", "SM", "AD", "VA", "GI", "JE",
  "GG", "IM",
]);

/** Waarom een factuur niet in een betaalbatch kan, of null (voorproef; de database beslist). */
export function betaalBlokkade(f: Pick<Factuur, "status" | "valuta" | "totaal_incl" | "iban" | "leverancier" | "signalen">): string | null {
  if (f.status === "in_betaalbatch") return "Zit al in een betaalbatch.";
  if (f.status !== "goedgekeurd") return "Alleen goedgekeurde facturen.";
  if ((f.valuta ?? "EUR") !== "EUR") return `SEPA kan alleen in euro (${f.valuta}).`;
  if (f.totaal_incl === null || f.totaal_incl <= 0) return "Het bedrag ontbreekt of is niet positief.";
  if (f.totaal_incl > 999_999_999.99) return "Het bedrag is te hoog.";
  if (!f.iban?.trim()) return "Het IBAN ontbreekt.";
  const ibanFout = controleerIban(f.iban);
  if (ibanFout) return ibanFout;
  if (!SEPA_LANDEN.has(f.iban.replace(/\s/g, "").slice(0, 2).toUpperCase())) return "Het IBAN ligt buiten het SEPA-gebied.";
  if (!f.leverancier?.trim()) return "De naam van de leverancier ontbreekt.";
  if (f.signalen.some((s) => s.ernst === "kritiek" && !s.opgelost)) return "Er is een open kritiek signaal (bijv. een afwijkend IBAN).";
  return null;
}

export interface BetaalRekening {
  naam: string;
  iban: string;
  bic: string;
}

export function leesBetaalRekening(config: Record<string, unknown> | null | undefined): BetaalRekening {
  const tekst = (w: unknown) => (typeof w === "string" ? w : "");
  return { naam: tekst(config?.naam), iban: tekst(config?.iban), bic: tekst(config?.bic) };
}

/** Fout in de rekeninggegevens (zelfde eisen als maak_betaalbatch), of null. */
export function controleerBetaalRekening(r: BetaalRekening): string | null {
  if (!r.naam.trim()) return "Vul de naam van de rekeninghouder in.";
  if (!r.iban.trim()) return "Vul het IBAN in.";
  const fout = controleerIban(r.iban);
  if (fout) return fout;
  if (r.bic.trim() && !isGeldigeBic(r.bic)) return "Ongeldige BIC (8 of 11 tekens, bijv. RABONL2U).";
  return null;
}

/** Eerstvolgende werkdag na vandaag (JJJJ-MM-DD): standaard uitvoerdatum. */
export function volgendeWerkdag(vandaag: Date): string {
  const d = new Date(Date.UTC(vandaag.getFullYear(), vandaag.getMonth(), vandaag.getDate()));
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/** Het pain.001.001.03-bestand van een batch. */
export function sepaBestand(batch: Betaalbatch): string {
  return maakPain001(naarSepaBatch(batch as unknown as BatchRij));
}
