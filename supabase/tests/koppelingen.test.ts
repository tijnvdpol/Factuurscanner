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

interface Taak {
  id: string;
  soort: string;
  status: string;
  pogingen: number;
  laatste_fout: string | null;
  volgende_poging_op: string;
}

let db: PGlite;
let beheerder: string;
let invoerder: string;
let goedkeurder: string;
let buitenstaander: string;
let org: string;
let rekening: string;
let factuur: string;

async function planTaak(soort: string, sleutel: string, factuurId: string | null = null): Promise<string> {
  await alsBeheerder(db);
  return waarde<string>(db, "select intern.plan_taak($1, $2, $3, $4)", [org, soort, sleutel, factuurId]);
}

async function taak(id: string): Promise<Taak> {
  await alsBeheerder(db);
  const [t] = await rijen<Taak>(db, "select * from public.koppeling_taken where id = $1", [id]);
  return t;
}

async function claim(soorten: string[] | null = null): Promise<Taak[]> {
  await alsServiceRole(db);
  return rijen<Taak>(db, "select * from public.claim_taken(10, $1)", [soorten]);
}

async function rondAf(id: string, gelukt: boolean, fout: string | null = null, opnieuw = true, resultaat: object | null = null) {
  await alsServiceRole(db);
  return waarde<string>(db, "select public.rond_taak_af($1, $2, $3::jsonb, $4, $5)", [
    id, gelukt, resultaat ? JSON.stringify(resultaat) : null, fout, opnieuw,
  ]);
}

/** Maakt alle wachtende taken direct klaar om te draaien (in plaats van de wachttijd af te wachten). */
async function maakKlaar() {
  await alsBeheerder(db);
  await db.exec("update public.koppeling_taken set volgende_poging_op = now() - interval '1 second' where status = 'wachtrij'");
}

beforeAll(async () => {
  db = await maakDatabase();
  beheerder = await maakGebruiker(db, "beheerder@example.invalid");
  invoerder = await maakGebruiker(db, "invoerder@example.invalid");
  goedkeurder = await maakGebruiker(db, "goedkeurder@example.invalid");
  buitenstaander = await maakGebruiker(db, "buiten@example.invalid");
  org = await organisatieVan(db, beheerder);
  await alsGebruiker(db, beheerder);
  await db.query("select public.voeg_lid_toe($1, 'invoerder@example.invalid', 'invoerder')", [org]);
  await db.query("select public.voeg_lid_toe($1, 'goedkeurder@example.invalid', 'goedkeurder', 5000)", [org]);
  rekening = await waarde(db, "select id from public.grootboekrekeningen where organisatie_id = $1 and code = '4300'", [org]);
  await alsGebruiker(db, invoerder);
  factuur = await waarde<string>(db, "select public.sla_factuur_op($1::jsonb)", [
    JSON.stringify({
      organisatie_id: org, leverancier: "Koppel BV", factuurnummer: "K-1", totaal_incl: 121,
      iban: "NL91ABNA0417164300", grootboekrekening_id: rekening,
      btw_regels: [{ tarief: 21, grondslag: 100, btw_bedrag: 21 }],
    }),
  ]);
});

afterAll(async () => {
  await db.close();
});

