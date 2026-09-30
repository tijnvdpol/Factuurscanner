import { describe, expect, it, vi } from "vitest";
import {
  BoekhoudMock,
  boekhoudHandler,
  btwSleutel,
  bouwRegels,
  mockId,
  type AccountingProvider,
  type BoekhoudDeps,
} from "../../supabase/functions/_shared/koppelingen/boekhouding.ts";
import { MONEYBIRD_URL, MoneybirdLive } from "../../supabase/functions/_shared/koppelingen/moneybird.ts";
import { kiesBoekhoudProvider } from "../../supabase/functions/_shared/koppelingen/boekhoudProvider.ts";
import { DefinitieveFout, voerTaakUit, type Taak } from "../../supabase/functions/_shared/koppelingen/taken.ts";

const FACTUUR_ID = "3f2b7c1e-9a4d-4e6b-8c2a-1d5e7f9a0b3c";

function gegevens(extra: Record<string, unknown> = {}) {
  return {
    status: "exporteren",
    provider: "moneybird",
    organisatie_id: "o1",
    factuur: {
      id: FACTUUR_ID, factuurnummer: "F-001", factuurdatum: "2026-09-20", vervaldatum: "2026-10-20", valuta: "EUR",
      bedrag_excl: 150, totaal_incl: 175.5, bestand_pad: "o1/f1/factuur.pdf", bestandsnaam: "factuur.pdf",
    },
    btw_regels: [{ tarief: 21, grondslag: 100, btw_bedrag: 21 }, { tarief: 9, grondslag: 50, btw_bedrag: 4.5 }],
    leverancier: { id: "l1", naam: "Leverancier BV", btw_nummer: "NL123456789B01", kvk_nummer: "12345678", iban: "NL91ABNA0417164300" },
    grootboekrekening: { id: "g1", code: "4300", omschrijving: "Kantoorkosten" },
    mappings: {
      grootboek: { extern_id: "L-4300", extern_naam: "Kantoorkosten" },
      btw: { "21": { extern_id: "T-21", extern_naam: "21%" }, "9": { extern_id: "T-9", extern_naam: "9%" } },
      leverancier: null,
    },
    ...extra,
  };
}

describe("boekingsregels", () => {
  it("één regel per btw-tarief, met de gekoppelde grootboekrekening en btw-code", () => {
    expect(bouwRegels(gegevens() as never, "Moneybird")).toEqual([
      { omschrijving: "Leverancier BV F-001 (21% btw)", bedragExcl: 100, percentage: 21, btwCodeId: "T-21", grootboekId: "L-4300" },
      { omschrijving: "Leverancier BV F-001 (9% btw)", bedragExcl: 50, percentage: 9, btwCodeId: "T-9", grootboekId: "L-4300" },
    ]);
  });

  it("ontbrekende mapping of btw-regels: definitieve fout met uitleg", () => {
    const g = gegevens();
    expect(() => bouwRegels({ ...g, mappings: { ...g.mappings, grootboek: null } } as never, "Moneybird"))
      .toThrow(/Grootboekrekening 4300 Kantoorkosten is niet gekoppeld aan Moneybird/);
    expect(() => bouwRegels({ ...g, mappings: { ...g.mappings, btw: { "21": g.mappings.btw["21"] } } } as never, "Moneybird"))
      .toThrow(/Btw-tarief 9% is niet gekoppeld/);
    expect(() => bouwRegels({ ...g, btw_regels: [] } as never, "Moneybird")).toThrow(DefinitieveFout);
    // Zonder btw-regels maar excl. = incl.: één regel tegen 0%
    const nul = { ...g, btw_regels: [], factuur: { ...g.factuur, bedrag_excl: 80, totaal_incl: 80 },
      mappings: { ...g.mappings, btw: { "0": { extern_id: "T-0", extern_naam: "0%" } } } };
    expect(bouwRegels(nul as never, "Moneybird")).toEqual([
      { omschrijving: "Leverancier BV F-001", bedragExcl: 80, percentage: 0, btwCodeId: "T-0", grootboekId: "L-4300" },
    ]);
  });

  it("btw-sleutel", () => {
    expect([btwSleutel(21), btwSleutel(9.0), btwSleutel(5.5), btwSleutel(0)]).toEqual(["21", "9", "5.5", "0"]);
  });
});

