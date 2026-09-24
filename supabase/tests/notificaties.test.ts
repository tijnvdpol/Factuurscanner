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
let kleineGoedkeurder: string;
let buitenstaander: string;
let org: string;
let rekening: string;
let nummer = 0;

interface Notificatie {
  id: string;
  soort: string;
  ontvanger_id: string;
  factuur_id: string | null;
  status: string;
  details: Record<string, unknown>;
}

async function slaOp(f: Record<string, unknown> = {}): Promise<string> {
  await alsGebruiker(db, invoerder);
  nummer++;
  return waarde<string>(db, "select public.sla_factuur_op($1::jsonb, true)", [
    JSON.stringify({
      organisatie_id: org, grootboekrekening_id: rekening, iban: "NL91ABNA0417164300", leverancier: "Leverancier BV",
      factuurnummer: `N-${nummer}`, totaal_incl: 1000 + nummer, valuta: "EUR", ...f,
    }),
  ]);
}

async function wijzigStatus(userId: string, factuurId: string, status: string, reden: string | null = null): Promise<void> {
  await alsGebruiker(db, userId);
  await db.query("select public.wijzig_status($1, $2, $3)", [factuurId, status, reden]);
}

async function notificaties(filter: { soort?: string; factuur_id?: string } = {}): Promise<Notificatie[]> {
  await alsBeheerder(db);
  const lijst = await rijen<Notificatie>(
    db, "select id, soort, ontvanger_id, factuur_id, status, details from public.notificaties where organisatie_id = $1 order by created_at, id", [org],
  );
  return lijst.filter((n) => (!filter.soort || n.soort === filter.soort) && (!filter.factuur_id || n.factuur_id === filter.factuur_id));
}

const ontvangers = (lijst: Notificatie[]) => lijst.map((n) => n.ontvanger_id).sort();

/** Gecontroleerde factuur (ingevoerd door de invoerder, gecontroleerd door de controller). */
async function gecontroleerd(f: Record<string, unknown> = {}): Promise<string> {
  const id = await slaOp(f);
  await wijzigStatus(controller, id, "gecontroleerd");
  return id;
}

async function mailActie(notificatieId: string): Promise<{ id: string; verloopt_op: string }> {
  await alsServiceRole(db);
  return waarde(db, "select public.maak_mail_actie($1)", [notificatieId]);
}

async function voerUit(actieId: string, actie: string, reden: string | null = null): Promise<{ ok: boolean; melding: string }> {
  await alsServiceRole(db);
  return waarde(db, "select public.voer_mail_actie_uit($1, $2, $3)", [actieId, actie, reden]);
}

async function goedkeuringsmailVoor(factuurId: string, userId: string): Promise<Notificatie> {
  const n = (await notificaties({ soort: "goedkeuren", factuur_id: factuurId })).find((x) => x.ontvanger_id === userId);
  if (!n) throw new Error("Geen goedkeuringsmail gevonden");
  return n;
}

async function factuur(id: string): Promise<{ status: string; goedgekeurd_door: string | null; afkeur_reden: string | null }> {
  await alsBeheerder(db);
  const [f] = await rijen<{ status: string; goedgekeurd_door: string | null; afkeur_reden: string | null }>(
    db, "select status, goedgekeurd_door, afkeur_reden from public.facturen where id = $1", [id],
  );
  return f;
}

beforeAll(async () => {
  db = await maakDatabase();
  beheerder = await maakGebruiker(db, "beheerder@example.invalid");
  invoerder = await maakGebruiker(db, "invoerder@example.invalid");
  controller = await maakGebruiker(db, "controller@example.invalid");
  goedkeurder = await maakGebruiker(db, "goedkeurder@example.invalid");
  kleineGoedkeurder = await maakGebruiker(db, "klein@example.invalid");
  buitenstaander = await maakGebruiker(db, "buiten@example.invalid");
  org = await organisatieVan(db, beheerder);
  await alsGebruiker(db, beheerder);
  await db.query("select public.voeg_lid_toe($1, 'invoerder@example.invalid', 'invoerder')", [org]);
  await db.query("select public.voeg_lid_toe($1, 'controller@example.invalid', 'controller')", [org]);
  await db.query("select public.voeg_lid_toe($1, 'goedkeurder@example.invalid', 'goedkeurder', 5000)", [org]);
  await db.query("select public.voeg_lid_toe($1, 'klein@example.invalid', 'goedkeurder', 500)", [org]);
  rekening = await waarde(db, "select id from public.grootboekrekeningen where organisatie_id = $1 and code = '4300'", [org]);
});

