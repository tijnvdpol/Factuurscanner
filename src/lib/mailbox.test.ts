import { describe, expect, it, vi } from "vitest";
import {
  beoordeelBijlage,
  controleerHandtekening,
  leesAdres,
  leesMailgunFormulier,
  mailboxHandler,
  mailgunHandtekening,
  mockScan,
  veiligeBestandsnaam,
  verwerkMail,
  type InboxBijlageRij,
  type Mail,
  type MailboxTaakDeps,
} from "../../supabase/functions/_shared/koppelingen/mailbox.ts";
import { maakPdf, maakTestmail, testFactuur } from "../../supabase/functions/_shared/koppelingen/testmail.ts";
import { DefinitieveFout, type Taak } from "../../supabase/functions/_shared/koppelingen/taken.ts";

const SLEUTEL = "key-geheim-voor-tests";
const NU = new Date("2026-09-24T12:00:00Z");
const TIMESTAMP = String(NU.getTime() / 1000);

describe("Mailgun-handtekening", () => {
  it("HMAC-SHA256 over timestamp + token (zelfde als het voorbeeld van Mailgun)", async () => {
    // Referentiewaarde berekend met Node: createHmac("sha256", SLEUTEL).update("1790251200abc123").digest("hex")
    expect(TIMESTAMP).toBe("1790251200");
    expect(await mailgunHandtekening(SLEUTEL, TIMESTAMP, "abc123")).toBe("4487c83f517c87e276972227af47688e16f523d89f8cc800d9d3d9a3add0b240");
  });

  it("geldig, fout, ontbrekend of te oud", async () => {
    const signature = await mailgunHandtekening(SLEUTEL, TIMESTAMP, "abc123");
    expect(await controleerHandtekening(SLEUTEL, { timestamp: TIMESTAMP, token: "abc123", signature }, NU)).toEqual({ geldig: true });
    expect((await controleerHandtekening(SLEUTEL, { timestamp: TIMESTAMP, token: "abc124", signature }, NU)).reden).toBe("handtekening klopt niet");
    expect((await controleerHandtekening("andere-sleutel", { timestamp: TIMESTAMP, token: "abc123", signature }, NU)).geldig).toBe(false);
    expect((await controleerHandtekening(SLEUTEL, { timestamp: TIMESTAMP, token: "abc123", signature: null }, NU)).reden).toBe("handtekening ontbreekt");
    const later = new Date(NU.getTime() + 13 * 3600 * 1000);
    expect((await controleerHandtekening(SLEUTEL, { timestamp: TIMESTAMP, token: "abc123", signature }, later)).reden).toBe("handtekening verlopen");
    // Binnen het retry-venster van Mailgun (8 uur) nog geldig
    const retry = new Date(NU.getTime() + 8 * 3600 * 1000);
    expect((await controleerHandtekening(SLEUTEL, { timestamp: TIMESTAMP, token: "abc123", signature }, retry)).geldig).toBe(true);
  });
});

describe("webhook lezen", () => {
  it("adressen", () => {
    expect(leesAdres('"Jansen, Jan" <Jan@Voorbeeld.NL>')).toEqual({ adres: "jan@voorbeeld.nl", naam: "Jansen, Jan" });
    expect(leesAdres("jan@voorbeeld.nl")).toEqual({ adres: "jan@voorbeeld.nl", naam: null });
    expect(leesAdres("geen adres")).toBeNull();
  });

  it("formulier met bijlagen, headers en een inline logo", async () => {
    const f = new FormData();
    f.set("recipient", "Facturen@Inbox.Voorbeeld.nl");
    f.set("sender", "bounce@leverancier.nl");
    f.set("from", "Leverancier BV <facturen@leverancier.nl>");
    f.set("subject", "Factuur 2026-001");
    f.set("stripped-text", "Zie bijlage");
    f.set("Message-Id", "<abc@leverancier.nl>");
    f.set("message-headers", JSON.stringify([["X-Mailgun-Spf", "Pass"], ["X-Mailgun-Dkim-Check-Result", "Fail"], ["X-Mailgun-Sflag", "No"]]));
    f.set("attachment-count", "2");
    f.set("attachment-1", new File([new Uint8Array([37, 80, 68, 70])], "factuur.pdf", { type: "application/pdf" }));
    f.set("attachment-2", new File([new Uint8Array(30_000)], "logo.png", { type: "image/png" }));
    f.set("content-id-map", JSON.stringify({ "<logo@x>": "attachment-2" }));

    const mail = await leesMailgunFormulier(f);
    expect(mail).toMatchObject({
      aan: "facturen@inbox.voorbeeld.nl", van: "facturen@leverancier.nl", vanNaam: "Leverancier BV",
      envelopAfzender: "bounce@leverancier.nl", onderwerp: "Factuur 2026-001", tekst: "Zie bijlage",
      messageId: "<abc@leverancier.nl>", spf: "Pass", dkim: "Fail", spam: false, bron: "mailgun",
    });
    expect(mail.bijlagen.map((b) => [b.naam, b.mimeType, b.inhoud.byteLength, !!b.inline])).toEqual([
      ["factuur.pdf", "application/pdf", 4, false],
      ["logo.png", "image/png", 30_000, true],
    ]);
  });

  it("zonder Message-Id: een vaste sleutel uit afzender, onderwerp en tijd (Mailgun-retries blijven dubbel)", async () => {
    const f = new FormData();
    f.set("recipient", "facturen@x.nl");
    f.set("from", "a@b.nl");
    f.set("subject", "Test");
    f.set("timestamp", "1");
    const a = await leesMailgunFormulier(f);
    const b = await leesMailgunFormulier(f);
    expect(a.messageId).toMatch(/^geen-message-id-[0-9a-f]{64}$/);
    expect(b.messageId).toBe(a.messageId);
  });
});

