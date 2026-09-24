// VIES (Europese Commissie): controleert of een btw-nummer geldig is. Geen imports (testbaar met Vitest).
//
// Live: GET https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{land}/vat/{nummer}  (gratis, geen sleutel)
//   Antwoord (ook bij een ongeldig nummer HTTP 200): { isValid, userError, requestDate, name, address, … }
//   userError: VALID | INVALID | INVALID_INPUT | MS_UNAVAILABLE | TIMEOUT | SERVICE_UNAVAILABLE |
//              MS_MAX_CONCURRENT_REQ | GLOBAL_MAX_CONCURRENT_REQ | …  (de laatste groep = tijdelijk: opnieuw proberen)
// Mock: deterministisch, zie ViesMock.

import { DefinitieveFout } from "./taken.ts";

export interface ViesResultaat {
  geldig: boolean;
  naam: string | null;
  adres: string | null;
  /** Tijdstip van de controle volgens VIES (ISO). */
  gecontroleerdOp: string;
}

export interface ViesProvider {
  controleer(btwNummer: string): Promise<ViesResultaat>;
}

export const VIES_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api";

/** "NL 0044.95445.B01" → { land: "NL", nummer: "004495445B01" } */
export function splitsBtwNummer(btwNummer: string): { land: string; nummer: string } {
  const schoon = btwNummer.replace(/[\s.-]/g, "").toUpperCase();
  const land = schoon.slice(0, 2);
  if (!/^[A-Z]{2}$/.test(land) || schoon.length < 4) throw new DefinitieveFout(`Ongeldig btw-nummer: ${btwNummer}`);
  return { land, nummer: schoon.slice(2) };
}

/** "---" betekent in VIES: niet beschikbaar (sommige landen geven geen naam of adres). */
function waardeOfNull(waarde: unknown): string | null {
  if (typeof waarde !== "string") return null;
  const schoon = waarde.replace(/\s*\n\s*/g, ", ").replace(/^,\s*|,\s*$/g, "").trim();
  return schoon === "" || schoon === "---" ? null : schoon;
}

const TIJDELIJK = /UNAVAILABLE|TIMEOUT|MAX_CONCURRENT|BLOCKED|SERVICE/;

/** Zet het VIES-antwoord om. Gooit een (tijdelijke) Error als VIES het nummer nu niet kon controleren. */
export function leesViesAntwoord(data: unknown, nu = new Date()): ViesResultaat {
  const d = (data ?? {}) as Record<string, unknown>;
  // Foutvorm van de REST-API: { actionSucceed: false, errorWrappers: [{ error, message }] }
  if (d.actionSucceed === false && Array.isArray(d.errorWrappers)) {
    const code = String((d.errorWrappers[0] as Record<string, unknown>)?.error ?? "ONBEKEND");
    if (code === "INVALID_INPUT") return { geldig: false, naam: null, adres: null, gecontroleerdOp: nu.toISOString() };
    throw new Error(`VIES kon het nummer nu niet controleren (${code}).`);
  }
  const userError = typeof d.userError === "string" ? d.userError : "";
  if (d.isValid === true) {
    return {
      geldig: true,
      naam: waardeOfNull(d.name),
      adres: waardeOfNull(d.address),
      gecontroleerdOp: typeof d.requestDate === "string" ? d.requestDate : nu.toISOString(),
    };
  }
  if (userError === "INVALID" || userError === "INVALID_INPUT" || (d.isValid === false && userError === "")) {
    return { geldig: false, naam: null, adres: null, gecontroleerdOp: typeof d.requestDate === "string" ? d.requestDate : nu.toISOString() };
  }
  if (TIJDELIJK.test(userError)) throw new Error(`VIES kon het nummer nu niet controleren (${userError}).`);
  throw new Error(`Onverwacht antwoord van VIES${userError ? ` (${userError})` : ""}.`);
}

export class ViesLive implements ViesProvider {
  private readonly fetcher: typeof fetch;

  constructor(fetcher: typeof fetch = fetch) {
    this.fetcher = fetcher;
  }

  async controleer(btwNummer: string): Promise<ViesResultaat> {
    const { land, nummer } = splitsBtwNummer(btwNummer);
    let response: Response;
    try {
      response = await this.fetcher(`${VIES_URL}/ms/${land}/vat/${encodeURIComponent(nummer)}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new Error(`VIES niet bereikbaar: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (response.status === 400) {
      // Ongeldige invoer (bijv. onbekende landcode)
      return { geldig: false, naam: null, adres: null, gecontroleerdOp: new Date().toISOString() };
    }
    if (!response.ok) throw new Error(`VIES gaf HTTP ${response.status}.`);
    return leesViesAntwoord(await response.json());
  }
}

/**
 * Mock (geen internet nodig), deterministisch op het nummer:
 *   eindigt op 99            → ongeldig
 *   eindigt op 98            → VIES tijdelijk niet bereikbaar (test de retries)
 *   NL004495445B01           → geldig, met de naam uit het echte VIES-voorbeeld
 *   anders                   → geldig; naam "Mockbedrijf <nummer>" (DE en ES geven in VIES geen naam: null)
 */
export class ViesMock implements ViesProvider {
  private readonly nu: () => Date;

  constructor(nu: () => Date = () => new Date()) {
    this.nu = nu;
  }

  async controleer(btwNummer: string): Promise<ViesResultaat> {
    const { land, nummer } = splitsBtwNummer(btwNummer);
    const gecontroleerdOp = this.nu().toISOString();
    if (nummer.endsWith("98")) throw new Error("VIES kon het nummer nu niet controleren (MS_UNAVAILABLE).");
    if (nummer.endsWith("99")) return { geldig: false, naam: null, adres: null, gecontroleerdOp };
    if (land === "NL" && nummer === "004495445B01") {
      return { geldig: true, naam: "OPENJONGERENVERENIGING DE KOORNBEURS", adres: "VOLDERSGRACHT 00001, 2611ET DELFT", gecontroleerdOp };
    }
    const zonderNaam = land === "DE" || land === "ES";
    return {
      geldig: true,
      naam: zonderNaam ? null : `Mockbedrijf ${land}${nummer}`,
      adres: zonderNaam ? null : "Voorbeeldstraat 1, 1234AB Voorbeeldstad",
      gecontroleerdOp,
    };
  }
}
