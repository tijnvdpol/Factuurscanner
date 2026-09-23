import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alsGebruiker, maakDatabase, maakGebruiker, waarde } from "./db";

let db: PGlite;
let a: string;
let b: string;

async function slaOp(factuur: Record<string, unknown>): Promise<string> {
  return waarde<string>(db, "select public.sla_factuur_op($1::jsonb)", [JSON.stringify(factuur)]);
}

async function rekening(code: string): Promise<string> {
  return waarde<string>(db, "select id from public.grootboekrekeningen where code = $1", [code]);
}

beforeAll(async () => {
  db = await maakDatabase();
  a = await maakGebruiker(db, "a@example.invalid");
  b = await maakGebruiker(db, "b@example.invalid");
});

afterAll(async () => {
  await db.close();
});

describe("grootboekrekeningen", () => {
  it("nieuwe gebruiker krijgt de standaardset", async () => {
    await alsGebruiker(db, a);
    expect(await waarde(db, "select count(*)::int from public.grootboekrekeningen")).toBe(16);
    expect(await waarde(db, "select omschrijving from public.grootboekrekeningen where code = '4400'")).toBe("ICT en software");
  });

  it("toevoegen, wijzigen en deactiveren; verwijderen kan niet", async () => {
    await alsGebruiker(db, a);
    await db.query("insert into public.grootboekrekeningen (code, omschrijving) values ('4410', 'Hosting')");
    await db.query("update public.grootboekrekeningen set omschrijving = 'Hosting en domeinen', actief = false where code = '4410'");
    expect(await waarde(db, "select actief from public.grootboekrekeningen where code = '4410'")).toBe(false);
    await expect(db.query("delete from public.grootboekrekeningen where code = '4410'")).rejects.toThrow(/permission denied/);
    await expect(
      db.query("insert into public.grootboekrekeningen (code, omschrijving) values ('4410', 'Dubbel')"),
    ).rejects.toThrow(/duplicate key/);
  });

  it("andere gebruiker ziet de rekeningen niet en kan er niet aan koppelen", async () => {
    await alsGebruiker(db, a);
    const ictA = await rekening("4400");
    await alsGebruiker(db, b);
    expect(await waarde(db, "select count(*)::int from public.grootboekrekeningen where id = $1", [ictA])).toBe(0);
    await expect(slaOp({ factuurnummer: "B-1", grootboekrekening_id: ictA })).rejects.toThrow(/foreign key/);
  });
});

describe("codering", () => {
  it("slaat bron en zekerheid op; handmatig zonder zekerheid", async () => {
    await alsGebruiker(db, a);
    const ict = await rekening("4400");
    const f1 = await slaOp({ leverancier: "Hoster", factuurnummer: "H-1", grootboekrekening_id: ict, codering_bron: "ai", codering_zekerheid: 0.82 });
    const f2 = await slaOp({ leverancier: "Hoster", factuurnummer: "H-2", grootboekrekening_id: ict, codering_zekerheid: 0.5 });
    const { rows } = await db.query<{ codering_bron: string; codering_zekerheid: string | null }>(
      "select codering_bron, codering_zekerheid::text from public.facturen where id = any($1) order by factuurnummer",
      [[f1, f2]],
    );
    expect(rows).toEqual([
      { codering_bron: "ai", codering_zekerheid: "0.82" },
      { codering_bron: "handmatig", codering_zekerheid: null },
    ]);
  });

  it("historie: meest gebruikte handmatig bevestigde rekening, AI-codering telt niet mee", async () => {
    await alsGebruiker(db, a);
    const kantoor = await rekening("4300");
    const ict = await rekening("4400");
    // Hoster: 1x handmatig ICT (H-2) en 1x AI (telt niet)
    await slaOp({ leverancier: "Hoster", factuurnummer: "H-3", grootboekrekening_id: kantoor, codering_bron: "handmatig" });
    await slaOp({ leverancier: "Hoster", factuurnummer: "H-4", grootboekrekening_id: kantoor, codering_bron: "handmatig" });
    const { rows } = await db.query<{ grootboekrekening_id: string; zekerheid: string }>(
      "select grootboekrekening_id, zekerheid::text from public.stel_codering_voor(' hoster ')",
    );
    expect(rows).toEqual([{ grootboekrekening_id: kantoor, zekerheid: "0.67" }]);
    expect(ict).not.toBe(kantoor);
  });

  it("geen historie bij een onbekende leverancier of alleen AI-codering", async () => {
    await alsGebruiker(db, a);
    const ict = await rekening("4400");
    await slaOp({ leverancier: "Alleen AI BV", factuurnummer: "A-1", grootboekrekening_id: ict, codering_bron: "ai", codering_zekerheid: 0.9 });
    expect((await db.query("select * from public.stel_codering_voor('Alleen AI BV')")).rows).toEqual([]);
    expect((await db.query("select * from public.stel_codering_voor('Onbekend')")).rows).toEqual([]);
  });

  it("gedeactiveerde rekening wordt niet voorgesteld", async () => {
    await alsGebruiker(db, a);
    const reis = await rekening("4150");
    await slaOp({ leverancier: "NS", factuurnummer: "NS-1", grootboekrekening_id: reis });
    expect((await db.query("select * from public.stel_codering_voor('NS')")).rows).toHaveLength(1);
    await db.query("update public.grootboekrekeningen set actief = false where id = $1", [reis]);
    expect((await db.query("select * from public.stel_codering_voor('NS')")).rows).toEqual([]);
  });
});
