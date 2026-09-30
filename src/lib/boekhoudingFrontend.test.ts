import { describe, expect, it } from "vitest";
import { leesBoekhoudConfig, stelBtwVoor, stelGrootboekVoor } from "./boekhouding";
import { magVerwijderen, vergrendeling } from "./workflow";
import { LEGE_WORKFLOW } from "../types";

describe("boekhouding (frontend)", () => {
  const intern = [
    { id: "a", code: "4300", omschrijving: "Kantoorkosten" },
    { id: "b", code: "4999", omschrijving: "Bankkosten" },
    { id: "c", code: "4100", omschrijving: "Autokosten" },
  ];
  const extern = [
    { id: "X1", code: "4300", naam: "Kantoorbenodigdheden" },
    { id: "X2", code: "4900", naam: "Bankkosten" },
    { id: "X3", code: null, naam: "Overig" },
  ];

  it("grootboek: eerst op code, dan op naam; bestaande mappings blijven staan", () => {
    expect(stelGrootboekVoor(intern, extern, [])).toEqual([
      { intern: "a", extern: extern[0] },
      { intern: "b", extern: extern[1] },
    ]);
    expect(stelGrootboekVoor(intern, extern, [{ soort: "grootboek", intern: "a" }]).map((v) => v.intern)).toEqual(["b"]);
  });

  it("btw: op percentage", () => {
    const codes = [{ id: "H", code: "1", naam: "Hoog", percentage: 21 }, { id: "N", code: "0", naam: "Geen", percentage: 0 }];
    expect(stelBtwVoor(["21", "9", "0"], codes, [{ soort: "btw", intern: "0" }])).toEqual([{ intern: "21", extern: codes[0] }]);
  });

  it("config: standaard Moneybird en automatisch", () => {
    expect(leesBoekhoudConfig(null)).toEqual({ provider: "moneybird", automatisch: true });
    expect(leesBoekhoudConfig({ provider: "exact", automatisch: false })).toEqual({ provider: "exact", automatisch: false });
    expect(leesBoekhoudConfig({ provider: "twinfield" })).toEqual({ provider: "moneybird", automatisch: true });
  });

  it("vergrendeling en verwijderen na export", () => {
    expect(vergrendeling({ status: "goedgekeurd", geexporteerd_op: null })).toBeNull();
    expect(vergrendeling({ status: "betaald", geexporteerd_op: null })).toMatch(/betaald/);
    expect(vergrendeling({ status: "goedgekeurd", geexporteerd_op: "2026-09-24T10:00:00Z" })).toMatch(/geëxporteerd/);
    const ctx = { rol: "beheerder" as const, userId: "u", aantalLeden: 2, goedkeuringslimiet: null };
    expect(magVerwijderen({ status: "goedgekeurd", workflow: LEGE_WORKFLOW, geexporteerd_op: "2026-09-24T10:00:00Z" }, ctx)).toBe(false);
    expect(magVerwijderen({ status: "goedgekeurd", workflow: LEGE_WORKFLOW }, ctx)).toBe(true);
  });
});
