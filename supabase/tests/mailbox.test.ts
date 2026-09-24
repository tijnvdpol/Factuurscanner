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

const ADRES = "facturen@inbox.voorbeeld.nl";

let db: PGlite;
let beheerder: string;
let invoerder: string;
let controller: string;
let goedkeurder: string;
let buitenstaander: string;
let org: string;
let volgnummer = 0;

interface Registratie {
  status: string;
  bericht_id?: string;
  organisatie_id?: string;
  bekend?: boolean;
}

async function registreer(extra: Record<string, unknown> = {}): Promise<Registratie> {
  await alsServiceRole(db);
  return waarde<Registratie>(db, "select public.registreer_inbox_bericht($1::jsonb)", [
    JSON.stringify({
      aan: ADRES, van: "facturen@leverancier.nl", onderwerp: "Factuur", message_id: `<m${++volgnummer}@leverancier.nl>`,
      spf: "Pass", dkim: "Pass", spam: false, bron: "mailgun", ...extra,
    }),
  ]);
}

async function rondAf(berichtId: string, bijlagen: Record<string, unknown>[] = [pdf(1)]): Promise<number> {
  await alsServiceRole(db);
  return waarde<number>(db, "select public.rond_inbox_bericht_af($1, $2::jsonb)", [berichtId, JSON.stringify(bijlagen)]);
}

function pdf(n: number, pad: string | null = `inbox/${n}.pdf`) {
  return { volgnummer: n, bestandsnaam: `factuur-${n}.pdf`, mime_type: "application/pdf", grootte: 1000, pad: pad && `${org}/${pad}` };
}

async function bijlagen(berichtId: string): Promise<{ id: string; status: string; reden: string | null; factuur_id: string | null }[]> {
  await alsBeheerder(db);
  return rijen(db, "select id, status, reden, factuur_id from public.inbox_bijlagen where bericht_id = $1 order by volgnummer", [berichtId]);
}

async function mailboxTaken(bijlageId: string): Promise<{ id: string; status: string }[]> {
  await alsBeheerder(db);
  return rijen(db, "select id, status from public.koppeling_taken where soort = 'mailbox' and sleutel = $1", [bijlageId]);
}

const SCAN = {
  leverancier: "Leverancier B.V.", factuurnummer: "L-2026-001", factuurdatum: "2026-09-20", vervaldatum: "2026-10-20",
  valuta: "EUR", bedrag_excl: 100, totaal_incl: 121, iban: "NL91ABNA0417164300", btw_nummer: "NL123456789B01", kvk_nummer: "12345678",
  btw_regels: [{ tarief: 21, grondslag: 100, btw_bedrag: 21 }],
};

async function maakFactuur(bijlageId: string, factuur: object = SCAN): Promise<{ status: string; factuur_id: string }> {
  await alsServiceRole(db);
  return waarde(db, "select public.maak_factuur_uit_inbox($1, $1, $2::jsonb, $3, 'gemini-test', null)", [
    bijlageId, JSON.stringify(factuur), `${org}/${bijlageId}/factuur.pdf`,
  ]);
}

/** Een geaccepteerde mail met één bijlage in de wachtrij; geeft het bijlage-id. */
async function geaccepteerdeBijlage(): Promise<string> {
  const r = await registreer();
  await rondAf(r.bericht_id!);
  return (await bijlagen(r.bericht_id!))[0].id;
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
});

afterAll(async () => {
  await db.close();
});

