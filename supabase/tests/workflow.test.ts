import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alsGebruiker, maakDatabase, maakGebruiker, organisatieVan, waarde } from "./db";

let db: PGlite;
let beheerder: string;
let invoerder: string;
let goedkeurder: string;
let controller: string;
let org: string;
let rekening: string;

async function slaOp(factuur: Record<string, unknown>): Promise<string> {
  return waarde<string>(db, "select public.sla_factuur_op($1::jsonb, true)", [
    JSON.stringify({ organisatie_id: org, grootboekrekening_id: rekening, ...factuur }),
  ]);
}

async function wijzig(id: string, status: string, toelichting: string | null = null): Promise<string | null> {
  return waarde<string | null>(db, "select public.wijzig_status($1, $2, $3)", [id, status, toelichting]);
}

async function status(id: string): Promise<string> {
  return waarde<string>(db, "select status from public.facturen where id = $1", [id]);
}

/** Factuur ingevoerd door de invoerder en gecontroleerd door `controleur` (standaard de invoerder). */
async function gecontroleerdeFactuur(factuur: Record<string, unknown>, controleur = invoerder): Promise<string> {
  await alsGebruiker(db, invoerder);
  const id = await slaOp(factuur);
  await alsGebruiker(db, controleur);
  await wijzig(id, "gecontroleerd");
  return id;
}

let volgnummer = 0;
const nr = () => `W-${++volgnummer}`;

beforeAll(async () => {
  db = await maakDatabase();
  beheerder = await maakGebruiker(db, "beheerder@example.invalid");
  invoerder = await maakGebruiker(db, "invoerder@example.invalid");
  goedkeurder = await maakGebruiker(db, "goedkeurder@example.invalid");
  controller = await maakGebruiker(db, "controller@example.invalid");
  org = await organisatieVan(db, beheerder);
  await alsGebruiker(db, beheerder);
  await db.query("select public.voeg_lid_toe($1, 'invoerder@example.invalid', 'invoerder')", [org]);
  await db.query("select public.voeg_lid_toe($1, 'goedkeurder@example.invalid', 'goedkeurder', 5000)", [org]);
  await db.query("select public.voeg_lid_toe($1, 'controller@example.invalid', 'controller')", [org]);
  rekening = await waarde(db, "select id from public.grootboekrekeningen where organisatie_id = $1 and code = '4300'", [org]);
});

afterAll(async () => {
  await db.close();
});

describe("status alleen via wijzig_status", () => {
  it("nieuwe factuur is altijd gescand; direct wijzigen van de status kan niet", async () => {
    await alsGebruiker(db, invoerder);
    const id = await slaOp({ factuurnummer: nr(), status: "goedgekeurd" });
    expect(await status(id)).toBe("gescand");
    await expect(db.query("update public.facturen set status = 'goedgekeurd' where id = $1", [id])).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.facturen set goedgekeurd_door = $1 where id = $2", [invoerder, id])).rejects.toThrow(/permission denied/);
    await expect(
      db.query("insert into public.facturen (organisatie_id, user_id, factuurnummer, status) values ($1, $2, $3, 'betaald')", [org, invoerder, nr()]),
    ).resolves.toBeDefined();
    expect(await waarde(db, "select count(*)::int from public.facturen where status = 'betaald'")).toBe(0);
  });

  it("alleen toegestane overgangen", async () => {
    await alsGebruiker(db, controller);
    const id = await slaOp({ factuurnummer: nr() });
    await expect(wijzig(id, "betaald")).rejects.toThrow(/geen toegestane statuswijziging/);
    await expect(wijzig(id, "onzin")).rejects.toThrow(/geen toegestane statuswijziging/);
  });
});

describe("rollen", () => {
  it("goedkeurder mag niet controleren, invoerder niet goedkeuren of betalen", async () => {
    await alsGebruiker(db, invoerder);
    const id = await slaOp({ factuurnummer: nr(), totaal_incl: 100 });
    await alsGebruiker(db, goedkeurder);
    await expect(wijzig(id, "gecontroleerd")).rejects.toThrow(/rol \(goedkeurder\)/);
    await alsGebruiker(db, invoerder);
    await wijzig(id, "gecontroleerd");
    await expect(wijzig(id, "goedgekeurd")).rejects.toThrow(/rol \(invoerder\)/);
    await alsGebruiker(db, goedkeurder);
    expect(await wijzig(id, "goedgekeurd")).toBeNull();
    await expect(wijzig(id, "betaald")).rejects.toThrow(/rol \(goedkeurder\)/);
    await alsGebruiker(db, controller);
    await wijzig(id, "betaald");
    const rij = await db.query<{ status: string; gecontroleerd_door: string; goedgekeurd_door: string; betaald: boolean }>(
      "select status, gecontroleerd_door, goedgekeurd_door, betaald_op is not null as betaald from public.facturen where id = $1",
      [id],
    );
    expect(rij.rows[0]).toEqual({ status: "betaald", gecontroleerd_door: invoerder, goedgekeurd_door: goedkeurder, betaald: true });
  });

  it("betaalde factuur kan niet meer worden gewijzigd", async () => {
    await alsGebruiker(db, controller);
    const id = await waarde<string>(db, "select id from public.facturen where status = 'betaald' limit 1");
    await expect(slaOp({ id, factuurnummer: "ANDERS", totaal_incl: 100 })).rejects.toThrow(/betaalde factuur/);
    await expect(db.query("delete from public.btw_regels where factuur_id = $1", [id])).resolves.toBeDefined();
    await expect(db.query("insert into public.btw_regels (factuur_id, tarief) values ($1, 21)", [id])).rejects.toThrow(/betaalde factuur/);
  });
});

