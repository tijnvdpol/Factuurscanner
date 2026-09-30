import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alsBeheerder,
  alsGebruiker,
  alsServiceRole,
  maakDatabase,
  maakGebruiker,
  organisatieVan,
  rijen,
  waarde,
} from "./db";

let db: PGlite;
let beheerder: string;
let invoerder: string;
let goedkeurder: string;
let org: string;
let rekening: string;

async function slaOp(f: Record<string, unknown>): Promise<string> {
  await alsGebruiker(db, invoerder);
  return waarde<string>(db, "select public.sla_factuur_op($1::jsonb, true)", [
    JSON.stringify({ organisatie_id: org, grootboekrekening_id: rekening, iban: "NL91ABNA0417164300", ...f }),
  ]);
}

async function taken(soort: string): Promise<{ id: string; sleutel: string; factuur_id: string; payload: Record<string, unknown>; status: string }[]> {
  await alsBeheerder(db);
  return rijen(db, "select id, sleutel, factuur_id, payload, status from public.koppeling_taken where soort = $1 order by created_at", [soort]);
}

async function signalen(factuurId: string, type: string): Promise<{ sleutel: string; bericht: string }[]> {
  await alsBeheerder(db);
  return rijen(db, "select sleutel, bericht from public.factuur_signalen where factuur_id = $1 and type = $2 and not opgelost order by sleutel", [factuurId, type]);
}

async function verificatie(soort: string, sleutel: string, uitkomst: string, details: object = {}): Promise<number> {
  await alsServiceRole(db);
  return waarde<number>(db, "select public.sla_verificatie_op($1, $2, $3, $4, $5::jsonb, 'mock')", [
    org, soort, sleutel, uitkomst, JSON.stringify(details),
  ]);
}

async function euroVan(id: string) {
  await alsBeheerder(db);
  const [r] = await rijen<{ bedrag_eur: string | null; koers: string | null; koers_datum: string | null; koers_bron: string | null }>(
    db, "select bedrag_eur, koers, koers_datum::text, koers_bron from public.facturen where id = $1", [id],
  );
  return r;
}

beforeAll(async () => {
  db = await maakDatabase();
  beheerder = await maakGebruiker(db, "beheerder@example.invalid");
  invoerder = await maakGebruiker(db, "invoerder@example.invalid");
  goedkeurder = await maakGebruiker(db, "goedkeurder@example.invalid");
  org = await organisatieVan(db, beheerder);
  await alsGebruiker(db, beheerder);
  await db.query("select public.voeg_lid_toe($1, 'invoerder@example.invalid', 'invoerder')", [org]);
  await db.query("select public.voeg_lid_toe($1, 'goedkeurder@example.invalid', 'goedkeurder', 5000)", [org]);
  rekening = await waarde(db, "select id from public.grootboekrekeningen where organisatie_id = $1 and code = '4300'", [org]);
});

afterAll(async () => {
  await db.close();
});

