import type { PostgrestError } from "@supabase/supabase-js";
import {
  alleenFactuurData,
  GEEN_CODERING,
  type Codering,
  type CoderingBron,
  type Factuur,
  type FactuurData,
  type FactuurStatus,
  type Signaal,
} from "../types";
import { supabase } from "./supabase";
import { verwijderBestand } from "./opslag";

export class DbError extends Error {
  code: string | undefined;
  constructor(melding: string, code?: string) {
    super(melding);
    this.code = code;
  }
}

// Expliciete foreign-key-hints (!naam): sinds de organisaties zijn er meerdere routes tussen tabellen.
const SELECT = `
  id, leverancier_naam, factuurnummer, factuurdatum, vervaldatum, valuta, bedrag_excl, totaal_incl,
  status, bestand_pad, bestandsnaam, ai_model, created_at, iban, btw_nummer, kvk_nummer,
  grootboekrekening_id, codering_bron, codering_zekerheid,
  user_id, gecontroleerd_door, gecontroleerd_op, goedgekeurd_door, goedgekeurd_op, betaald_op, afkeur_reden,
  leverancier:leveranciers!facturen_leverancier_fk ( iban ),
  btw_regels!btw_regels_factuur_id_fkey ( volgorde, tarief, grondslag, btw_bedrag ),
  signalen:factuur_signalen!factuur_signalen_factuur_id_fkey (
    id, factuur_id, type, ernst, bericht, details, opgelost, opgelost_door, opgelost_op, toelichting, created_at
  )
`;

interface FactuurRij {
  id: string;
  leverancier_naam: string | null;
  factuurnummer: string | null;
  factuurdatum: string | null;
  vervaldatum: string | null;
  valuta: string | null;
  bedrag_excl: number | string | null;
  totaal_incl: number | string | null;
  status: FactuurStatus;
  bestand_pad: string | null;
  bestandsnaam: string | null;
  ai_model: string | null;
  created_at: string;
  iban: string | null;
  btw_nummer: string | null;
  kvk_nummer: string | null;
  grootboekrekening_id: string | null;
  codering_bron: CoderingBron | null;
  codering_zekerheid: number | string | null;
  user_id: string | null;
  gecontroleerd_door: string | null;
  gecontroleerd_op: string | null;
  goedgekeurd_door: string | null;
  goedgekeurd_op: string | null;
  betaald_op: string | null;
  afkeur_reden: string | null;
  leverancier: { iban: string | null } | null;
  btw_regels: {
    volgorde: number;
    tarief: number | string | null;
    grondslag: number | string | null;
    btw_bedrag: number | string | null;
  }[];
  signalen: Signaal[];
}

function getal(waarde: number | string | null): number | null {
  return waarde === null ? null : Number(waarde);
}

function naarFactuur(rij: FactuurRij): Factuur {
  return {
    id: rij.id,
    leverancier: rij.leverancier_naam,
    factuurnummer: rij.factuurnummer,
    factuurdatum: rij.factuurdatum,
    vervaldatum: rij.vervaldatum,
    bedrag_excl: getal(rij.bedrag_excl),
    btw_regels: [...rij.btw_regels]
      .sort((a, b) => a.volgorde - b.volgorde)
      .map((r) => ({ tarief: getal(r.tarief), grondslag: getal(r.grondslag), btw_bedrag: getal(r.btw_bedrag) })),
    totaal_incl: getal(rij.totaal_incl),
    valuta: rij.valuta,
    iban: rij.iban,
    btw_nummer: rij.btw_nummer,
    kvk_nummer: rij.kvk_nummer,
    leverancier_iban: rij.leverancier?.iban ?? null,
    codering: {
      grootboekrekening_id: rij.grootboekrekening_id,
      bron: rij.codering_bron,
      zekerheid: getal(rij.codering_zekerheid),
    },
    signalen: [...rij.signalen].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    bestandsnaam: rij.bestandsnaam,
    bestand_pad: rij.bestand_pad,
    status: rij.status,
    ai_model: rij.ai_model,
    aangemaaktOp: rij.created_at,
    workflow: {
      ingevoerd_door: rij.user_id,
      gecontroleerd_door: rij.gecontroleerd_door,
      gecontroleerd_op: rij.gecontroleerd_op,
      goedgekeurd_door: rij.goedgekeurd_door,
      goedgekeurd_op: rij.goedgekeurd_op,
      betaald_op: rij.betaald_op,
      afkeur_reden: rij.afkeur_reden,
    },
  };
}