describe("functiescheiding", () => {
  it("invoerder kan eigen factuur niet goedkeuren", async () => {
    await alsGebruiker(db, controller);
    const id = await slaOp({ factuurnummer: nr(), totaal_incl: 100 });
    await alsGebruiker(db, beheerder);
    await wijzig(id, "gecontroleerd");
    await alsGebruiker(db, controller);
    await expect(wijzig(id, "goedgekeurd")).rejects.toThrow(/zelf hebt ingevoerd/);
  });

  it("controleur kan zelf gecontroleerde factuur niet goedkeuren", async () => {
    const id = await gecontroleerdeFactuur({ factuurnummer: nr(), totaal_incl: 100 }, controller);
    await alsGebruiker(db, controller);
    await expect(wijzig(id, "goedgekeurd")).rejects.toThrow(/zelf hebt gecontroleerd/);
    await alsGebruiker(db, beheerder);
    await wijzig(id, "goedgekeurd");
  });
});

describe("goedkeuringsvoorwaarden", () => {
  it("boven de limiet: geblokkeerd met duidelijke reden; onbeperkte goedkeurder wel", async () => {
    const id = await gecontroleerdeFactuur({ factuurnummer: nr(), totaal_incl: 6000.5 });
    await alsGebruiker(db, goedkeurder);
    await expect(wijzig(id, "goedgekeurd")).rejects.toThrow("Boven je goedkeuringslimiet van € 5.000.");
    await alsGebruiker(db, controller);
    await wijzig(id, "goedgekeurd");
  });

  it("precies op de limiet mag", async () => {
    const id = await gecontroleerdeFactuur({ factuurnummer: nr(), totaal_incl: 5000 });
    await alsGebruiker(db, goedkeurder);
    await wijzig(id, "goedgekeurd");
  });

  it("open kritiek signaal blokkeert; na oplossen wel", async () => {
    await alsGebruiker(db, invoerder);
    await slaOp({ leverancier: "Kritiek BV", factuurnummer: nr(), iban: "NL91ABNA0417164300", totaal_incl: 10 });
    const id = await gecontroleerdeFactuur({ leverancier: "Kritiek BV", factuurnummer: nr(), iban: "NL44RABO0123456789", totaal_incl: 20 });
    await alsGebruiker(db, goedkeurder);
    await expect(wijzig(id, "goedgekeurd")).rejects.toThrow(/open kritiek signaal/);
    const signaal = await waarde<string>(db, "select id from public.factuur_signalen where factuur_id = $1 and ernst = 'kritiek'", [id]);
    await db.query("select public.los_signaal_op($1, 'Nagebeld, klopt')", [signaal]);
    await wijzig(id, "goedgekeurd");
  });

  it("grootboekrekening is verplicht", async () => {
    const id = await gecontroleerdeFactuur({ factuurnummer: nr(), totaal_incl: 10, grootboekrekening_id: null });
    await alsGebruiker(db, goedkeurder);
    await expect(wijzig(id, "goedgekeurd")).rejects.toThrow(/grootboekrekening/);
  });

  it("signaal net onder limiet", async () => {
    await alsGebruiker(db, invoerder);
    const net = await slaOp({ factuurnummer: nr(), totaal_incl: 4800 });
    const ver = await slaOp({ factuurnummer: nr(), totaal_incl: 4700 });
    expect(await waarde(db, "select bericht from public.factuur_signalen where factuur_id = $1 and type = 'net_onder_limiet'", [net]))
      .toContain("€ 5.000");
    expect(await waarde(db, "select count(*)::int from public.factuur_signalen where factuur_id = $1 and type = 'net_onder_limiet'", [ver]))
      .toBe(0);
  });
});

