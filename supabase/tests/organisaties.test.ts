import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  alsBeheerder,
  alsGebruiker,
  maakDatabase,
  maakGebruiker,
  migreerVanaf,
  organisatieVan,
  rijen,
  waarde,
} from "./db";

const ORG_MIGRATIE = "20260923190000";

async function slaOp(db: PGlite, factuur: Record<string, unknown>, bijwerken = false): Promise<string> {
  return waarde<string>(db, "select public.sla_factuur_op($1::jsonb, $2)", [JSON.stringify(factuur), bijwerken]);
}

describe("backfill naar organisaties", () => {
  let db: PGlite;
  let a: string;
  let fA: string;

  beforeAll(async () => {
    db = await maakDatabase(ORG_MIGRATIE);
    a = await maakGebruiker(db, "oud@example.invalid");
    await alsGebruiker(db, a);
    const ict = await waarde<string>(db, "select id from public.grootboekrekeningen where code = '4400'");
    fA = await slaOp(db, {
      leverancier: "Oud BV", factuurnummer: "O-1", totaal_incl: 5000, iban: "NL91ABNA0417164300",
      grootboekrekening_id: ict, btw_regels: [{ tarief: 21, grondslag: 100, btw_bedrag: 21 }],
    });
    await migreerVanaf(db, ORG_MIGRATIE);
  });

  afterAll(async () => {
    await db.close();
  });

  it("bestaande gebruiker wordt beheerder van een persoonlijke organisatie", async () => {
    await alsBeheerder(db);
    expect(await rijen(db, "select rol, goedkeuringslimiet from public.organisatie_leden where user_id = $1", [a])).toEqual([
      { rol: "beheerder", goedkeuringslimiet: null },
    ]);
    expect(await waarde(db, "select naam from public.organisaties")).toBe("Organisatie van oud@example.invalid");
  });

  it("alle bestaande data hoort bij die organisatie; niets dubbel", async () => {
    const org = await organisatieVan(db, a);
    await alsBeheerder(db);
    for (const tabel of ["leveranciers", "facturen", "grootboekrekeningen", "factuur_signalen"]) {
      expect(await waarde(db, `select count(*)::int from public.${tabel} where organisatie_id is distinct from $1`, [org])).toBe(0);
    }
    expect(await waarde(db, "select count(*)::int from public.grootboekrekeningen")).toBe(16);
    expect(await waarde(db, "select user_id from public.facturen where id = $1", [fA])).toBe(a);
  });

  it("gebruiker ziet en bewerkt zijn data na de migratie", async () => {
    await alsGebruiker(db, a);
    expect(await waarde(db, "select count(*)::int from public.facturen")).toBe(1);
    await slaOp(db, { id: fA, leverancier: "Oud BV", factuurnummer: "O-1b", totaal_incl: 5000 }, true);
    expect(await waarde(db, "select factuurnummer from public.facturen where id = $1", [fA])).toBe("O-1b");
  });

  it("nieuwe gebruiker krijgt een eigen organisatie met standaardrekeningen", async () => {
    const nieuw = await maakGebruiker(db, "nieuw@example.invalid");
    await alsGebruiker(db, nieuw);
    expect(await waarde(db, "select count(*)::int from public.organisaties")).toBe(1);
    expect(await waarde(db, "select count(*)::int from public.grootboekrekeningen")).toBe(16);
    expect(await waarde(db, "select public.zorg_voor_organisatie()")).toBe(await organisatieVan(db, nieuw));
  });
});

