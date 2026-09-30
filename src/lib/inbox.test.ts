import { describe, expect, it } from "vitest";
import { echtheid, grootte, redenBeoordeling } from "./inbox";

describe("inbox", () => {
  it("echtheid van de afzender", () => {
    expect(echtheid({ spf: "Pass", dkim: "Pass", spam: false })).toEqual({ tekst: "SPF + DKIM geslaagd", ok: true });
    expect(echtheid({ spf: "pass", dkim: null, spam: false })).toEqual({ tekst: "SPF geslaagd", ok: true });
    expect(echtheid({ spf: "SoftFail", dkim: null, spam: false })).toEqual({
      tekst: "Afzender niet bevestigd (SPF: SoftFail, DKIM: onbekend)", ok: false,
    });
    expect(echtheid({ spf: "Pass", dkim: "Pass", spam: true }).ok).toBe(false);
  });

  it("reden van beoordeling", () => {
    const basis = { spf: "Pass", dkim: null, spam: false, bekende_afzender: false };
    expect(redenBeoordeling({ ...basis, status: "te_beoordelen" })).toBe("De afzender staat niet in de lijst met vertrouwde afzenders.");
    expect(redenBeoordeling({ ...basis, spf: "Fail", status: "te_beoordelen" })).toMatch(/mogelijk vervalst/);
    expect(redenBeoordeling({ ...basis, spam: true, status: "te_beoordelen" })).toMatch(/spam/);
    expect(redenBeoordeling({ ...basis, status: "geaccepteerd" })).toBeNull();
  });

  it("bestandsgrootte", () => {
    expect(grootte(512)).toBe("512 B");
    expect(grootte(30_000)).toBe("29 kB");
    expect(grootte(2_500_000)).toBe("2,4 MB");
    expect(grootte(null)).toBe("");
  });
});