describe("bijlagen beoordelen", () => {
  it.each([
    ["factuur.pdf", "application/pdf", 50_000, false, true],
    ["scan.JPG", "application/octet-stream", 400_000, false, true],
    ["foto.heic", "image/heic", 900_000, false, true],
    ["logo.png", "image/png", 30_000, true, false],
    ["icoon.png", "image/png", 3_000, false, false],
    ["algemene-voorwaarden.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 50_000, false, false],
    ["groot.pdf", "application/pdf", 16 * 1024 * 1024, false, false],
  ])("%s (%s, %i bytes, inline %s) → bruikbaar %s", (naam, mimeType, grootte, inline, bruikbaar) => {
    expect(beoordeelBijlage({ naam, mimeType, grootte, inline }).bruikbaar).toBe(bruikbaar);
  });

  it("veilige bestandsnaam", () => {
    expect(veiligeBestandsnaam("Factuur 2026/001 (été).pdf")).toBe("Factuur_2026_001_(ete).pdf");
  });
});

describe("mail verwerken", () => {
  const mail: Mail = {
    aan: "facturen@x.nl", van: "a@b.nl", vanNaam: null, envelopAfzender: null, onderwerp: "F", tekst: null,
    messageId: "<m1>", spf: "Pass", dkim: null, spam: false, bron: "mailgun",
    bijlagen: [
      { naam: "factuur.pdf", mimeType: "application/pdf", inhoud: new Uint8Array(10) },
      { naam: "voorwaarden.txt", mimeType: "text/plain", inhoud: new Uint8Array(10) },
    ],
  };

  it("slaat alleen bruikbare bijlagen op, onder {organisatie}/inbox/{bericht}/", async () => {
    const upload = vi.fn(async () => undefined);
    const rondAf = vi.fn(async () => 1);
    const r = await verwerkMail(mail, {
      registreer: async () => ({ status: "nieuw", bericht_id: "b1", organisatie_id: "o1", bekend: true }),
      upload,
      rondAf,
    });
    expect(r).toEqual({ status: "nieuw", berichtId: "b1", bekend: true, bruikbaar: 1, genegeerd: 1 });
    expect(upload).toHaveBeenCalledWith("o1/inbox/b1/1-factuur.pdf", expect.any(Uint8Array), "application/pdf");
    expect(upload).toHaveBeenCalledTimes(1);
    expect(rondAf).toHaveBeenCalledWith("b1", [
      expect.objectContaining({ volgnummer: 1, pad: "o1/inbox/b1/1-factuur.pdf", reden: null }),
      expect.objectContaining({ volgnummer: 2, pad: null, reden: "Geen pdf of afbeelding." }),
    ]);
  });

  it("onbekend adres of al ontvangen: niets opslaan", async () => {
    const upload = vi.fn();
    expect(await verwerkMail(mail, { registreer: async () => ({ status: "onbekend_adres" }), upload, rondAf: vi.fn() }))
      .toEqual({ status: "onbekend_adres" });
    expect(await verwerkMail(mail, { registreer: async () => ({ status: "duplicaat", bericht_id: "b1" }), upload, rondAf: vi.fn() }))
      .toEqual({ status: "duplicaat", berichtId: "b1" });
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("taak mailbox: bijlage scannen en factuur maken", () => {
  const taak: Taak = { id: "t1", organisatie_id: "o1", soort: "mailbox", factuur_id: null, sleutel: "x1", payload: { bijlage_id: "x1" }, pogingen: 1, max_pogingen: 6 };
  const rij: InboxBijlageRij = {
    id: "x1", organisatie_id: "o1", pad: "o1/inbox/b1/1-Factuur 1.pdf", bestandsnaam: "Factuur 1.pdf", mime_type: "application/pdf",
    factuur_id: null, testdata: null, bericht_status: "geaccepteerd",
  };
  const scanOk = mockScan({ id: "x1", bestandsnaam: "f.pdf", testdata: null }, "2026-09-24");

  function deps(extra: Partial<MailboxTaakDeps> = {}) {
    const d = {
      bijlage: vi.fn(async () => rij),
      download: vi.fn(async () => new Uint8Array([1])),
      kopieer: vi.fn(async () => undefined),
      verwijder: vi.fn(async () => undefined),
      scan: vi.fn(async () => scanOk),
      rpc: vi.fn(async () => ({ status: "verwerkt", factuur_id: "x1" })),
      ...extra,
    };
    return d;
  }

  it("kopieert naar {organisatie}/{factuur_id}/… en maakt de factuur met het id van de bijlage", async () => {
    const d = deps();
    const r = await mailboxHandler(d)(taak);
    expect(d.kopieer).toHaveBeenCalledWith("o1/inbox/b1/1-Factuur 1.pdf", "o1/x1/Factuur_1.pdf");
    expect(d.rpc).toHaveBeenCalledWith("maak_factuur_uit_inbox", expect.objectContaining({
      p_bijlage_id: "x1", p_factuur_id: "x1", p_pad: "o1/x1/Factuur_1.pdf", p_ai_model: "mock",
    }));
    expect(r.omschrijving).toMatch(/^factuur MOCK-X1 van Onbekende leverancier \(mock-scan\) aangemaakt$/);
  });

  it("duplicaat: de kopie wordt weer verwijderd", async () => {
    const d = deps({ rpc: vi.fn(async () => ({ status: "duplicaat", factuur_id: "ander" })) });
    expect((await mailboxHandler(d)(taak)).omschrijving).toMatch(/^duplicaat/);
    expect(d.verwijder).toHaveBeenCalledWith("o1/x1/Factuur_1.pdf");
  });

  it("scanfout: limiet/storing = opnieuw proberen, onleesbaar bestand = definitief", async () => {
    const tijdelijk = mailboxHandler(deps({ scan: vi.fn(async () => ({ ok: false as const, status: 429, melding: "limiet" })) }))(taak);
    await expect(tijdelijk).rejects.toThrow("Scannen mislukt: limiet");
    await expect(tijdelijk).rejects.not.toBeInstanceOf(DefinitieveFout);
    await expect(mailboxHandler(deps({ scan: vi.fn(async () => ({ ok: false as const, status: 400, melding: "onleesbaar" })) }))(taak))
      .rejects.toBeInstanceOf(DefinitieveFout);
  });

  it("al verwerkt, of mail niet (meer) goedgekeurd", async () => {
    const d = deps({ bijlage: vi.fn(async () => ({ ...rij, factuur_id: "f9" })) });
    expect(await mailboxHandler(d)(taak)).toEqual({ omschrijving: "al verwerkt", factuur_id: "f9" });
    expect(d.scan).not.toHaveBeenCalled();
    await expect(mailboxHandler(deps({ bijlage: vi.fn(async () => ({ ...rij, bericht_status: "geweigerd" })) }))(taak))
      .rejects.toBeInstanceOf(DefinitieveFout);
  });
});

describe("testmail en voorbeeld-PDF", () => {
  it("de PDF is geldig: kop, eindmarkering en kloppende xref-verwijzingen", () => {
    const pdf = new TextDecoder().decode(maakPdf([{ tekst: "Factuur (test) \\ €", x: 50, y: 50 }]));
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf).toContain("(Factuur \\(test\\) \\\\ ) Tj");
    const startxref = Number(pdf.match(/startxref\n(\d+)/)![1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe("xref");
    const posities = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(posities).toHaveLength(6);
    posities.forEach((p, i) => expect(pdf.slice(p, p + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });

  it("testfactuur: bedragen kloppen", () => {
    const f = testFactuur("bekend", "2026-09-24", "1234");
    expect(f).toMatchObject({ factuurnummer: "VK-2026-1234", bedrag_excl: 250, totaal_incl: 302.5, vervaldatum: "2026-10-24" });
    expect(f.btw_regels).toEqual([{ tarief: 21, grondslag: 250, btw_bedrag: 52.5 }]);
  });

  it("bekende testmail: SPF/DKIM geslaagd, PDF met testdata en een inline logo; onbekende: SPF SoftFail", () => {
    const bekend = maakTestmail("bekend", "facturen@x.nl", NU, "1234");
    expect(bekend).toMatchObject({ van: "facturen@voorbeeld-kantoor.nl", spf: "Pass", dkim: "Pass", bron: "mock" });
    expect(bekend.bijlagen[0]).toMatchObject({ naam: "Factuur VK-2026-1234.pdf", testdata: { factuurnummer: "VK-2026-1234", kvk_nummer: "12345678" } });
    expect(beoordeelBijlage({ ...bekend.bijlagen[1], grootte: bekend.bijlagen[1].inhoud.byteLength }).bruikbaar).toBe(false);
    const onbekend = maakTestmail("onbekend", "facturen@x.nl", NU, "5678");
    expect(onbekend).toMatchObject({ van: "billing@snel-webdesign.example", spf: "SoftFail", dkim: null });
  });

  it("mock-scan gebruikt de testdata van de gesimuleerde mail", () => {
    const testdata = maakTestmail("bekend", "a@b.nl", NU, "4321").bijlagen[0].testdata!;
    expect(mockScan({ id: "x", bestandsnaam: "f.pdf", testdata }, "2026-09-24")).toEqual({ ok: true, factuur: testdata, model: "mock", codering: null });
  });
});