describe("boekhouding-taak", () => {
  const taak: Taak = { id: "t1", organisatie_id: "o1", soort: "boekhouding", factuur_id: FACTUUR_ID, sleutel: FACTUUR_ID, payload: {}, pogingen: 1, max_pogingen: 6 };

  function opzet(g: Record<string, unknown>, provider: Partial<AccountingProvider> = {}) {
    const rpcs: [string, Record<string, unknown>][] = [];
    const p: AccountingProvider = {
      pakket: "moneybird", naam: "Moneybird",
      grootboekrekeningen: async () => [], btwCodes: async () => [],
      zoekOfMaakLeverancier: vi.fn(async () => ({ id: "C-9", naam: "Leverancier BV", aangemaakt: true })),
      zoekInkoopfactuur: vi.fn(async () => null),
      maakInkoopfactuur: vi.fn(async () => ({ id: "PI-1", url: "https://moneybird.com/1/documents/PI-1" })),
      voegBijlageToe: vi.fn(async () => undefined),
      ...provider,
    };
    const d: BoekhoudDeps = {
      modus: async () => "live",
      rpc: async (functie, args) => {
        rpcs.push([functie, args]);
        return functie === "export_gegevens" ? g : null;
      },
      provider: () => p,
      bestand: async () => new Uint8Array([37, 80, 68, 70]),
    };
    return { d, p, rpcs };
  }

  it("leverancier aanmaken en vastleggen, factuur aanmaken, registreren, bijlage toevoegen", async () => {
    const { d, p, rpcs } = opzet(gegevens());
    const r = await voerTaakUit(taak, { boekhouding: boekhoudHandler(d) });
    expect(r).toMatchObject({ gelukt: true, resultaat: {
      omschrijving: "Geëxporteerd naar Moneybird (PI-1); leverancier Leverancier BV aangemaakt", extern_id: "PI-1", modus: "live",
    } });
    expect(rpcs.map(([f]) => f)).toEqual(["export_gegevens", "sla_leverancier_mapping_op", "registreer_export"]);
    expect(p.maakInkoopfactuur).toHaveBeenCalledWith(expect.objectContaining({ leverancierId: "C-9", referentie: "F-001", valuta: "EUR" }));
    expect(rpcs[2][1]).toMatchObject({ p_extern_id: "PI-1", p_provider: "moneybird", p_modus: "live" });
    expect(p.voegBijlageToe).toHaveBeenCalledWith("PI-1", expect.objectContaining({ naam: "factuur.pdf", mimeType: "application/pdf" }));
  });

  it("staat de factuur al in het pakket: koppelen, niet opnieuw aanmaken", async () => {
    const g = gegevens({ mappings: { ...gegevens().mappings, leverancier: { extern_id: "C-1", extern_naam: "x" } } });
    const { d, p, rpcs } = opzet(g, { zoekInkoopfactuur: vi.fn(async () => ({ id: "PI-OUD", url: null })) });
    const r = await boekhoudHandler(d)(taak);
    expect(r.omschrijving).toBe("Geëxporteerd naar Moneybird (PI-OUD), stond er al en is gekoppeld");
    expect(p.maakInkoopfactuur).not.toHaveBeenCalled();
    expect(p.zoekOfMaakLeverancier).not.toHaveBeenCalled();
    expect(p.voegBijlageToe).not.toHaveBeenCalled();
    expect(rpcs.find(([f]) => f === "registreer_export")![1]).toMatchObject({ p_extern_id: "PI-OUD", p_details: { al_aanwezig: true } });
  });

  it("een mislukte bijlage laat de export staan", async () => {
    const { d } = opzet(gegevens(), { voegBijlageToe: async () => { throw new Error("Moneybird: HTTP 503"); } });
    expect((await boekhoudHandler(d)(taak)).omschrijving).toMatch(/bijlage niet toegevoegd: Moneybird: HTTP 503/);
  });

  it("al geëxporteerd: niets doen; niet goedgekeurd of zonder mapping: definitief mislukt", async () => {
    const al = opzet({ status: "al_geexporteerd", reden: "Al geëxporteerd naar moneybird (PI-1)." });
    expect(await boekhoudHandler(al.d)(taak)).toEqual({ omschrijving: "Al geëxporteerd naar moneybird (PI-1)." });
    expect(al.p.maakInkoopfactuur).not.toHaveBeenCalled();

    const niet = opzet({ status: "niet_toegestaan", reden: "Alleen goedgekeurde facturen worden geëxporteerd (status: gescand)." });
    expect(await voerTaakUit(taak, { boekhouding: boekhoudHandler(niet.d) })).toMatchObject({ gelukt: false, opnieuw: false });

    const g = gegevens();
    const zonder = opzet({ ...g, mappings: { ...g.mappings, grootboek: null } });
    const r = await voerTaakUit(taak, { boekhouding: boekhoudHandler(zonder.d) });
    expect(r).toMatchObject({ gelukt: false, opnieuw: false, fout: expect.stringMatching(/niet gekoppeld aan Moneybird/) });
    expect(zonder.p.zoekOfMaakLeverancier).not.toHaveBeenCalled();
  });
});

