import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alsBeheerder, alsGebruiker, maakDatabase, maakGebruiker, organisatieVan, rijen, waarde } from "./db";

interface AuditRij {
  tabel: string;
  actie: string;
  gewijzigde_velden: string[] | null;
  oud: Record<string, unknown> | null;
  nieuw: Record<string, unknown> | null;
  user_id: string | null;
  toelichting: string | null;
}

let db: PGlite;
let beheerder: string;
let invoerder: string;
let buitenstaander: string;
let org: string;
let rekening: string;
let factuur: string;

async function slaOp(f: Record<string, unknown>): Promise<string> {
  return waarde<string>(db, "select public.sla_factuur_op($1::jsonb, true)", [
    JSON.stringify({ organisatie_id: org, grootboekrekening_id: rekening, ...f }),
  ]);
}

async function historie(id: string): Promise<AuditRij[]> {
  return rijen<AuditRij>(
    db,
    "select tabel, actie, gewijzigde_velden, oud, nieuw, user_id, toelichting from public.factuur_historie($1)",
    [id],
  );
}

beforeAll(async () => {
  db = await maakDatabase();
  beheerder = await maakGebruiker(db, "beheerder@example.invalid");
  invoerder = await maakGebruiker(db, "invoerder@example.invalid");
  buitenstaander = await maakGebruiker(db, "buiten@example.invalid");
  org = await organisatieVan(db, beheerder);
  await alsGebruiker(db, beheerder);
  await db.query("select public.voeg_lid_toe($1, 'invoerder@example.invalid', 'invoerder')", [org]);
  rekening = await waarde(db, "select id from public.grootboekrekeningen where organisatie_id = $1 and code = '4300'", [org]);
  await alsGebruiker(db, invoerder);
  factuur = await slaOp({
    leverancier: "Audit BV", factuurnummer: "A-1", totaal_incl: 121, iban: "NL91ABNA0417164300",
    btw_regels: [{ tarief: 21, grondslag: 100, btw_bedrag: 21 }],
  });
});

afterAll(async () => {
  await db.close();
});

