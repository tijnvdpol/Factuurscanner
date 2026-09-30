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
let controller: string;
let goedkeurder: string;
let buitenstaander: string;
let org: string;
let rekening: string;
let nummer = 0;

async function slaOp(f: Record<string, unknown> = {}): Promise<string> {
  await alsGebruiker(db, invoerder);
  nummer++;
  return waarde<string>(db, "select public.sla_factuur_op($1::jsonb, true)", [
    JSON.stringify({
      organisatie_id: org, grootboekrekening_id: rekening, iban: "NL91ABNA0417164300", leverancier: "Boekhoud BV",
      factuurnummer: `B-${nummer}`, totaal_incl: 121 + nummer, bedrag_excl: 100, valuta: "EUR",
      btw_regels: [{ tarief: 21, grondslag: 100, btw_bedrag: 21 + nummer }], ...f,
    }),
  ]);
}

async function wijzigStatus(userId: string, factuurId: string, status: string): Promise<void> {
  await alsGebruiker(db, userId);
  await db.query("select public.wijzig_status($1, $2)", [factuurId, status]);
}

async function goedgekeurd(f: Record<string, unknown> = {}): Promise<string> {
  const id = await slaOp(f);
  await wijzigStatus(controller, id, "gecontroleerd");
  await wijzigStatus(goedkeurder, id, "goedgekeurd");
  return id;
}

async function exportTaken(factuurId: string): Promise<{ id: string; status: string }[]> {
  await alsBeheerder(db);
  return rijen(db, "select id, status from public.koppeling_taken where soort = 'boekhouding' and factuur_id = $1 order by created_at", [factuurId]);
}

async function gegevens(factuurId: string): Promise<Record<string, any>> {
  await alsServiceRole(db);
  return waarde(db, "select public.export_gegevens($1)", [factuurId]);
}

async function registreer(factuurId: string, externId = `MB-${factuurId.slice(0, 8)}`): Promise<void> {
  await alsServiceRole(db);
  await db.query("select public.registreer_export($1, 'moneybird', 'mock', $2, null, '{}'::jsonb)", [factuurId, externId]);
}

beforeAll(async () => {
  db = await maakDatabase();
  beheerder = await maakGebruiker(db, "beheerder@example.invalid");
  invoerder = await maakGebruiker(db, "invoerder@example.invalid");
  controller = await maakGebruiker(db, "controller@example.invalid");
  goedkeurder = await maakGebruiker(db, "goedkeurder@example.invalid");
  buitenstaander = await maakGebruiker(db, "buiten@example.invalid");
  org = await organisatieVan(db, beheerder);
  await alsGebruiker(db, beheerder);
  await db.query("select public.voeg_lid_toe($1, 'invoerder@example.invalid', 'invoerder')", [org]);
  await db.query("select public.voeg_lid_toe($1, 'controller@example.invalid', 'controller')", [org]);
  await db.query("select public.voeg_lid_toe($1, 'goedkeurder@example.invalid', 'goedkeurder', 5000)", [org]);
  rekening = await waarde(db, "select id from public.grootboekrekeningen where organisatie_id = $1 and code = '4300'", [org]);
});

afterAll(async () => {
  await db.close();
});

describe("export inplannen", () => {
  it("na goedkeuren wordt de export gepland; eerder niet", async () => {
    const id = await slaOp();
    await wijzigStatus(controller, id, "gecontroleerd");
    expect(await exportTaken(id)).toEqual([]);
    await wijzigStatus(goedkeurder, id, "goedgekeurd");
    expect(await exportTaken(id)).toMatchObject([{ status: "wachtrij" }]);
  });

  it("automatisch exporteren kan uit; dan via de knop (alleen controller/beheerder, geen dubbele taken)", async () => {
    await alsGebruiker(db, beheerder);
    await db.query("select public.stel_koppeling_in($1, 'boekhouding', 'mock', '{\"provider\": \"exact\", \"automatisch\": false}'::jsonb)", [org]);
    const id = await goedgekeurd();
    expect(await exportTaken(id)).toEqual([]);

    await alsGebruiker(db, invoerder);
    await expect(db.query("select public.plan_exports($1)", [org])).rejects.toThrow(/controller of beheerder/);

    await alsGebruiker(db, controller);
    const n = await waarde<number>(db, "select public.plan_exports($1, $2)", [org, [id]]);
    expect(n).toBe(1);
    expect(await waarde(db, "select public.plan_exports($1, $2)", [org, [id]])).toBe(0);
    expect(await exportTaken(id)).toHaveLength(1);

    await alsGebruiker(db, beheerder);
    await db.query("select public.stel_koppeling_in($1, 'boekhouding', 'mock', '{\"provider\": \"moneybird\"}'::jsonb)", [org]);
  });

  it("plan_exports slaat niet-goedgekeurde en al geëxporteerde facturen over", async () => {
    const open = await slaOp();
    const klaar = await goedgekeurd();
    await registreer(klaar);
    await alsGebruiker(db, controller);
    expect(await waarde(db, "select public.plan_exports($1, $2)", [org, [open, klaar]])).toBe(0);
  });
});

