import { describe, expect, it, vi } from "vitest";
import { leesViesAntwoord, splitsBtwNummer, ViesLive, ViesMock } from "../../supabase/functions/_shared/koppelingen/vies.ts";
import { EcbLive, EcbMock, kiesKoers, leesEcbCsv } from "../../supabase/functions/_shared/koppelingen/ecb.ts";
import { KVK_URL, KvkLive, KvkMock, leesBasisprofiel } from "../../supabase/functions/_shared/koppelingen/kvk.ts";
import { DefinitieveFout, type Taak } from "../../supabase/functions/_shared/koppelingen/taken.ts";
import { verrijkingHandlers, type VerrijkingDeps } from "../../supabase/functions/_shared/koppelingen/verrijking.ts";

/** Nep-fetch die per aanroep het opgegeven antwoord geeft en de URL's en headers bewaart. */
function nepFetch(...antwoorden: (Response | Error)[]) {
  const aanroepen: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    aanroepen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const a = antwoorden.shift();
    if (!a) throw new Error("geen antwoord meer");
    if (a instanceof Error) throw a;
    return a;
  });
  return { fetcher: fetcher as unknown as typeof fetch, aanroepen };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Echte antwoorden (VIES en KvK-testomgeving, september 2026)
const VIES_GELDIG = {
  isValid: true, requestDate: "2026-09-24T11:50:24.774Z", userError: "VALID",
  name: "OPENJONGERENVERENIGING DE KOORNBEURS", address: "\nVOLDERSGRACHT 00001\n2611ET DELFT\n",
  requestIdentifier: "", originalVatNumber: "004495445B01", vatNumber: "004495445B01",
};
const VIES_ONGELDIG = { isValid: false, requestDate: "2026-09-24T11:50:35.695Z", userError: "INVALID", name: "---", address: "---" };
const ECB_CSV = `KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,OBS_PRE_BREAK,OBS_COM,TIME_FORMAT,BREAKS,COLLECTION,COMPILING_ORG,DISS_ORG,DOM_SER_IDS,PUBL_ECB,PUBL_MU,PUBL_PUBLIC,UNIT_INDEX_BASE,COMPILATION,COVERAGE,DECIMALS,NAT_TITLE,SOURCE_AGENCY,SOURCE_PUB,TITLE,TITLE_COMPL,UNIT,UNIT_MULT
EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-03,1.1615,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,US dollar/Euro ECB reference exchange rate,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)",USD,0
EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-04,1.1622,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,US dollar/Euro ECB reference exchange rate,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)",USD,0
EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-07,1.1622,A,F,,,P1D,,A,,,,,,,99Q1=100,,,4,,4F0,,US dollar/Euro ECB reference exchange rate,"ECB reference exchange rate, US dollar/Euro, 2.15 pm (C.E.T.)",USD,0`;
const KVK_PROFIEL = {
  kvkNummer: "68750110", indNonMailing: "Ja", naam: "Test BV Donald", formeleRegistratiedatum: "20170519",
  materieleRegistratie: { datumAanvang: "20170519" }, statutaireNaam: "Test BV Donald",
  handelsnamen: [{ naam: "Test BV Donald Nevenvestiging", volgorde: 1 }, { naam: "Test BV Donald", volgorde: 0 }],
  _embedded: {
    hoofdvestiging: {
      adressen: [
        { type: "correspondentieadres", volledigAdres: "Postbus 200                                 1000AE Rommeldam" },
        { type: "bezoekadres", volledigAdres: "Hizzaarderlaan 3 A                                 8823SJ Lollum" },
      ],
    },
  },
};

