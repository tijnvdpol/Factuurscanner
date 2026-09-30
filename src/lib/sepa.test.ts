import { describe, expect, it } from "vitest";
import { controleerBatch, isGeldigIban, maakPain001, sepaTekst, type SepaBatch } from "../../supabase/functions/_shared/koppelingen/sepa.ts";
import { BankMock, betalingHandler, naarSepaBatch, type BatchRij, type BetalingDeps } from "../../supabase/functions/_shared/koppelingen/bank.ts";
import { DefinitieveFout, voerTaakUit, type Taak } from "../../supabase/functions/_shared/koppelingen/taken.ts";

const BATCH: SepaBatch = {
  msgId: "FS20260924-001",
  aangemaaktOp: "2026-09-24T12:30:05Z",
  uitvoerdatum: "2026-09-25",
  debiteur: { naam: "Mijn Bedrijf B.V.", iban: "NL44 RABO 0123 4567 89", bic: "RABONL2U" },
  posten: [
    { endToEndId: "FS20260924-001-001", bedrag: 121.5, naam: "Café & Co <Zoë>", iban: "NL91ABNA0417164300", omschrijving: "Factuur F-2026/001" },
    { endToEndId: "FS20260924-001-002", bedrag: 0.1 + 0.2, naam: "Leverancier BV", iban: "DE89370400440532013000", omschrijving: "Factuur 42" },
  ],
};

describe("SEPA pain.001.001.03", () => {
  it("tekens: accenten weg, & wordt +, alleen de SEPA-tekenset, ingekort", () => {
    expect(sepaTekst("Café & Co <Zoë> ß", 70)).toBe("Cafe + Co Zoe ss");
    expect(sepaTekst("Factuur #12 € 5", 140)).toBe("Factuur 12 5");
    expect(sepaTekst("a".repeat(80), 70)).toHaveLength(70);
  });

  it("IBAN-controle (mod 97)", () => {
    expect(isGeldigIban("NL91 ABNA 0417 1643 00")).toBe(true);
    expect(isGeldigIban("NL92ABNA0417164300")).toBe(false);
    expect(isGeldigIban("DE89370400440532013000")).toBe(true);
  });

  it("maakt een geldig bestand: kop, controletotaal, debiteur, transacties", () => {
    const x = maakPain001(BATCH);
    expect(x).toContain('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"');
    expect(x).toContain("<MsgId>FS20260924-001</MsgId>");
    expect(x).toContain("<CreDtTm>2026-09-24T14:30:05</CreDtTm>");
    expect(x.match(/<NbOfTxs>2<\/NbOfTxs>/g)).toHaveLength(2);
    expect(x.match(/<CtrlSum>121.80<\/CtrlSum>/g)).toHaveLength(2);
    expect(x).toContain("<ReqdExctnDt>2026-09-25</ReqdExctnDt>");
    expect(x).toContain("<DbtrAcct><Id><IBAN>NL44RABO0123456789</IBAN></Id></DbtrAcct>");
    expect(x).toContain("<BIC>RABONL2U</BIC>");
    expect(x).toContain('<InstdAmt Ccy="EUR">0.30</InstdAmt>');
    expect(x).toContain("<Cdtr><Nm>Cafe + Co Zoe</Nm></Cdtr>");
    expect(x).toContain("<Ustrd>Factuur F-2026/001</Ustrd>");
    expect(maakPain001(BATCH)).toBe(x);
  });

  it("zonder BIC: NOTPROVIDED", () => {
    expect(maakPain001({ ...BATCH, debiteur: { ...BATCH.debiteur, bic: null } })).toContain("<Othr><Id>NOTPROVIDED</Id></Othr>");
  });

  it("weigert een ongeldig bestand, met alle problemen tegelijk", () => {
    const fout = (() => {
      try {
        controleerBatch({
          ...BATCH,
          debiteur: { ...BATCH.debiteur, iban: "NL00XXXX" },
          posten: [
            { ...BATCH.posten[0], bedrag: 0 },
            { ...BATCH.posten[1], iban: "NL92ABNA0417164300", endToEndId: BATCH.posten[0].endToEndId },
            { ...BATCH.posten[1], endToEndId: "X-3", bedrag: 1.005 },
          ],
        });
      } catch (err) {
        return err;
      }
    })();
    expect(fout).toBeInstanceOf(DefinitieveFout);
    const m = (fout as Error).message;
    expect(m).toMatch(/IBAN van de betalende rekening/);
    expect(m).toMatch(/tussen € 0,01/);
    expect(m).toMatch(/IBAN NL92ABNA0417164300 is ongeldig/);
    expect(m).toMatch(/dubbel kenmerk/);
    expect(m).toMatch(/meer dan 2 decimalen/);
  });

});