describe("omrekening naar euro", () => {
  it("euro: bedrag_eur = totaal; vreemde valuta: leeg en een ecb-taak", async () => {
    const eur = await slaOp({ leverancier: "Euro BV", factuurnummer: "E-1", totaal_incl: 121, valuta: "EUR" });
    expect(await euroVan(eur)).toEqual({ bedrag_eur: "121.00", koers: null, koers_datum: null, koers_bron: null });

    const usd = await slaOp({ leverancier: "Dollar Inc", factuurnummer: "U-1", totaal_incl: 6000, valuta: "USD", factuurdatum: "2026-09-05" });
    expect((await euroVan(usd)).bedrag_eur).toBeNull();
    const ecb = (await taken("ecb")).filter((t) => t.factuur_id === usd);
    expect(ecb).toHaveLength(1);
    expect(ecb[0]).toMatchObject({ sleutel: `${usd}:USD:2026-09-05`, payload: { valuta: "USD", datum: "2026-09-05" } });
    expect((await taken("ecb")).some((t) => t.factuur_id === eur)).toBe(false);
  });

  it("de worker vult de koers in; audit met bron ecb en zonder gebruiker", async () => {
    const usd = await slaOp({ leverancier: "Dollar Inc", factuurnummer: "U-2", totaal_incl: 6000, valuta: "USD", factuurdatum: "2026-09-05" });
    await alsServiceRole(db);
    expect(Number(await waarde(db, "select public.verwerk_wisselkoers($1, 'USD', '2026-09-05', '2026-09-04', 1.1622, 'ecb')", [usd])))
      .toBe(5162.62);
    expect(await euroVan(usd)).toEqual({ bedrag_eur: "5162.62", koers: "1.162200", koers_datum: "2026-09-04", koers_bron: "ecb" });
    await alsBeheerder(db);
    const [log] = await rijen<{ bron: string; user_id: string | null; gewijzigde_velden: string[] }>(
      db, "select bron, user_id, gewijzigde_velden from public.audit_log where record_id = $1 and actie = 'update' order by id desc limit 1", [usd],
    );
    expect(log).toEqual({ bron: "ecb", user_id: null, gewijzigde_velden: ["bedrag_eur", "koers", "koers_bron", "koers_datum"] });
    // En de koers staat in de cache
    await alsServiceRole(db);
    expect(await rijen(db, "select datum::text, koers::float8 as koers from public.zoek_wisselkoers('USD', '2026-09-06', 'ecb')"))
      .toEqual([{ datum: "2026-09-04", koers: 1.1622 }]);
  });

  it("een gewijzigde factuur krijgt de oude koers niet; bij een nieuw bedrag wordt opnieuw omgerekend", async () => {
    const usd = await slaOp({ leverancier: "Dollar Inc", factuurnummer: "U-3", totaal_incl: 100, valuta: "USD", factuurdatum: "2026-09-05" });
    await slaOp({ id: usd, leverancier: "Dollar Inc", factuurnummer: "U-3", totaal_incl: 100, valuta: "GBP", factuurdatum: "2026-09-05" });
    await alsServiceRole(db);
    expect(await waarde(db, "select public.verwerk_wisselkoers($1, 'USD', '2026-09-05', '2026-09-04', 1.1622, 'ecb')", [usd])).toBeNull();
    expect((await euroVan(usd)).bedrag_eur).toBeNull();
    expect((await taken("ecb")).filter((t) => t.factuur_id === usd).map((t) => t.sleutel))
      .toEqual([`${usd}:USD:2026-09-05`, `${usd}:GBP:2026-09-05`]);

    await alsServiceRole(db);
    await db.query("select public.verwerk_wisselkoers($1, 'GBP', '2026-09-05', '2026-09-04', 0.8641, 'mock')", [usd]);
    expect((await euroVan(usd)).bedrag_eur).toBe("115.73");
    await slaOp({ id: usd, leverancier: "Dollar Inc", factuurnummer: "U-3", totaal_incl: 200, valuta: "GBP", factuurdatum: "2026-09-05" });
    expect(await euroVan(usd)).toEqual({ bedrag_eur: null, koers: null, koers_datum: null, koers_bron: null });
  });

  it("gebruikers en de service role kunnen bedrag_eur niet zelf zetten", async () => {
    const eur = await slaOp({ leverancier: "Euro BV", factuurnummer: "E-2", totaal_incl: 50 });
    await alsGebruiker(db, invoerder);
    await expect(db.query("update public.facturen set bedrag_eur = 1 where id = $1", [eur])).rejects.toThrow(/permission denied/);
    await alsServiceRole(db);
    await db.query("update public.facturen set bedrag_eur = 1, koers = 2 where id = $1", [eur]);
    expect(await euroVan(eur)).toMatchObject({ bedrag_eur: "50.00", koers: null });
    await alsGebruiker(db, invoerder);
    await expect(db.query("select public.verwerk_wisselkoers($1, 'USD', '2026-09-05', '2026-09-04', 1, 'ecb')", [eur]))
      .rejects.toThrow(/permission denied/);
  });
});

describe("goedkeuringslimiet in euro", () => {
  async function gecontroleerd(totaal: number, valuta: string, nummer: string): Promise<string> {
    const id = await slaOp({ leverancier: "Limiet Ltd", factuurnummer: nummer, totaal_incl: totaal, valuta, factuurdatum: "2026-09-07" });
    await alsGebruiker(db, beheerder);
    await db.query("select public.wijzig_status($1, 'gecontroleerd')", [id]);
    return id;
  }

  it("zonder koers: geblokkeerd voor een goedkeurder met limiet", async () => {
    const id = await gecontroleerd(4000, "USD", "L-1");
    await alsGebruiker(db, goedkeurder);
    await expect(db.query("select public.wijzig_status($1, 'goedgekeurd')", [id])).rejects.toThrow(/wisselkoers voor USD is nog niet bekend/);
  });

  it("USD 6.000 ≈ € 5.162,62 is boven een limiet van € 5.000, ook al zou 'EUR 6.000' dat ook zijn", async () => {
    const id = await gecontroleerd(6000, "USD", "L-2");
    await alsServiceRole(db);
    await db.query("select public.verwerk_wisselkoers($1, 'USD', '2026-09-07', '2026-09-07', 1.1622, 'ecb')", [id]);
    await alsGebruiker(db, goedkeurder);
    await expect(db.query("select public.wijzig_status($1, 'goedgekeurd')", [id])).rejects.toThrow(/Boven je goedkeuringslimiet van € 5.000/);
  });

  it("JPY 700.000 ≈ € 4.060 is binnen de limiet (vroeger: 700.000 > 5.000)", async () => {
    const id = await gecontroleerd(700000, "JPY", "L-3");
    await alsServiceRole(db);
    await db.query("select public.verwerk_wisselkoers($1, 'JPY', '2026-09-07', '2026-09-07', 172.41, 'ecb')", [id]);
    await alsGebruiker(db, goedkeurder);
    await db.query("select public.wijzig_status($1, 'goedgekeurd')", [id]);
    expect(await waarde(db, "select status from public.facturen where id = $1", [id])).toBe("goedgekeurd");
  });

  it("net onder limiet wordt in euro bepaald (na de koers)", async () => {
    const id = await slaOp({ leverancier: "Limiet Ltd", factuurnummer: "L-4", totaal_incl: 5700, valuta: "USD", factuurdatum: "2026-09-07" });
    expect(await signalen(id, "net_onder_limiet")).toEqual([]);
    await alsServiceRole(db);
    // 5700 / 1.1622 = 4904,49 → binnen 5% onder € 5.000
    await db.query("select public.verwerk_wisselkoers($1, 'USD', '2026-09-07', '2026-09-07', 1.1622, 'ecb')", [id]);
    expect((await signalen(id, "net_onder_limiet")).map((s) => s.sleutel)).toEqual(["5000.00"]);
  });
});