describe("VIES", () => {
  it("splitst het btw-nummer in land en nummer", () => {
    expect(splitsBtwNummer("NL 0044.95445.B01")).toEqual({ land: "NL", nummer: "004495445B01" });
    expect(() => splitsBtwNummer("12")).toThrow(DefinitieveFout);
  });

  it("leest geldig en ongeldig; '---' en regeleinden netjes", () => {
    expect(leesViesAntwoord(VIES_GELDIG)).toEqual({
      geldig: true, naam: "OPENJONGERENVERENIGING DE KOORNBEURS", adres: "VOLDERSGRACHT 00001, 2611ET DELFT",
      gecontroleerdOp: "2026-09-24T11:50:24.774Z",
    });
    expect(leesViesAntwoord(VIES_ONGELDIG)).toMatchObject({ geldig: false, naam: null, adres: null });
  });

  it("tijdelijke fouten gooien (retry), ongeldige invoer is 'ongeldig'", () => {
    expect(() => leesViesAntwoord({ isValid: false, userError: "MS_UNAVAILABLE" })).toThrow(/MS_UNAVAILABLE/);
    expect(() => leesViesAntwoord({ actionSucceed: false, errorWrappers: [{ error: "MS_MAX_CONCURRENT_REQ" }] })).toThrow(/MAX_CONCURRENT/);
    expect(() => leesViesAntwoord({ isValid: false, userError: "MS_UNAVAILABLE" })).not.toThrow(DefinitieveFout);
    expect(leesViesAntwoord({ actionSucceed: false, errorWrappers: [{ error: "INVALID_INPUT" }] }).geldig).toBe(false);
  });

  it("live: roept de juiste URL aan", async () => {
    const { fetcher, aanroepen } = nepFetch(json(VIES_GELDIG));
    const r = await new ViesLive(fetcher).controleer("NL004495445B01");
    expect(r.geldig).toBe(true);
    expect(aanroepen[0].url).toBe("https://ec.europa.eu/taxation_customs/vies/rest-api/ms/NL/vat/004495445B01");
  });

  it("live: 500 en netwerkfout zijn tijdelijk, 400 is ongeldig", async () => {
    await expect(new ViesLive(nepFetch(json({}, 500)).fetcher).controleer("DE123456789")).rejects.toThrow(/HTTP 500/);
    await expect(new ViesLive(nepFetch(new TypeError("fetch failed")).fetcher).controleer("DE123456789")).rejects.toThrow(/niet bereikbaar/);
    expect((await new ViesLive(nepFetch(json({}, 400)).fetcher).controleer("XX123456789")).geldig).toBe(false);
  });

  it("mock: regels op het nummer", async () => {
    const mock = new ViesMock(() => new Date("2026-09-24T10:00:00Z"));
    expect(await mock.controleer("NL123456789B99")).toMatchObject({ geldig: false });
    await expect(mock.controleer("NL123456789B98")).rejects.toThrow(/MS_UNAVAILABLE/);
    expect(await mock.controleer("NL004495445B01")).toMatchObject({ geldig: true, naam: "OPENJONGERENVERENIGING DE KOORNBEURS" });
    expect(await mock.controleer("DE123456789")).toMatchObject({ geldig: true, naam: null });
    expect(await mock.controleer("BE0123456789")).toMatchObject({ geldig: true, naam: "Mockbedrijf BE0123456789" });
  });
});

