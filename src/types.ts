export interface BtwRegel {
  tarief: number | null;
  grondslag: number | null;
  btw_bedrag: number | null;
}

export interface FactuurData {
  leverancier: string | null;
  factuurnummer: string | null;
  factuurdatum: string | null;
  bedrag_excl: number | null;
  btw_regels: BtwRegel[];
  totaal_incl: number | null;
  valuta: string | null;
}

export interface Factuur extends FactuurData {
  id: string;
  bestandsnaam: string;
  aangemaaktOp: string;
}

export type VeldFouten = Record<string, string>;

export function legeFactuurData(): FactuurData {
  return {
    leverancier: null,
    factuurnummer: null,
    factuurdatum: null,
    bedrag_excl: null,
    btw_regels: [],
    totaal_incl: null,
    valuta: "EUR",
  };
}
