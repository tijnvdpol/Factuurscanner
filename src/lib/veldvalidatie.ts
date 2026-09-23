// Pure validatiefuncties voor losse factuurvelden. Elke controle geeft een Nederlandse foutmelding
// terug, of null als de waarde in orde is. Lege waarden zijn hier altijd in orde ("niet herkend"
// wordt apart getoond); de database gebruikt dezelfde regels voor het signaal "validatiefout".

/** IBAN-lengte per landcode (SWIFT IBAN-register). */
export const IBAN_LENGTES: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28,
  CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18,
  FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HN: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20,
  LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28,
  NL: 18, NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24,
  SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26,
  UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

/** Zelfde normalisatie als de database: spaties weg, hoofdletters. */
export function normaliseerIban(invoer: string): string {
  return invoer.replace(/\s/g, "").toUpperCase();
}

/** Zelfde normalisatie als de database: spaties en punten weg, hoofdletters. */
export function normaliseerBtwNummer(invoer: string): string {
  return invoer.replace(/[\s.]/g, "").toUpperCase();
}

export function normaliseerKvkNummer(invoer: string): string {
  return invoer.replace(/\s/g, "");
}

/** Rest van het IBAN-controlegetal (mod 97); 1 betekent geldig. */
function ibanRest(iban: string): number {
  const herschikt = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const teken of herschikt) {
    const cijfers = /\d/.test(teken) ? teken : String(teken.charCodeAt(0) - 55);
    for (const c of cijfers) rest = (rest * 10 + Number(c)) % 97;
  }
  return rest;
}

export function controleerIban(invoer: string | null): string | null {
  if (!invoer?.trim()) return null;
  const iban = normaliseerIban(invoer);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) {
    return "Ongeldig IBAN: begin met een landcode en 2 cijfers, gevolgd door letters en cijfers.";
  }
  const land = iban.slice(0, 2);
  const lengte = IBAN_LENGTES[land];
  if (lengte === undefined) return `Ongeldig IBAN: onbekende landcode ${land}.`;
  if (iban.length !== lengte) {
    return `Ongeldig IBAN: een IBAN uit ${land} heeft ${lengte} tekens (nu ${iban.length}).`;
  }
  if (ibanRest(iban) !== 1) return "Ongeldig IBAN: het controlegetal klopt niet.";
  return null;
}

export function isGeldigeIban(invoer: string): boolean {
  return controleerIban(invoer) === null;
}

/** NL-btw-nummers: NL + 9 cijfers + B + 2 cijfers. Buitenlandse nummers alleen op globaal formaat. */
export function controleerBtwNummer(invoer: string | null): string | null {
  if (!invoer?.trim()) return null;
  const nummer = normaliseerBtwNummer(invoer);
  if (nummer.startsWith("NL")) {
    return /^NL\d{9}B\d{2}$/.test(nummer)
      ? null
      : "Ongeldig btw-nummer: een Nederlands btw-nummer is NL + 9 cijfers + B + 2 cijfers (bijv. NL123456789B01).";
  }
  return /^[A-Z]{2}[A-Z0-9+*]{2,13}$/.test(nummer)
    ? null
    : "Ongeldig btw-nummer: begin met een landcode van 2 letters, gevolgd door letters en cijfers.";
}

export function controleerKvkNummer(invoer: string | null): string | null {
  if (!invoer?.trim()) return null;
  return /^\d{8}$/.test(normaliseerKvkNummer(invoer)) ? null : "Ongeldig KvK-nummer: dit moet uit 8 cijfers bestaan.";
}

/** Een datum als JJJJ-MM-DD die ook echt bestaat (dus geen 2026-02-30). */
export function isGeldigeDatum(datum: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return false;
  const d = new Date(`${datum}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === datum;
}

/** Vervaldatum moet een geldige datum zijn en mag niet vóór de factuurdatum liggen. */
export function controleerVervaldatum(vervaldatum: string | null, factuurdatum: string | null): string | null {
  if (!vervaldatum) return null;
  if (!isGeldigeDatum(vervaldatum)) return "Ongeldige datum. Gebruik het formaat JJJJ-MM-DD.";
  if (factuurdatum && isGeldigeDatum(factuurdatum) && vervaldatum < factuurdatum) {
    return "Vervaldatum ligt vóór de factuurdatum.";
  }
  return null;
}