describe("export_gegevens en registreren", () => {
  it("geeft factuur, btw-regels, leverancier en mappings voor het gekozen pakket", async () => {
    const id = await goedgekeurd({ leverancier: "Mapping BV" });
    let g = await gegevens(id);
    expect(g).toMatchObject({
      status: "exporteren", provider: "moneybird",
      factuur: { id, valuta: "EUR", bedrag_excl: 100 },
      btw_regels: [{ tarief: 21, grondslag: 100 }],
      leverancier: { naam: "Mapping BV" },
      grootboekrekening: { code: "4300", omschrijving: "Kantoorkosten" },
      mappings: { grootboek: null, btw: {}, leverancier: null },
    });

    await alsGebruiker(db, controller);
    await db.query("select public.stel_boekhoud_mapping_in($1, 'moneybird', 'grootboek', $2, 'L-4300', 'Kantoorkosten')", [org, rekening]);
    await db.query("select public.stel_boekhoud_mapping_in($1, 'moneybird', 'btw', '21', 'T-21', '21% btw')", [org]);
    await alsServiceRole(db);
    await db.query("select public.sla_leverancier_mapping_op($1, 'moneybird', $2, 'C-1', 'Mapping BV')", [org, g.leverancier.id]);
    g = await gegevens(id);
    expect(g.mappings).toEqual({
      grootboek: { extern_id: "L-4300", extern_naam: "Kantoorkosten" },
      btw: { "21": { extern_id: "T-21", extern_naam: "21% btw" } },
      leverancier: { extern_id: "C-1", extern_naam: "Mapping BV" },
    });
    // Een andere provider heeft eigen mappings
    await alsGebruiker(db, beheerder);
    await db.query("select public.stel_koppeling_in($1, 'boekhouding', 'mock', '{\"provider\": \"snelstart\"}'::jsonb)", [org]);
    expect((await gegevens(id)).mappings).toEqual({ grootboek: null, btw: {}, leverancier: null });
    await alsGebruiker(db, beheerder);
    await db.query("select public.stel_koppeling_in($1, 'boekhouding', 'mock', '{\"provider\": \"moneybird\"}'::jsonb)", [org]);
  });

  it("alleen goedgekeurde facturen", async () => {
    const id = await slaOp();
    expect(await gegevens(id)).toMatchObject({ status: "niet_toegestaan", reden: "Alleen goedgekeurde facturen worden geëxporteerd (status: gescand)." });
  });

  it("registreren: één export per factuur; zelfde extern id is idempotent, een ander extern id een fout", async () => {
    const id = await goedgekeurd();
    await registreer(id, "MB-1");
    await registreer(id, "MB-1");
    await expect(registreer(id, "MB-2")).rejects.toThrow(/al geëxporteerd als MB-1/);
    expect(await gegevens(id)).toMatchObject({ status: "al_geexporteerd" });

    await alsBeheerder(db);
    const [log] = await rijen<{ bron: string; user_id: string | null }>(db,
      "select bron, user_id from public.audit_log where record_id = $1 and 'geexporteerd_op' = any (gewijzigde_velden)", [id]);
    expect(log).toEqual({ bron: "boekhouding", user_id: null });
  });

  it("een lege mapping verwijdert hem; handmatige mapping wordt niet overschreven door de export", async () => {
    const [lev] = await rijen<{ id: string }>(db, "select id from public.leveranciers where organisatie_id = $1 limit 1", [org]);
    await alsGebruiker(db, controller);
    await db.query("select public.stel_boekhoud_mapping_in($1, 'exact', 'leverancier', $2, 'HANDMATIG', 'Hand')", [org, lev.id]);
    await alsServiceRole(db);
    await db.query("select public.sla_leverancier_mapping_op($1, 'exact', $2, 'AUTO', 'Auto')", [org, lev.id]);
    await alsBeheerder(db);
    expect(await waarde(db, "select extern_id from public.boekhoud_mappings where provider = 'exact' and intern = $1", [lev.id])).toBe("HANDMATIG");

    await alsGebruiker(db, controller);
    await db.query("select public.stel_boekhoud_mapping_in($1, 'exact', 'leverancier', $2, '')", [org, lev.id]);
    await alsBeheerder(db);
    expect(await waarde(db, "select count(*)::int from public.boekhoud_mappings where provider = 'exact' and intern = $1", [lev.id])).toBe(0);

    await alsGebruiker(db, invoerder);
    await expect(db.query("select public.stel_boekhoud_mapping_in($1, 'exact', 'btw', '21', 'X')", [org])).rejects.toThrow(/controller of beheerder/);
    await alsGebruiker(db, controller);
    await expect(db.query("select public.stel_boekhoud_mapping_in($1, 'exact', 'btw', 'hoog', 'X')", [org])).rejects.toThrow(/percentage/);
  });
});

