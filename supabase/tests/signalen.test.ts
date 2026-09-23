import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alsBeheerder, alsGebruiker, maakDatabase, maakGebruiker, waarde } from "./db";
import { controleerBtwNummer, controleerIban, controleerKvkNummer } from "../../src/lib/veldvalidatie";
import { normaliseerFactuurnummer } from "../../src/lib/signalen";

let db: PGlite;
let a: string;
let b: string;

async function slaOp(factuur: Record<string, unknown>, bijwerken = false): Promise<string> {
  return waarde<string>(db, "select public.sla_factuur_op($1::jsonb, $2)", [JSON.stringify(factuur), bijwerken]);
}

async function signalen(factuurId: string) {
  const { rows } = await db.query<{ id: string; type: string; ernst: string; opgelost: boolean; sleutel: string }>(
    "select id, type, ernst, opgelost, sleutel from public.factuur_signalen where factuur_id = $1 order by type, sleutel",
    [factuurId],
  );
  return rows;
}

beforeAll(async () => {
  db = await maakDatabase();
  a = await maakGebruiker(db, "a@example.invalid");
  b = await maakGebruiker(db, "b@example.invalid");
});

afterAll(async () => {
  await db.close();
});

describe("SQL-regels gelijk aan TypeScript", () => {
  it.each([
    "NL91ABNA0417164300", "nl91 abna 0417 1643 00", "NL91ABNA0417164301", "NL91ABNA041716430",
    "XX91ABNA0417164300", "DE89370400440532013000", "FR1420041010050500013M02606", "1234", "",
  ])("IBAN %s", async (iban) => {
    await alsBeheerder(db);
    expect(await waarde(db, "select intern.controleer_iban($1)", [iban])).toBe(controleerIban(iban));
  });

  it.each(["NL123456789B01", "nl 1234.56.789.b01", "NL12345678B01", "DE123456789", "123456789B01", ""])(
    "btw-nummer %s",
    async (nr) => {
      await alsBeheerder(db);
      expect(await waarde(db, "select intern.controleer_btw_nummer($1)", [nr])).toBe(controleerBtwNummer(nr));
    },
  );

  it.each(["12345678", "1234 5678", "1234567", "abcdefgh", ""])("KvK-nummer %s", async (nr) => {
    await alsBeheerder(db);
    expect(await waarde(db, "select intern.controleer_kvk_nummer($1)", [nr])).toBe(controleerKvkNummer(nr));
  });

  it.each(["F-001", "f 001", "2024-0012", "000123", "100", "0", "INV-00-01", " - ", "A0B00C"])(
    "factuurnummer %s",
    async (nr) => {
      await alsBeheerder(db);
      expect(await waarde(db, "select intern.normaliseer_factuurnummer($1)", [nr])).toBe(normaliseerFactuurnummer(nr));
    },
  );
});

describe("signalen bij opslaan", () => {
  it("nieuwe leverancier alleen bij de eerste factuur", async () => {
    await alsGebruiker(db, a);
    const f1 = await slaOp({ leverancier: "Nieuw BV", factuurnummer: "N-1", totaal_incl: 10 });
    const f2 = await slaOp({ leverancier: "nieuw bv", factuurnummer: "N-2", totaal_incl: 20 });
    expect((await signalen(f1)).map((s) => s.type)).toEqual(["nieuwe_leverancier"]);
    expect(await signalen(f2)).toEqual([]);
  });

  it("mogelijk duplicaat op genormaliseerd factuurnummer", async () => {
    await alsGebruiker(db, a);
    await slaOp({ leverancier: "Dup BV", factuurnummer: "2026-0001", totaal_incl: 50 });
    const f2 = await slaOp({ leverancier: "Dup BV", factuurnummer: "2026 1", totaal_incl: 75 });
    const s = await signalen(f2);
    expect(s.find((x) => x.type === "mogelijk_duplicaat")?.ernst).toBe("waarschuwing");
  });

  it("mogelijk duplicaat op zelfde bedrag binnen 30 dagen, niet daarbuiten", async () => {
    await alsGebruiker(db, a);
    await slaOp({ leverancier: "Bedrag BV", factuurnummer: "B-1", factuurdatum: "2026-06-01", totaal_incl: 123.45 });
    const binnen = await slaOp({ leverancier: "Bedrag BV", factuurnummer: "B-2", factuurdatum: "2026-06-25", totaal_incl: 123.45 });
    const buiten = await slaOp({ leverancier: "Bedrag BV", factuurnummer: "B-3", factuurdatum: "2026-08-15", totaal_incl: 123.45 });
    expect((await signalen(binnen)).some((s) => s.type === "mogelijk_duplicaat")).toBe(true);
    expect((await signalen(buiten)).some((s) => s.type === "mogelijk_duplicaat")).toBe(false);
  });

  it("rond bedrag vanaf 1.000", async () => {
    await alsGebruiker(db, a);
    const rond = await slaOp({ leverancier: "Rond BV", factuurnummer: "R-1", totaal_incl: 2500 });
    const klein = await slaOp({ leverancier: "Rond BV", factuurnummer: "R-2", totaal_incl: 900 });
    const krom = await slaOp({ leverancier: "Rond BV", factuurnummer: "R-3", totaal_incl: 2550 });
    expect((await signalen(rond)).some((s) => s.type === "rond_bedrag")).toBe(true);
    expect((await signalen(klein)).some((s) => s.type === "rond_bedrag")).toBe(false);
    expect((await signalen(krom)).some((s) => s.type === "rond_bedrag")).toBe(false);
  });

  it("validatiefouten per veld, en weg na correctie", async () => {
    await alsGebruiker(db, a);
    const basis = { leverancier: "Valid BV", factuurnummer: "V-1", factuurdatum: "2026-09-10", totaal_incl: 121 };
    const f = await slaOp({
      ...basis, vervaldatum: "2026-09-01", iban: "NL91ABNA0417164301", btw_nummer: "NL1", kvk_nummer: "123",
      btw_regels: [{ tarief: 21, grondslag: 100, btw_bedrag: 20 }],
    });
    expect((await signalen(f)).filter((s) => s.type === "validatiefout").map((s) => s.sleutel)).toEqual([
      "btw_nummer", "iban", "kvk_nummer", "totaal_incl", "vervaldatum",
    ]);
    await slaOp({ ...basis, id: f, btw_regels: [{ tarief: 21, grondslag: 100, btw_bedrag: 21 }] }, true);
    expect((await signalen(f)).filter((s) => s.type === "validatiefout")).toEqual([]);
  });
});

