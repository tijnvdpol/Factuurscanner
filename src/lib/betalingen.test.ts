import { describe, expect, it } from "vitest";
import { betaalBlokkade, controleerBetaalRekening, sepaBestand, volgendeWerkdag, type Betaalbatch } from "./betalingen";
import type { Signaal } from "../types";

const GOED = {
  status: "goedgekeurd" as const, valuta: "EUR", totaal_incl: 121, iban: "NL91 ABNA 0417 1643 00", leverancier: "Leverancier BV",
  signalen: [] as Signaal[],
};

describe("betalingen (frontend)", () => {
  it("betaalBlokkade: zelfde regels als de database", () => {
    expect(betaalBlokkade(GOED)).toBeNull();
    expect(betaalBlokkade({ ...GOED, status: "gecontroleerd" })).toMatch(/goedgekeurde/);
    expect(betaalBlokkade({ ...GOED, status: "in_betaalbatch" })).toMatch(/al in een betaalbatch/);
    expect(betaalBlokkade({ ...GOED, valuta: "USD" })).toMatch(/euro \(USD\)/);
    expect(betaalBlokkade({ ...GOED, totaal_incl: -5 })).toMatch(/niet positief/);
    expect(betaalBlokkade({ ...GOED, iban: "NL92ABNA0417164300" })).toMatch(/controlegetal/);
    expect(betaalBlokkade({ ...GOED, iban: "TR330006100519786457841326" })).toMatch(/SEPA-gebied/);
    expect(betaalBlokkade({ ...GOED, signalen: [{ ernst: "kritiek", opgelost: false } as Signaal] })).toMatch(/kritiek signaal/);
    expect(betaalBlokkade({ ...GOED, signalen: [{ ernst: "kritiek", opgelost: true } as Signaal] })).toBeNull();
  });

  it("betalende rekening", () => {
    expect(controleerBetaalRekening({ naam: "Bedrijf", iban: "NL44RABO0123456789", bic: "" })).toBeNull();
    expect(controleerBetaalRekening({ naam: "", iban: "NL44RABO0123456789", bic: "" })).toMatch(/naam/);
    expect(controleerBetaalRekening({ naam: "B", iban: "NL02RABO0123456789", bic: "" })).toMatch(/controlegetal/);
    expect(controleerBetaalRekening({ naam: "B", iban: "NL44RABO0123456789", bic: "RABO" })).toMatch(/BIC/);
  });

  it("standaard uitvoerdatum: de volgende werkdag", () => {
    expect(volgendeWerkdag(new Date(2026, 8, 24))).toBe("2026-09-25"); // do → vr
    expect(volgendeWerkdag(new Date(2026, 8, 25))).toBe("2026-09-28"); // vr → ma
    expect(volgendeWerkdag(new Date(2026, 8, 26))).toBe("2026-09-28"); // za → ma
  });

  it("SEPA-bestand uit een batch", () => {
    const batch = {
      id: "b", organisatie_id: "o", nummer: "FS20260924-002", status: "aangemaakt", uitvoerdatum: "2026-09-25",
      debiteur_naam: "Bedrijf", debiteur_iban: "NL44RABO0123456789", debiteur_bic: null, aantal: 1, totaal: 121, modus: null,
      bank_referentie: null, aangemaakt_door: null, aangemaakt_op: "2026-09-24T10:00:00Z", ingediend_op: null, verwerkt_op: null,
      geannuleerd_op: null, toelichting: null,
      posten: [{ id: "p", factuur_id: "f", volgnummer: 1, end_to_end_id: "FS20260924-002-001", bedrag: 121, naam: "Lev", iban: "NL91ABNA0417164300", omschrijving: "Factuur 1", status: "open", reden: null }],
    } satisfies Betaalbatch;
    const xml = sepaBestand(batch);
    expect(xml).toContain("<MsgId>FS20260924-002</MsgId>");
    expect(xml).toContain('<InstdAmt Ccy="EUR">121.00</InstdAmt>');
  });
});