afterAll(async () => {
  await db.close();
});

describe("goedkeuringsmail", () => {
  it("na controleren: alleen wie mag goedkeuren binnen de limiet, niet invoerder of controleur", async () => {
    const id = await gecontroleerd({ totaal_incl: 1210 });
    const lijst = await notificaties({ soort: "goedkeuren", factuur_id: id });
    // beheerder (geen limiet) en goedkeurder (5.000); niet de kleine goedkeurder (500), controller (controleur) of invoerder
    expect(ontvangers(lijst)).toEqual([beheerder, goedkeurder].sort());

    await alsBeheerder(db);
    const taken = await rijen<{ sleutel: string; factuur_id: string }>(
      db, "select sleutel, factuur_id from public.koppeling_taken where soort = 'email' and factuur_id = $1", [id],
    );
    expect(taken.map((t) => t.sleutel).sort()).toEqual(lijst.map((n) => n.id).sort());
  });

  it("boven de limiet van iedereen met een limiet: alleen wie geen limiet heeft", async () => {
    const id = await gecontroleerd({ totaal_incl: 8000 });
    expect(ontvangers(await notificaties({ soort: "goedkeuren", factuur_id: id }))).toEqual([beheerder]);
  });

  it("vreemde valuta: leden met een limiet krijgen de mail pas als de koers bekend is, zonder dubbele mails", async () => {
    const id = await gecontroleerd({ totaal_incl: 400, valuta: "USD", factuurdatum: "2026-09-05" });
    expect(ontvangers(await notificaties({ soort: "goedkeuren", factuur_id: id }))).toEqual([beheerder]);

    await alsServiceRole(db);
    await db.query("select public.verwerk_wisselkoers($1, 'USD', '2026-09-05', '2026-09-04', 1.1622, 'mock')", [id]);
    // 400 USD ≈ € 344: nu ook beide goedkeurders; de beheerder niet nog een keer
    expect(ontvangers(await notificaties({ soort: "goedkeuren", factuur_id: id }))).toEqual(
      [beheerder, goedkeurder, kleineGoedkeurder].sort(),
    );
  });

  it("een nieuwe controleronde geeft nieuwe mails", async () => {
    const id = await gecontroleerd({ totaal_incl: 1300 });
    await wijzigStatus(goedkeurder, id, "afgekeurd", "Verkeerde kostenplaats");
    await wijzigStatus(invoerder, id, "gescand");
    await wijzigStatus(controller, id, "gecontroleerd");
    expect(await notificaties({ soort: "goedkeuren", factuur_id: id })).toHaveLength(4);
  });

  it("notificatie_voor_verzending: te versturen met samenvatting; na goedkeuren in de app overgeslagen", async () => {
    const id = await gecontroleerd({ totaal_incl: 1400, leverancier: "Samenvatting BV" });
    const n = await goedkeuringsmailVoor(id, goedkeurder);
    await alsServiceRole(db);
    const voor = await waarde<Record<string, any>>(db, "select public.notificatie_voor_verzending($1)", [n.id]);
    expect(voor).toMatchObject({
      status: "verzenden", soort: "goedkeuren", ontvanger_email: "goedkeurder@example.invalid", blokkade: null,
      facturen: [{ id, leverancier: "Samenvatting BV", totaal_incl: 1400, bedrag_eur: 1400, status: "gecontroleerd",
                   ingevoerd_door: "invoerder@example.invalid", gecontroleerd_door: "controller@example.invalid" }],
    });

    await wijzigStatus(beheerder, id, "goedgekeurd");
    await alsServiceRole(db);
    const na = await waarde<Record<string, any>>(db, "select public.notificatie_voor_verzending($1)", [n.id]);
    expect(na).toMatchObject({ status: "overslaan", reden: 'De factuur heeft intussen status "goedgekeurd".' });
  });

  it("een blokkade (geen grootboekrekening) staat in de gegevens voor de mail", async () => {
    const id = await gecontroleerd({ totaal_incl: 1500, grootboekrekening_id: null });
    const n = await goedkeuringsmailVoor(id, goedkeurder);
    await alsServiceRole(db);
    const voor = await waarde<Record<string, any>>(db, "select public.notificatie_voor_verzending($1)", [n.id]);
    expect(voor.blokkade).toBe("Kies eerst een grootboekrekening.");
    // De proef heeft niets gewijzigd
    expect((await factuur(id)).status).toBe("gecontroleerd");
  });
});

