import { describe, expect, it } from "vitest";
import { genereerCsv } from "./csv";
import { GEEN_CODERING, GEEN_OMREKENING, LEGE_WORKFLOW, legeFactuurData, type Factuur } from "../types";

function factuur(extra: Partial<Factuur>): Factuur {
  return {
    ...legeFactuurData(),
    id: "f1",
    leverancier: "Hoster",
    factuurnummer: "H-1",
    leverancier_iban: null,
    signalen: [],
    koppelingen: [],
    euro: GEEN_OMREKENING,
    codering: GEEN_CODERING,
    bestandsnaam: null,
    bestand_pad: null,
    status: "gescand",
    ai_model: null,
    aangemaaktOp: "2026-09-01T10:00:00Z",
    workflow: LEGE_WORKFLOW,
    ...extra,
  };
}

describe("genereerCsv", () => {
  it("zet de grootboekrekening in de laatste twee kolommen", () => {
    const csv = genereerCsv(
      [factuur({ codering: { grootboekrekening_id: "ict", bron: "handmatig", zekerheid: null } }), factuur({ id: "f2" })],
      [{ id: "ict", code: "4400", omschrijving: "ICT en software", actief: true }],
    );
    const [kop, rij1, rij2] = csv.split("\r\n");
    expect(kop.split(";").slice(-2)).toEqual(["Grootboekrekening", "Omschrijving grootboekrekening"]);
    expect(rij1.split(";").slice(-2)).toEqual(["4400", "ICT en software"]);
    expect(rij2.split(";").slice(-2)).toEqual(["", ""]);
  });
});