describe("ECB", () => {
  it("leest de CSV en kiest de laatste koers op of vóór de datum", () => {
    const rijen = leesEcbCsv(ECB_CSV);
    expect(rijen).toEqual([
      { datum: "2026-09-03", koers: 1.1615 },
      { datum: "2026-09-04", koers: 1.1622 },
      { datum: "2026-09-07", koers: 1.1622 },
    ]);
    // Zaterdag 5 september: de koers van vrijdag
    expect(kiesKoers(rijen, "2026-09-05")).toEqual({ datum: "2026-09-04", koers: 1.1622 });
    expect(kiesKoers(rijen, "2026-09-01")).toBeNull();
  });

  it("live: vraagt 10 dagen terug op en neemt de laatste publicatie", async () => {
    const { fetcher, aanroepen } = nepFetch(new Response(ECB_CSV));
    const koers = await new EcbLive(fetcher, () => "2026-09-24").koers("USD", "2026-09-05");
    expect(koers).toEqual({ valuta: "USD", datum: "2026-09-04", koers: 1.1622 });
    expect(aanroepen[0].url).toBe(
      "https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=2026-08-26&endPeriod=2026-09-05&format=csvdata",
    );
  });

  it("live: factuurdatum in de toekomst → tot vandaag", async () => {
    const { fetcher, aanroepen } = nepFetch(new Response(ECB_CSV));
    await new EcbLive(fetcher, () => "2026-09-07").koers("USD", "2026-12-01");
    expect(aanroepen[0].url).toContain("endPeriod=2026-09-07");
  });

  it("live: 404 bij een oude datum is definitief, bij vandaag tijdelijk (nog niet gepubliceerd)", async () => {
    await expect(new EcbLive(nepFetch(new Response("", { status: 404 })).fetcher, () => "2026-09-24").koers("XYZ", "2026-06-01"))
      .rejects.toBeInstanceOf(DefinitieveFout);
    const vandaag = new EcbLive(nepFetch(new Response("", { status: 404 })).fetcher, () => "2026-09-24").koers("USD", "2026-09-24");
    await expect(vandaag).rejects.toThrow(/nog niet gepubliceerd/);
    await expect(vandaag).rejects.not.toBeInstanceOf(DefinitieveFout);
    await expect(new EcbLive(nepFetch(new Response("", { status: 503 })).fetcher).koers("USD", "2026-06-01")).rejects.toThrow(/HTTP 503/);
  });

  it("ongeldige invoer is definitief", async () => {
    await expect(new EcbMock().koers("EUR", "2026-09-01")).rejects.toBeInstanceOf(DefinitieveFout);
    await expect(new EcbMock().koers("USD", "1-9-2026")).rejects.toBeInstanceOf(DefinitieveFout);
  });

  it("mock: vaste koers, in het weekend die van vrijdag, onbekende valuta definitief", async () => {
    expect(await new EcbMock().koers("USD", "2026-09-06")).toEqual({ valuta: "USD", datum: "2026-09-04", koers: 1.1622 });
    expect(await new EcbMock().koers("GBP", "2026-09-08")).toEqual({ valuta: "GBP", datum: "2026-09-08", koers: 0.8641 });
    await expect(new EcbMock().koers("XYZ", "2026-09-08")).rejects.toBeInstanceOf(DefinitieveFout);
  });
});

describe("KvK", () => {
  it("leest het basisprofiel (handelsnamen op volgorde, bezoekadres)", () => {
    expect(leesBasisprofiel(KVK_PROFIEL)).toEqual({
      kvkNummer: "68750110", naam: "Test BV Donald", statutaireNaam: "Test BV Donald",
      handelsnamen: ["Test BV Donald", "Test BV Donald Nevenvestiging"], datumEinde: null,
      adres: "Hizzaarderlaan 3 A 8823SJ Lollum",
    });
    expect(leesBasisprofiel({ ...KVK_PROFIEL, materieleRegistratie: { datumAanvang: "20170519", datumEinde: "20250630" } }).datumEinde)
      .toBe("2025-06-30");
  });

  it("live: pad, sleutel in header apikey; 404 = niet gevonden; 401 definitief; 503 tijdelijk", async () => {
    const { fetcher, aanroepen } = nepFetch(json(KVK_PROFIEL), json({}, 404), json({}, 401), json({}, 503));
    const kvk = new KvkLive(KVK_URL.test, "sleutel", fetcher);
    expect((await kvk.basisprofiel("68750110"))?.naam).toBe("Test BV Donald");
    expect(aanroepen[0]).toEqual({
      url: "https://api.kvk.nl/test/api/v1/basisprofielen/68750110",
      headers: { apikey: "sleutel", Accept: "application/json" },
    });
    expect(await kvk.basisprofiel("12345678")).toBeNull();
    await expect(kvk.basisprofiel("12345678")).rejects.toBeInstanceOf(DefinitieveFout);
    await expect(kvk.basisprofiel("12345678")).rejects.toThrow(/HTTP 503/);
    await expect(kvk.basisprofiel("1234")).rejects.toBeInstanceOf(DefinitieveFout);
  });

  it("mock: bekende bedrijven en regels op het nummer", async () => {
    const mock = new KvkMock("Bakkerij Jansen B.V.", () => new Date("2026-09-24T10:00:00Z"));
    expect((await mock.basisprofiel("68750110"))?.naam).toBe("Test BV Donald");
    expect(await mock.basisprofiel("11111100")).toBeNull();
    expect(await mock.basisprofiel("11111199")).toMatchObject({ datumEinde: "2026-01-01", naam: "Bakkerij Jansen B.V." });
    expect(await mock.basisprofiel("11111198")).toMatchObject({ naam: "Andere Naam Holding B.V." });
    expect(await mock.basisprofiel("11111111")).toMatchObject({ naam: "Bakkerij Jansen B.V.", datumEinde: null });
  });
});

