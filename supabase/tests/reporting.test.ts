import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alsBeheerder, alsGebruiker, alsServiceRole, maakDatabase, maakGebruiker, organisatieVan, rijen, waarde } from "./db";

let db: PGlite;
let beheerder: string;
let invoerder: string;
let controller: string;
let goedkeurder: string;
let org: string;
let rekening: string;
let vandaag: string;
let nummer = 0;

/** Datum t.o.v. vandaag (Nederlandse tijd), als JJJJ-MM-DD. */
async function dag(verschil: number): Promise<string> {
  await alsBeheerder(db);
  return waarde(db, "select ((now() at time zone 'Europe/Amsterdam')::date + $1::int)::text", [verschil]);
}

async function slaOp(f: Record<string, unknown>): Promise<string> {
  await alsGebruiker(db, invoerder);
  nummer++;
  return waarde<string>(db, "select public.sla_factuur_op($1::jsonb, true)", [
    JSON.stringify({ organisatie_id: org, grootboekrekening_id: rekening, iban: "NL91ABNA0417164300", factuurnummer: `R-${nummer}`, valuta: "EUR", ...f }),
  ]);
}

async function status(id: string, ...stappen: [string, string][]): Promise<void> {
  for (const [wie, naar] of stappen) {
    await alsGebruiker(db, wie);
    await db.query("select public.wijzig_status($1, $2, $3)", [id, naar, naar === "afgekeurd" ? "Test" : null]);
  }
}

async function alsLezer(): Promise<void> {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claims', '', false)");
  await db.exec("set role reporting_lezer");
}

beforeAll(async () => {
  db = await maakDatabase();
  beheerder = await maakGebruiker(db, "beheerder@example.invalid");
  invoerder = await maakGebruiker(db, "invoerder@example.invalid");
  controller = await maakGebruiker(db, "controller@example.invalid");
  goedkeurder = await maakGebruiker(db, "goedkeurder@example.invalid");
  org = await organisatieVan(db, beheerder);
  await alsGebruiker(db, beheerder);
  await db.query("select public.voeg_lid_toe($1, 'invoerder@example.invalid', 'invoerder')", [org]);
  await db.query("select public.voeg_lid_toe($1, 'controller@example.invalid', 'controller')", [org]);
  await db.query("select public.voeg_lid_toe($1, 'goedkeurder@example.invalid', 'goedkeurder')", [org]);
  rekening = await waarde(db, "select id from public.grootboekrekeningen where organisatie_id = $1 and code = '4300'", [org]);
  vandaag = await dag(0);

  // A: niet vervallen, goedgekeurd;  B: 45 dagen over, te keuren;  C: 100 dagen over, gescand;
  // D: USD zonder koers, 10 dagen over;  E: betaald (niet open);  F: afgekeurd (niet open);  G: geen vervaldatum
  const a = await slaOp({ leverancier: "Alfa BV", totaal_incl: 1000, vervaldatum: await dag(5), factuurdatum: await dag(-25) });
  await status(a, [controller, "gecontroleerd"], [goedkeurder, "goedgekeurd"]);
  const b = await slaOp({ leverancier: "Alfa BV", totaal_incl: 200, vervaldatum: await dag(-45), factuurdatum: await dag(-75) });
  await status(b, [controller, "gecontroleerd"]);
  await slaOp({ leverancier: "Beta BV", totaal_incl: 300, vervaldatum: await dag(-100), factuurdatum: await dag(-130) });
  await slaOp({ leverancier: "Gamma Inc", totaal_incl: 400, valuta: "USD", vervaldatum: await dag(-10), factuurdatum: await dag(-40) });
  const e = await slaOp({ leverancier: "Beta BV", totaal_incl: 500, vervaldatum: await dag(-3), factuurdatum: await dag(-30) });
  await status(e, [controller, "gecontroleerd"], [goedkeurder, "goedgekeurd"], [controller, "betaald"]);
  const f = await slaOp({ leverancier: "Beta BV", totaal_incl: 600, vervaldatum: await dag(1) });
  await status(f, [goedkeurder, "afgekeurd"]);
  await slaOp({ leverancier: "Delta BV", totaal_incl: 50, vervaldatum: null, factuurdatum: await dag(-10) });
});

afterAll(async () => {
  await db.close();
});

