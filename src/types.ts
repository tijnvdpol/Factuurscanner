export interface BtwRegel {
  tarief: number | null;
  grondslag: number | null;
  btw_bedrag: number | null;
}

export interface FactuurData {
  leverancier: string | null;
  factuurnummer: string | null;
  factuurdatum: string | null;
  vervaldatum: string | null;
  bedrag_excl: number | null;
  btw_regels: BtwRegel[];
  totaal_incl: number | null;
  valuta: string | null;
  iban: string | null;
  btw_nummer: string | null;
  kvk_nummer: string | null;
}

export const STATUSSEN = ["gescand", "gecontroleerd", "goedgekeurd", "betaald"] as const;
export type FactuurStatus = (typeof STATUSSEN)[number];

export const STATUS_LABELS: Record<FactuurStatus, string> = {
  gescand: "Gescand",
  gecontroleerd: "Gecontroleerd",
  goedgekeurd: "Goedgekeurd",
  betaald: "Betaald",
};

export interface Factuur extends FactuurData {
  id: string;
  bestandsnaam: string | null;
  /** Pad van het originele bestand in Storage; null voor facturen zonder bestand. */
  bestand_pad: string | null;
  status: FactuurStatus;
  ai_model: string | null;
  aangemaaktOp: string;
}

export type VeldFouten = Record<string, string>;

export function legeFactuurData(): FactuurData {
  return {
    leverancier: null,
    factuurnummer: null,
    factuurdatum: null,
    vervaldatum: null,
    bedrag_excl: null,
    btw_regels: [],
    totaal_incl: null,
    valuta: "EUR",
    iban: null,
    btw_nummer: null,
    kvk_nummer: null,
  };
}
