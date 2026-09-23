import { describe, expect, it } from "vitest";
import { auditCsv, formatWaarde, omschrijving, wijzigingen, type AuditRegel, type WeergaveContext } from "./audit";

const ctx: WeergaveContext = {
  naamVan: (id) => ({ u1: "anna@example.nl", u2: "bram@example.nl" })[id],
  rekeningNaam: (id) => (id === "r1" ? "4300 Kantoorkosten" : undefined),
};

function regel(extra: Partial<AuditRegel>): AuditRegel {
  return {
    id: 1,
    organisatie_id: "o1",
    tabel: "facturen",
    record_id: "f1",
    actie: "update",
    gewijzigde_velden: null,
    oud: null,
    nieuw: null,
    user_id: "u1",
    toelichting: null,
    created_at: "2026-09-23T10:00:00Z",
    ...extra,
  };
}

describe("formatWaarde", () => {
  it("maakt waarden leesbaar", () => {
    expect(formatWaarde("status", "gecontroleerd", ctx)).toBe("Gecontroleerd");
    expect(formatWaarde("totaal_incl", 1234.5, ctx)).toBe("€ 1.234,50");
    expect(formatWaarde("tarief", 21, ctx)).toBe("21%");
    expect(formatWaarde("gecontroleerd_door", "u2", ctx)).toBe("bram@example.nl");
    expect(formatWaarde("gecontroleerd_door", "u9", ctx)).toBe("onbekende gebruiker");
    expect(formatWaarde("grootboekrekening_id", "r1", ctx)).toBe("4300 Kantoorkosten");
    expect(formatWaarde("opgelost", true, ctx)).toBe("ja");
    expect(formatWaarde("rol", "goedkeurder", ctx)).toBe("Goedkeurder");
    expect(formatWaarde("codering_zekerheid", 0.82, ctx)).toBe("82%");
    expect(formatWaarde("iban", null, ctx)).toBe("—");
  });
});

describe("wijzigingen en omschrijving", () => {
  it("statuswijziging: van → naar met Nederlandse veldnamen", () => {
    const r = regel({
      actie: "statuswijziging",
      gewijzigde_velden: ["gecontroleerd_door", "status"],
      oud: { status: "gescand", gecontroleerd_door: null },
      nieuw: { status: "gecontroleerd", gecontroleerd_door: "u1" },
    });
    expect(omschrijving(r, ctx)).toBe("Status: Gescand → Gecontroleerd");
    expect(wijzigingen(r, ctx)).toEqual([
      { veld: "gecontroleerd_door", label: "Gecontroleerd door", van: "—", naar: "anna@example.nl" },
      { veld: "status", label: "Status", van: "Gescand", naar: "Gecontroleerd" },
    ]);
  });

  it("aanmaken: alleen gevulde, niet-technische velden", () => {
    const r = regel({
      actie: "insert",
      nieuw: { id: "f1", organisatie_id: "o1", factuurnummer: "F-1", iban: null, totaal_incl: 121, updated_at: "x" },
    });
    expect(omschrijving(r, ctx)).toBe("Factuur aangemaakt");
    expect(wijzigingen(r, ctx).map((w) => [w.label, w.naar])).toEqual([
      ["Factuurnummer", "F-1"],
      ["Totaal incl. BTW", "€ 121,00"],
    ]);
  });

  it("signaal opgelost en lid gewijzigd", () => {
    expect(
      omschrijving(regel({ tabel: "factuur_signalen", gewijzigde_velden: ["opgelost"], oud: { opgelost: false }, nieuw: { opgelost: true } }), ctx),
    ).toBe("Signaal opgelost");
    expect(omschrijving(regel({ tabel: "factuur_signalen", actie: "insert", nieuw: { type: "iban_afwijkend" } }), ctx)).toBe(
      "Signaal: IBAN afwijkend",
    );
    expect(omschrijving(regel({ tabel: "organisatie_leden", record_id: "u2" }), ctx)).toBe("Lid bram@example.nl gewijzigd");
  });
});

describe("auditCsv", () => {
  it("één regel per logregel, met gebruiker, wijzigingen en toelichting", () => {
    const csv = auditCsv(
      [
        regel({
          actie: "statuswijziging",
          gewijzigde_velden: ["afkeur_reden", "status"],
          oud: { status: "gescand", afkeur_reden: null },
          nieuw: { status: "afgekeurd", afkeur_reden: "Fout; opnieuw" },
          toelichting: "Fout; opnieuw",
        }),
        regel({ user_id: null, actie: "insert", tabel: "organisatie_leden", record_id: "u2", nieuw: { rol: "beheerder" } }),
      ],
      ctx,
    );
    const [kop, r1, r2] = csv.split("\r\n");
    expect(kop).toBe("Tijdstip;Gebruiker;Onderdeel;Actie;Omschrijving;Wijzigingen;Toelichting;Record-id");
    expect(r1).toContain("anna@example.nl;Factuur;Statuswijziging;Status: Gescand → Afgekeurd;");
    expect(r1).toContain('"Reden afkeuring: — → Fout; opnieuw | Status: Gescand → Afgekeurd"');
    expect(r2).toContain(";systeem;Lid;Aangemaakt;");
  });
});