describe("mock-bank en betaling-taak", () => {
  const RIJ: BatchRij = {
    id: "b1", organisatie_id: "o1", nummer: "FS20260924-001", status: "aangemaakt", uitvoerdatum: "2026-09-25",
    debiteur_naam: "Mijn Bedrijf", debiteur_iban: "NL44RABO0123456789", debiteur_bic: null, bank_referentie: null,
    aangemaakt_op: "2026-09-24T12:30:05Z",
    posten: [
      { end_to_end_id: "FS20260924-001-001", bedrag: "100.00", naam: "A", iban: "NL91ABNA0417164300", omschrijving: "Factuur 1", status: "open" },
      { end_to_end_id: "FS20260924-001-002", bedrag: "50.13", naam: "B", iban: "NL91ABNA0417164300", omschrijving: "Factuur 2", status: "open" },
    ],
  };
  const taak = (stap: string): Taak => ({
    id: "t", organisatie_id: "o1", soort: "betaling", factuur_id: null, sleutel: `b1:${stap}`, payload: { batch_id: "b1", stap }, pogingen: 1, max_pogingen: 6,
  });

  function deps(rij: BatchRij | null, modus: "live" | "mock" = "mock") {
    const rpcs: [string, Record<string, unknown>][] = [];
    const d: BetalingDeps = {
      modus: async () => modus,
      rpc: async (functie, args) => {
        rpcs.push([functie, args]);
        if (functie === "betaalbatch_gegevens") return rij;
        if (functie === "verwerk_bankbevestiging") return { betaald: 1, geweigerd: 1 };
        return null;
      },
      bank: (m) => (m === "mock" ? new BankMock() : null),
    };
    return { d, rpcs };
  }

  it("mock: bedrag op ,13 geweigerd (AC04), de rest betaald", async () => {
    const s = await new BankMock().status("x", naarSepaBatch(RIJ));
    expect(s.posten).toEqual([
      { end_to_end_id: "FS20260924-001-001", status: "betaald" },
      { end_to_end_id: "FS20260924-001-002", status: "geweigerd", reden: "AC04 Rekening opgeheven (mock)" },
    ]);
  });

  it("indienen: bestand naar de mock-bank en registreren", async () => {
    const { d, rpcs } = deps(RIJ);
    const r = await betalingHandler(d)(taak("indienen"));
    expect(r.omschrijving).toBe("Betaalbatch FS20260924-001 ingediend bij Bank (mock) (MOCKBANK-FS20260924-001)");
    expect(rpcs[1]).toEqual(["registreer_batch_ingediend", { p_batch_id: "b1", p_referentie: "MOCKBANK-FS20260924-001", p_modus: "mock" }]);
  });

  it("status: bevestiging per betaling doorgeven", async () => {
    const { d, rpcs } = deps({ ...RIJ, status: "ingediend", bank_referentie: "MOCKBANK-FS20260924-001" });
    const r = await betalingHandler(d)(taak("status"));
    expect(r).toMatchObject({ betaald: 1, geweigerd: 1 });
    expect((rpcs[1][1].p_posten as unknown[]).length).toBe(2);
  });

  it("live: niets doen; geannuleerde batch: niets doen", async () => {
    const live = deps(RIJ, "live");
    expect((await betalingHandler(live.d)(taak("indienen"))).omschrijving).toMatch(/geen bank-API gekoppeld/);
    expect(live.rpcs.map(([f]) => f)).toEqual(["betaalbatch_gegevens"]);

    const weg = deps({ ...RIJ, status: "geannuleerd" });
    expect((await betalingHandler(weg.d)(taak("status"))).omschrijving).toMatch(/al geannuleerd/);
  });

  it("een ongeldige batch wordt niet ingediend (definitief)", async () => {
    const { d } = deps({ ...RIJ, debiteur_iban: "NL00FOUT" });
    expect(await voerTaakUit(taak("indienen"), { betaling: betalingHandler(d) })).toMatchObject({ gelukt: false, opnieuw: false });
  });
});