describe("audit log: bron en systeem", () => {
  it("een actie in de app heeft bron 'app' en de gebruiker", async () => {
    await alsBeheerder(db);
    const [regel] = await rijen<{ bron: string; user_id: string }>(
      db, "select bron, user_id from public.audit_log where tabel = 'facturen' and record_id = $1 and actie = 'insert'", [factuur],
    );
    expect(regel).toEqual({ bron: "app", user_id: invoerder });
  });

  it("een wijziging zonder gebruiker is 'systeem'", async () => {
    await alsBeheerder(db);
    await db.query("update public.leveranciers set btw_nummer = 'NL123456789B01' where organisatie_id = $1", [org]);
    const [regel] = await rijen<{ bron: string; user_id: string | null }>(
      db, "select bron, user_id from public.audit_log where tabel = 'leveranciers' and actie = 'update' order by id desc limit 1",
    );
    expect(regel).toEqual({ bron: "systeem", user_id: null });
  });

  it("wijzig_status_als legt de gebruiker en bron vast (zoals goedkeuren via mail)", async () => {
    await alsGebruiker(db, invoerder);
    await db.query("select public.wijzig_status($1, 'gecontroleerd')", [factuur]);
    // Een server-functie (hier de superuser) keurt goed namens de goedkeurder
    await alsBeheerder(db);
    await db.query("select intern.wijzig_status_als($1, $2, 'goedgekeurd', null, 'email')", [goedkeurder, factuur]);
    const [regel] = await rijen<{ actie: string; bron: string; user_id: string }>(
      db,
      "select actie, bron, user_id from public.audit_log where tabel = 'facturen' and record_id = $1 order by id desc limit 1",
      [factuur],
    );
    expect(regel).toEqual({ actie: "statuswijziging", bron: "email", user_id: goedkeurder });
    expect(await waarde(db, "select goedgekeurd_door from public.facturen where id = $1", [factuur])).toBe(goedkeurder);
    // De audit-context lekt niet naar volgende regels in dezelfde transactie
    expect(await waarde(db, "select coalesce(current_setting('factuurscanner.audit_bron', true), '')")).toBe("");
  });

  it("wijzig_status_als doet dezelfde controles: functiescheiding geldt ook via mail", async () => {
    await alsGebruiker(db, invoerder);
    const f = await waarde<string>(db, "select public.sla_factuur_op($1::jsonb)", [
      JSON.stringify({ organisatie_id: org, leverancier: "Koppel BV", factuurnummer: "K-2", totaal_incl: 50,
        iban: "NL91ABNA0417164300", grootboekrekening_id: rekening }),
    ]);
    await db.query("select public.wijzig_status($1, 'gecontroleerd')", [f]);
    await alsBeheerder(db);
    await expect(db.query("select intern.wijzig_status_als($1, $2, 'goedgekeurd', null, 'email')", [invoerder, f]))
      .rejects.toThrow(/rol \(invoerder\)/);
    await expect(db.query("select intern.wijzig_status_als($1, $2, 'goedgekeurd', null, 'email')", [buitenstaander, f]))
      .rejects.toThrow(/niet gevonden/);
  });

  it("de service role kan de status niet rechtstreeks wijzigen", async () => {
    await alsServiceRole(db);
    await expect(db.query("update public.facturen set status = 'betaald' where id = $1", [factuur]))
      .rejects.toThrow(/workflowknoppen/);
  });

  it("de service role kan de audit log niet wijzigen", async () => {
    await alsServiceRole(db);
    await expect(db.exec("delete from public.audit_log")).rejects.toThrow(/niet worden gewijzigd/);
  });
});

describe("koppeling_instellingen", () => {
  it("de beheerder stelt de modus in; dat staat in de audit log", async () => {
    await alsGebruiker(db, beheerder);
    await db.query("select public.stel_koppeling_in($1, 'vies', 'live', null)", [org]);
    await db.query("select public.stel_koppeling_in($1, 'boekhouding', 'mock', '{\"provider\": \"exact\"}'::jsonb)", [org]);
    await db.query("select public.stel_koppeling_in($1, 'vies', 'mock', null)", [org]);
    const lijst = await rijen<{ koppeling: string; modus: string; config: object }>(
      db, "select koppeling, modus, config from public.koppeling_instellingen where organisatie_id = $1 order by koppeling", [org],
    );
    expect(lijst).toEqual([
      { koppeling: "boekhouding", modus: "mock", config: { provider: "exact" } },
      { koppeling: "vies", modus: "mock", config: {} },
    ]);
    await alsBeheerder(db);
    const log = await rijen<{ actie: string; user_id: string; gewijzigde_velden: string[] | null }>(
      db, "select actie, user_id, gewijzigde_velden from public.audit_log where tabel = 'koppeling_instellingen' order by id",
    );
    expect(log.map((r) => r.actie)).toEqual(["insert", "insert", "update"]);
    expect(log[2].gewijzigde_velden).toEqual(["modus"]);
    expect(log.every((r) => r.user_id === beheerder)).toBe(true);
  });

  it("alleen de beheerder mag instellen, en niet rechtstreeks in de tabel", async () => {
    await alsGebruiker(db, invoerder);
    await expect(db.query("select public.stel_koppeling_in($1, 'vies', 'live', null)", [org])).rejects.toThrow(/beheerder/);
    await expect(db.query("update public.koppeling_instellingen set modus = 'live'")).rejects.toThrow(/permission denied/);
    await alsGebruiker(db, beheerder);
    await expect(db.query("select public.stel_koppeling_in($1, 'vies', 'aan', null)", [org])).rejects.toThrow(/live.*mock/);
    await expect(db.query("select public.stel_koppeling_in($1, 'onbekend', 'live', null)", [org])).rejects.toThrow(/check/);
  });

  it("een andere organisatie ziet de instellingen niet", async () => {
    await alsGebruiker(db, buitenstaander);
    expect(await waarde(db, "select count(*)::int from public.koppeling_instellingen")).toBe(0);
    await expect(db.query("select public.stel_koppeling_in($1, 'vies', 'live', null)", [org])).rejects.toThrow(/beheerder/);
  });
});

