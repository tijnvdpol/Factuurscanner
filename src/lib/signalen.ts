// Signaalregels als pure functies. De database (intern.bepaal_signalen) is leidend en slaat de
// signalen op; deze functies geven in het formulier alvast een voorproefje vóór het opslaan en
// houden de regels testbaar. Houd beide in sync (de databasetests vergelijken ze).

import type { FactuurData, SignaalErnst, SignaalType } from "../types";
import { controleerBtwNummer, controleerIban, controleerKvkNummer, normaliseerIban } from "./veldvalidatie";

export const DUPLICAAT_DAGEN = 30;
export const ROND_BEDRAG_MINIMUM = 1000;
export const LIMIET_MARGE = 0.05;

export interface SignaalVoorstel {
  type: SignaalType;
  ernst: SignaalErnst;
  bericht: string;
}

/** Hoofdletters, zonder spaties, voorloopnullen (per cijferreeks) en streepjes: "F-001" → "F1". */
export function normaliseerFactuurnummer(nummer: string | null): string | null {
  if (nummer === null) return null;
  const genormaliseerd = nummer
    .replace(/\s/g, "")
    .toUpperCase()
    .replace(/(^|[^0-9])0+(?=[0-9])/g, "$1")
    .replace(/-/g, "");
  return genormaliseerd === "" ? null : genormaliseerd;
}