describe("organisaties, rollen en RLS", () => {
  let db: PGlite;
  let a: string; // beheerder van org A
  let b: string; // wordt goedkeurder in org A
  let c: string; // alleen in eigen org C
  let orgA: string;
  let orgB: string;
  let orgC: string;
  let fA: string;

  beforeAll(async () => {
    db = await maakDatabase();
    a = await maakGebruiker(db, "a@example.invalid");
    b = await maakGebruiker(db, "b@example.invalid");
    c = await maakGebruiker(db, "c@example.invalid");
    orgA = await organisatieVan(db, a);
    orgB = await organisatieVan(db, b);
    orgC = await organisatieVan(db, c);
    await alsGebruiker(db, a);
    fA = await slaOp(db, {
      organisatie_id: orgA, leverancier: "Leverancier A", factuurnummer: "A-1", totaal_incl: 100, iban: "NL91ABNA0417164300",
    });
  });

  afterAll(async () => {
    await db.close();
  });

  it("gebruiker uit een andere organisatie ziet niets", async () => {
    await alsGebruiker(db, c);
    for (const tabel of ["facturen", "leveranciers", "btw_regels", "factuur_signalen"]) {
      expect(await waarde(db, `select count(*)::int from public.${tabel}`)).toBe(0);
    }
    expect(await waarde(db, "select count(*)::int from public.grootboekrekeningen where organisatie_id = $1", [orgA])).toBe(0);
    expect(await waarde(db, "select count(*)::int from public.organisaties")).toBe(1);
    expect(await waarde(db, "select count(*)::int from public.organisatie_leden")).toBe(1);
    await expect(db.query("select * from public.org_gebruikers($1)", [orgA])).rejects.toThrow(/Geen toegang/);
  });

  it("opslaan in een organisatie waarvan je geen lid bent kan niet", async () => {
    await alsGebruiker(db, c);
    await expect(slaOp(db, { organisatie_id: orgA, factuurnummer: "C-1" })).rejects.toThrow(/geen lid/);
    await expect(slaOp(db, { id: fA, organisatie_id: orgC, factuurnummer: "GEHACKT" })).rejects.toThrow();
  });

  it("alleen een beheerder kan leden toevoegen", async () => {
    await alsGebruiker(db, c);
    await expect(db.query("select public.voeg_lid_toe($1, 'c@example.invalid', 'beheerder')", [orgA])).rejects.toThrow(/Alleen een beheerder/);
    await alsGebruiker(db, a);
    await expect(db.query("select public.voeg_lid_toe($1, 'onbekend@example.invalid', 'invoerder')", [orgA])).rejects.toThrow(/geen account/);
    await db.query("select public.voeg_lid_toe($1, ' B@EXAMPLE.invalid ', 'goedkeurder', 5000)", [orgA]);
    await expect(db.query("select public.voeg_lid_toe($1, 'b@example.invalid', 'invoerder')", [orgA])).rejects.toThrow(/al lid/);
    await expect(db.query("select public.voeg_lid_toe($1, 'c@example.invalid', 'baas')", [orgA])).rejects.toThrow(/Ongeldige rol/);
  });

  it("nieuw lid deelt de data van de organisatie", async () => {
    await alsGebruiker(db, b);
    expect(await waarde(db, "select count(*)::int from public.facturen where organisatie_id = $1", [orgA])).toBe(1);
    // Met twee organisaties moet de organisatie expliciet gekozen worden
    await expect(slaOp(db, { factuurnummer: "B-1" })).rejects.toThrow(/Kies een organisatie/);
    await slaOp(db, { organisatie_id: orgA, leverancier: "leverancier a", factuurnummer: "A-2", totaal_incl: 50 });
    expect(await waarde(db, "select count(*)::int from public.leveranciers where organisatie_id = $1", [orgA])).toBe(1);
    expect(await waarde(db, "select user_id from public.facturen where factuurnummer = 'A-2'")).toBe(b);
    const gebruikers = await rijen<{ email: string; rol: string }>(db, "select email, rol from public.org_gebruikers($1) order by email", [orgA]);
    expect(gebruikers).toEqual([
      { email: "a@example.invalid", rol: "beheerder" },
      { email: "b@example.invalid", rol: "goedkeurder" },
    ]);
  });

  it("ingevoerd_door, organisatie en bekend IBAN zijn niet rechtstreeks te wijzigen; leverancier niet te verwijderen", async () => {
    await alsGebruiker(db, b);
    await expect(db.query("update public.facturen set user_id = $1 where id = $2", [b, fA])).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.facturen set organisatie_id = $1 where id = $2", [orgB, fA])).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.leveranciers set iban = 'NL44RABO0123456789'")).rejects.toThrow(/permission denied/);
    await expect(db.query("delete from public.leveranciers")).rejects.toThrow(/permission denied/);
    await expect(
      db.query("insert into public.facturen (organisatie_id, user_id, factuurnummer) values ($1, $2, 'NEP')", [orgA, a]),
    ).rejects.toThrow(/row-level security/);
  });

  it("goedkeurder kan geen rekeningen beheren, beheerder wel", async () => {
    await alsGebruiker(db, b);
    await expect(
      db.query("insert into public.grootboekrekeningen (organisatie_id, code, omschrijving) values ($1, '9999', 'x')", [orgA]),
    ).rejects.toThrow(/row-level security/);
    await alsGebruiker(db, a);
    await db.query("insert into public.grootboekrekeningen (organisatie_id, code, omschrijving) values ($1, '9999', 'x')", [orgA]);
  });

  it("kritiek signaal: niet door een invoerder, wel door een goedkeurder", async () => {
    await alsGebruiker(db, a);
    await db.query("select public.voeg_lid_toe($1, 'c@example.invalid', 'invoerder')", [orgA]);
    await alsGebruiker(db, c);
    const f = await slaOp(db, { organisatie_id: orgA, leverancier: "Leverancier A", factuurnummer: "A-3", iban: "NL44RABO0123456789" });
    const signaal = await waarde<string>(db, "select id from public.factuur_signalen where factuur_id = $1 and type = 'iban_afwijkend'", [f]);
    await expect(db.query("select public.los_signaal_op($1, 'akkoord')", [signaal])).rejects.toThrow(/kritiek signaal/);
    await alsGebruiker(db, b);
    await db.query("select public.los_signaal_op($1, 'Nagebeld')", [signaal]);
    await alsGebruiker(db, a);
    await db.query("select public.verwijder_lid($1, $2)", [orgA, c]);
  });

  it("laatste beheerder kan niet weg of gedegradeerd worden", async () => {
    await alsGebruiker(db, a);
    await expect(db.query("select public.verwijder_lid($1, $2)", [orgA, a])).rejects.toThrow(/laatste beheerder/);
    await expect(db.query("select public.wijzig_lid($1, $2, 'controller', null)", [orgA, a])).rejects.toThrow(/laatste beheerder/);
    await db.query("select public.wijzig_lid($1, $2, 'beheerder', null)", [orgA, b]);
    await db.query("select public.verwijder_lid($1, $2)", [orgA, a]);
    expect(await waarde(db, "select count(*)::int from public.facturen")).toBe(0);
    await alsGebruiker(db, b);
    await db.query("select public.voeg_lid_toe($1, 'a@example.invalid', 'invoerder')", [orgA]);
  });

  it("naam van de organisatie: alleen de beheerder wijzigt", async () => {
    await alsGebruiker(db, a);
    await db.query("update public.organisaties set naam = 'Hack' where id = $1", [orgA]);
    await alsGebruiker(db, b);
    expect(await waarde(db, "select naam from public.organisaties where id = $1", [orgA])).not.toBe("Hack");
    await db.query("update public.organisaties set naam = 'Bedrijf A' where id = $1", [orgA]);
    expect(await waarde(db, "select naam from public.organisaties where id = $1", [orgA])).toBe("Bedrijf A");
  });

  it("storage: organisatiemap voor leden, oude paden via de factuur", async () => {
    await alsBeheerder(db);
    await db.query("insert into storage.buckets (id, name) values ('facturen', 'facturen') on conflict do nothing");
    // Oud pad in de map van gebruiker a, gekoppeld aan een factuur van org A
    const oudPad = `${a}/${fA}/oud.pdf`;
    await db.query("insert into storage.objects (bucket_id, name, owner) values ('facturen', $1, $2)", [oudPad, a]);
    await db.query("update public.facturen set bestand_pad = $1 where id = $2", [oudPad, fA]);

    await alsGebruiker(db, b);
    const nieuwPad = `${orgA}/${crypto.randomUUID()}/nieuw.pdf`;
    await db.query("insert into storage.objects (bucket_id, name) values ('facturen', $1)", [nieuwPad]);
    await expect(
      db.query("insert into storage.objects (bucket_id, name) values ('facturen', $1)", [`${orgC}/x/y.pdf`]),
    ).rejects.toThrow(/row-level security/);
    expect(await waarde(db, "select count(*)::int from storage.objects where name = any($1)", [[oudPad, nieuwPad]])).toBe(2);

    await alsGebruiker(db, c);
    expect(await waarde(db, "select count(*)::int from storage.objects")).toBe(0);
  });
});