describe("IBAN afwijkend", () => {
  let lev: string;
  let f2: string;

  it("geeft een kritiek signaal en overschrijft het bekende IBAN niet", async () => {
    await alsGebruiker(db, a);
    const f1 = await slaOp({ leverancier: "Iban BV", factuurnummer: "I-1", iban: "NL91ABNA0417164300" });
    lev = await waarde(db, "select leverancier_id from public.facturen where id = $1", [f1]);
    f2 = await slaOp({ leverancier: "Iban BV", factuurnummer: "I-2", iban: "NL44 RABO 0123 4567 89" }, true);
    const s = (await signalen(f2)).find((x) => x.type === "iban_afwijkend");
    expect(s?.ernst).toBe("kritiek");
    expect(await waarde(db, "select iban from public.leveranciers where id = $1", [lev])).toBe("NL91ABNA0417164300");
    expect(await waarde(db, "select iban from public.facturen where id = $1", [f2])).toBe("NL44RABO0123456789");
  });

  it("oplossen vereist een toelichting", async () => {
    await alsGebruiker(db, a);
    const id = (await signalen(f2)).find((x) => x.type === "iban_afwijkend")!.id;
    await expect(db.query("select public.los_signaal_op($1, '  ')", [id])).rejects.toThrow(/toelichting is verplicht/);
  });

  it("andere gebruiker kan het signaal niet zien of oplossen", async () => {
    await alsGebruiker(db, a);
    const id = (await signalen(f2)).find((x) => x.type === "iban_afwijkend")!.id;
    await alsGebruiker(db, b);
    expect(await signalen(f2)).toEqual([]);
    await expect(db.query("select public.los_signaal_op($1, 'hack')", [id])).rejects.toThrow(/niet gevonden/);
  });

  it("signalen zijn niet rechtstreeks te wijzigen of te verwijderen", async () => {
    await alsGebruiker(db, a);
    await expect(db.query("update public.factuur_signalen set opgelost = true")).rejects.toThrow(/permission denied/);
    await expect(db.query("delete from public.factuur_signalen")).rejects.toThrow(/permission denied/);
    await expect(
      db.query("insert into public.factuur_signalen (factuur_id, type, ernst, bericht) values ($1, 'rond_bedrag', 'info', 'x')", [f2]),
    ).rejects.toThrow(/permission denied/);
  });

  it("oplossen met IBAN overnemen werkt het bekende IBAN bij; opgelost signaal blijft staan", async () => {
    await alsGebruiker(db, a);
    const id = (await signalen(f2)).find((x) => x.type === "iban_afwijkend")!.id;
    await db.query("select public.los_signaal_op($1, 'Nagebeld met leverancier, nieuw rekeningnummer klopt', true)", [id]);
    expect(await waarde(db, "select iban from public.leveranciers where id = $1", [lev])).toBe("NL44RABO0123456789");
    await slaOp({ id: f2, leverancier: "Iban BV", factuurnummer: "I-2", iban: "NL44RABO0123456789" }, true);
    const s = (await signalen(f2)).filter((x) => x.type === "iban_afwijkend");
    expect(s).toHaveLength(1);
    expect(s[0].opgelost).toBe(true);
  });
});