describe("VIES", () => {
  it("plant een controle per btw-nummer (EU), niet voor ongeldige of niet-EU-nummers", async () => {
    await slaOp({ leverancier: "Vies BV", factuurnummer: "V-1", btw_nummer: "NL123456789B99" });
    await slaOp({ leverancier: "Vies BV", factuurnummer: "V-2", btw_nummer: "NL123456789B99" });
    await slaOp({ leverancier: "Swiss AG", factuurnummer: "V-3", btw_nummer: "CHE123456789" });
    await slaOp({ leverancier: "Fout BV", factuurnummer: "V-4", btw_nummer: "NL12" });
    expect((await taken("vies")).map((t) => t.sleutel)).toEqual(["NL123456789B99"]);
  });

  it("ongeldig → signaal op alle facturen met dit nummer; later geldig → signaal weg", async () => {
    const f1 = await slaOp({ leverancier: "Vies2 BV", factuurnummer: "V2-1", btw_nummer: "BE0123456799" });
    const f2 = await slaOp({ leverancier: "Vies2 BV", factuurnummer: "V2-2", btw_nummer: "BE0123456799" });
    expect(await verificatie("vies", "BE0123456799", "ongeldig")).toBe(2);
    expect((await signalen(f1, "btw_vies_ongeldig"))[0].bericht).toMatch(/BE0123456799 is volgens VIES .* niet geldig/);
    expect(await signalen(f2, "btw_vies_ongeldig")).toHaveLength(1);

    await verificatie("vies", "BE0123456799", "geldig", { naam: "Vies2 BV" });
    expect(await signalen(f1, "btw_vies_ongeldig")).toEqual([]);
  });

  it("met een recent resultaat wordt niet opnieuw gecontroleerd; het signaal komt er wel meteen", async () => {
    await verificatie("vies", "DE123456799", "ongeldig");
    const f = await slaOp({ leverancier: "Deutsch GmbH", factuurnummer: "D-1", btw_nummer: "DE123456799" });
    expect((await taken("vies")).some((t) => t.sleutel === "DE123456799")).toBe(false);
    expect(await signalen(f, "btw_vies_ongeldig")).toHaveLength(1);
  });

  it("het resultaat staat in de audit log (bron vies, systeem) en is alleen voor leden leesbaar", async () => {
    await alsBeheerder(db);
    const log = await rijen<{ bron: string; user_id: string | null }>(
      db, "select bron, user_id from public.audit_log where tabel = 'verificaties' and nieuw ->> 'sleutel' = 'BE0123456799'",
    );
    expect(log).toEqual([{ bron: "vies", user_id: null }]);
    const buiten = await maakGebruiker(db, "buiten-vies@example.invalid");
    await alsGebruiker(db, buiten);
    expect(await waarde(db, "select count(*)::int from public.verificaties")).toBe(0);
    await alsGebruiker(db, invoerder);
    expect(await waarde(db, "select count(*)::int from public.verificaties")).toBeGreaterThan(0);
    await expect(db.query("select public.sla_verificatie_op($1, 'vies', 'NL1', 'geldig', '{}'::jsonb, 'mock')", [org]))
      .rejects.toThrow(/permission denied/);
  });
});