/** Standaardmeldingen van Postgres zelf; andere meldingen komen uit onze eigen (Nederlandse) functies. */
const POSTGRES_MELDING = /permission denied|row-level security|duplicate key|violates|constraint/i;

/** Vertaalt een Supabase/Postgres-fout naar een begrijpelijke Nederlandse melding. */
export function vertaalFout(error: PostgrestError, data?: FactuurData): DbError {
  // Eigen meldingen uit de databasefuncties (RAISE) direct doorgeven, bijv. "Alleen een beheerder ...".
  if ((error.code === "42501" || error.code === "23505") && !POSTGRES_MELDING.test(error.message)) {
    return new DbError(error.message, error.code);
  }
  switch (error.code) {
    case "23505": {
      const wie = [data?.leverancier, data?.factuurnummer && `factuurnummer ${data.factuurnummer}`]
        .filter(Boolean)
        .join(", ");
      return new DbError(
        `Deze factuur staat al in je overzicht${wie ? ` (${wie})` : ""}. Bewerk de bestaande factuur of controleer het factuurnummer.`,
        error.code,
      );
    }
    case "23514":
      return new DbError(
        error.message.includes("valuta")
          ? "Valuta moet een code van 3 letters zijn (bijv. EUR)."
          : "Een of meer velden bevatten een ongeldige waarde.",
        error.code,
      );
    case "22007":
    case "22008":
      return new DbError("Een van de datums is ongeldig. Gebruik het formaat JJJJ-MM-DD.", error.code);
    case "22003":
      return new DbError("Een bedrag of tarief is te groot.", error.code);
    case "22023":
    case "P0002":
      // Eigen meldingen uit de databasefuncties (bijv. "Een toelichting is verplicht ...")
      return new DbError(error.message, error.code);
    case "42501":
      return new DbError("Je hebt geen rechten voor deze actie.", error.code);
    case "PGRST301":
    case "PGRST303":
      return new DbError("Je sessie is verlopen. Log opnieuw in.", error.code);
    default:
      if (!error.code && /fetch/i.test(error.message)) {
        return new DbError("Kon geen verbinding maken met de database. Controleer je internetverbinding.");
      }
      return new DbError(`Er ging iets mis bij de database: ${error.message}`, error.code);
  }
}

export async function haalFacturenOp(organisatieId: string): Promise<Factuur[]> {
  const { data, error } = await supabase
    .from("facturen")
    .select(SELECT)
    .eq("organisatie_id", organisatieId)
    .order("created_at");
  if (error) throw vertaalFout(error);
  return (data as unknown as FactuurRij[]).map(naarFactuur);
}

interface OpslaanInvoer {
  id: string;
  organisatieId: string;
  data: FactuurData;
  bestandPad: string | null;
  bestandsnaam: string | null;
  aiModel: string | null;
  codering: Codering;
  /** true = ingevulde leveranciersgegevens (IBAN e.d.) overschrijven; false = alleen lege aanvullen. */
  leverancierBijwerken: boolean;
}