describe("mock-adapters", () => {
  it("elk pakket heeft een eigen rekeningschema en btw-codes, met vaste id's", async () => {
    for (const pakket of ["moneybird", "exact", "snelstart"] as const) {
      const m = new BoekhoudMock(pakket);
      const rekeningen = await m.grootboekrekeningen();
      expect(rekeningen.find((r) => r.code === "4300")).toBeTruthy();
      expect(rekeningen).toEqual(await new BoekhoudMock(pakket).grootboekrekeningen());
      expect((await m.btwCodes()).map((b) => b.percentage)).toEqual(expect.arrayContaining([21, 9, 0]));
    }
    expect((await new BoekhoudMock("exact").grootboekrekeningen())[0].id).toMatch(/^[0-9]{8}-[0-9]{4}-4[0-9]{3}-8[0-9]{3}-[0-9]{12}$/);
    expect(mockId("a")).toBe(mockId("a"));
    expect(mockId("a")).not.toBe(mockId("b"));
  });

  it("dezelfde factuur geeft hetzelfde id; TIJDELIJK en WEIGER simuleren fouten", async () => {
    const m = new BoekhoudMock("snelstart");
    const f = { leverancierId: "C", referentie: "F-1", datum: "2026-09-01", vervaldatum: null, valuta: "EUR", regels: [] };
    expect(await m.maakInkoopfactuur(f)).toEqual(await m.maakInkoopfactuur(f));
    await expect(m.maakInkoopfactuur({ ...f, referentie: "F-TIJDELIJK" })).rejects.not.toBeInstanceOf(DefinitieveFout);
    await expect(m.maakInkoopfactuur({ ...f, referentie: "F-WEIGER" })).rejects.toBeInstanceOf(DefinitieveFout);
  });

  it("provider kiezen: mock altijd; live alleen Moneybird, met secrets", () => {
    const env = (waarden: Record<string, string>) => (n: string) => waarden[n];
    expect(kiesBoekhoudProvider("exact", "mock", env({})).naam).toBe("Exact Online (mock)");
    expect(() => kiesBoekhoudProvider("exact", "live", env({}))).toThrow(/alleen als mock beschikbaar/);
    expect(() => kiesBoekhoudProvider("moneybird", "live", env({}))).toThrow(/MONEYBIRD_TOKEN/);
    expect(kiesBoekhoudProvider("moneybird", "live", env({ MONEYBIRD_TOKEN: "t", MONEYBIRD_ADMINISTRATIE_ID: "123" }))).toBeInstanceOf(MoneybirdLive);
  });
});