describe("KvK", () => {
  it("plant een controle bij een (nieuw) KvK-nummer, met de naam van de factuur", async () => {
    await slaOp({ leverancier: "Test B.V. Donald", factuurnummer: "K-1", kvk_nummer: "68750110" });
    expect((await taken("kvk")).find((t) => t.sleutel === "68750110")?.payload).toEqual({ kvk_nummer: "68750110", naam: "Test B.V. Donald" });
  });

  const donald = { naam: "Test BV Donald", statutaire_naam: "Test BV Donald", handelsnamen: ["Test BV Donald", "Donald Nevenvestiging"] };

  it("naam komt overeen (rechtsvorm en leestekens tellen niet) → geen signaal", async () => {
    const f = await slaOp({ leverancier: "Test B.V. Donald", factuurnummer: "K-2", kvk_nummer: "68750110" });
    await verificatie("kvk", "68750110", "gevonden", donald);
    expect(await signalen(f, "kvk_afwijking")).toEqual([]);
  });

  it("andere naam → waarschuwing; handelsnaam telt ook", async () => {
    const f = await slaOp({ leverancier: "Katrien Kappers", factuurnummer: "K-3", kvk_nummer: "68750110" });
    const handelsnaam = await slaOp({ leverancier: "Donald Nevenvestiging", factuurnummer: "K-4", kvk_nummer: "68750110" });
    await verificatie("kvk", "68750110", "gevonden", donald);
    const [s] = await signalen(f, "kvk_afwijking");
    expect(s.bericht).toMatch(/De naam op de factuur \(Katrien Kappers\) komt niet overeen met de KvK-gegevens van 68750110 \(Test BV Donald\)/);
    expect(await signalen(handelsnaam, "kvk_afwijking")).toEqual([]);
  });

  it("niet gevonden en uitgeschreven", async () => {
    const weg = await slaOp({ leverancier: "Spook BV", factuurnummer: "K-5", kvk_nummer: "11111100" });
    await verificatie("kvk", "11111100", "niet_gevonden");
    expect((await signalen(weg, "kvk_afwijking"))[0].bericht).toBe("KvK-nummer 11111100 komt niet voor in het Handelsregister.");

    const oud = await slaOp({ leverancier: "Oud Bedrijf", factuurnummer: "K-6", kvk_nummer: "87654321" });
    await verificatie("kvk", "87654321", "uitgeschreven", { naam: "Oud Bedrijf V.O.F.", handelsnamen: ["Oud Bedrijf"], datum_einde: "2025-06-30" });
    expect((await signalen(oud, "kvk_afwijking")).map((s) => s.bericht))
      .toEqual(["Oud Bedrijf V.O.F. (KvK 87654321) staat volgens de KvK uitgeschreven sinds 30-06-2025."]);
  });

  it("een opgelost KvK-signaal komt niet terug bij opnieuw opslaan", async () => {
    const f = await slaOp({ leverancier: "Spook BV", factuurnummer: "K-7", kvk_nummer: "11111100" });
    await alsGebruiker(db, invoerder);
    const id = await waarde<string>(db, "select id from public.factuur_signalen where factuur_id = $1 and type = 'kvk_afwijking'", [f]);
    await db.query("select public.los_signaal_op($1, 'Nieuw bedrijf, inschrijving loopt')", [id]);
    await slaOp({ id: f, leverancier: "Spook BV", factuurnummer: "K-7", kvk_nummer: "11111100", totaal_incl: 10 });
    expect(await signalen(f, "kvk_afwijking")).toEqual([]);
  });
});

describe("bedrijfsnamen vergelijken", () => {
  it.each([
    ["Test B.V.", "test bv", true],
    ["Bakkerij Jansen", "Bakkerij Jansen V.O.F.", true],
    ["Café 't Hoekje", "Cafe t Hoekje", true],
    ["Donald", "Test BV Donald", true],
    ["BV", "Test BV Donald", false],
    ["Katrien Kappers", "Test BV Donald", false],
    ["Acme Ltd", "ACME Limited", true],
  ])("%s ~ %s → %s", async (a, b, verwacht) => {
    await alsBeheerder(db);
    expect(await waarde(db, "select intern.naam_komt_overeen($1, array[$2])", [a, b])).toBe(verwacht);
  });
});

describe("wisselkoersen", () => {
  it("leesbaar voor ingelogde gebruikers, niet voor anon; niet te schrijven", async () => {
    await alsGebruiker(db, invoerder);
    expect(await waarde<number>(db, "select count(*)::int from public.wisselkoersen")).toBeGreaterThan(0);
    await expect(db.query("insert into public.wisselkoersen (valuta, datum, koers, bron) values ('USD', '2026-01-01', 1, 'ecb')"))
      .rejects.toThrow(/permission denied/);
    await alsGebruiker(db, null);
    await expect(db.query("select * from public.wisselkoersen")).rejects.toThrow(/permission denied/);
  });
});