describe("instellingen", () => {
  it("ontvangstadres: alleen de beheerder; opgeslagen in kleine letters", async () => {
    await alsGebruiker(db, controller);
    await expect(db.query("select public.stel_inbox_adres_in($1, $2)", [org, ADRES])).rejects.toThrow(/beheerder/);
    await alsGebruiker(db, beheerder);
    await expect(db.query("select public.stel_inbox_adres_in($1, 'geen-adres')", [org])).rejects.toThrow(/Ongeldig/);
    await db.query("select public.stel_inbox_adres_in($1, $2)", [org, "Facturen@Inbox.Voorbeeld.nl"]);
    expect(await waarde(db, "select adres from public.inbox_adressen where organisatie_id = $1", [org])).toBe(ADRES);
  });

  it("vertrouwde afzenders: controller en beheerder, adres of domein; in de audit log", async () => {
    await alsGebruiker(db, invoerder);
    await expect(db.query("select public.voeg_inbox_afzender_toe($1, 'x@y.nl')", [org])).rejects.toThrow(/controller of beheerder/);
    await alsGebruiker(db, controller);
    await expect(db.query("select public.voeg_inbox_afzender_toe($1, 'leverancier.nl')", [org])).rejects.toThrow(/e-mailadres/);
    await db.query("select public.voeg_inbox_afzender_toe($1, '@Leverancier.nl', 'Vaste leverancier')", [org]);
    await db.query("select public.voeg_inbox_afzender_toe($1, 'boekhouding@partner.nl')", [org]);
    await alsBeheerder(db);
    expect(await waarde(db, "select count(*)::int from public.audit_log where tabel = 'inbox_afzenders' and user_id = $1", [controller])).toBe(2);
  });

  it("gebruikers kunnen de tabellen niet rechtstreeks wijzigen; buitenstaanders zien niets", async () => {
    await alsGebruiker(db, beheerder);
    await expect(db.query("insert into public.inbox_afzenders (organisatie_id, patroon) values ($1, '@x.nl')", [org])).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.inbox_adressen set adres = 'x@y.nl'")).rejects.toThrow(/permission denied/);
    await expect(db.query("select public.registreer_inbox_bericht('{}'::jsonb)")).rejects.toThrow(/permission denied/);
    await alsGebruiker(db, buitenstaander);
    expect(await waarde(db, "select count(*)::int from public.inbox_afzenders")).toBe(0);
    expect(await waarde(db, "select count(*)::int from public.inbox_adressen")).toBe(0);
  });
});

describe("mail ontvangen", () => {
  it("onbekend ontvangstadres", async () => {
    expect(await registreer({ aan: "iemand@anders.nl" })).toEqual({ status: "onbekend_adres" });
  });

  it("bekende afzender (domein) + SPF: geaccepteerd; bruikbare bijlagen direct in de wachtrij", async () => {
    const r = await registreer({ van: "Facturen@Leverancier.nl" });
    expect(r).toMatchObject({ status: "nieuw", organisatie_id: org, bekend: true });
    expect(await rondAf(r.bericht_id!, [pdf(1), pdf(2, null)])).toBe(1);
    const b = await bijlagen(r.bericht_id!);
    expect(b.map((x) => x.status)).toEqual(["wachtrij", "genegeerd"]);
    expect(await mailboxTaken(b[0].id)).toEqual([{ id: expect.any(String), status: "wachtrij" }]);
    await alsBeheerder(db);
    expect(await waarde(db, "select status from public.inbox_berichten where id = $1", [r.bericht_id])).toBe("geaccepteerd");
    expect(await waarde(db, "select nieuw ->> 'omschrijving' from public.audit_log where tabel = 'inbox_berichten' and record_id = $1", [r.bericht_id]))
      .toBe("Mail van facturen@leverancier.nl ontvangen (2 bijlagen, 1 bruikbaar)");
  });

  it("vertrouwd adres maar SPF én DKIM niet geslaagd (mogelijk vervalst): ter beoordeling", async () => {
    const r = await registreer({ van: "boekhouding@partner.nl", spf: "SoftFail", dkim: "Fail" });
    expect(r.bekend).toBe(false);
    await rondAf(r.bericht_id!);
    expect((await bijlagen(r.bericht_id!)).map((x) => x.status)).toEqual(["wacht"]);
  });

  it("spam of onbekende afzender: ter beoordeling", async () => {
    expect((await registreer({ spam: true })).bekend).toBe(false);
    expect((await registreer({ van: "nep@leverancier.nl.evil.com" })).bekend).toBe(false);
    expect((await registreer({ van: "iemand@andere-partner.nl" })).bekend).toBe(false);
  });

  it("dezelfde Message-Id: duplicaat; een onderbroken registratie wordt afgemaakt", async () => {
    const eerst = await registreer({ message_id: "<dubbel@x>" });
    // Webhook faalde voor rond_inbox_bericht_af: Mailgun probeert opnieuw → zelfde bericht, nog 'nieuw'
    expect(await registreer({ message_id: "<dubbel@x>" })).toMatchObject({ status: "nieuw", bericht_id: eerst.bericht_id });
    await rondAf(eerst.bericht_id!);
    expect(await registreer({ message_id: "<dubbel@x>" })).toMatchObject({ status: "duplicaat", bericht_id: eerst.bericht_id });
    // Nog een keer afronden verandert niets
    await rondAf(eerst.bericht_id!, [pdf(1), pdf(2)]);
    expect(await bijlagen(eerst.bericht_id!)).toHaveLength(1);
  });
});

