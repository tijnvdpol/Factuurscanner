// KvK Handelsregister: bedrijfsgegevens bij een KvK-nummer (Basisprofiel API v1). Geen imports (testbaar).
//
// Live: GET {basis}/v1/basisprofielen/{kvkNummer}, header "apikey".
//   productie: https://api.kvk.nl/api   (betaald abonnement, secret KVK_API_KEY)
//   test:      https://api.kvk.nl/test/api  (fictieve bedrijven, met de openbare testsleutel van de KvK;
//              kies met KVK_OMGEVING=test). Testnummers o.a. 68750110 (BV), 69599084 (eenmanszaak).
//   404 = nummer bestaat niet. materieleRegistratie.datumEinde gevuld = uitgeschreven.
// Mock: vaste set fictieve bedrijven + regels op het nummer (zie KvkMock).

import { DefinitieveFout } from "./taken.ts";

export interface KvkBedrijf {
  kvkNummer: string;
  naam: string | null;
  statutaireNaam: string | null;
  handelsnamen: string[];
  /** JJJJ-MM-DD als het bedrijf is uitgeschreven, anders null. */
  datumEinde: string | null;
  adres: string | null;
}

/** null = het nummer komt niet voor in het Handelsregister. */
export interface KvkProvider {
  basisprofiel(kvkNummer: string): Promise<KvkBedrijf | null>;
}

export const KVK_URL = { productie: "https://api.kvk.nl/api", test: "https://api.kvk.nl/test/api" } as const;
/** Openbare testsleutel die de KvK zelf publiceert (developers.kvk.nl); werkt alleen op de testomgeving. */
export const KVK_TEST_SLEUTEL = "l7xx1f2691f2520d487b902f4e0b57a0b197";

/** "20170519" of "2017-05-19" → "2017-05-19" */
function isoDatum(waarde: unknown): string | null {
  if (typeof waarde !== "string") return null;
  const m = waarde.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function tekst(waarde: unknown): string | null {
  return typeof waarde === "string" && waarde.trim() !== "" ? waarde.replace(/\s+/g, " ").trim() : null;
}

export function leesBasisprofiel(data: unknown): KvkBedrijf {
  const d = (data ?? {}) as Record<string, unknown>;
  const registratie = (d.materieleRegistratie ?? {}) as Record<string, unknown>;
  const hoofdvestiging = ((d._embedded as Record<string, unknown> | undefined)?.hoofdvestiging ?? {}) as Record<string, unknown>;
  const adressen = Array.isArray(hoofdvestiging.adressen) ? (hoofdvestiging.adressen as Record<string, unknown>[]) : [];
  const adres = adressen.find((a) => a.type === "bezoekadres") ?? adressen[0];
  const handelsnamen = Array.isArray(d.handelsnamen)
    ? (d.handelsnamen as Record<string, unknown>[])
        .sort((a, b) => Number(a.volgorde ?? 0) - Number(b.volgorde ?? 0))
        .map((h) => tekst(h.naam))
        .filter((n): n is string => n !== null)
    : [];
  return {
    kvkNummer: String(d.kvkNummer ?? ""),
    naam: tekst(d.naam),
    statutaireNaam: tekst(d.statutaireNaam),
    handelsnamen,
    datumEinde: isoDatum(registratie.datumEinde),
    adres: tekst(adres?.volledigAdres),
  };
}

export class KvkLive implements KvkProvider {
  private readonly basisUrl: string;
  private readonly sleutel: string;
  private readonly fetcher: typeof fetch;

  constructor(basisUrl: string, sleutel: string, fetcher: typeof fetch = fetch) {
    this.basisUrl = basisUrl;
    this.sleutel = sleutel;
    this.fetcher = fetcher;
  }

  async basisprofiel(kvkNummer: string): Promise<KvkBedrijf | null> {
    if (!/^\d{8}$/.test(kvkNummer)) throw new DefinitieveFout(`Ongeldig KvK-nummer: ${kvkNummer}`);
    let response: Response;
    try {
      response = await this.fetcher(`${this.basisUrl}/v1/basisprofielen/${kvkNummer}`, {
        headers: { apikey: this.sleutel, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new Error(`KvK niet bereikbaar: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
      throw new DefinitieveFout("De KvK-API weigert de sleutel (KVK_API_KEY ongeldig of geen abonnement op het Basisprofiel).");
    }
    if (response.status === 400) {
      // De KvK geeft bij sommige onbekende nummers 400 met een foutcode; dat is geen tijdelijke storing.
      return null;
    }
    if (!response.ok) throw new Error(`KvK gaf HTTP ${response.status}.`);
    return leesBasisprofiel(await response.json());
  }
}

/** Fictieve bedrijven voor de mock (zelfde opbouw als de KvK-testomgeving). */
export const MOCK_BEDRIJVEN: KvkBedrijf[] = [
  { kvkNummer: "68750110", naam: "Test BV Donald", statutaireNaam: "Test BV Donald", handelsnamen: ["Test BV Donald", "Test BV Donald Nevenvestiging"], datumEinde: null, adres: "Hizzaarderlaan 3 A 8823SJ Lollum" },
  { kvkNummer: "12345678", naam: "Voorbeeld Kantoorartikelen B.V.", statutaireNaam: "Voorbeeld Kantoorartikelen B.V.", handelsnamen: ["Voorbeeld Kantoor", "Kantoorwinkel Voorbeeld"], datumEinde: null, adres: "Stationsplein 1 3511ED Utrecht" },
  { kvkNummer: "87654321", naam: "Oud Bedrijf V.O.F.", statutaireNaam: null, handelsnamen: ["Oud Bedrijf"], datumEinde: "2025-06-30", adres: "Dorpsstraat 10 1234AB Ergens" },
];

/**
 * Mock (geen account nodig):
 *   een nummer uit MOCK_BEDRIJVEN     → dat bedrijf
 *   eindigt op 00                     → niet gevonden
 *   eindigt op 99                     → uitgeschreven (per 1 januari van dit jaar)
 *   eindigt op 98                     → gevonden, maar met een andere naam ("Andere Naam Holding B.V.")
 *   anders                            → gevonden met de naam van de factuur (zoals een echte, kloppende leverancier)
 */
export class KvkMock implements KvkProvider {
  private readonly naamOpFactuur: string | null;
  private readonly nu: () => Date;

  constructor(naamOpFactuur: string | null, nu: () => Date = () => new Date()) {
    this.naamOpFactuur = naamOpFactuur;
    this.nu = nu;
  }

  async basisprofiel(kvkNummer: string): Promise<KvkBedrijf | null> {
    if (!/^\d{8}$/.test(kvkNummer)) throw new DefinitieveFout(`Ongeldig KvK-nummer: ${kvkNummer}`);
    const bekend = MOCK_BEDRIJVEN.find((b) => b.kvkNummer === kvkNummer);
    if (bekend) return bekend;
    if (kvkNummer.endsWith("00")) return null;
    const naam = kvkNummer.endsWith("98") ? "Andere Naam Holding B.V." : (this.naamOpFactuur ?? `Mockbedrijf ${kvkNummer}`);
    return {
      kvkNummer,
      naam,
      statutaireNaam: naam,
      handelsnamen: [naam],
      datumEinde: kvkNummer.endsWith("99") ? `${this.nu().getUTCFullYear()}-01-01` : null,
      adres: "Voorbeeldstraat 1 1234AB Voorbeeldstad",
    };
  }
}