describe("andere meldingen", () => {
  it("afgekeurd: invoerder en controleur, niet wie afkeurde", async () => {
    const id = await gecontroleerd({ totaal_incl: 1600 });
    await wijzigStatus(goedkeurder, id, "afgekeurd", "Geen inkooporder");
    const lijst = await notificaties({ soort: "afgekeurd", factuur_id: id });
    expect(ontvangers(lijst)).toEqual([invoerder, controller].sort());
    expect(lijst[0].details).toMatchObject({ reden: "Geen inkooporder", afgekeurd_door: goedkeurder });
  });

  it("afgekeurd zonder invoerder en controleur (uit de mail): controllers en beheerders behalve wie afkeurde", async () => {
    await alsBeheerder(db);
    const id = await waarde<string>(db,
      "insert into public.facturen (organisatie_id, leverancier_naam, totaal_incl) values ($1, 'Mail BV', 99) returning id", [org]);
    await wijzigStatus(controller, id, "afgekeurd", "Spam");
    expect(ontvangers(await notificaties({ soort: "afgekeurd", factuur_id: id }))).toEqual([beheerder]);
  });

  it("export opgegeven: mail aan controllers en beheerders", async () => {
    const id = await slaOp();
    await alsBeheerder(db);
    await db.query("select intern.plan_taak($1, 'boekhouding', $2, $3)", [org, id, id]);
    await alsServiceRole(db);
    // (ook de automatische exports van eerder goedgekeurde facturen worden geclaimd; die maken hier niet uit)
    const [taak] = await rijen<{ id: string }>(db, "select id from public.claim_taken(50, array['boekhouding']) where sleutel = $1", [id]);
    await db.query("select public.rond_taak_af($1, false, null, 'Grootboekrekening 4300 niet gekoppeld', false)", [taak.id]);
    const lijst = await notificaties({ soort: "export_mislukt", factuur_id: id });
    expect(ontvangers(lijst)).toEqual([beheerder, controller].sort());
    expect(lijst[0].details).toMatchObject({ taak_id: taak.id, fout: "Grootboekrekening 4300 niet gekoppeld" });
  });

  it("een opgegeven email-taak zet de notificatie op mislukt; opnieuw proberen zet hem terug", async () => {
    await alsGebruiker(db, controller);
    const notificatieId = await waarde<string>(db, "select public.plan_testmail($1)", [org]);
    await alsServiceRole(db);
    const [taak] = await rijen<{ id: string }>(db, "select id from public.claim_taken(50, array['email']) where sleutel = $1", [notificatieId]);
    // (andere geclaimde email-taken maken hier niet uit)
    await db.query("select public.rond_taak_af($1, false, null, 'Resend: domein niet geverifieerd', false)", [taak.id]);
    await alsBeheerder(db);
    expect(await waarde(db, "select status || '|' || reden from public.notificaties where id = $1", [notificatieId]))
      .toBe("mislukt|Resend: domein niet geverifieerd");

    await alsGebruiker(db, controller);
    await db.query("select public.probeer_taak_opnieuw($1)", [taak.id]);
    await alsBeheerder(db);
    expect(await waarde(db, "select status from public.notificaties where id = $1", [notificatieId])).toBe("wachtrij");
  });

  it("bijna vervallen: één mail per controller/beheerder, elke factuur maar één keer", async () => {
    const a = await slaOp({ vervaldatum: "2026-10-02", factuurdatum: "2026-09-02" });
    const b = await slaOp({ vervaldatum: "2026-10-05", factuurdatum: "2026-09-05" });
    await slaOp({ vervaldatum: "2026-10-20", factuurdatum: "2026-09-20" }); // te ver weg
    await alsBeheerder(db);
    expect(await waarde(db, "select intern.plan_vervalherinneringen('2026-10-01')")).toBe(2);
    const lijst = await notificaties({ soort: "bijna_vervallen" });
    expect(ontvangers(lijst)).toEqual([beheerder, controller].sort());
    expect(lijst[0].details.factuur_ids).toEqual([a]);
    // b (5 oktober) valt pas de dag erna binnen 3 dagen

    expect(await waarde(db, "select intern.plan_vervalherinneringen('2026-10-01')")).toBe(0);
    expect(await waarde(db, "select intern.plan_vervalherinneringen('2026-10-02')")).toBe(2);
    const nieuw = (await notificaties({ soort: "bijna_vervallen" })).slice(-2);
    expect(nieuw.map((n) => n.details.factuur_ids)).toEqual([[b], [b]]);

    // Instelling: 30 dagen vooruit
    await alsGebruiker(db, beheerder);
    await db.query("select public.stel_koppeling_in($1, 'email', 'mock', '{\"dagen_voor_vervaldatum\": 30}'::jsonb)", [org]);
    await alsBeheerder(db);
    expect(await waarde(db, "select intern.plan_vervalherinneringen('2026-10-03')")).toBe(2);
  });

  it("markeer_notificatie: mock-inhoud alleen voor de ontvanger; herinnering in de historie van elke factuur", async () => {
    const [n] = (await notificaties({ soort: "bijna_vervallen" })).filter((x) => x.ontvanger_id === controller);
    await alsServiceRole(db);
    await db.query(
      "select public.markeer_notificatie($1, 'verzonden', 'mock', 'controller@example.invalid', 'Herinnering', 'mock-1', null, $2::jsonb)",
      [n.id, JSON.stringify({ html: "<p>hoi</p>", tekst: "hoi" })],
    );
    // idempotent
    await db.query("select public.markeer_notificatie($1, 'verzonden', 'mock', 'x', 'y', 'mock-2', null, null)", [n.id]);

    await alsGebruiker(db, controller);
    expect(await rijen(db, "select tekst from public.notificatie_inhoud where notificatie_id = $1", [n.id])).toEqual([{ tekst: "hoi" }]);
    await alsGebruiker(db, beheerder);
    expect(await rijen(db, "select 1 from public.notificatie_inhoud where notificatie_id = $1", [n.id])).toEqual([]);
    // Maar de beheerder ziet wel dat de mail verstuurd is
    expect(await waarde(db, "select provider_id from public.notificaties where id = $1", [n.id])).toBe("mock-1");

    await alsBeheerder(db);
    const factuurId = (n.details.factuur_ids as string[])[0];
    const [log] = await rijen<{ actie: string; bron: string; omschrijving: string }>(db,
      "select actie, bron, nieuw ->> 'omschrijving' as omschrijving from public.audit_log where record_id = $1 and actie = 'notificatie'", [factuurId]);
    expect(log).toEqual({ actie: "notificatie", bron: "email", omschrijving: "Herinnering vervaldatum gemaild aan controller@example.invalid (mock)" });
  });
});