describe("beoordelen", () => {
  let n = 0;
  async function teBeoordelen(): Promise<string> {
    const r = await registreer({ van: `onbekend${++n}@nieuw-bedrijf.nl` });
    await rondAf(r.bericht_id!);
    return r.bericht_id!;
  }

  it("alleen controller of beheerder; invoerder en buitenstaander niet", async () => {
    const id = await teBeoordelen();
    await alsGebruiker(db, invoerder);
    await expect(db.query("select public.beoordeel_inbox_bericht($1, 'verwerken')", [id])).rejects.toThrow(/controller of beheerder/);
    await alsGebruiker(db, buitenstaander);
    await expect(db.query("select public.beoordeel_inbox_bericht($1, 'verwerken')", [id])).rejects.toThrow(/niet gevonden/);
  });

  it("verwerken (en afzender vertrouwen): bijlagen naar de wachtrij, beoordeling in de audit log", async () => {
    const id = await teBeoordelen();
    await alsGebruiker(db, controller);
    expect(await waarde(db, "select public.beoordeel_inbox_bericht($1, 'verwerken', true, 'Nieuwe leverancier, gebeld')", [id])).toBe(1);
    const [b] = await bijlagen(id);
    expect(b.status).toBe("wachtrij");
    expect(await mailboxTaken(b.id)).toHaveLength(1);
    await alsBeheerder(db);
    expect(await waarde(db, "select count(*)::int from public.inbox_afzenders where patroon = 'onbekend2@nieuw-bedrijf.nl'")).toBe(1);
    const [log] = await rijen<{ user_id: string; bron: string; toelichting: string }>(
      db, "select user_id, bron, toelichting from public.audit_log where tabel = 'inbox_berichten' and record_id = $1 order by id desc limit 1", [id],
    );
    expect(log).toEqual({ user_id: controller, bron: "app", toelichting: "Nieuwe leverancier, gebeld" });
    await alsGebruiker(db, controller);
    await expect(db.query("select public.beoordeel_inbox_bericht($1, 'weigeren', false, 'x')", [id])).rejects.toThrow(/al beoordeeld/);
  });

  it("weigeren: reden verplicht, bijlagen genegeerd, geen taken", async () => {
    const id = await teBeoordelen();
    await alsGebruiker(db, beheerder);
    await expect(db.query("select public.beoordeel_inbox_bericht($1, 'weigeren')", [id])).rejects.toThrow(/reden/);
    await db.query("select public.beoordeel_inbox_bericht($1, 'weigeren', false, 'Phishing')", [id]);
    const [b] = await bijlagen(id);
    expect(b).toMatchObject({ status: "genegeerd", reden: "Mail geweigerd" });
    expect(await mailboxTaken(b.id)).toEqual([]);
  });
});

