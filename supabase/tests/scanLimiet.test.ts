import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alsGebruiker, alsServiceRole, maakDatabase, maakGebruiker, waarde } from "./db";

let db: PGlite;
let gebruiker: string;

const claim = (sleutel: string, limiet: number) => waarde<boolean>(db, "select public.claim_scan($1, $2)", [sleutel, limiet]);

beforeAll(async () => {
  db = await maakDatabase();
  gebruiker = await maakGebruiker(db, "scan@example.com");
});

afterAll(async () => {
  await db.close();
});

describe("dagelijkse scanlimiet", () => {
  it("staat precies zoveel scans toe als de limiet", async () => {
    await alsServiceRole(db);
    const sleutel = crypto.randomUUID();
    const uitkomsten = [];
    for (let i = 0; i < 7; i++) uitkomsten.push(await claim(sleutel, 5));
    expect(uitkomsten).toEqual([true, true, true, true, true, false, false]);
  });

  it("telt per sleutel apart", async () => {
    await alsServiceRole(db);
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    expect(await claim(a, 1)).toBe(true);
    expect(await claim(a, 1)).toBe(false);
    expect(await claim(b, 1)).toBe(true);
  });

  it("geef_scan_terug maakt een claim ongedaan, nooit onder nul", async () => {
    await alsServiceRole(db);
    const sleutel = crypto.randomUUID();
    expect(await claim(sleutel, 1)).toBe(true);
    await db.query("select public.geef_scan_terug($1)", [sleutel]);
    expect(await claim(sleutel, 1)).toBe(true);
    await db.query("select public.geef_scan_terug($1)", [sleutel]);
    await db.query("select public.geef_scan_terug($1)", [sleutel]);
    expect(await claim(sleutel, 1)).toBe(true);
    expect(await claim(sleutel, 1)).toBe(false);
  });

  it("een limiet onder 1 laat niets toe", async () => {
    await alsServiceRole(db);
    expect(await claim(crypto.randomUUID(), 0)).toBe(false);
  });

  it("ingelogde gebruikers kunnen de teller niet lezen of verhogen", async () => {
    await alsGebruiker(db, gebruiker);
    await expect(claim(crypto.randomUUID(), 5)).rejects.toThrow();
    await expect(db.query("select * from public.scan_gebruik")).rejects.toThrow();
    await alsGebruiker(db, null);
    await expect(claim(crypto.randomUUID(), 5)).rejects.toThrow();
  });
});