describe("goedkeuren en afkeuren via de mail", () => {
  it("maak_mail_actie is idempotent per notificatie", async () => {
    const id = await gecontroleerd({ totaal_incl: 1700 });
    const n = await goedkeuringsmailVoor(id, goedkeurder);
    const a = await mailActie(n.id);
    expect(await mailActie(n.id)).toEqual(a);
    const uren = (new Date(a.verloopt_op).getTime() - Date.now()) / 3_600_000;
    expect(uren).toBeGreaterThan(71);
    expect(uren).toBeLessThanOrEqual(72);
  });

  it("goedkeuren: als de goedkeurder, bron email; daarna is de link verbruikt", async () => {
    const id = await gecontroleerd({ totaal_incl: 1800 });
    const a = await mailActie((await goedkeuringsmailVoor(id, goedkeurder)).id);

    await alsServiceRole(db);
    const bekijk = await waarde<Record<string, any>>(db, "select public.bekijk_mail_actie($1)", [a.id]);
    expect(bekijk).toMatchObject({ geldig: true, mogelijk: { goedkeuren: null, afkeuren: null }, goedkeurder: "goedkeurder@example.invalid" });
    expect((await factuur(id)).status).toBe("gecontroleerd");

    expect(await voerUit(a.id, "goedkeuren")).toEqual({ ok: true, melding: "De factuur is goedgekeurd." });
    expect(await factuur(id)).toMatchObject({ status: "goedgekeurd", goedgekeurd_door: goedkeurder });

    await alsBeheerder(db);
    const [log] = await rijen<{ user_id: string; bron: string; toelichting: string }>(db,
      "select user_id, bron, toelichting from public.audit_log where record_id = $1 and actie = 'statuswijziging' order by id desc limit 1", [id]);
    expect(log).toEqual({ user_id: goedkeurder, bron: "email", toelichting: "Goedgekeurd via de knop in de e-mail" });

    expect(await voerUit(a.id, "goedkeuren")).toEqual({ ok: false, melding: "Deze link is al gebruikt." });
    expect(await voerUit(a.id, "afkeuren", "toch niet")).toEqual({ ok: false, melding: "Deze link is al gebruikt." });
  });

  it("afkeuren vraagt een reden en legt die vast", async () => {
    const id = await gecontroleerd({ totaal_incl: 1900 });
    const a = await mailActie((await goedkeuringsmailVoor(id, goedkeurder)).id);
    expect((await voerUit(a.id, "afkeuren", "  ")).ok).toBe(false);
    expect(await voerUit(a.id, "afkeuren", "Dubbel gefactureerd")).toEqual({ ok: true, melding: "De factuur is afgekeurd." });
    expect(await factuur(id)).toMatchObject({ status: "afgekeurd", afkeur_reden: "Dubbel gefactureerd" });
  });

  it("de server controleert de limiet opnieuw; een geweigerde poging verbruikt de link niet en staat in de log", async () => {
    const id = await gecontroleerd({ totaal_incl: 2100 });
    const a = await mailActie((await goedkeuringsmailVoor(id, goedkeurder)).id);
    await alsGebruiker(db, beheerder);
    await db.query("select public.wijzig_lid($1, $2, 'goedkeurder', 2000)", [org, goedkeurder]);

    expect(await voerUit(a.id, "goedkeuren")).toEqual({ ok: false, melding: "Boven je goedkeuringslimiet van € 2.000." });
    expect((await factuur(id)).status).toBe("gecontroleerd");
    await alsBeheerder(db);
    const [log] = await rijen<{ user_id: string; bron: string; toelichting: string; omschrijving: string }>(db,
      "select user_id, bron, toelichting, nieuw ->> 'omschrijving' as omschrijving from public.audit_log where record_id = $1 and actie = 'notificatie' order by id desc limit 1", [id]);
    expect(log).toEqual({ user_id: goedkeurder, bron: "email", toelichting: "Boven je goedkeuringslimiet van € 2.000.", omschrijving: "Goedkeuren via de e-mail geweigerd" });

    await alsGebruiker(db, beheerder);
    await db.query("select public.wijzig_lid($1, $2, 'goedkeurder', 5000)", [org, goedkeurder]);
    expect((await voerUit(a.id, "goedkeuren")).ok).toBe(true);
  });

  it("verlopen, of opnieuw gecontroleerd: de link werkt niet meer", async () => {
    const id = await gecontroleerd({ totaal_incl: 2200 });
    const a = await mailActie((await goedkeuringsmailVoor(id, goedkeurder)).id);
    await alsBeheerder(db);
    await db.query("update public.mail_acties set verloopt_op = now() - interval '1 minute' where id = $1", [a.id]);
    expect(await voerUit(a.id, "goedkeuren")).toEqual({ ok: false, melding: "Deze link is verlopen. Open de factuur in de app." });

    const id2 = await gecontroleerd({ totaal_incl: 2300 });
    const b = await mailActie((await goedkeuringsmailVoor(id2, goedkeurder)).id);
    await wijzigStatus(beheerder, id2, "afgekeurd", "fout bedrag");
    await wijzigStatus(invoerder, id2, "gescand");
    await wijzigStatus(controller, id2, "gecontroleerd");
    expect((await voerUit(b.id, "goedkeuren")).melding).toMatch(/opnieuw gecontroleerd/);
  });

  it("strikte functiescheiding, ook in een organisatie met één lid", async () => {
    // Beheerder heeft de factuur gecontroleerd; een (hier handmatig gemaakte) link voor de beheerder werkt niet.
    const id = await slaOp({ totaal_incl: 2400 });
    await wijzigStatus(beheerder, id, "gecontroleerd");
    await alsBeheerder(db);
    const n = await waarde<string>(db,
      "select intern.plan_notificatie($1, 'goedkeuren', 'handmatig-1', $2, $3, jsonb_build_object('gecontroleerd_op', (select gecontroleerd_op from public.facturen where id = $3)))",
      [org, beheerder, id]);
    const a = await mailActie(n);
    expect((await voerUit(a.id, "goedkeuren")).melding).toBe(
      "Functiescheiding: je kunt een factuur die je zelf hebt gecontroleerd niet goedkeuren.");

    // Eén lid: in de app mag dat (met melding), via de mail nooit.
    const alleen = await maakGebruiker(db, "alleen@example.invalid");
    const eigenOrg = await organisatieVan(db, alleen);
    const eigenRekening = await waarde<string>(db, "select id from public.grootboekrekeningen where organisatie_id = $1 and code = '4300'", [eigenOrg]);
    await alsGebruiker(db, alleen);
    const eigen = await waarde<string>(db, "select public.sla_factuur_op($1::jsonb, true)", [
      JSON.stringify({ organisatie_id: eigenOrg, grootboekrekening_id: eigenRekening, leverancier: "Eigen BV", factuurnummer: "E-1", totaal_incl: 50 }),
    ]);
    await db.query("select public.wijzig_status($1, 'gecontroleerd')", [eigen]);
    await alsBeheerder(db);
    // Er gaat geen goedkeuringsmail uit (het enige lid is invoerder en controleur)
    expect(await waarde(db, "select count(*)::int from public.notificaties where organisatie_id = $1", [eigenOrg])).toBe(0);
    const n2 = await waarde<string>(db,
      "select intern.plan_notificatie($1, 'goedkeuren', 'handmatig-2', $2, $3, jsonb_build_object('gecontroleerd_op', (select gecontroleerd_op from public.facturen where id = $3)))",
      [eigenOrg, alleen, eigen]);
    const b = await mailActie(n2);
    expect((await voerUit(b.id, "goedkeuren")).melding).toBe(
      "Functiescheiding: je kunt een factuur die je zelf hebt ingevoerd niet goedkeuren.");
    expect((await factuur(eigen)).status).toBe("gecontroleerd");
  });
});