function dagenTussen(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Een bestaande factuur van dezelfde leverancier, om duplicaten tegen te vergelijken. */
export interface VergelijkFactuur {
  id: string;
  leverancier: string | null;
  factuurnummer: string | null;
  factuurdatum: string | null;
  totaal_incl: number | null;
  /** Aanmaakdatum (JJJJ-MM-DD of ISO); gebruikt als de factuurdatum ontbreekt. */
  aangemaaktOp: string;
}

function zelfdeLeverancier(a: string | null, b: string | null): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Mogelijke duplicaten: zelfde leverancier en genormaliseerd factuurnummer, of zelfde totaal binnen 30 dagen. */
export function zoekDuplicaten(
  factuur: Pick<VergelijkFactuur, "leverancier" | "factuurnummer" | "factuurdatum" | "totaal_incl"> & { id?: string },
  anderen: VergelijkFactuur[],
  vandaag = new Date().toISOString().slice(0, 10),
): VergelijkFactuur[] {
  const nummer = normaliseerFactuurnummer(factuur.factuurnummer);
  const datum = factuur.factuurdatum ?? vandaag;
  return anderen.filter((o) => {
    if (o.id === factuur.id || !zelfdeLeverancier(o.leverancier, factuur.leverancier)) return false;
    if (nummer !== null && normaliseerFactuurnummer(o.factuurnummer) === nummer) return true;
    return (
      factuur.totaal_incl !== null &&
      o.totaal_incl === factuur.totaal_incl &&
      dagenTussen(o.factuurdatum ?? o.aangemaaktOp.slice(0, 10), datum) <= DUPLICAAT_DAGEN
    );
  });
}

export function isRondBedrag(totaal: number | null): boolean {
  return totaal !== null && totaal >= ROND_BEDRAG_MINIMUM && totaal % 100 === 0;
}

/** Ligt het bedrag binnen 5% onder (of precies op) een goedkeuringslimiet? Geeft die limiet terug. */
export function netOnderLimiet(totaal: number | null, limieten: (number | null)[]): number | null {
  if (totaal === null) return null;
  const geraakt = limieten
    .filter((l): l is number => l !== null && l > 0)
    .filter((l) => totaal <= l && totaal >= l * (1 - LIMIET_MARGE))
    .sort((a, b) => a - b);
  return geraakt[0] ?? null;
}

export function isIbanAfwijkend(factuurIban: string | null, bekendIban: string | null): boolean {
  if (!factuurIban?.trim() || !bekendIban?.trim()) return false;
  return normaliseerIban(factuurIban) !== normaliseerIban(bekendIban);
}

export interface SignaalContext {
  /** Andere facturen in het overzicht (voor duplicaten en "nieuwe leverancier"). */
  anderen: VergelijkFactuur[];
  /** Het bekende IBAN van de leverancier, of null als de leverancier (nog) geen IBAN heeft. */
  bekendIban: string | null;
  /** Goedkeuringslimieten van de leden (null = onbeperkt). */
  limieten: (number | null)[];
}

/** Voorspelt welke signalen de database bij het opslaan zal geven (zonder de totaalcontrole). */
export function voorspelSignalen(
  factuur: FactuurData & { id?: string },
  context: SignaalContext,
): SignaalVoorstel[] {
  const signalen: SignaalVoorstel[] = [];

  if (factuur.leverancier) {
    const duplicaten = zoekDuplicaten(factuur, context.anderen);
    if (duplicaten.length > 0) {
      const lijst = duplicaten.map((d) => d.factuurnummer ?? "zonder nummer").join(", ");
      signalen.push({
        type: "mogelijk_duplicaat",
        ernst: "waarschuwing",
        bericht: `Mogelijk duplicaat: ${factuur.leverancier} heeft al een factuur met hetzelfde nummer of bedrag (${lijst}).`,
      });
    }

    if (isIbanAfwijkend(factuur.iban, context.bekendIban)) {
      signalen.push({
        type: "iban_afwijkend",
        ernst: "kritiek",
        bericht: `Het IBAN op de factuur wijkt af van het bekende IBAN van ${factuur.leverancier} (${context.bekendIban}).`,
      });
    }

    const eerdere = context.anderen.some(
      (o) => o.id !== factuur.id && zelfdeLeverancier(o.leverancier, factuur.leverancier),
    );
    if (!eerdere) {
      signalen.push({
        type: "nieuwe_leverancier",
        ernst: "info",
        bericht: `Eerste factuur van ${factuur.leverancier}. Controleer of deze leverancier bekend en betrouwbaar is.`,
      });
    }
  }

  if (isRondBedrag(factuur.totaal_incl)) {
    signalen.push({
      type: "rond_bedrag",
      ernst: "info",
      bericht: "Het totaalbedrag is een rond bedrag. Controleer of er een onderbouwing (specificatie) bij de factuur zit.",
    });
  }

  // Bij vreemde valuta is het bedrag in euro pas na het ophalen van de koers bekend (database).
  const inEuro = (factuur.valuta ?? "EUR").trim().toUpperCase() === "EUR";
  const limiet = inEuro ? netOnderLimiet(factuur.totaal_incl, context.limieten) : null;
  if (limiet !== null) {
    signalen.push({
      type: "net_onder_limiet",
      ernst: "waarschuwing",
      bericht: `Het bedrag ligt net onder een goedkeuringslimiet van € ${limiet.toLocaleString("nl-NL")}.`,
    });
  }

  for (const fout of [
    controleerIban(factuur.iban),
    controleerBtwNummer(factuur.btw_nummer),
    controleerKvkNummer(factuur.kvk_nummer),
  ]) {
    if (fout) signalen.push({ type: "validatiefout", ernst: "waarschuwing", bericht: fout });
  }

  return signalen;
}

export const ERNST_VOLGORDE: Record<SignaalErnst, number> = { kritiek: 0, waarschuwing: 1, info: 2 };

export const ERNST_LABELS: Record<SignaalErnst, string> = {
  kritiek: "Kritiek",
  waarschuwing: "Waarschuwing",
  info: "Info",
};

export const SIGNAAL_LABELS: Record<SignaalType, string> = {
  mogelijk_duplicaat: "Mogelijk duplicaat",
  iban_afwijkend: "IBAN afwijkend",
  nieuwe_leverancier: "Nieuwe leverancier",
  rond_bedrag: "Rond bedrag",
  net_onder_limiet: "Net onder limiet",
  validatiefout: "Validatiefout",
  btw_vies_ongeldig: "Btw-nummer ongeldig (VIES)",
  kvk_afwijking: "Afwijking KvK",
};

/** Aantal open signalen per ernst, voor de badges in de lijst. */
export function telOpenSignalen(signalen: { ernst: SignaalErnst; opgelost: boolean }[]): Record<SignaalErnst, number> {
  const telling: Record<SignaalErnst, number> = { kritiek: 0, waarschuwing: 0, info: 0 };
  for (const s of signalen) if (!s.opgelost) telling[s.ernst]++;
  return telling;
}
