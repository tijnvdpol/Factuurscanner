import { describe, expect, it } from "vitest";
import { handmatigeCodering, kiesCoderingsvoorstel, voorstelLabel } from "./codering";
import type { Grootboekrekening } from "../types";

const rekeningen: Grootboekrekening[] = [
  { id: "ict", code: "4400", omschrijving: "ICT en software", actief: true },
  { id: "kantoor", code: "4300", omschrijving: "Kantoorkosten", actief: true },
  { id: "oud", code: "4999", omschrijving: "Vervallen", actief: false },
];

describe("kiesCoderingsvoorstel", () => {
  it("historie gaat vóór AI", () => {
    expect(kiesCoderingsvoorstel({ grootboekrekening_id: "kantoor", zekerheid: 0.75 }, { grootboekrekening_id: "ict", zekerheid: 0.9 }, rekeningen))
      .toEqual({ grootboekrekening_id: "kantoor", bron: "historie", zekerheid: 0.75 });
  });

  it("AI als er geen historie is", () => {
    expect(kiesCoderingsvoorstel(null, { grootboekrekening_id: "ict", zekerheid: 0.9 }, rekeningen))
      .toEqual({ grootboekrekening_id: "ict", bron: "ai", zekerheid: 0.9 });
  });

  it("negeert inactieve of onbekende rekeningen", () => {
    expect(kiesCoderingsvoorstel({ grootboekrekening_id: "oud", zekerheid: 1 }, { grootboekrekening_id: "ict", zekerheid: 0.4 }, rekeningen).bron)
      .toBe("ai");
    expect(kiesCoderingsvoorstel(null, { grootboekrekening_id: "bestaat-niet", zekerheid: 1 }, rekeningen))
      .toEqual({ grootboekrekening_id: null, bron: null, zekerheid: null });
  });
});

describe("voorstelLabel", () => {
  it("toont bron en percentage bij een voorstel", () => {
    expect(voorstelLabel({ grootboekrekening_id: "ict", bron: "ai", zekerheid: 0.823 })).toBe("Voorgesteld (AI, 82%)");
    expect(voorstelLabel({ grootboekrekening_id: "ict", bron: "historie", zekerheid: 1 })).toBe("Voorgesteld (historie, 100%)");
  });

  it("geen label na bevestiging of zonder rekening", () => {
    expect(voorstelLabel(handmatigeCodering("ict"))).toBeNull();
    expect(voorstelLabel(handmatigeCodering(null))).toBeNull();
  });
});
