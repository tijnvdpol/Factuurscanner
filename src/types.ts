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

export const STATUSSEN = ["gescand", "gecontroleerd", "goedgekeurd", "betaald", "afgekeurd"] as const;
export type FactuurStatus = (typeof STATUSSEN)[number];

export const STATUS_LABELS: Record<FactuurStatus, string> = {
  gescand: "Gescand",
  gecontroleerd: "Gecontroleerd",
  goedgekeurd: "Goedgekeurd",
  betaald: "Betaald",
  afgekeurd: "Afgekeurd",
};

export const SIGNAAL_TYPES = [
  "mogelijk_duplicaat",
  "iban_afwijkend",
  "nieuwe_leverancier",
  "rond_bedrag",
  "net_onder_limiet",
  "validatiefout",
] as const;
export type SignaalType = (typeof SIGNAAL_TYPES)[number];
export type SignaalErnst = "info" | "waarschuwing" | "kritiek";

export interface Signaal {
  id: string;
  factuur_id: string;
  type: SignaalType;
  ernst: SignaalErnst;
  bericht: string;
  details: Record<string, unknown>;
  opgelost: boolean;
  opgelost_door: string | null;
  opgelost_op: string | null;
  toelichting: string | null;
  created_at: string;
}

export interface Grootboekrekening {
  id: string;
  code: string;
  omschrijving: string;
  actief: boolean;
}

export type CoderingBron = "handmatig" | "historie" | "ai";

/** Grootboekrekening van een factuur, met waar die vandaan komt. Zekerheid (0–1) alleen bij een voorstel. */
export interface Codering {
  grootboekrekening_id: string | null;
  bron: CoderingBron | null;
  zekerheid: number | null;
}

export const GEEN_CODERING: Codering = { grootboekrekening_id: null, bron: null, zekerheid: null };

export interface Factuur extends FactuurData {
  id: string;
  codering: Codering;
  /** Het bekende IBAN van de gekoppelde leverancier (kan afwijken van het IBAN op de factuur). */
  leverancier_iban: string | null;
  signalen: Signaal[];
  bestandsnaam: string | null;
  /** Pad van het originele bestand in Storage; null voor facturen zonder bestand. */
  bestand_pad: string | null;
  status: FactuurStatus;
  ai_model: string | null;
  aangemaaktOp: string;
  workflow: Workflow;
}

/** Wie deed wat in de statusworkflow (user-id's en tijdstippen). */
export interface Workflow {
  ingevoerd_door: string | null;
  gecontroleerd_door: string | null;
  gecontroleerd_op: string | null;
  goedgekeurd_door: string | null;
  goedgekeurd_op: string | null;
  betaald_op: string | null;
  afkeur_reden: string | null;
}

export const LEGE_WORKFLOW: Workflow = {
  ingevoerd_door: null,
  gecontroleerd_door: null,
  gecontroleerd_op: null,
  goedgekeurd_door: null,
  goedgekeurd_op: null,
  betaald_op: null,
  afkeur_reden: null,
};

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

/** Alleen de bewerkbare factuurvelden (zonder id, status, signalen e.d.). */
export function alleenFactuurData(f: FactuurData): FactuurData {
  return {
    leverancier: f.leverancier,
    factuurnummer: f.factuurnummer,
    factuurdatum: f.factuurdatum,
    vervaldatum: f.vervaldatum,
    bedrag_excl: f.bedrag_excl,
    btw_regels: f.btw_regels,
    totaal_incl: f.totaal_incl,
    valuta: f.valuta,
    iban: f.iban,
    btw_nummer: f.btw_nummer,
    kvk_nummer: f.kvk_nummer,
  };
}

export const ROLLEN = ["invoerder", "goedkeurder", "controller", "beheerder"] as const;
export type Rol = (typeof ROLLEN)[number];

export const ROL_LABELS: Record<Rol, string> = {
  invoerder: "Invoerder",
  goedkeurder: "Goedkeurder",
  controller: "Controller",
  beheerder: "Beheerder",
};

/** Lidmaatschap van de ingelogde gebruiker. */
export interface Lidmaatschap {
  organisatie_id: string;
  naam: string;
  rol: Rol;
  /** null = onbeperkt */
  goedkeuringslimiet: number | null;
}

/** Een (oud-)lid van de organisatie, voor namen in de historie en het ledenbeheer. */
export interface OrgGebruiker {
  user_id: string;
  email: string;
  rol: Rol | null;
  goedkeuringslimiet: number | null;
  is_lid: boolean;
}
