import { describe, expect, it } from "vitest";
import { effectieveModus, koppelingBadges, type KoppelingTaakStatus } from "./koppelingen";
import { envNaamModus, koppelingOverzicht } from "../../supabase/functions/_shared/koppelingen/modus.ts";
import {
  DefinitieveFout,
  foutTekst,
  gelijkGeheim,
  type Taak,
  voerTaakUit,
} from "../../supabase/functions/_shared/koppelingen/taken.ts";

describe("modus per koppeling", () => {
  it("env gaat voor en zet de modus vast", () => {
    expect(effectieveModus("live", "mock")).toEqual({ modus: "live", vastgezet: true });
    expect(effectieveModus(" MOCK ", "live")).toEqual({ modus: "mock", vastgezet: true });
  });

  it("zonder (geldige) env telt de instelling, anders mock", () => {
    expect(effectieveModus(undefined, "live")).toEqual({ modus: "live", vastgezet: false });
    expect(effectieveModus("aan", "live")).toEqual({ modus: "live", vastgezet: false });
    expect(effectieveModus("", null)).toEqual({ modus: "mock", vastgezet: false });
  });

  it("env-naam", () => {
    expect(envNaamModus("boekhouding")).toBe("KOPPELING_BOEKHOUDING_MODUS");
  });

  it("overzicht: ontbrekende secrets alleen als namen; mock is altijd klaar", () => {
    const env: Record<string, string> = { KOPPELING_KVK_MODUS: "live", MONEYBIRD_TOKEN: "geheim", MONEYBIRD_ADMINISTRATIE_ID: " " };
    const overzicht = koppelingOverzicht((naam) => env[naam], [
      { koppeling: "boekhouding", modus: "live", config: { provider: "moneybird" } },
      { koppeling: "vies", modus: "live" },
    ]);
    const per = Object.fromEntries(overzicht.map((k) => [k.koppeling, k]));
    expect(overzicht).toHaveLength(7);
    expect(per.kvk).toMatchObject({ modus: "live", vastgezet: true, ontbrekend: ["KVK_API_KEY"], klaar: false });
    expect(per.boekhouding).toMatchObject({ modus: "live", ontbrekend: ["MONEYBIRD_ADMINISTRATIE_ID"], klaar: false });
    expect(per.boekhouding.config).toEqual({ provider: "moneybird" });
    expect(per.vies).toMatchObject({ modus: "live", ontbrekend: [], klaar: true });
    expect(per.email).toMatchObject({ modus: "mock", klaar: true });
    // Nooit waarden van secrets in het overzicht
    expect(JSON.stringify(overzicht)).not.toContain("geheim");
  });

  it("KvK in de testomgeving heeft geen eigen sleutel nodig", () => {
    const env: Record<string, string> = { KOPPELING_KVK_MODUS: "live", KVK_OMGEVING: "Test" };
    const kvk = koppelingOverzicht((naam) => env[naam], []).find((k) => k.koppeling === "kvk");
    expect(kvk).toMatchObject({ modus: "live", ontbrekend: [], klaar: true });
  });
});

describe("taak uitvoeren", () => {
  const taak: Taak = {
    id: "t1", organisatie_id: "o1", soort: "vies", factuur_id: null, sleutel: "NL1", payload: {}, pogingen: 1, max_pogingen: 6,
  };

  it("gelukt: resultaat door", async () => {
    const r = await voerTaakUit(taak, { vies: () => Promise.resolve({ geldig: true }) });
    expect(r).toEqual({ gelukt: true, resultaat: { geldig: true }, fout: null, opnieuw: false });
  });

  it("tijdelijke fout: opnieuw; definitieve fout: niet opnieuw", async () => {
    expect(await voerTaakUit(taak, { vies: () => Promise.reject(new Error("503 Service Unavailable")) })).toMatchObject({
      gelukt: false, fout: "503 Service Unavailable", opnieuw: true,
    });
    expect(await voerTaakUit(taak, { vies: () => Promise.reject(new DefinitieveFout("Ongeldig btw-nummer")) })).toMatchObject({
      gelukt: false, fout: "Ongeldig btw-nummer", opnieuw: false,
    });
  });

  it("onbekende soort: direct opgegeven", async () => {
    expect(await voerTaakUit(taak, {})).toMatchObject({ gelukt: false, opnieuw: false, fout: expect.stringMatching(/"vies"/) });
  });

  it("foutmelding: tokens in een URL gemaskeerd en ingekort", () => {
    expect(foutTekst(new Error("GET https://x.nl/api?key=abc123&q=1 faalde"))).toBe("GET https://x.nl/api?key=***&q=1 faalde");
    expect(foutTekst("x".repeat(600))).toHaveLength(500);
    expect(foutTekst({})).toBe("Onbekende fout.");
  });

  it("geheim vergelijken", () => {
    expect(gelijkGeheim("abc", "abc")).toBe(true);
    expect(gelijkGeheim("abc", "abd")).toBe(false);
    expect(gelijkGeheim("abc", "abcd")).toBe(false);
    expect(gelijkGeheim("", "")).toBe(false);
    expect(gelijkGeheim(null, "abc")).toBe(false);
  });
});

describe("badges in de factuurlijst", () => {
  const status = (extra: Partial<KoppelingTaakStatus>): KoppelingTaakStatus => ({
    factuur_id: "f1", soort: "boekhouding", taak_id: "t1", status: "gelukt", pogingen: 1, max_pogingen: 6,
    volgende_poging_op: "2026-09-24T12:05:00Z", laatste_fout: null, bijgewerkt_op: "2026-09-24T12:00:00Z", ...extra,
  });

  it("alleen problemen: mislukt (klikbaar) en wachten op een nieuwe poging", () => {
    const badges = koppelingBadges([
      status({ soort: "boekhouding", taak_id: "t1", status: "opgegeven", laatste_fout: "Moneybird: 503" }),
      status({ soort: "vies", taak_id: "t2", status: "wachtrij", pogingen: 2, laatste_fout: "MS_UNAVAILABLE" }),
      status({ soort: "ecb", taak_id: "t3", status: "gelukt" }),
      status({ soort: "kvk", taak_id: "t4", status: "wachtrij", pogingen: 0 }),
      status({ soort: "email", taak_id: "t5", status: "bezig" }),
    ]);
    expect(badges.map((b) => [b.taakId, b.soortBadge, b.kanOpnieuw])).toEqual([
      ["t2", "wacht", false],
      ["t1", "mislukt", true],
    ]);
    expect(badges[1].tekst).toBe("Export mislukt");
    expect(badges[1].titel).toContain("Moneybird: 503");
    expect(badges[0].tekst).toMatch(/^VIES: nieuwe poging om \d{2}:\d{2}$/);
    expect(badges[0].titel).toBe("Poging 2 van 6 mislukt: MS_UNAVAILABLE");
  });

  it("geen taken of alles in orde: geen badges", () => {
    expect(koppelingBadges([])).toEqual([]);
    expect(koppelingBadges([status({ status: "gelukt" })])).toEqual([]);
  });
});