/** Slaat factuur + leverancier + btw-regels in één transactie op (RPC sla_factuur_op). */
export async function slaFactuurOp(invoer: OpslaanInvoer): Promise<string> {
  const { data, error } = await supabase.rpc("sla_factuur_op", {
    p_factuur: {
      ...invoer.data,
      id: invoer.id,
      organisatie_id: invoer.organisatieId,
      bestand_pad: invoer.bestandPad,
      bestandsnaam: invoer.bestandsnaam,
      ai_model: invoer.aiModel,
      grootboekrekening_id: invoer.codering.grootboekrekening_id,
      codering_bron: invoer.codering.bron,
      codering_zekerheid: invoer.codering.zekerheid,
    },
    p_leverancier_bijwerken: invoer.leverancierBijwerken,
  });
  if (error) throw vertaalFout(error, invoer.data);
  return data as string;
}

/** Verwijdert de factuur (btw-regels gaan mee via cascade) en daarna het originele bestand. */
export async function verwijderFactuur(factuur: Factuur): Promise<void> {
  const { data, error } = await supabase.from("facturen").delete().eq("id", factuur.id).select("id");
  if (error) throw vertaalFout(error);
  if (!data || data.length === 0) throw new DbError("Factuur niet gevonden. Ververs de pagina.");

  if (factuur.bestand_pad) {
    // De factuur is al weg; een achtergebleven bestand is niet erg genoeg om een fout te tonen.
    await verwijderBestand(factuur.bestand_pad).catch((err) => console.warn(err));
  }
}

export interface ImportResultaat {
  geimporteerd: number;
  duplicaten: number;
  mislukt: Factuur[];
}

/** Eenmalige import van facturen uit localStorage (van vóór de Supabase-koppeling). */
export async function importeerLokaleFacturen(
  facturen: Factuur[],
  userId: string,
  organisatieId: string,
): Promise<ImportResultaat> {
  const resultaat: ImportResultaat = { geimporteerd: 0, duplicaten: 0, mislukt: [] };

  for (const factuur of facturen) {
    // Een bestand uit de tussenfase (Storage, maar lijst nog lokaal) alleen meenemen als het van deze gebruiker is;
    // het id moet dan gelijk blijven omdat het in het bestandspad zit.
    const eigenBestand = factuur.bestand_pad?.startsWith(`${userId}/${factuur.id}/`) ?? false;
    const { bestandsnaam, ai_model } = factuur;
    const data = alleenFactuurData(factuur);

    try {
      await slaFactuurOp({
        id: eigenBestand ? factuur.id : crypto.randomUUID(),
        organisatieId,
        data,
        bestandPad: eigenBestand ? factuur.bestand_pad : null,
        bestandsnaam,
        aiModel: ai_model,
        codering: GEEN_CODERING,
        leverancierBijwerken: false,
      });
      resultaat.geimporteerd++;
    } catch (err) {
      if (err instanceof DbError && err.code === "23505") resultaat.duplicaten++;
      else resultaat.mislukt.push(factuur);
    }
  }
  return resultaat;
}

/** Lost een signaal op (toelichting verplicht); bij een afwijkend IBAN kan het nieuwe IBAN worden overgenomen. */
export async function losSignaalOp(signaalId: string, toelichting: string, ibanOvernemen = false): Promise<void> {
  const { error } = await supabase.rpc("los_signaal_op", {
    p_signaal_id: signaalId,
    p_toelichting: toelichting,
    p_iban_overnemen: ibanOvernemen,
  });
  if (error) throw vertaalFout(error);
}

/**
 * Wijzigt de status via de databasefunctie wijzig_status (die rol, functiescheiding, limiet en
 * blokkades controleert). Geeft een eventuele melding terug, bijv. over functiescheiding bij één lid.
 */
export async function wijzigStatus(factuurId: string, nieuweStatus: FactuurStatus, toelichting?: string): Promise<string | null> {
  const { data, error } = await supabase.rpc("wijzig_status", {
    p_factuur_id: factuurId,
    p_nieuwe_status: nieuweStatus,
    p_toelichting: toelichting ?? null,
  });
  if (error) throw vertaalFout(error);
  return (data as string | null) ?? null;
}
