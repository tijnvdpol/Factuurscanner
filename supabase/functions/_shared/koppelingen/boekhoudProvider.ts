// Welke adapter geldt: mock-modus → de mock van het gekozen pakket; live → Moneybird. Exact Online en SnelStart
// zijn (nog) alleen als mock beschikbaar; live geeft dan een duidelijke fout in plaats van een neppe export.

import { type AccountingProvider, BoekhoudMock, type Pakket, PAKKET_NAMEN, PAKKETTEN } from "./boekhouding.ts";
import { MoneybirdLive } from "./moneybird.ts";
import type { Modus } from "./modus.ts";
import { DefinitieveFout } from "./taken.ts";

export function isPakket(waarde: unknown): waarde is Pakket {
  return typeof waarde === "string" && (PAKKETTEN as readonly string[]).includes(waarde);
}

export function kiesBoekhoudProvider(
  pakket: Pakket,
  modus: Modus,
  env: (naam: string) => string | undefined,
  fetcher: typeof fetch = fetch,
): AccountingProvider {
  if (modus === "mock") return new BoekhoudMock(pakket);
  if (pakket !== "moneybird") {
    throw new DefinitieveFout(
      `${PAKKET_NAMEN[pakket]} is alleen als mock beschikbaar. Zet het boekhoudpakket op mock, of kies Moneybird.`,
    );
  }
  const token = env("MONEYBIRD_TOKEN")?.trim();
  const administratie = env("MONEYBIRD_ADMINISTRATIE_ID")?.trim();
  if (!token || !administratie) {
    throw new DefinitieveFout("Moneybird staat op live, maar MONEYBIRD_TOKEN of MONEYBIRD_ADMINISTRATIE_ID ontbreekt.");
  }
  return new MoneybirdLive(token, administratie, fetcher);
}
