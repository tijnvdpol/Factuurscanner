import { describe, expect, it, vi } from "vitest";
import { leesMailToken, maakMailToken, mailTokenSleutel } from "../../supabase/functions/_shared/koppelingen/mailtoken.ts";
import {
  bedragMetEuro,
  esc,
  mailActieLink,
  stelMailOp,
  type FactuurSamenvatting,
  type MailGegevens,
} from "../../supabase/functions/_shared/koppelingen/mailteksten.ts";
import {
  APP_URL_PLACEHOLDER,
  appUrlVoor,
  emailHandler,
  MailMock,
  RESEND_URL,
  ResendLive,
  type EmailDeps,
  type UitgaandeMail,
} from "../../supabase/functions/_shared/koppelingen/email.ts";
import { DefinitieveFout, voerTaakUit, type Taak } from "../../supabase/functions/_shared/koppelingen/taken.ts";

const SLEUTEL = "geheim-voor-tests";
/** Intl zet een harde spatie tussen valutateken en bedrag; in de tests vergelijken we met een gewone spatie. */
const sp = (tekst: string) => tekst.replace(/ /g, " ");
const ID = "3f2b7c1e-9a4d-4e6b-8c2a-1d5e7f9a0b3c";
const NU = new Date("2026-09-24T12:00:00Z");
const MORGEN = new Date("2026-09-25T12:00:00Z");

describe("mail-token", () => {
  it("geldig token geeft het id en de verlooptijd terug", async () => {
    const token = await maakMailToken(SLEUTEL, ID, MORGEN);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await leesMailToken(SLEUTEL, token, NU)).toEqual({ geldig: true, actieId: ID, verlooptOp: MORGEN });
  });

  it("zelfde invoer → zelfde token (een nieuwe poging van de worker verstuurt exact dezelfde mail)", async () => {
    expect(await maakMailToken(SLEUTEL, ID, MORGEN)).toBe(await maakMailToken(SLEUTEL, ID, MORGEN));
  });

  it("verlopen, andere sleutel, gewijzigde payload of rommel: ongeldig", async () => {
    const token = await maakMailToken(SLEUTEL, ID, MORGEN);
    expect(await leesMailToken(SLEUTEL, token, new Date("2026-09-26T00:00:00Z"))).toMatchObject({ geldig: false, reden: expect.stringMatching(/verlopen/) });
    expect(await leesMailToken("andere-sleutel", token, NU)).toMatchObject({ geldig: false, reden: expect.stringMatching(/ongeldig of beschadigd/) });

    // Ander id in de payload, oude handtekening
    const [v, , h] = token.split(".");
    const vals = btoa(JSON.stringify({ i: "00000000-0000-4000-8000-000000000000", e: 1_900_000_000 })).replace(/=+$/, "");
    expect((await leesMailToken(SLEUTEL, `${v}.${vals}.${h}`, NU)).geldig).toBe(false);

    for (const rommel of [undefined, 42, "", "v1.abc", "v2.a.b", "v1.a.b.c", "x".repeat(600)]) {
      expect((await leesMailToken(SLEUTEL, rommel, NU)).geldig).toBe(false);
    }
  });

  it("sleutel: MAIL_TOKEN_GEHEIM, anders afgeleid van de service-rolsleutel (niet de sleutel zelf)", async () => {
    expect(await mailTokenSleutel((n) => ({ MAIL_TOKEN_GEHEIM: " eigen " })[n])).toBe("eigen");
    const afgeleid = await mailTokenSleutel((n) => ({ SUPABASE_SERVICE_ROLE_KEY: "service-sleutel" })[n]);
    expect(afgeleid).not.toContain("service-sleutel");
    expect(afgeleid.length).toBeGreaterThan(30);
    await expect(mailTokenSleutel(() => undefined)).rejects.toThrow(/ontbreken/);
  });
});

