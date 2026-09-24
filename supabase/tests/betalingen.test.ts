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

const IBAN = "NL91ABNA0417164300";

async function slaOp(f: Record<string, unknown> = {}): Promise<string> {
  await alsGebruiker(db, invoerder);
  nummer++;
  return waarde<string>(db, "select public.sla_factuur_op($1::jsonb, true)", [
    JSON.stringify({
      organisatie_id: org, grootboekrekening_id: rekening, iban: IBAN, leverancier: `Betaal BV ${nummer}`,
      factuurnummer: `P-${nummer}`, totaal_incl: 100 + nummer, valuta: "EUR", vervaldatum: "2026-10-15", ...f,
    }),
  ]);
}

async function goedgekeurd(f: Record<string, unknown> = {}): Promise<string> {
  const id = await slaOp(f);
  await alsGebruiker(db, controller);
  await db.query("select public.wijzig_status($1, 'gecontroleerd')", [id]);
  await alsGebruiker(db, goedkeurder);
  await db.query("select public.wijzig_status($1, 'goedgekeurd')", [id]);
  return id;
}

async function status(id: string): Promise<string> {
  await alsBeheerder(db);
  return waarde(db, "select status from public.facturen where id = $1", [id]);
}

async function maakBatch(ids: string[], als = controller): Promise<string> {
  await alsGebruiker(db, als);
  return waarde(db, "select public.maak_betaalbatch($1, $2, null)", [org, ids]);
}

async function batch(id: string): Promise<Record<string, any>> {
  await alsServiceRole(db);
  return waarde(db, "select public.betaalbatch_gegevens($1)", [id]);
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
  await db.query("select public.voeg_lid_toe($1, 'goedkeurder@example.invalid', 'goedkeurder')", [org]);
  rekening = await waarde(db, "select id from public.grootboekrekeningen where organisatie_id = $1 and code = '4300'", [org]);
});

afterAll(async () => {
  await db.close();
});

