// ECB-referentiekoersen: koers van een valuta op (of vlak vóór) een datum. Geen imports (testbaar met Vitest).
//
// Live: ECB Data Portal, dataset EXR (dagelijks, rond 16:00 CET gepubliceerd, niet in het weekend en op
//   TARGET-feestdagen). GET https://data-api.ecb.europa.eu/service/data/EXR/D.{VALUTA}.EUR.SP00.A
//   ?startPeriod=…&endPeriod=…&format=csvdata   → CSV met o.a. TIME_PERIOD en OBS_VALUE.
//   OBS_VALUE = eenheden vreemde valuta per 1 euro (USD 1,1622 → € 1 = $ 1,1622). Bedrag in euro = bedrag / koers.
// Mock: vaste, realistische koersen.

import { DefinitieveFout } from "./taken.ts";

export interface Koers {
  valuta: string;
  /** Datum van de gebruikte ECB-publicatie (JJJJ-MM-DD), op of vóór de gevraagde datum. */
  datum: string;
  koers: number;
}

export interface KoersProvider {
  koers(valuta: string, datum: string): Promise<Koers>;
}

export const ECB_URL = "https://data-api.ecb.europa.eu/service/data/EXR";
/** Zo ver terug zoeken we naar de laatste publicatie (lange weekenden, Kerst en Pasen). */
export const MAX_DAGEN_TERUG = 10;

export function dagenErbij(datum: string, dagen: number): string {
  const d = new Date(`${datum}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dagen);
  return d.toISOString().slice(0, 10);
}

/** Leest de CSV van de ECB; geeft [{ datum, koers }] in de volgorde van het bestand. */
export function leesEcbCsv(csv: string): { datum: string; koers: number }[] {
  const regels = csv.trim().split(/\r?\n/);
  if (regels.length < 2) return [];
  const kop = regels[0].split(",");
  const iDatum = kop.indexOf("TIME_PERIOD");
  const iWaarde = kop.indexOf("OBS_VALUE");
  if (iDatum < 0 || iWaarde < 0) throw new Error("Onverwacht CSV-formaat van de ECB.");
  return regels
    .slice(1)
    // De eerste kolommen bevatten geen komma's tussen aanhalingstekens; TIME_PERIOD en OBS_VALUE staan daarvoor.
    .map((regel) => regel.split(","))
    .map((velden) => ({ datum: velden[iDatum], koers: Number(velden[iWaarde]) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.datum) && Number.isFinite(r.koers) && r.koers > 0);
}

/** De laatste koers op of vóór de datum. */
export function kiesKoers(rijen: { datum: string; koers: number }[], datum: string): { datum: string; koers: number } | null {
  return rijen.filter((r) => r.datum <= datum).sort((a, b) => b.datum.localeCompare(a.datum))[0] ?? null;
}

function controleerInvoer(valuta: string, datum: string): void {
  if (!/^[A-Z]{3}$/.test(valuta) || valuta === "EUR") throw new DefinitieveFout(`Ongeldige valuta: ${valuta}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) throw new DefinitieveFout(`Ongeldige datum: ${datum}`);
}

export class EcbLive implements KoersProvider {
  private readonly fetcher: typeof fetch;
  private readonly vandaag: () => string;

  constructor(fetcher: typeof fetch = fetch, vandaag: () => string = () => new Date().toISOString().slice(0, 10)) {
    this.fetcher = fetcher;
    this.vandaag = vandaag;
  }

  async koers(valuta: string, datum: string): Promise<Koers> {
    controleerInvoer(valuta, datum);
    // Een factuurdatum in de toekomst: de laatst beschikbare koers.
    const tot = datum > this.vandaag() ? this.vandaag() : datum;
    const url = `${ECB_URL}/D.${valuta}.EUR.SP00.A?startPeriod=${dagenErbij(tot, -MAX_DAGEN_TERUG)}&endPeriod=${tot}&format=csvdata`;
    let response: Response;
    try {
      response = await this.fetcher(url, { headers: { Accept: "text/csv" }, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new Error(`ECB niet bereikbaar: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 404 = geen gegevens: onbekende valuta, of (bij een recente datum) nog niet gepubliceerd.
    if (response.status === 404) {
      if (tot >= dagenErbij(this.vandaag(), -1)) throw new Error(`De ECB-koers voor ${valuta} is nog niet gepubliceerd.`);
      throw new DefinitieveFout(`De ECB publiceert geen koers voor ${valuta} rond ${datum}.`);
    }
    if (!response.ok) throw new Error(`ECB gaf HTTP ${response.status}.`);
    const gekozen = kiesKoers(leesEcbCsv(await response.text()), tot);
    if (!gekozen) {
      if (tot >= dagenErbij(this.vandaag(), -1)) throw new Error(`De ECB-koers voor ${valuta} is nog niet gepubliceerd.`);
      throw new DefinitieveFout(`De ECB publiceert geen koers voor ${valuta} rond ${datum}.`);
    }
    return { valuta, ...gekozen };
  }
}

/** Mockkoersen (per 1 euro), ongeveer de ECB-koersen van september 2026. */
export const MOCK_KOERSEN: Record<string, number> = {
  USD: 1.1622, GBP: 0.8641, CHF: 0.9362, JPY: 178.86, SEK: 10.987, NOK: 11.672, DKK: 7.4638, PLN: 4.2615,
  CZK: 24.412, HUF: 391.35, CAD: 1.6043, AUD: 1.7721, CNY: 8.2957, TRY: 48.212, RON: 5.0772,
};

/** Mock: vaste koers per valuta; in het weekend de koers van vrijdag (zoals de ECB). */
export class EcbMock implements KoersProvider {
  async koers(valuta: string, datum: string): Promise<Koers> {
    controleerInvoer(valuta, datum);
    const koers = MOCK_KOERSEN[valuta];
    if (!koers) throw new DefinitieveFout(`De ECB publiceert geen koers voor ${valuta} rond ${datum}.`);
    let d = datum;
    for (let dag = new Date(`${d}T00:00:00Z`).getUTCDay(); dag === 0 || dag === 6; dag = new Date(`${d}T00:00:00Z`).getUTCDay()) {
      d = dagenErbij(d, -1);
    }
    return { valuta, datum: d, koers };
  }
}