describe("Moneybird (live, met nep-fetch)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  function nep(antwoorden: ((url: string, init: RequestInit) => Response | Promise<Response>)[]) {
    const aanroepen: { url: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      aanroepen.push({ url: String(url), init: init ?? {} });
      const volgende = antwoorden.shift();
      if (!volgende) throw new Error(`Onverwachte aanroep: ${String(url)}`);
      return volgende(String(url), init ?? {});
    });
    return { mb: new MoneybirdLive("geheim-token", "123", fetcher as unknown as typeof fetch), aanroepen };
  }

  it("grootboek: alleen kostenrekeningen die op inkoopfacturen mogen; btw: inkooptarieven", async () => {
    const { mb, aanroepen } = nep([
      () => json([
        { id: 1, name: "Kantoorkosten", account_type: "expenses", account_id: "4300", allowed_document_types: ["purchase_invoice", "general_journal_document"] },
        { id: 2, name: "Omzet", account_type: "revenue", account_id: "8000" },
        { id: 3, name: "Inkopen", account_type: "direct_costs", account_id: null, allowed_document_types: [] },
      ]),
      () => json([{ id: 10, name: "21% btw", percentage: "21.0" }]),
    ]);
    expect(await mb.grootboekrekeningen()).toEqual([
      { id: "1", code: "4300", naam: "Kantoorkosten" },
      { id: "3", code: null, naam: "Inkopen" },
    ]);
    expect(await mb.btwCodes()).toEqual([{ id: "10", code: null, naam: "21% btw", percentage: 21 }]);
    expect(aanroepen[0].url).toBe(`${MONEYBIRD_URL}/123/ledger_accounts.json`);
    expect(aanroepen[0].init.headers).toMatchObject({ Authorization: "Bearer geheim-token" });
    expect(aanroepen[1].url).toContain("filter=tax_rate_type:purchase_invoice,active:true");
  });

  it("leverancier: eerst zoeken op KvK (exacte match), anders aanmaken", async () => {
    const gevonden = nep([() => json([{ id: 7, company_name: "Andere Naam BV", chamber_of_commerce: "12 34 56 78" }])]);
    const l = { naam: "Leverancier BV", kvk_nummer: "12345678", btw_nummer: "NL123456789B01", iban: "NL91ABNA0417164300" };
    expect(await gevonden.mb.zoekOfMaakLeverancier(l)).toEqual({ id: "7", naam: "Andere Naam BV", aangemaakt: false });
    expect(gevonden.aanroepen[0].url).toBe(`${MONEYBIRD_URL}/123/contacts/filter.json?query=12345678&per_page=100`);

    const nieuw = nep([() => json([]), () => json([]), () => json([{ id: 8, company_name: "Leverancier BV Holding" }]), () => json({ id: 9, company_name: "Leverancier BV" }, 201)]);
    expect(await nieuw.mb.zoekOfMaakLeverancier(l)).toEqual({ id: "9", naam: "Leverancier BV", aangemaakt: true });
    expect(JSON.parse(nieuw.aanroepen[3].init.body as string)).toEqual({
      contact: { company_name: "Leverancier BV", tax_number: "NL123456789B01", chamber_of_commerce: "12345678", bank_account: "NL91ABNA0417164300" },
    });
  });

  it("inkoopfactuur zoeken (zelfde referentie bij de leverancier) en aanmaken", async () => {
    const { mb, aanroepen } = nep([
      () => json([{ id: 50, reference: "F-000" }, { id: 51, reference: "F-001 " }]),
      () => json({ id: 60 }, 201),
    ]);
    expect(await mb.zoekInkoopfactuur("C-1", "F-001", "2026-09-20")).toEqual({ id: "51", url: "https://moneybird.com/123/documents/51" });
    expect(decodeURIComponent(aanroepen[0].url)).toContain("filter=contact_id:C-1,period:20250101..20271231");

    await mb.maakInkoopfactuur({
      leverancierId: "C-1", referentie: "F-001", datum: "2026-09-20", vervaldatum: null, valuta: "USD",
      regels: [{ omschrijving: "x", bedragExcl: 100, percentage: 21, btwCodeId: "T", grootboekId: "L" }],
    });
    expect(JSON.parse(aanroepen[1].init.body as string)).toEqual({
      purchase_invoice: {
        contact_id: "C-1", reference: "F-001", date: "2026-09-20", currency: "USD", prices_are_incl_tax: false,
        details_attributes: [{ description: "x", price: "100.00", amount: "1", tax_rate_id: "T", ledger_account_id: "L" }],
      },
    });
  });

  it("fouten: 429/5xx/netwerk tijdelijk; 401, 404 en 422 definitief", async () => {
    for (const r of [json({}, 429), json({}, 502), new TypeError("fetch failed")]) {
      const { mb } = nep([() => { if (r instanceof Error) throw r; return r; }]);
      const fout = await mb.btwCodes().catch((e) => e);
      expect(fout).not.toBeInstanceOf(DefinitieveFout);
    }
    await expect(nep([() => json({ error: "Unauthorized" }, 401)]).mb.btwCodes()).rejects.toThrow(/MONEYBIRD_TOKEN/);
    await expect(nep([() => json({ error: "Not found" }, 404)]).mb.btwCodes()).rejects.toThrow(/MONEYBIRD_ADMINISTRATIE_ID/);
    await expect(nep([() => json({ error: { date: ["valt in een afgesloten periode"] } }, 422)]).mb.maakInkoopfactuur({
      leverancierId: "C", referentie: "R", datum: "2020-01-01", vervaldatum: null, valuta: "EUR", regels: [],
    })).rejects.toThrow(/date valt in een afgesloten periode/);
  });
});