describe("verrijkingstaken", () => {
  const taak = (soort: string, payload: Record<string, unknown>, factuur_id: string | null = "f1"): Taak => ({
    id: "t1", organisatie_id: "o1", soort, factuur_id, sleutel: String(Object.values(payload)[0]), payload, pogingen: 1, max_pogingen: 6,
  });

  function deps(extra: Partial<VerrijkingDeps> = {}, rpcAntwoorden: Record<string, unknown> = {}) {
    const rpc = vi.fn(async (functie: string) => rpcAntwoorden[functie] ?? null);
    const d: VerrijkingDeps = {
      modus: async () => "mock",
      rpc,
      vies: () => new ViesMock(() => new Date("2026-09-24T10:00:00Z")),
      ecb: () => new EcbMock(),
      kvk: (_modus, naam) => new KvkMock(naam, () => new Date("2026-09-24T10:00:00Z")),
      ...extra,
    };
    return { d, rpc };
  }

  it("vies: slaat het resultaat op met de bron (mock/live)", async () => {
    const { d, rpc } = deps({}, { sla_verificatie_op: 2 });
    const r = await verrijkingHandlers(d).vies(taak("vies", { btw_nummer: "NL123456789B99" }));
    expect(rpc).toHaveBeenCalledWith("sla_verificatie_op", expect.objectContaining({
      p_organisatie_id: "o1", p_soort: "vies", p_sleutel: "NL123456789B99", p_uitkomst: "ongeldig", p_bron: "mock",
    }));
    expect(r).toMatchObject({ omschrijving: "btw-nummer NL123456789B99 is ongeldig", facturen_bijgewerkt: 2 });
  });

  it("ecb: haalt de koers op en rekent de factuur om", async () => {
    const { d, rpc } = deps({ modus: async () => "live", ecb: () => new EcbMock() }, { zoek_wisselkoers: [], verwerk_wisselkoers: 5162.62 });
    const r = await verrijkingHandlers(d).ecb(taak("ecb", { valuta: "USD", datum: "2026-09-06" }));
    expect(rpc).toHaveBeenCalledWith("verwerk_wisselkoers", {
      p_factuur_id: "f1", p_valuta: "USD", p_datum: "2026-09-06", p_koers_datum: "2026-09-04", p_koers: 1.1622, p_bron: "ecb",
    });
    expect(r.omschrijving).toBe("USD omgerekend naar € 5.162,62 (koers 1,1622 van 2026-09-04)");
  });

  it("ecb: gebruikt de cache alleen bij precies dezelfde datum", async () => {
    const ecb = { koers: vi.fn() };
    const { d } = deps({ ecb: () => ecb }, { zoek_wisselkoers: [{ datum: "2026-09-08", koers: "1.170000" }], verwerk_wisselkoers: 100 });
    const r = await verrijkingHandlers(d).ecb(taak("ecb", { valuta: "USD", datum: "2026-09-08" }));
    expect(ecb.koers).not.toHaveBeenCalled();
    expect(r).toMatchObject({ uit_cache: true, koers: 1.17 });
  });

  it("ecb: factuur intussen gewijzigd → geen fout, wel een melding", async () => {
    const { d } = deps({}, { zoek_wisselkoers: [], verwerk_wisselkoers: null });
    expect((await verrijkingHandlers(d).ecb(taak("ecb", { valuta: "USD", datum: "2026-09-08" }))).omschrijving).toMatch(/intussen gewijzigd/);
  });

  it("kvk: uitkomst gevonden / niet gevonden / uitgeschreven", async () => {
    for (const [nummer, uitkomst] of [["11111111", "gevonden"], ["11111100", "niet_gevonden"], ["11111199", "uitgeschreven"]]) {
      const { d, rpc } = deps({}, { sla_verificatie_op: 1 });
      await verrijkingHandlers(d).kvk(taak("kvk", { kvk_nummer: nummer, naam: "Bakkerij Jansen" }));
      expect(rpc).toHaveBeenCalledWith("sla_verificatie_op", expect.objectContaining({ p_sleutel: nummer, p_uitkomst: uitkomst }));
    }
  });
});
