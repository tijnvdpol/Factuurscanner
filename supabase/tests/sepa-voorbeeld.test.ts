// Schrijft voorbeeld-betaalbestanden als SEPA_VOORBEELD een pad is, om ze tegen de officiële XSD te valideren
// (zie docs/beslissingen.md, B90). Zonder die variabele doet deze test niets.

import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { maakPain001, type SepaBatch } from "../functions/_shared/koppelingen/sepa.ts";

const BATCH: SepaBatch = {
  msgId: "FS20260924-001",
  aangemaaktOp: "2026-09-24T12:30:05Z",
  uitvoerdatum: "2026-09-25",
  debiteur: { naam: "Mijn Bedrijf B.V.", iban: "NL44RABO0123456789", bic: "RABONL2U" },
  posten: [
    { endToEndId: "FS20260924-001-001", bedrag: 121.5, naam: "Café & Co <Zoë>", iban: "NL91ABNA0417164300", omschrijving: "Factuur F-2026/001" },
    { endToEndId: "FS20260924-001-002", bedrag: 0.3, naam: "Lieferant GmbH", iban: "DE89370400440532013000", omschrijving: "Rechnung 42" },
  ],
};

it("voorbeeldbestanden voor validatie tegen pain.001.001.03.xsd", () => {
  const pad = process.env.SEPA_VOORBEELD;
  if (!pad) return;
  writeFileSync(pad, maakPain001(BATCH));
  writeFileSync(pad.replace(/\.xml$/, "-zonder-bic.xml"), maakPain001({ ...BATCH, debiteur: { ...BATCH.debiteur, bic: null } }));
});