describe("terugval na inhoudelijke wijziging", () => {
  it("bedrag gewijzigd na controle → gescand; factuurnummer wijzigen niet", async () => {
    const id = await gecontroleerdeFactuur({ factuurnummer: "T-1", totaal_incl: 100 });
    await alsGebruiker(db, invoerder);
    await slaOp({ id, factuurnummer: "T-1a", totaal_incl: 100 });
    expect(await status(id)).toBe("gecontroleerd");
    await slaOp({ id, factuurnummer: "T-1a", totaal_incl: 101 });
    expect(await status(id)).toBe("gescand");
    expect(await waarde(db, "select gecontroleerd_door from public.facturen where id = $1", [id])).toBeNull();
  });

  it("btw-regels of IBAN gewijzigd na goedkeuring → gescand (ook via directe insert)", async () => {
    const id = await gecontroleerdeFactuur({ factuurnummer: nr(), totaal_incl: 121, btw_regels: [{ tarief: 21, grondslag: 100, btw_bedrag: 21 }] });
    await alsGebruiker(db, goedkeurder);
    await wijzig(id, "goedgekeurd");
    await alsGebruiker(db, invoerder);
    await db.query("insert into public.btw_regels (factuur_id, volgorde, tarief) values ($1, 1, 9)", [id]);
    expect(await status(id)).toBe("gescand");

    const id2 = await gecontroleerdeFactuur({ factuurnummer: nr(), totaal_incl: 10 });
    await alsGebruiker(db, invoerder);
    await slaOp({ id: id2, totaal_incl: 10, iban: "NL91ABNA0417164300" });
    expect(await status(id2)).toBe("gescand");
  });
});

describe("afkeuren", () => {
  it("reden verplicht; terug naar gescand wist de reden", async () => {
    await alsGebruiker(db, invoerder);
    const id = await slaOp({ factuurnummer: nr(), totaal_incl: 10 });
    await alsGebruiker(db, goedkeurder);
    await expect(wijzig(id, "afgekeurd", "  ")).rejects.toThrow(/reden is verplicht/);
    await wijzig(id, "afgekeurd", "Verkeerde tenaamstelling");
    expect(await waarde(db, "select afkeur_reden from public.facturen where id = $1", [id])).toBe("Verkeerde tenaamstelling");
    await expect(wijzig(id, "gescand")).rejects.toThrow(/rol \(goedkeurder\)/);
    await alsGebruiker(db, invoerder);
    await wijzig(id, "gescand");
    expect(await waarde(db, "select afkeur_reden from public.facturen where id = $1", [id])).toBeNull();
  });

  it("goedgekeurde factuur kan niet worden afgekeurd", async () => {
    const id = await gecontroleerdeFactuur({ factuurnummer: nr(), totaal_incl: 10 });
    await alsGebruiker(db, goedkeurder);
    await wijzig(id, "goedgekeurd");
    await expect(wijzig(id, "afgekeurd", "te laat")).rejects.toThrow(/geen toegestane/);
  });
});

describe("verwijderen", () => {
  it("invoerder verwijdert alleen eigen gescande factuur; beheerder altijd", async () => {
    const gecontroleerd = await gecontroleerdeFactuur({ factuurnummer: nr() });
    await alsGebruiker(db, invoerder);
    const eigen = await slaOp({ factuurnummer: nr() });
    await db.query("delete from public.facturen where id = $1", [gecontroleerd]);
    expect(await status(gecontroleerd)).toBe("gecontroleerd");
    await db.query("delete from public.facturen where id = $1", [eigen]);
    expect(await waarde(db, "select count(*)::int from public.facturen where id = $1", [eigen])).toBe(0);
    await alsGebruiker(db, beheerder);
    await db.query("delete from public.facturen where id = $1", [gecontroleerd]);
    expect(await waarde(db, "select count(*)::int from public.facturen where id = $1", [gecontroleerd])).toBe(0);
  });
});

describe("organisatie met één lid", () => {
  it("mag alles, met melding over functiescheiding", async () => {
    const solo = await maakGebruiker(db, "solo@example.invalid");
    const soloOrg = await organisatieVan(db, solo);
    await alsGebruiker(db, solo);
    const rek = await waarde<string>(db, "select id from public.grootboekrekeningen where organisatie_id = $1 limit 1", [soloOrg]);
    const id = await waarde<string>(db, "select public.sla_factuur_op($1::jsonb)", [
      JSON.stringify({ organisatie_id: soloOrg, factuurnummer: "S-1", totaal_incl: 99, grootboekrekening_id: rek }),
    ]);
    const melding = "Functiescheiding niet mogelijk: organisatie heeft één lid";
    expect(await wijzig(id, "gecontroleerd")).toBe(melding);
    expect(await wijzig(id, "goedgekeurd")).toBe(melding);
    expect(await wijzig(id, "betaald")).toBe(melding);
  });
});