const FACTUUR: FactuurSamenvatting = {
  id: "f1", leverancier: "Leverancier <script>alert(1)</script> BV", factuurnummer: "F-001", factuurdatum: "2026-09-20",
  vervaldatum: "2026-10-20", valuta: "EUR", totaal_incl: 1210, bedrag_eur: 1210, status: "gecontroleerd", bron: "upload",
  grootboekrekening: "4300 Kantoorkosten", ingevoerd_door: "invoerder@bedrijf.nl", gecontroleerd_door: "controller@bedrijf.nl",
  afkeur_reden: null, signalen: [{ ernst: "waarschuwing", bericht: "Btw-nummer ongeldig (VIES) & \"meer\"" }],
};

function gegevens(extra: Partial<MailGegevens> = {}): MailGegevens {
  return {
    soort: "goedkeuren", organisatie: "Bedrijf BV", ontvanger: "goedkeurder@bedrijf.nl", facturen: [FACTUUR], details: {},
    appUrl: "https://facturen.bedrijf.nl", actie: { token: "v1.abc.def", verlooptOp: MORGEN, blokkade: null }, ...extra,
  };
}

describe("mailteksten", () => {
  it("goedkeuren: gegevens, knoppen met token en keuze, verlooptijd; alles ge-escaped", () => {
    const m = stelMailOp(gegevens());
    expect(sp(m.onderwerp)).toBe("Goedkeuren: Leverancier <script>alert(1)</script> BV F-001 (€ 1.210,00)");
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("Leverancier &lt;script&gt;alert(1)&lt;/script&gt; BV");
    expect(m.html).toContain("&amp; &quot;meer&quot;");
    expect(m.html).toContain('href="https://facturen.bedrijf.nl/#mail-actie=v1.abc.def&amp;keuze=goedkeuren"');
    expect(m.html).toContain('href="https://facturen.bedrijf.nl/#mail-actie=v1.abc.def&amp;keuze=afkeuren"');
    expect(m.html).toContain("geldig tot 25-09-2026 om 14:00");
    expect(m.tekst).toContain("Goedkeuren: https://facturen.bedrijf.nl/#mail-actie=v1.abc.def&keuze=goedkeuren");
    expect(m.tekst).toContain("Gecontroleerd door: controller@bedrijf.nl");
  });

  it("goedkeuren met een blokkade: geen goedkeurknop, wel de reden en afkeuren", () => {
    const m = stelMailOp(gegevens({ actie: { token: "t", verlooptOp: MORGEN, blokkade: "Kies eerst een grootboekrekening." } }));
    expect(m.html).not.toContain("keuze=goedkeuren");
    expect(m.html).toContain("keuze=afkeuren");
    expect(m.html).toContain("Goedkeuren kan nu nog niet: Kies eerst een grootboekrekening.");
    expect(m.tekst).not.toContain("keuze=goedkeuren");
  });

  it("vreemde valuta toont het bedrag in euro, of dat de koers nog volgt", () => {
    expect(sp(bedragMetEuro({ ...FACTUUR, valuta: "USD", totaal_incl: 400, bedrag_eur: 344.18 }))).toBe("US$ 400,00 (≈ € 344,18)");
    expect(sp(bedragMetEuro({ ...FACTUUR, valuta: "USD", totaal_incl: 400, bedrag_eur: null }))).toBe("US$ 400,00 (koers volgt)");
  });

  it("afgekeurd, export mislukt, bijna vervallen en test", () => {
    const af = stelMailOp(gegevens({ soort: "afgekeurd", details: { reden: "Geen inkooporder", afgekeurd_door_email: "gk@bedrijf.nl" } }));
    expect(af.onderwerp).toContain("Afgekeurd:");
    expect(af.tekst).toContain("Reden: Geen inkooporder");
    expect(af.tekst).toContain("Afgekeurd door: gk@bedrijf.nl");

    const ex = stelMailOp(gegevens({ soort: "export_mislukt", details: { fout: "Grootboek 4300 niet gekoppeld" } }));
    expect(ex.onderwerp).toContain("Export mislukt:");
    expect(ex.tekst).toContain("Fout: Grootboek 4300 niet gekoppeld");
    expect(stelMailOp(gegevens({ soort: "export_mislukt", facturen: [] })).onderwerp).toBe("Export naar het boekhoudpakket mislukt");

    const bv = stelMailOp(gegevens({ soort: "bijna_vervallen", details: { dagen: 3 }, facturen: [FACTUUR, { ...FACTUUR, id: "f2", factuurnummer: "F-002", bedrag_eur: 90 }] }));
    expect(bv.onderwerp).toBe("2 facturen vervallen binnenkort (Bedrijf BV)");
    expect(sp(bv.tekst)).toContain("Totaal ≈ € 1.300,00");
    expect(bv.tekst).toContain("20-10-2026");

    expect(stelMailOp(gegevens({ soort: "test" })).tekst).toContain("verstuurd naar goedkeurder@bedrijf.nl");
  });

  it("esc en links", () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    expect(mailActieLink("https://app", "v1.a.b", "afkeuren")).toBe("https://app/#mail-actie=v1.a.b&keuze=afkeuren");
  });
});