describe("factuur uit een bijlage", () => {
  it("bron mailbox, geen 'ingevoerd door', status gescand, signalen en verrijking; audit met bron mailbox", async () => {
    const bijlage = await geaccepteerdeBijlage();
    expect(await maakFactuur(bijlage)).toEqual({ status: "verwerkt", factuur_id: bijlage });
    await alsBeheerder(db);
    const [f] = await rijen<Record<string, unknown>>(
      db, "select bron, user_id, status, inbox_bijlage_id, bestand_pad, leverancier_naam, totaal_incl::float8 as totaal from public.facturen where id = $1", [bijlage],
    );
    expect(f).toEqual({
      bron: "mailbox", user_id: null, status: "gescand", inbox_bijlage_id: bijlage, bestand_pad: `${org}/${bijlage}/factuur.pdf`,
      leverancier_naam: "Leverancier B.V.", totaal: 121,
    });
    expect(await waarde(db, "select count(*)::int from public.factuur_signalen where factuur_id = $1 and type = 'nieuwe_leverancier'", [bijlage])).toBe(1);
    expect((await rijen<{ soort: string }>(db, "select soort from public.koppeling_taken where factuur_id = $1 order by soort", [bijlage])).map((t) => t.soort))
      .toEqual(["kvk", "vies"]);
    const log = await rijen<{ actie: string; bron: string; user_id: string | null }>(
      db, "select actie, bron, user_id from public.audit_log where tabel = 'facturen' and record_id = $1 order by id", [bijlage],
    );
    expect(log.slice(0, 1)).toEqual([{ actie: "insert", bron: "mailbox", user_id: null }]);
    expect(log.some((l) => l.actie === "import" && l.bron === "mailbox")).toBe(true);
    expect((await bijlagen((await rijen<{ bericht_id: string }>(db, "select bericht_id from public.inbox_bijlagen where id = $1", [bijlage]))[0].bericht_id))[0])
      .toMatchObject({ status: "verwerkt", factuur_id: bijlage });
    // Nog een keer (nieuwe poging van de worker): geen tweede factuur
    expect(await maakFactuur(bijlage)).toEqual({ status: "verwerkt", factuur_id: bijlage });
  });

  it("zelfde leverancier + factuurnummer: duplicaat, geen factuur", async () => {
    const bijlage = await geaccepteerdeBijlage();
    expect((await maakFactuur(bijlage)).status).toBe("duplicaat");
    await alsBeheerder(db);
    expect(await waarde(db, "select count(*)::int from public.facturen where id = $1", [bijlage])).toBe(0);
    expect((await rijen<{ status: string; reden: string }>(db, "select status, reden from public.inbox_bijlagen where id = $1", [bijlage]))[0])
      .toEqual({ status: "duplicaat", reden: "Factuur L-2026-001 van Leverancier B.V. staat al in het overzicht." });
  });

  it("een nieuw IBAN bij een bekende leverancier geeft het kritieke signaal (net als bij uploaden)", async () => {
    const bijlage = await geaccepteerdeBijlage();
    await maakFactuur(bijlage, { ...SCAN, factuurnummer: "L-2026-002", iban: "NL44RABO0123456789" });
    await alsBeheerder(db);
    expect(await waarde(db, "select ernst from public.factuur_signalen where factuur_id = $1 and type = 'iban_afwijkend'", [bijlage])).toBe("kritiek");
    expect(await waarde(db, "select iban from public.leveranciers where organisatie_id = $1 and naam = 'Leverancier B.V.'", [org])).toBe("NL91ABNA0417164300");
  });

  it("alleen voor een geaccepteerde mail en met een pad onder de factuur", async () => {
    const r = await registreer({ van: "onbekend@x.nl" });
    await rondAf(r.bericht_id!);
    const [b] = await bijlagen(r.bericht_id!);
    await expect(maakFactuur(b.id)).rejects.toThrow(/niet \(meer\) goedgekeurd/);
    const bijlage = await geaccepteerdeBijlage();
    await alsServiceRole(db);
    await expect(db.query("select public.maak_factuur_uit_inbox($1, $1, '{}'::jsonb, $2, null, null)", [bijlage, `${org}/inbox/x.pdf`]))
      .rejects.toThrow(/Ongeldig bestandspad/);
    await alsGebruiker(db, beheerder);
    await expect(db.query("select public.maak_factuur_uit_inbox($1, $1, '{}'::jsonb, 'x', null, null)", [bijlage])).rejects.toThrow(/permission denied/);
  });

  it("functiescheiding en limiet gelden ook voor mailfacturen", async () => {
    const bijlage = await geaccepteerdeBijlage();
    await maakFactuur(bijlage, { ...SCAN, factuurnummer: "L-2026-003", totaal_incl: 6050, bedrag_excl: 5000, btw_regels: [{ tarief: 21, grondslag: 5000, btw_bedrag: 1050 }] });
    await alsGebruiker(db, controller);
    await db.query("select public.wijzig_status($1, 'gecontroleerd')", [bijlage]);
    await expect(db.query("select public.wijzig_status($1, 'goedgekeurd')", [bijlage])).rejects.toThrow(/zelf hebt gecontroleerd/);
    await alsGebruiker(db, goedkeurder);
    // € 6.050 is boven de limiet van € 5.000 van de goedkeurder
    await expect(db.query("select public.wijzig_status($1, 'goedgekeurd')", [bijlage])).rejects.toThrow(/goedkeuringslimiet/);
  });

  it("gebruikers kunnen de herkomst niet vervalsen", async () => {
    await alsGebruiker(db, invoerder);
    const id = await waarde<string>(db, "select public.sla_factuur_op($1::jsonb)", [JSON.stringify({ organisatie_id: org, leverancier: "Eigen", factuurnummer: "E1" })]);
    await expect(db.query("update public.facturen set bron = 'mailbox' where id = $1", [id])).rejects.toThrow(/permission denied/);
    await alsServiceRole(db);
    await db.query("update public.facturen set bron = 'mailbox' where id = $1", [id]);
    expect(await waarde(db, "select bron from public.facturen where id = $1", [id])).toBe("upload");
  });
});

