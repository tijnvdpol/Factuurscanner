import { describe, expect, it } from "vitest";
import {
  isIbanAfwijkend,
  isRondBedrag,
  netOnderLimiet,
  normaliseerFactuurnummer,
  telOpenSignalen,
  voorspelSignalen,
  zoekDuplicaten,
  type VergelijkFactuur,
} from "./signalen";
import { legeFactuurData } from "../types";

describe("normaliseerFactuurnummer", () => {
  it.each([
    ["F-001", "F1"],
    ["f 001", "F1"],
    ["F1", "F1"],
    ["2024-0012", "202412"],
    ["2024-12", "202412"],
    ["000123", "123"],
    ["100", "100"],
    ["0", "0"],
    ["20240012", "20240012"],
  ])("%s → %s", (invoer, verwacht) => {
    expect(normaliseerFactuurnummer(invoer)).toBe(verwacht);
  });

  it("leeg en null worden null", () => {
    expect(normaliseerFactuurnummer(null)).toBeNull();
    expect(normaliseerFactuurnummer(" - ")).toBeNull();
  });
});

describe("zoekDuplicaten", () => {
  const bestaand: VergelijkFactuur[] = [
    { id: "1", leverancier: "Bol.com", factuurnummer: "F-0001", factuurdatum: "2026-06-01", totaal_incl: 100, aangemaaktOp: "2026-06-02" },
    { id: "2", leverancier: "Bol.com", factuurnummer: "F-0002", factuurdatum: "2026-06-10", totaal_incl: 250, aangemaaktOp: "2026-06-11" },
    { id: "3", leverancier: "Coolblue", factuurnummer: "F1", factuurdatum: "2026-06-01", totaal_incl: 100, aangemaaktOp: "2026-06-02" },
  ];

  it("vindt zelfde leverancier met genormaliseerd gelijk nummer", () => {
    const r = zoekDuplicaten({ leverancier: "bol.com ", factuurnummer: "f 1", factuurdatum: "2026-09-01", totaal_incl: 5 }, bestaand);
    expect(r.map((d) => d.id)).toEqual(["1"]);
  });

  it("vindt zelfde bedrag binnen 30 dagen, niet daarbuiten", () => {
    const binnen = zoekDuplicaten({ leverancier: "Bol.com", factuurnummer: "X", factuurdatum: "2026-07-01", totaal_incl: 100 }, bestaand);
    const buiten = zoekDuplicaten({ leverancier: "Bol.com", factuurnummer: "X", factuurdatum: "2026-07-02", totaal_incl: 100 }, bestaand);
    expect(binnen.map((d) => d.id)).toEqual(["1"]);
    expect(buiten).toEqual([]);
  });

  it("negeert andere leveranciers en zichzelf", () => {
    expect(zoekDuplicaten({ id: "1", leverancier: "Bol.com", factuurnummer: "F-0001", factuurdatum: null, totaal_incl: null }, bestaand)).toEqual([]);
    expect(zoekDuplicaten({ leverancier: "Jumbo", factuurnummer: "F1", factuurdatum: null, totaal_incl: null }, bestaand)).toEqual([]);
  });
});

describe("losse regels", () => {
  it("rond bedrag: veelvoud van 100 en ≥ 1.000", () => {
    expect(isRondBedrag(1000)).toBe(true);
    expect(isRondBedrag(25_000)).toBe(true);
    expect(isRondBedrag(900)).toBe(false);
    expect(isRondBedrag(1050)).toBe(false);
    expect(isRondBedrag(1000.5)).toBe(false);
    expect(isRondBedrag(null)).toBe(false);
  });

  it("net onder limiet: binnen 5% onder de laagste geraakte limiet", () => {
    expect(netOnderLimiet(4800, [5000])).toBe(5000);
    expect(netOnderLimiet(4750, [5000])).toBe(5000);
    expect(netOnderLimiet(5000, [5000])).toBe(5000);
    expect(netOnderLimiet(4749.99, [5000])).toBeNull();
    expect(netOnderLimiet(5000.01, [5000])).toBeNull();
    expect(netOnderLimiet(980, [1000, null, 1010])).toBe(1000);
    expect(netOnderLimiet(980, [null])).toBeNull();
  });

  it("IBAN afwijkend alleen als beide bekend en verschillend", () => {
    expect(isIbanAfwijkend("NL91 ABNA 0417 1643 00", "NL91ABNA0417164300")).toBe(false);
    expect(isIbanAfwijkend("NL44RABO0123456789", "NL91ABNA0417164300")).toBe(true);
    expect(isIbanAfwijkend(null, "NL91ABNA0417164300")).toBe(false);
    expect(isIbanAfwijkend("NL44RABO0123456789", null)).toBe(false);
  });

  it("telt alleen open signalen", () => {
    expect(
      telOpenSignalen([
        { ernst: "kritiek", opgelost: false },
        { ernst: "kritiek", opgelost: true },
        { ernst: "info", opgelost: false },
      ]),
    ).toEqual({ kritiek: 1, waarschuwing: 0, info: 1 });
  });
});

describe("voorspelSignalen", () => {
  it("nieuwe leverancier, rond bedrag en validatiefout", () => {
    const r = voorspelSignalen(
      { ...legeFactuurData(), leverancier: "Nieuw BV", totaal_incl: 2000, kvk_nummer: "123" },
      { anderen: [], bekendIban: null, limieten: [] },
    );
    expect(r.map((s) => s.type)).toEqual(["nieuwe_leverancier", "rond_bedrag", "validatiefout"]);
  });

  it("kritiek bij afwijkend IBAN en waarschuwing net onder limiet", () => {
    const r = voorspelSignalen(
      { ...legeFactuurData(), leverancier: "Oud BV", iban: "NL44RABO0123456789", totaal_incl: 4990 },
      {
        anderen: [{ id: "x", leverancier: "Oud BV", factuurnummer: "1", factuurdatum: "2020-01-01", totaal_incl: 1, aangemaaktOp: "2020-01-01" }],
        bekendIban: "NL91ABNA0417164300",
        limieten: [5000],
      },
    );
    expect(r.map((s) => [s.type, s.ernst])).toEqual([
      ["iban_afwijkend", "kritiek"],
      ["net_onder_limiet", "waarschuwing"],
    ]);
  });
});