describe("views", () => {
  it("openstaande posten: niet betaald en niet afgekeurd, met ouderdom en bedrag in euro", async () => {
    await alsLezer();
    const r = await rijen<{ leverancier: string; bedrag_eur: string | null; status_omschrijving: string; ouderdom: string; dagen_over_vervaldatum: number }>(db,
      "select leverancier, bedrag_eur::text, status_omschrijving, ouderdom, dagen_over_vervaldatum from reporting.openstaande_posten order by leverancier, bedrag");
    expect(r).toEqual([
      { leverancier: "Alfa BV", bedrag_eur: "200.00", status_omschrijving: "Te keuren", ouderdom: "31-60 dagen", dagen_over_vervaldatum: 45 },
      { leverancier: "Alfa BV", bedrag_eur: "1000.00", status_omschrijving: "Te betalen", ouderdom: "Niet vervallen", dagen_over_vervaldatum: 0 },
      { leverancier: "Beta BV", bedrag_eur: "300.00", status_omschrijving: "Te controleren", ouderdom: "Meer dan 90 dagen", dagen_over_vervaldatum: 100 },
      { leverancier: "Delta BV", bedrag_eur: "50.00", status_omschrijving: "Te controleren", ouderdom: "Geen vervaldatum", dagen_over_vervaldatum: 0 },
      { leverancier: "Gamma Inc", bedrag_eur: null, status_omschrijving: "Te controleren", ouderdom: "1-30 dagen", dagen_over_vervaldatum: 10 },
    ]);
  });

  it("crediteurenouderdom per leverancier", async () => {
    await alsLezer();
    const r = await rijen<Record<string, unknown>>(db,
      "select leverancier, aantal::int, niet_vervallen::float8, dagen_1_30::float8, dagen_31_60::float8, meer_dan_90::float8, geen_vervaldatum::float8, totaal_eur::float8, aantal_zonder_bedrag_eur::int from reporting.crediteurenouderdom order by leverancier");
    expect(r).toEqual([
      { leverancier: "Alfa BV", aantal: 2, niet_vervallen: 1000, dagen_1_30: 0, dagen_31_60: 200, meer_dan_90: 0, geen_vervaldatum: 0, totaal_eur: 1200, aantal_zonder_bedrag_eur: 0 },
      { leverancier: "Beta BV", aantal: 1, niet_vervallen: 0, dagen_1_30: 0, dagen_31_60: 0, meer_dan_90: 300, geen_vervaldatum: 0, totaal_eur: 300, aantal_zonder_bedrag_eur: 0 },
      { leverancier: "Delta BV", aantal: 1, niet_vervallen: 0, dagen_1_30: 0, dagen_31_60: 0, meer_dan_90: 0, geen_vervaldatum: 50, totaal_eur: 50, aantal_zonder_bedrag_eur: 0 },
      { leverancier: "Gamma Inc", aantal: 1, niet_vervallen: 0, dagen_1_30: 0, dagen_31_60: 0, meer_dan_90: 0, geen_vervaldatum: 0, totaal_eur: 0, aantal_zonder_bedrag_eur: 1 },
    ]);
  });

  it("cashflowprognose: vervallen = vandaag, geen vervaldatum = factuurdatum + 30, cumulatief", async () => {
    await alsLezer();
    const r = await rijen<{ verwachte_datum: string; aantal: number; bedrag_eur: number; bedrag_goedgekeurd: number; cumulatief_eur: number }>(db,
      "select verwachte_datum::text, aantal::int, bedrag_eur::float8, bedrag_goedgekeurd::float8, cumulatief_eur::float8 from reporting.cashflowprognose order by verwachte_datum");
    expect(r).toEqual([
      { verwachte_datum: vandaag, aantal: 3, bedrag_eur: 500, bedrag_goedgekeurd: 0, cumulatief_eur: 500 },
      { verwachte_datum: await dag(5), aantal: 1, bedrag_eur: 1000, bedrag_goedgekeurd: 1000, cumulatief_eur: 1500 },
      { verwachte_datum: await dag(20), aantal: 1, bedrag_eur: 50, bedrag_goedgekeurd: 0, cumulatief_eur: 1550 },
    ]);
  });

  it("doorlooptijd van goedkeuring: alleen goedgekeurde facturen, met wie en via welke weg", async () => {
    await alsLezer();
    const r = await rijen<Record<string, unknown>>(db,
      "select leverancier, status, goedgekeurd_door, gecontroleerd_door, goedgekeurd_via, keren_afgekeurd, uren_invoer_tot_goedkeuring >= 0 as positief from reporting.doorlooptijd_goedkeuring order by leverancier");
    expect(r).toEqual([
      { leverancier: "Alfa BV", status: "goedgekeurd", goedgekeurd_door: "goedkeurder@example.invalid", gecontroleerd_door: "controller@example.invalid", goedgekeurd_via: "app", keren_afgekeurd: 0, positief: true },
      { leverancier: "Beta BV", status: "betaald", goedgekeurd_door: "goedkeurder@example.invalid", gecontroleerd_door: "controller@example.invalid", goedgekeurd_via: "app", keren_afgekeurd: 0, positief: true },
    ]);
  });
});

describe("rol reporting_lezer", () => {
  it("leest alleen de views: geen tabellen, geen auth.users, niet schrijven", async () => {
    await alsLezer();
    for (const sql of [
      "select * from public.facturen",
      "select * from public.audit_log",
      "select * from public.organisatie_leden",
      "select * from auth.users",
    ]) {
      await expect(db.query(sql), sql).rejects.toThrow(/permission denied/);
    }
    // De views zijn niet schrijfbaar (en de rol heeft alleen select)
    await expect(db.query("delete from reporting.openstaande_posten")).rejects.toThrow(/permission denied|cannot delete from view/);
    await expect(db.query("delete from reporting.crediteurenouderdom")).rejects.toThrow(/permission denied|cannot delete from view/);
  });

  it("kan geen security-definerfunctie aanroepen (dus ook niet met een zelfgezette JWT een gebruiker nadoen)", async () => {
    await alsBeheerder(db);
    const r = await rijen<{ f: string }>(db, `
      select n.nspname || '.' || p.proname as f
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname in ('public', 'intern', 'reporting')
        and has_function_privilege('reporting_lezer', p.oid, 'execute')`);
    expect(r).toEqual([]);

    // Ook met een nagemaakte JWT-claim geen toegang tot gegevens
    await alsLezer();
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: beheerder, role: "authenticated" })]);
    await expect(db.query("select public.wijzig_status(gen_random_uuid(), 'betaald')")).rejects.toThrow(/permission denied/);
    await expect(db.query("select * from public.facturen")).rejects.toThrow(/permission denied/);
  });

  it("app-gebruikers en de service role zien het schema reporting niet", async () => {
    await alsGebruiker(db, beheerder);
    await expect(db.query("select * from reporting.openstaande_posten")).rejects.toThrow(/permission denied/);
    await alsServiceRole(db);
    await expect(db.query("select * from reporting.openstaande_posten")).rejects.toThrow(/permission denied/);
  });
});