const MAIL: UitgaandeMail = { aan: "jan@bedrijf.nl", onderwerp: "Onderwerp", html: "<p>x</p>", tekst: "x", sleutel: "n-1", soort: "test" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Resend", () => {
  it("verstuurt met afzender, idempotentiesleutel en platte tekst", async () => {
    const fetcher = vi.fn(async () => json({ id: "re_123" }));
    const r = await new ResendLive("re_sleutel", "Facturen <facturen@bedrijf.nl>", fetcher as unknown as typeof fetch).verstuur(MAIL);
    expect(r).toEqual({ id: "re_123" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RESEND_URL);
    expect(init.headers).toMatchObject({ Authorization: "Bearer re_sleutel", "Idempotency-Key": "factuurscanner-n-1" });
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: "Facturen <facturen@bedrijf.nl>", to: ["jan@bedrijf.nl"], subject: "Onderwerp", text: "x", tags: [{ name: "soort", value: "test" }],
    });
  });

  it("tijdelijke fouten → nieuwe poging; definitieve fouten → opgeven; al verstuurd → gelukt", async () => {
    const met = (response: Response | Error) =>
      new ResendLive("k", "a@b.nl", (async () => {
        if (response instanceof Error) throw response;
        return response;
      }) as unknown as typeof fetch).verstuur(MAIL);

    for (const tijdelijk of [
      json({ name: "rate_limit_exceeded", message: "Too many requests" }, 429),
      json({ name: "daily_quota_exceeded", message: "quota" }, 429),
      json({ name: "concurrent_idempotent_requests", message: "bezig" }, 409),
      json({ name: "application_error", message: "oeps" }, 500),
      new TypeError("fetch failed"),
    ]) {
      const fout = await met(tijdelijk).catch((e) => e);
      expect(fout).toBeInstanceOf(Error);
      expect(fout).not.toBeInstanceOf(DefinitieveFout);
    }
    for (const definitief of [
      json({ name: "validation_error", message: "You can only send testing emails to your own email address" }, 403),
      json({ name: "missing_api_key", message: "Missing API key" }, 401),
      json({ name: "validation_error", message: "Invalid `to` field" }, 422),
    ]) {
      await expect(met(definitief)).rejects.toBeInstanceOf(DefinitieveFout);
    }
    expect(await met(json({ name: "invalid_idempotent_request", message: "anders" }, 409))).toEqual({ id: "al-verstuurd:n-1" });
  });

  it("mock: +tijdelijk en +ongeldig simuleren fouten", async () => {
    const mock = new MailMock();
    expect(await mock.verstuur(MAIL)).toEqual({ id: "mock-n-1" });
    await expect(mock.verstuur({ ...MAIL, aan: "jan+tijdelijk@x.nl" })).rejects.not.toBeInstanceOf(DefinitieveFout);
    await expect(mock.verstuur({ ...MAIL, aan: "jan+ongeldig@x.nl" })).rejects.toBeInstanceOf(DefinitieveFout);
  });

  it("APP_URL: zonder / aan het eind; in mock mag hij ontbreken", () => {
    expect(appUrlVoor("live", "https://app.nl/")).toBe("https://app.nl");
    expect(appUrlVoor("mock", undefined)).toBe(APP_URL_PLACEHOLDER);
    expect(() => appUrlVoor("live", " ")).toThrow(DefinitieveFout);
  });
});