describe("audit trail", () => {
  it("aanmaken logt factuur, btw-regel en signalen met de gebruiker", async () => {
    await alsGebruiker(db, invoerder);
    const h = await historie(factuur);
    expect(h.map((r) => `${r.tabel}:${r.actie}`)).toEqual([
      "facturen:insert",
      "btw_regels:insert",
      "factuur_signalen:insert",
    ]);
    expect(h.every((r) => r.user_id === invoerder)).toBe(true);
    expect(await waarde(db, "select count(*)::int from public.audit_log where tabel = 'leveranciers' and actie = 'insert'")).toBe(1);
  });

  it("update bewaart alleen gewijzigde velden (zonder updated_at)", async () => {
    await alsGebruiker(db, invoerder);
    await slaOp({ id: factuur, leverancier: "Audit BV", factuurnummer: "A-1b", totaal_incl: 121, iban: "NL91ABNA0417164300", btw_regels: [{ tarief: 21, grondslag: 100, btw_bedrag: 21 }] });
    const laatste = (await historie(factuur)).at(-1)!;
    expect(laatste).toMatchObject({
      tabel: "facturen",
      actie: "update",
      gewijzigde_velden: ["factuurnummer"],
      oud: { factuurnummer: "A-1" },
      nieuw: { factuurnummer: "A-1b" },
    });
  });

  it("opslaan zonder wijziging logt niets", async () => {
    await alsGebruiker(db, invoerder);
    const voor = (await historie(factuur)).length;
    await slaOp({ id: factuur, leverancier: "Audit BV", factuurnummer: "A-1b", totaal_incl: 121, iban: "NL91ABNA0417164300", btw_regels: [{ tarief: 21, grondslag: 100, btw_bedrag: 21 }] });
    expect((await historie(factuur)).length).toBe(voor);
  });

  it("statuswijziging met actie, velden en toelichting", async () => {
    await alsGebruiker(db, invoerder);
    await db.query("select public.wijzig_status($1, 'gecontroleerd')", [factuur]);
    await alsGebruiker(db, beheerder);
    await db.query("select public.wijzig_status($1, 'afgekeurd', 'Verkeerde tenaamstelling')", [factuur]);
    const [gecontroleerd, afgekeurd] = (await historie(factuur)).filter((r) => r.actie === "statuswijziging");
    expect(gecontroleerd).toMatchObject({ user_id: invoerder, oud: { status: "gescand" }, nieuw: { status: "gecontroleerd" }, toelichting: null });
    expect(gecontroleerd.gewijzigde_velden).toEqual(["gecontroleerd_door", "gecontroleerd_op", "status"]);
    expect(afgekeurd).toMatchObject({ user_id: beheerder, nieuw: { status: "afgekeurd" }, toelichting: "Verkeerde tenaamstelling" });
  });

  it("automatische terugval staat met toelichting in de log", async () => {
    await alsGebruiker(db, invoerder);
    await db.query("select public.wijzig_status($1, 'gescand')", [factuur]);
    await db.query("select public.wijzig_status($1, 'gecontroleerd')", [factuur]);
    await slaOp({ id: factuur, leverancier: "Audit BV", factuurnummer: "A-1b", totaal_incl: 242, iban: "NL91ABNA0417164300", btw_regels: [{ tarief: 21, grondslag: 200, btw_bedrag: 42 }] });
    const updates = (await historie(factuur)).filter((r) => r.tabel === "facturen" && r.actie === "update");
    const terugval = updates.at(-1)!;
    expect(terugval.gewijzigde_velden).toContain("status");
    expect(terugval.toelichting).toMatch(/automatisch teruggezet/);
    // De toelichting "lekt" niet naar latere regels in dezelfde transactie
    const btw = (await historie(factuur)).filter((r) => r.tabel === "btw_regels").at(-1)!;
    expect(btw.toelichting).toBeNull();
  });

  it("oplossen van een signaal staat in de historie", async () => {
    await alsGebruiker(db, invoerder);
    const signaal = await waarde<string>(db, "select id from public.factuur_signalen where factuur_id = $1 limit 1", [factuur]);
    await db.query("select public.los_signaal_op($1, 'Bekende leverancier')", [signaal]);
    const laatste = (await historie(factuur)).at(-1)!;
    expect(laatste).toMatchObject({ tabel: "factuur_signalen", actie: "update", nieuw: { opgelost: true, toelichting: "Bekende leverancier" } });
  });

  it("organisatie met één lid: melding over functiescheiding in de log", async () => {
    const solo = await maakGebruiker(db, "solo@example.invalid");
    const soloOrg = await organisatieVan(db, solo);
    await alsGebruiker(db, solo);
    const id = await waarde<string>(db, "select public.sla_factuur_op($1::jsonb)", [JSON.stringify({ organisatie_id: soloOrg, factuurnummer: "S-1" })]);
    await db.query("select public.wijzig_status($1, 'gecontroleerd')", [id]);
    const log = (await historie(id)).find((r) => r.actie === "statuswijziging")!;
    expect(log.toelichting).toBe("Functiescheiding niet mogelijk: organisatie heeft één lid");
  });

  it("ledenbeheer wordt gelogd", async () => {
    await alsGebruiker(db, beheerder);
    await db.query("select public.wijzig_lid($1, $2, 'controller', 2500)", [org, invoerder]);
    const log = await rijen<AuditRij>(
      db,
      "select tabel, actie, gewijzigde_velden, oud, nieuw, user_id, toelichting from public.audit_log where tabel = 'organisatie_leden' and actie = 'update'",
    );
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ user_id: beheerder, oud: { rol: "invoerder", goedkeuringslimiet: null }, nieuw: { rol: "controller", goedkeuringslimiet: 2500 } });
  });

  it("verwijderen logt de factuur, zonder ruis van meeverwijderde regels", async () => {
    await alsGebruiker(db, beheerder);
    const tellen = () => waarde<number>(db, "select count(*)::int from public.audit_log where actie = 'delete'");
    const voor = await tellen();
    await db.query("delete from public.facturen where id = $1", [factuur]);
    expect(await tellen()).toBe(voor + 1);
    expect(
      await waarde(db, "select oud ->> 'factuurnummer' from public.audit_log where actie = 'delete' and tabel = 'facturen' and record_id = $1", [factuur]),
    ).toBe("A-1b");
  });
});

describe("audit log is alleen-lezen en per organisatie", () => {
  it("buitenstaander ziet niets", async () => {
    await alsGebruiker(db, buitenstaander);
    expect(await waarde(db, "select count(*)::int from public.audit_log where organisatie_id = $1", [org])).toBe(0);
  });

  it("leden kunnen niet invoegen, wijzigen of verwijderen", async () => {
    await alsGebruiker(db, beheerder);
    expect(await waarde<number>(db, "select count(*)::int from public.audit_log")).toBeGreaterThan(0);
    await expect(db.query("update public.audit_log set toelichting = 'weg'")).rejects.toThrow(/permission denied/);
    await expect(db.query("delete from public.audit_log")).rejects.toThrow(/permission denied/);
    await expect(
      db.query("insert into public.audit_log (organisatie_id, tabel, actie) values ($1, 'facturen', 'insert')", [org]),
    ).rejects.toThrow(/permission denied/);
  });

  it("ook de database-beheerder (SQL Editor / service role) kan niets wijzigen", async () => {
    await alsBeheerder(db);
    await expect(db.query("update public.audit_log set toelichting = 'weg'")).rejects.toThrow(/kan niet worden gewijzigd/);
    await expect(db.query("delete from public.audit_log")).rejects.toThrow(/kan niet worden gewijzigd/);
    await expect(db.query("truncate public.audit_log")).rejects.toThrow(/kan niet worden gewijzigd/);
  });
});