describe("betaalbatch maken", () => {
  it("zonder betalende rekening: duidelijke fout", async () => {
    const id = await goedgekeurd();
    await expect(maakBatch([id])).rejects.toThrow(/Stel eerst de betalende rekening in/);
    await alsGebruiker(db, beheerder);
    await db.query("select public.stel_koppeling_in($1, 'betaling', 'mock', $2::jsonb)", [
      org, JSON.stringify({ naam: "Mijn Bedrijf B.V.", iban: "NL44 RABO 0123 4567 89", bic: "RABONL2U" }),
    ]);
  });

  it("goedgekeurd → in betaalbatch; posten met kenmerk, bedrag en omschrijving; batch-taak gepland", async () => {
    // Posten staan op vervaldatum (daarna id): verschillende datums voor een vaste volgorde
    const a = await goedgekeurd({ totaal_incl: 121.5, vervaldatum: "2026-10-10" });
    const b = await goedgekeurd({ totaal_incl: 50, vervaldatum: "2026-10-20" });
    const batchId = await maakBatch([a, b]);
    expect(await status(a)).toBe("in_betaalbatch");

    const g = await batch(batchId);
    expect(g).toMatchObject({
      status: "aangemaakt", aantal: 2, totaal: 171.5, debiteur_naam: "Mijn Bedrijf B.V.", debiteur_iban: "NL44RABO0123456789",
      debiteur_bic: "RABONL2U",
    });
    expect(g.nummer).toMatch(/^FS\d{8}-001$/);
    expect(g.posten.map((p: any) => [p.end_to_end_id, p.bedrag, p.iban, p.status])).toEqual([
      [`${g.nummer}-001`, 121.5, IBAN, "open"],
      [`${g.nummer}-002`, 50, IBAN, "open"],
    ]);
    expect(g.posten[0].omschrijving).toMatch(/^Factuur P-\d+$/);

    await alsBeheerder(db);
    const [log] = await rijen<{ actie: string; bron: string; user_id: string; toelichting: string }>(db,
      "select actie, bron, user_id, toelichting from public.audit_log where record_id = $1 and actie = 'statuswijziging' order by id desc limit 1", [a]);
    expect(log).toEqual({ actie: "statuswijziging", bron: "betaling", user_id: controller, toelichting: `Opgenomen in betaalbatch ${g.nummer}` });
    expect(await waarde(db, "select count(*)::int from public.koppeling_taken where soort = 'betaling' and sleutel = $1", [`${batchId}:indienen`])).toBe(1);
  });

  it("een factuur kan niet in twee batches", async () => {
    const a = await goedgekeurd();
    await maakBatch([a]);
    await expect(maakBatch([a])).rejects.toThrow(/zit al in een betaalbatch/);
  });

  it("validatie: status, valuta, IBAN, SEPA-land, kritiek signaal; alle fouten tegelijk en niets aangemaakt", async () => {
    const open = await slaOp();
    const usd = await goedgekeurd({ valuta: "USD" });
    const geenIban = await goedgekeurd({ iban: null });
    const buiten = await goedgekeurd({ iban: "TR330006100519786457841326" });
    const goed = await goedgekeurd();
    await alsBeheerder(db);
    const voor = await waarde<number>(db, "select count(*)::int from public.betaalbatches");
    const fout = (await maakBatch([open, usd, geenIban, buiten, goed]).then(() => new Error("geen fout"), (e: Error) => e));
    expect(fout.message).toMatch(/status is "gescand"/);
    expect(fout.message).toMatch(/alleen in euro \(valuta USD\)/);
    expect(fout.message).toMatch(/IBAN ontbreekt/);
    expect(fout.message).toMatch(/buiten het SEPA-gebied/);
    await alsBeheerder(db);
    expect(await waarde(db, "select count(*)::int from public.betaalbatches")).toBe(voor);
    expect(await status(goed)).toBe("goedgekeurd");

    // Kritiek signaal: afwijkend IBAN t.o.v. de leverancier
    const eerste = await goedgekeurd({ leverancier: "Signaal BV" });
    await maakBatch([eerste]);
    const tweede = await slaOp({ leverancier: "Signaal BV", iban: "NL44RABO0123456789" });
    await alsBeheerder(db);
    expect(await waarde(db, "select count(*)::int from public.factuur_signalen where factuur_id = $1 and type = 'iban_afwijkend'", [tweede])).toBe(1);
  });

  it("alleen controller of beheerder; buitenstaander ziet niets", async () => {
    const a = await goedgekeurd();
    await expect(maakBatch([a], invoerder)).rejects.toThrow(/controller of beheerder/);
    await expect(maakBatch([a], goedkeurder)).rejects.toThrow(/controller of beheerder/);
    await alsGebruiker(db, buitenstaander);
    expect(await rijen(db, "select 1 from public.betaalbatches where organisatie_id = $1", [org])).toEqual([]);
    expect(await rijen(db, "select 1 from public.betaalbatch_posten where organisatie_id = $1", [org])).toEqual([]);
  });
});

describe("vergrendeling in een batch", () => {
  it("inhoud, btw-regels en verwijderen geblokkeerd; handmatig betaald markeren ook niet", async () => {
    const a = await goedgekeurd();
    await maakBatch([a]);
    await alsGebruiker(db, invoerder);
    await expect(db.query("update public.facturen set iban = 'NL44RABO0123456789' where id = $1", [a])).rejects.toThrow(/betaalbatch/);
    await expect(db.query("insert into public.btw_regels (factuur_id, volgorde, tarief) values ($1, 5, 21)", [a])).rejects.toThrow(/betaalbatch/);
    await alsGebruiker(db, beheerder);
    await expect(db.query("delete from public.facturen where id = $1", [a])).rejects.toThrow(/betaalbatch/);
    await expect(db.query("select public.wijzig_status($1, 'betaald')", [a])).rejects.toThrow(/geen toegestane statuswijziging/);
  });
});