describe("vergrendeling na export", () => {
  it("inhoud, btw-regels en verwijderen geblokkeerd; betaald markeren kan wel", async () => {
    const id = await goedgekeurd({ factuurnummer: "SLOT-1" });
    await registreer(id);

    await alsGebruiker(db, invoerder);
    await expect(db.query("update public.facturen set totaal_incl = 1 where id = $1", [id])).rejects.toThrow(/geëxporteerd/);
    // Kolomrechten (B28): gebruikers kunnen geexporteerd_op niet eens proberen te wijzigen
    await expect(db.query("update public.facturen set geexporteerd_op = null where id = $1", [id])).rejects.toThrow(/permission denied/);
    await alsBeheerder(db);
    expect(await waarde(db, "select geexporteerd_op is not null from public.facturen where id = $1", [id])).toBe(true);

    await alsGebruiker(db, invoerder);
    await expect(db.query("delete from public.btw_regels where factuur_id = $1", [id])).rejects.toThrow(/geëxporteerd/);
    await alsGebruiker(db, beheerder);
    await expect(db.query("delete from public.facturen where id = $1", [id])).rejects.toThrow(/kan niet worden verwijderd/);

    // Opslaan zonder wijziging (zoals het formulier) gaat goed
    await alsGebruiker(db, invoerder);
    const rij = await waarde<Record<string, unknown>>(db,
      "select jsonb_build_object('id', id, 'organisatie_id', organisatie_id, 'leverancier', leverancier_naam, 'factuurnummer', factuurnummer, 'totaal_incl', totaal_incl, 'bedrag_excl', bedrag_excl, 'valuta', valuta, 'iban', iban, 'grootboekrekening_id', grootboekrekening_id, 'btw_regels', (select jsonb_agg(jsonb_build_object('tarief', tarief, 'grondslag', grondslag, 'btw_bedrag', btw_bedrag)) from public.btw_regels where factuur_id = f.id)) from public.facturen f where id = $1",
      [id]);
    await expect(db.query("select public.sla_factuur_op($1::jsonb)", [JSON.stringify(rij)])).resolves.toBeDefined();

    await wijzigStatus(controller, id, "betaald");
    await alsBeheerder(db);
    expect(await waarde(db, "select status from public.facturen where id = $1", [id])).toBe("betaald");
  });

  it("de service role kan niet exporteren buiten registreer_export om", async () => {
    const id = await goedgekeurd();
    await alsServiceRole(db);
    await db.query("update public.facturen set geexporteerd_op = now() where id = $1", [id]);
    await alsBeheerder(db);
    expect(await waarde(db, "select geexporteerd_op from public.facturen where id = $1", [id])).toBeNull();
  });
});

describe("rechten", () => {
  it("gebruikers kunnen de serverfuncties niet aanroepen; buitenstaander ziet niets", async () => {
    await alsGebruiker(db, controller);
    for (const sql of [
      "select public.export_gegevens(gen_random_uuid())",
      "select public.registreer_export(gen_random_uuid(), 'moneybird', 'mock', 'x')",
      "select public.sla_leverancier_mapping_op(gen_random_uuid(), 'moneybird', gen_random_uuid(), 'x', 'y')",
    ]) {
      await expect(db.query(sql), sql).rejects.toThrow(/permission denied/);
    }
    await expect(db.query("insert into public.boekhoud_mappings (organisatie_id, provider, soort, intern, extern_id) values ($1, 'moneybird', 'btw', '9', 'x')", [org]))
      .rejects.toThrow(/permission denied/);

    await alsGebruiker(db, buitenstaander);
    expect(await rijen(db, "select 1 from public.boekhoud_mappings where organisatie_id = $1", [org])).toEqual([]);
    expect(await rijen(db, "select 1 from public.boekhoud_exports where organisatie_id = $1", [org])).toEqual([]);
    await expect(db.query("select public.plan_exports($1)", [org])).rejects.toThrow(/controller of beheerder/);
  });
});