describe("status van de taak op de bijlage", () => {
  it("opgegeven → bijlage mislukt; opnieuw proberen → weer in de wachtrij", async () => {
    const bijlage = await geaccepteerdeBijlage();
    const [taak] = await mailboxTaken(bijlage);
    await alsServiceRole(db);
    await db.query("select * from public.claim_taken(50, array['mailbox'])");
    await db.query("select public.rond_taak_af($1, false, null, 'Scannen mislukt: onleesbaar', false)", [taak.id]);
    await alsBeheerder(db);
    expect((await rijen(db, "select status, reden from public.inbox_bijlagen where id = $1", [bijlage]))[0])
      .toEqual({ status: "mislukt", reden: "Scannen mislukt: onleesbaar" });

    await alsGebruiker(db, invoerder);
    expect(await waarde(db, "select public.taak_van_inbox_bijlage($1)", [bijlage])).toBe(taak.id);
    await db.query("select public.probeer_taak_opnieuw($1)", [taak.id]);
    await alsBeheerder(db);
    expect((await rijen(db, "select status, reden from public.inbox_bijlagen where id = $1", [bijlage]))[0]).toEqual({ status: "wachtrij", reden: null });
  });

  it("buitenstaanders zien geen berichten of bijlagen", async () => {
    await alsGebruiker(db, buitenstaander);
    expect(await waarde(db, "select count(*)::int from public.inbox_berichten")).toBe(0);
    expect(await waarde(db, "select count(*)::int from public.inbox_bijlagen")).toBe(0);
    await alsGebruiker(db, invoerder);
    expect(await waarde<number>(db, "select count(*)::int from public.inbox_berichten")).toBeGreaterThan(0);
  });
});
