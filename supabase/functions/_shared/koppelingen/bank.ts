// Betaalopdrachten: de bank-adapter (BankProvider), de mock-bank en de betaling-taak in de worker. Geen imports
// buiten deze map (testbaar met Vitest).
//
// Een echte bank-API (bijv. via PSD2 of een bankkoppeling van de bank zelf) kan later als BankProvider worden
// toegevoegd: indienen (het pain.001-bestand) en de status opvragen (per betaling uitgevoerd of geweigerd).
//
// Flow per batch:
//   stap "indienen": mock → de gesimuleerde bank ontvangt het SEPA-bestand; registreer_batch_ingediend plant na een
//                    minuut stap "status". Live → er is geen bank-API: niets doen (bestand downloaden in de app).
//   stap "status":   de bank meldt per betaling betaald of geweigerd → verwerk_bankbevestiging. Nog in behandeling →
//                    tijdelijke fout, dus later opnieuw (retries van de wachtrij).

import type { Koppeling, Modus } from "./modus.ts";
import { maakPain001, naarCenten, type SepaBatch } from "./sepa.ts";
import type { TaakHandler } from "./taken.ts";

export interface BankStatus {
  status: "in_behandeling" | "verwerkt";
  posten: { end_to_end_id: string; status: "betaald" | "geweigerd"; reden?: string }[];
}

export interface BankProvider {
  readonly naam: string;
  dienIn(batch: SepaBatch, bestand: string): Promise<{ referentie: string }>;
  status(referentie: string, batch: SepaBatch): Promise<BankStatus>;
}

/**
 * Gesimuleerde bank: accepteert elk geldig bestand en voert alle betalingen uit, behalve:
 *   bedrag eindigt op ,13 → geweigerd met AC04 (rekening opgeheven)
 *   bedrag eindigt op ,14 → geweigerd met AM05 (dubbele betaling)
 * Zo zijn geweigerde betalingen te testen zonder echte bank.
 */
export class BankMock implements BankProvider {
  readonly naam = "Bank (mock)";

  dienIn(batch: SepaBatch, bestand: string): Promise<{ referentie: string }> {
    if (!bestand.includes(`<MsgId>${batch.msgId}</MsgId>`)) return Promise.reject(new Error("Mock-bank: bestand past niet bij de batch."));
    return Promise.resolve({ referentie: `MOCKBANK-${batch.msgId}` });
  }

  status(_referentie: string, batch: SepaBatch): Promise<BankStatus> {
    return Promise.resolve({
      status: "verwerkt",
      posten: batch.posten.map((p) => {
        const centen = naarCenten(p.bedrag) % 100;
        if (centen === 13) return { end_to_end_id: p.endToEndId, status: "geweigerd" as const, reden: "AC04 Rekening opgeheven (mock)" };
        if (centen === 14) return { end_to_end_id: p.endToEndId, status: "geweigerd" as const, reden: "AM05 Dubbele betaling (mock)" };
        return { end_to_end_id: p.endToEndId, status: "betaald" as const };
      }),
    });
  }
}

export interface BatchRij {
  id: string;
  organisatie_id: string;
  nummer: string;
  status: "aangemaakt" | "ingediend" | "verwerkt" | "geannuleerd";
  uitvoerdatum: string;
  debiteur_naam: string;
  debiteur_iban: string;
  debiteur_bic: string | null;
  bank_referentie: string | null;
  aangemaakt_op: string;
  posten: {
    end_to_end_id: string;
    bedrag: number | string;
    naam: string;
    iban: string;
    omschrijving: string;
    status: string;
  }[];
}

/** Batch uit de database → SEPA-batch (alle posten; ook later geweigerde horen bij het oorspronkelijke bestand). */
export function naarSepaBatch(b: BatchRij): SepaBatch {
  return {
    msgId: b.nummer,
    aangemaaktOp: b.aangemaakt_op,
    uitvoerdatum: b.uitvoerdatum,
    debiteur: { naam: b.debiteur_naam, iban: b.debiteur_iban, bic: b.debiteur_bic },
    posten: b.posten.map((p) => ({
      endToEndId: p.end_to_end_id,
      bedrag: Number(p.bedrag),
      naam: p.naam,
      iban: p.iban,
      omschrijving: p.omschrijving,
    })),
  };
}

export interface BetalingDeps {
  modus(organisatieId: string, koppeling: Koppeling): Promise<Modus>;
  rpc(functie: string, args: Record<string, unknown>): Promise<unknown>;
  bank(modus: Modus): BankProvider | null;
}

export function betalingHandler(d: BetalingDeps): TaakHandler {
  return async (taak) => {
    const batchId = String(taak.payload.batch_id ?? "");
    const stap = taak.payload.stap === "status" ? "status" : "indienen";
    const b = (await d.rpc("betaalbatch_gegevens", { p_batch_id: batchId })) as BatchRij | null;
    if (!b) return { omschrijving: "Betaalbatch bestaat niet meer." };
    if (b.status === "geannuleerd" || b.status === "verwerkt") {
      return { omschrijving: `Betaalbatch ${b.nummer} is al ${b.status}; niets te doen.` };
    }

    const modus = await d.modus(b.organisatie_id, "betaling");
    const bank = d.bank(modus);
    if (!bank) {
      return {
        omschrijving: `Betaalbatch ${b.nummer}: geen bank-API gekoppeld (live). Download het SEPA-bestand en upload het bij je bank.`,
        modus,
      };
    }
    const sepa = naarSepaBatch(b);

    if (stap === "indienen") {
      if (b.status !== "aangemaakt") return { omschrijving: `Betaalbatch ${b.nummer} is al ingediend.` };
      const { referentie } = await bank.dienIn(sepa, maakPain001(sepa));
      await d.rpc("registreer_batch_ingediend", { p_batch_id: b.id, p_referentie: referentie, p_modus: modus });
      return { omschrijving: `Betaalbatch ${b.nummer} ingediend bij ${bank.naam} (${referentie})`, modus, referentie };
    }

    const status = await bank.status(b.bank_referentie ?? "", sepa);
    if (status.status === "in_behandeling") throw new Error(`${bank.naam}: batch ${b.nummer} is nog in behandeling.`);
    const r = (await d.rpc("verwerk_bankbevestiging", { p_batch_id: b.id, p_posten: status.posten })) as { betaald: number; geweigerd: number };
    return {
      omschrijving: `Bevestiging van ${bank.naam} voor batch ${b.nummer}: ${r.betaald} betaald, ${r.geweigerd} geweigerd`,
      modus,
      ...r,
    };
  };
}