describe("afronden", () => {
  it("live: ingediend en bevestigd → facturen betaald", async () => {
    const a = await goedgekeurd();
    const b = await goedgekeurd();
    const id = await maakBatch([a, b]);
    await alsGebruiker(db, controller);
    await db.query("select public.log_betaalbestand_download($1)", [id]);
    await db.query("select public.markeer_batch_ingediend($1)", [id]);
    expect(await waarde(db, "select public.bevestig_betaalbatch($1)", [id])).toBe(2);
    expect([await status(a), await status(b)]).toEqual(["betaald", "betaald"]);
    expect(await batch(id)).toMatchObject({ status: "verwerkt", modus: "live" });
    await alsGebruiker(db, controller);
    await expect(db.query("select public.annuleer_betaalbatch($1, 'te laat')", [id])).rejects.toThrow(/status "verwerkt"/);

    await alsBeheerder(db);
    const logs = await rijen<{ omschrijving: string }>(db,
      "select nieuw ->> 'omschrijving' as omschrijving from public.audit_log where record_id = $1 order by id", [id]);
    expect(logs.map((l) => l.omschrijving)).toEqual([
      expect.stringMatching(/^Betaalbatch FS\d{8}-\d{3} gemaakt: 2 facturen/),
      expect.stringMatching(/SEPA-bestand .* gedownload/),
      expect.stringMatching(/bij de bank aangeboden/),
      expect.stringMatching(/als uitgevoerd bevestigd: 2 betaald/),
    ]);
  });

  it("annuleren (reden verplicht) zet de facturen terug; daarna kunnen ze in een nieuwe batch", async () => {
    const a = await goedgekeurd();
    const id = await maakBatch([a]);
    await alsGebruiker(db, controller);
    await expect(db.query("select public.annuleer_betaalbatch($1, ' ')", [id])).rejects.toThrow(/reden is verplicht/);
    expect(await waarde(db, "select public.annuleer_betaalbatch($1, 'Verkeerde uitvoerdatum')", [id])).toBe(1);
    expect(await status(a)).toBe("goedgekeurd");
    // Geen nieuwe export door het terugzetten naar goedgekeurd (alleen bij echt goedkeuren)
    await alsBeheerder(db);
    expect(await waarde(db, "select count(*)::int from public.koppeling_taken where soort = 'boekhouding' and factuur_id = $1", [a])).toBe(1);
    await expect(maakBatch([a])).resolves.toBeTruthy();
  });

  it("mock-bank: ingediend, daarna per betaling betaald of geweigerd", async () => {
    const a = await goedgekeurd();
    const b = await goedgekeurd();
    const id = await maakBatch([a, b]);
    const g = await batch(id);
    await alsServiceRole(db);
    await db.query("select public.registreer_batch_ingediend($1, 'MOCKBANK-1', 'mock')", [id]);
    await db.query("select public.registreer_batch_ingediend($1, 'MOCKBANK-2', 'mock')", [id]); // idempotent
    expect(await batch(id)).toMatchObject({ status: "ingediend", bank_referentie: "MOCKBANK-1", modus: "mock" });
    await alsBeheerder(db);
    expect(await waarde(db, "select count(*)::int from public.koppeling_taken where sleutel = $1 and volgende_poging_op > now()", [`${id}:status`])).toBe(1);

    await alsServiceRole(db);
    const r = await waarde(db, "select public.verwerk_bankbevestiging($1, $2::jsonb)", [id, JSON.stringify([
      { end_to_end_id: g.posten[0].end_to_end_id, status: "betaald" },
      { end_to_end_id: g.posten[1].end_to_end_id, status: "geweigerd", reden: "AC04 Rekening opgeheven" },
      { end_to_end_id: "onbekend", status: "betaald" },
    ])]);
    expect(r).toEqual({ betaald: 1, geweigerd: 1, batch_status: "verwerkt" });
    expect([await status(g.posten[0].factuur_id), await status(g.posten[1].factuur_id)]).toEqual(["betaald", "goedgekeurd"]);
    await alsBeheerder(db);
    const [log] = await rijen<{ bron: string; user_id: string | null; toelichting: string }>(db,
      "select bron, user_id, toelichting from public.audit_log where record_id = $1 and actie = 'statuswijziging' order by id desc limit 1",
      [g.posten[1].factuur_id]);
    expect(log).toMatchObject({ bron: "betaling", user_id: null, toelichting: expect.stringMatching(/geweigerd door de bank .*AC04/) });

    // Een geweigerde betaling kan opnieuw in een batch
    await expect(maakBatch([g.posten[1].factuur_id])).resolves.toBeTruthy();
    // Nog een keer bevestigen doet niets
    await alsServiceRole(db);
    expect(await waarde(db, "select public.verwerk_bankbevestiging($1, '[]'::jsonb)", [id])).toEqual({ betaald: 0, geweigerd: 0, batch_status: "verwerkt" });
  });

  it("gebruikers kunnen de bank-functies niet aanroepen", async () => {
    await alsGebruiker(db, beheerder);
    for (const sql of [
      "select public.betaalbatch_gegevens(gen_random_uuid())",
      "select public.registreer_batch_ingediend(gen_random_uuid(), 'x', 'mock')",
      "select public.verwerk_bankbevestiging(gen_random_uuid(), '[]'::jsonb)",
    ]) {
      await expect(db.query(sql), sql).rejects.toThrow(/permission denied/);
    }
  });
});