describe("email-taak", () => {
  const taak: Taak = {
    id: "t1", organisatie_id: "o1", soort: "email", factuur_id: "f1", sleutel: "n-1",
    payload: { notificatie_id: "n-1" }, pogingen: 1, max_pogingen: 6,
  };

  function deps(verzendgegevens: Record<string, unknown>, modus: "live" | "mock" = "mock") {
    const rpcs: [string, Record<string, unknown>][] = [];
    const verstuurd: UitgaandeMail[] = [];
    const d: EmailDeps = {
      modus: async () => modus,
      rpc: async (functie, args) => {
        rpcs.push([functie, args]);
        if (functie === "notificatie_voor_verzending") return verzendgegevens;
        if (functie === "maak_mail_actie") return { id: ID, verloopt_op: MORGEN.toISOString() };
        return null;
      },
      provider: () => ({ verstuur: async (m) => (verstuurd.push(m), { id: "p-1" }) }),
      appUrl: () => "https://app.nl",
      tokenSleutel: async () => SLEUTEL,
    };
    return { d, rpcs, verstuurd };
  }

  const TE_VERSTUREN = {
    status: "verzenden", reden: null, soort: "goedkeuren", organisatie_id: "o1", organisatie: "Bedrijf BV",
    ontvanger_email: "gk@bedrijf.nl", details: {}, facturen: [FACTUUR], blokkade: null,
  };

  it("goedkeuren: token voor de mail-actie, versturen, vastleggen met inhoud (mock)", async () => {
    const { d, rpcs, verstuurd } = deps(TE_VERSTUREN);
    const r = await voerTaakUit(taak, { email: emailHandler(d) });
    expect(r).toMatchObject({ gelukt: true, resultaat: { omschrijving: "Goedkeuringsverzoek gemaild aan gk@bedrijf.nl (mock)" } });

    expect(verstuurd).toHaveLength(1);
    expect(verstuurd[0]).toMatchObject({ aan: "gk@bedrijf.nl", sleutel: "n-1", soort: "goedkeuren" });
    const token = decodeURIComponent(verstuurd[0].tekst.match(/#mail-actie=([^&\s]+)/)![1]);
    expect(await leesMailToken(SLEUTEL, token, NU)).toMatchObject({ geldig: true, actieId: ID });

    const markeer = rpcs.find(([f]) => f === "markeer_notificatie")![1];
    expect(markeer).toMatchObject({ p_status: "verzonden", p_modus: "mock", p_provider_id: "p-1", p_inhoud: { tekst: verstuurd[0].tekst } });
  });

  it("live: geen inhoud opgeslagen", async () => {
    const { d, rpcs } = deps(TE_VERSTUREN, "live");
    await emailHandler(d)(taak);
    expect(rpcs.find(([f]) => f === "markeer_notificatie")![1]).toMatchObject({ p_modus: "live", p_inhoud: null });
  });

  it("niet meer relevant: overgeslagen, niets verstuurd", async () => {
    const { d, rpcs, verstuurd } = deps({ ...TE_VERSTUREN, status: "overslaan", reden: 'De factuur heeft intussen status "goedgekeurd".' });
    const r = await emailHandler(d)(taak);
    expect(r.omschrijving).toBe('Mail niet verstuurd: De factuur heeft intussen status "goedgekeurd".');
    expect(verstuurd).toHaveLength(0);
    expect(rpcs.map(([f]) => f)).toEqual(["notificatie_voor_verzending", "markeer_notificatie"]);
    expect(rpcs[1][1]).toMatchObject({ p_status: "overgeslagen" });
  });

  it("een fout van de provider laat de taak opnieuw proberen, zonder vast te leggen", async () => {
    const { d, rpcs } = deps(TE_VERSTUREN);
    d.provider = () => ({ verstuur: async () => { throw new Error("Resend: Too many requests"); } });
    const r = await voerTaakUit(taak, { email: emailHandler(d) });
    expect(r).toMatchObject({ gelukt: false, opnieuw: true, fout: "Resend: Too many requests" });
    expect(rpcs.some(([f]) => f === "markeer_notificatie")).toBe(false);
  });
});
