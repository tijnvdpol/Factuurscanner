import { describe, expect, it } from "vitest";
import {
  controleerBtwNummer,
  controleerIban,
  controleerKvkNummer,
  controleerVervaldatum,
  isGeldigeDatum,
  isGeldigeIban,
} from "./veldvalidatie";
import { valideerFactuur } from "./validatie";
import { legeFactuurData } from "../types";

describe("IBAN", () => {
  it.each([
    "NL91ABNA0417164300",
    "nl91 abna 0417 1643 00",
    "NL44RABO0123456789",
    "DE89370400440532013000",
    "BE68539007547034",
    "GB29NWBK60161331926819",
    "FR1420041010050500013M02606",
  ])("accepteert geldig IBAN %s", (iban) => {
    expect(controleerIban(iban)).toBeNull();
    expect(isGeldigeIban(iban)).toBe(true);
  });

  it("weigert een fout controlegetal", () => {
    expect(controleerIban("NL91ABNA0417164301")).toMatch(/controlegetal/);
  });

  it("weigert een verkeerde lengte voor het land", () => {
    expect(controleerIban("NL91ABNA041716430")).toMatch(/18 tekens/);
    expect(controleerIban("DE8937040044053201300")).toMatch(/22 tekens/);
  });

  it("weigert een onbekende landcode en onzin", () => {
    expect(controleerIban("XX91ABNA0417164300")).toMatch(/onbekende landcode XX/);
    expect(controleerIban("1234")).toMatch(/landcode/);
    expect(controleerIban("NL91-ABNA-0417-1643-00")).not.toBeNull();
  });

  it("laat leeg toe", () => {
    expect(controleerIban(null)).toBeNull();
    expect(controleerIban("  ")).toBeNull();
  });
});

describe("btw-nummer", () => {
  it.each(["NL123456789B01", "nl 1234.56.789.b01", "DE123456789", "BE0123456789"])("accepteert %s", (nr) => {
    expect(controleerBtwNummer(nr)).toBeNull();
  });

  it.each(["NL12345678B01", "NL123456789B1", "NL123456789X01", "NL123456789B012", "NL"])(
    "weigert NL-nummer %s",
    (nr) => {
      expect(controleerBtwNummer(nr)).toMatch(/NL \+ 9 cijfers/);
    },
  );

  it("weigert een nummer zonder landcode", () => {
    expect(controleerBtwNummer("123456789B01")).toMatch(/landcode/);
  });
});

describe("KvK-nummer", () => {
  it("accepteert 8 cijfers, ook met spaties", () => {
    expect(controleerKvkNummer("12345678")).toBeNull();
    expect(controleerKvkNummer("1234 5678")).toBeNull();
  });

  it.each(["1234567", "123456789", "1234567a"])("weigert %s", (nr) => {
    expect(controleerKvkNummer(nr)).toMatch(/8 cijfers/);
  });
});

describe("datums", () => {
  it("herkent bestaande datums", () => {
    expect(isGeldigeDatum("2026-02-28")).toBe(true);
    expect(isGeldigeDatum("2024-02-29")).toBe(true);
    expect(isGeldigeDatum("2026-02-30")).toBe(false);
    expect(isGeldigeDatum("28-02-2026")).toBe(false);
  });

  it("vervaldatum niet vóór factuurdatum", () => {
    expect(controleerVervaldatum("2026-09-30", "2026-09-01")).toBeNull();
    expect(controleerVervaldatum("2026-09-01", "2026-09-01")).toBeNull();
    expect(controleerVervaldatum("2026-08-31", "2026-09-01")).toMatch(/vóór de factuurdatum/);
    expect(controleerVervaldatum("2026-13-01", "2026-09-01")).toMatch(/Ongeldige datum/);
    expect(controleerVervaldatum("2026-09-01", null)).toBeNull();
    expect(controleerVervaldatum(null, "2026-09-01")).toBeNull();
  });
});

describe("valideerFactuur", () => {
  it("geeft per veld een fout", () => {
    const fouten = valideerFactuur({
      ...legeFactuurData(),
      factuurdatum: "2026-09-01",
      vervaldatum: "2026-08-01",
      iban: "NL91ABNA0417164301",
      btw_nummer: "NL12",
      kvk_nummer: "123",
    });
    expect(Object.keys(fouten).sort()).toEqual(["btw_nummer", "iban", "kvk_nummer", "vervaldatum"]);
  });

  it("geen fouten voor een correcte factuur", () => {
    expect(
      valideerFactuur({
        ...legeFactuurData(),
        factuurdatum: "2026-09-01",
        vervaldatum: "2026-10-01",
        iban: "NL91ABNA0417164300",
        btw_nummer: "NL123456789B01",
        kvk_nummer: "12345678",
        totaal_incl: 121,
        btw_regels: [{ tarief: 21, grondslag: 100, btw_bedrag: 21 }],
      }),
    ).toEqual({});
  });
});