describe("takenwachtrij", () => {
  it("dezelfde sleutel geeft dezelfde actieve taak (idempotent)", async () => {
    const a = await planTaak("vies", "NL123456789B01", factuur);
    const b = await planTaak("vies", "NL123456789B01", factuur);
    expect(b).toBe(a);
    const c = await planTaak("vies", "DE123456789", factuur);
    expect(c).not.toBe(a);
  });

  it("gebruikers kunnen geen taken claimen, afronden of rechtstreeks schrijven", async () => {
    await alsGebruiker(db, beheerder);
    await expect(db.query("select * from public.claim_taken()")).rejects.toThrow(/permission denied/);
    await expect(db.query("select public.rond_taak_af(gen_random_uuid(), true)")).rejects.toThrow(/permission denied/);
    await expect(db.query("insert into public.koppeling_taken (organisatie_id, soort, sleutel) values ($1, 'vies', 'x')", [org]))
      .rejects.toThrow(/permission denied/);
    await expect(db.query("select intern.plan_taak($1, 'vies', 'x')", [org])).rejects.toThrow(/permission denied/);
  });

  it("claim pakt alleen taken die klaar zijn, en verhoogt het aantal pogingen", async () => {
    await alsBeheerder(db);
    await db.exec("update public.koppeling_taken set status = 'gelukt' where status <> 'gelukt'");
    const later = await waarde<string>(
      db, "select intern.plan_taak($1, 'ecb', 'USD-2026-09-01', null, '{}'::jsonb, interval '1 hour')", [org],
    );
    const nu = await planTaak("ecb", "USD-2026-09-02");
    const geclaimd = await claim();
    expect(geclaimd.map((t) => t.id)).toEqual([nu]);
    expect(geclaimd[0]).toMatchObject({ status: "bezig", pogingen: 1 });
    expect((await taak(later)).status).toBe("wachtrij");
    // Een tweede claim pakt de taak die al bezig is niet nog eens
    expect(await claim()).toEqual([]);
    await rondAf(nu, true);
  });

  it("filtert op soort", async () => {
    const vies = await planTaak("vies", "filter-1");
    const kvk = await planTaak("kvk", "filter-1");
    const geclaimd = await claim(["kvk"]);
    expect(geclaimd.map((t) => t.id)).toEqual([kvk]);
    expect((await taak(vies)).status).toBe("wachtrij");
    await rondAf(kvk, true);
    await claim(["vies"]);
    await rondAf(vies, true);
  });

  it("mislukt: nieuwe poging met oplopende wachttijd, na het maximum opgegeven + audit log", async () => {
    const id = await planTaak("vies", "retry-1", factuur);
    await alsBeheerder(db);
    await db.query("update public.koppeling_taken set max_pogingen = 3 where id = $1", [id]);

    await claim(["vies"]);
    expect(await rondAf(id, false, "VIES: MS_UNAVAILABLE")).toBe("wachtrij");
    const na1 = await taak(id);
    expect(na1.laatste_fout).toBe("VIES: MS_UNAVAILABLE");
    await alsBeheerder(db);
    const wacht = await waarde<number>(db, "select extract(epoch from volgende_poging_op - now())::int from public.koppeling_taken where id = $1", [id]);
    expect(wacht).toBeGreaterThan(50);
    expect(wacht).toBeLessThanOrEqual(60);

    // Nog niet klaar: niet te claimen
    expect(await claim(["vies"])).toEqual([]);
    await maakKlaar();
    await claim(["vies"]);
    expect(await rondAf(id, false, "VIES: TIMEOUT")).toBe("wachtrij");
    await alsBeheerder(db);
    const wacht2 = await waarde<number>(db, "select extract(epoch from volgende_poging_op - now())::int from public.koppeling_taken where id = $1", [id]);
    expect(wacht2).toBeGreaterThan(290);

    await maakKlaar();
    await claim(["vies"]);
    expect(await rondAf(id, false, "VIES: TIMEOUT")).toBe("opgegeven");

    await alsGebruiker(db, invoerder);
    const [log] = await rijen<{ actie: string; bron: string; user_id: string | null; toelichting: string; nieuw: Record<string, unknown> }>(
      db, "select actie, bron, user_id, toelichting, nieuw from public.factuur_historie($1) where actie = 'verrijking'", [factuur],
    );
    expect(log).toMatchObject({ actie: "verrijking", bron: "vies", user_id: null, toelichting: "VIES: TIMEOUT" });
    expect(log.nieuw).toMatchObject({ taak_id: id, status: "opgegeven", pogingen: 3 });
  });

  it("een fout die een nieuwe poging niet oplost, geeft direct op", async () => {
    const id = await planTaak("boekhouding", "direct-op", factuur);
    await claim(["boekhouding"]);
    expect(await rondAf(id, false, "Grootboekrekening 4300 is niet gekoppeld.", false)).toBe("opgegeven");
    expect((await taak(id)).pogingen).toBe(1);
  });

  it("gelukt: resultaat bewaard en in de historie van de factuur", async () => {
    const id = await planTaak("kvk", "gelukt-1", factuur);
    await claim(["kvk"]);
    expect(await rondAf(id, true, null, true, { omschrijving: "KvK-gegevens opgehaald" })).toBe("gelukt");
    await alsGebruiker(db, invoerder);
    const log = await rijen<{ bron: string; nieuw: Record<string, unknown> }>(
      db, "select bron, nieuw from public.factuur_historie($1) where bron = 'kvk'", [factuur],
    );
    expect(log.at(-1)?.nieuw).toMatchObject({ omschrijving: "KvK-gegevens opgehaald", status: "gelukt" });
  });

  it("een vastgelopen taak komt na 10 minuten terug in de wachtrij", async () => {
    const id = await planTaak("ecb", "vastgelopen");
    await claim(["ecb"]);
    await alsBeheerder(db);
    await db.query("update public.koppeling_taken set geclaimd_op = now() - interval '11 minutes' where id = $1", [id]);
    const geclaimd = await claim(["ecb"]);
    expect(geclaimd.map((t) => t.id)).toEqual([id]);
    expect(geclaimd[0].pogingen).toBe(2);
    await rondAf(id, true);
  });

  it("opnieuw proberen: elk lid van de organisatie, niet een buitenstaander", async () => {
    const id = await planTaak("boekhouding", "opnieuw-1", factuur);
    await claim(["boekhouding"]);
    await rondAf(id, false, "Moneybird: 503", false);

    await alsGebruiker(db, buitenstaander);
    await expect(db.query("select public.probeer_taak_opnieuw($1)", [id])).rejects.toThrow(/niet gevonden/);

    await alsGebruiker(db, invoerder);
    await db.query("select public.probeer_taak_opnieuw($1)", [id]);
    expect(await taak(id)).toMatchObject({ status: "wachtrij", pogingen: 0 });
    await alsGebruiker(db, invoerder);
    await expect(db.query("select public.probeer_taak_opnieuw($1)", [id])).resolves.toBeDefined();

    await alsBeheerder(db);
    const [log] = await rijen<{ user_id: string; bron: string; actie: string }>(
      db, "select user_id, bron, actie from public.audit_log where nieuw ->> 'taak_id' = $1 and nieuw ->> 'omschrijving' = 'Handmatig opnieuw geprobeerd' limit 1", [id],
    );
    expect(log).toEqual({ user_id: invoerder, bron: "app", actie: "export" });

    await claim(["boekhouding"]);
    await rondAf(id, true);
    await alsGebruiker(db, invoerder);
    await expect(db.query("select public.probeer_taak_opnieuw($1)", [id])).rejects.toThrow(/al in behandeling of gelukt/);
  });

  it("testtaak: controller en beheerder, niet de invoerder; wordt niet gelogd", async () => {
    await alsGebruiker(db, invoerder);
    await expect(db.query("select public.plan_testtaak($1)", [org])).rejects.toThrow(/controller of beheerder/);
    await alsGebruiker(db, beheerder);
    const id = await waarde<string>(db, "select public.plan_testtaak($1)", [org]);
    await claim(["test"]);
    await rondAf(id, true, null, true, { bericht: "pong" });
    await alsBeheerder(db);
    expect(await waarde(db, "select count(*)::int from public.audit_log where nieuw ->> 'taak_id' = $1", [id])).toBe(0);
  });

  it("de statusview toont de laatste taak per soort, alleen voor leden", async () => {
    await alsGebruiker(db, invoerder);
    const status = await rijen<{ soort: string; status: string }>(
      db, "select soort, status from public.factuur_koppelingstatus where factuur_id = $1 order by soort", [factuur],
    );
    expect(status).toEqual([
      { soort: "boekhouding", status: "gelukt" },
      // Sinds fase 4.4: mail over de opgegeven export (en eerder het goedkeuringsverzoek)
      { soort: "email", status: "wachtrij" },
      { soort: "kvk", status: "gelukt" },
      { soort: "vies", status: "opgegeven" },
    ]);
    await alsGebruiker(db, buitenstaander);
    expect(await waarde(db, "select count(*)::int from public.factuur_koppelingstatus")).toBe(0);
    expect(await waarde(db, "select count(*)::int from public.koppeling_taken")).toBe(0);
  });

  it("anon heeft nergens toegang", async () => {
    await alsGebruiker(db, null);
    await expect(db.query("select * from public.koppeling_taken")).rejects.toThrow(/permission denied/);
    await expect(db.query("select * from public.koppeling_instellingen")).rejects.toThrow(/permission denied/);
    await expect(db.query("select * from public.factuur_koppelingstatus")).rejects.toThrow(/permission denied/);
    await expect(db.query("select public.plan_testtaak(gen_random_uuid())")).rejects.toThrow(/permission denied/);
  });
});