describe("rechten", () => {
  it("gebruikers kunnen de serverfuncties niet aanroepen en mail_acties niet lezen", async () => {
    await alsGebruiker(db, goedkeurder);
    for (const sql of [
      "select public.voer_mail_actie_uit(gen_random_uuid(), 'goedkeuren', null)",
      "select public.bekijk_mail_actie(gen_random_uuid())",
      "select public.maak_mail_actie(gen_random_uuid())",
      "select public.notificatie_voor_verzending(gen_random_uuid())",
      "select public.markeer_notificatie(gen_random_uuid(), 'verzonden')",
      "select * from public.mail_acties",
    ]) {
      await expect(db.query(sql), sql).rejects.toThrow(/permission denied/);
    }
    await alsGebruiker(db, null);
    await expect(db.query("select * from public.notificaties")).rejects.toThrow(/permission denied/);
  });

  it("RLS: eigen notificaties; controller/beheerder alles; buitenstaander niets", async () => {
    await alsGebruiker(db, invoerder);
    const eigen = await rijen<{ ontvanger_id: string }>(db, "select ontvanger_id from public.notificaties");
    expect(eigen.length).toBeGreaterThan(0);
    expect(eigen.every((n) => n.ontvanger_id === invoerder)).toBe(true);

    await alsGebruiker(db, controller);
    const alle = await rijen<{ ontvanger_id: string }>(db, "select ontvanger_id from public.notificaties where organisatie_id = $1", [org]);
    expect(new Set(alle.map((n) => n.ontvanger_id)).size).toBeGreaterThan(2);

    await alsGebruiker(db, buitenstaander);
    expect(await rijen(db, "select 1 from public.notificaties where organisatie_id = $1", [org])).toEqual([]);
  });

  it("testmail: alleen controller of beheerder", async () => {
    await alsGebruiker(db, invoerder);
    await expect(db.query("select public.plan_testmail($1)", [org])).rejects.toThrow(/controller of beheerder/);
  });
});
