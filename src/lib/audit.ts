// Leesbare weergave van de audit log: Nederlandse veld- en actienamen, "van → naar" en CSV-export.

import { ROL_LABELS, STATUS_LABELS, type FactuurStatus, type Rol } from "../types";
import { SIGNAAL_LABELS } from "./signalen";
import { formatBedrag } from "./getallen";

export type AuditActie = "insert" | "update" | "delete" | "statuswijziging";

export interface AuditRegel {
  id: number;
  organisatie_id: string;
  tabel: string;
  record_id: string | null;
  actie: AuditActie;
  gewijzigde_velden: string[] | null;
  oud: Record<string, unknown> | null;
  nieuw: Record<string, unknown> | null;
  user_id: string | null;
  toelichting: string | null;
  created_at: string;
}

export const ACTIE_LABELS: Record<AuditActie, string> = {
  insert: "Aangemaakt",
  update: "Gewijzigd",
  delete: "Verwijderd",
  statuswijziging: "Statuswijziging",
};

export const TABEL_LABELS: Record<string, string> = {
  facturen: "Factuur",
  btw_regels: "BTW-regel",
  leveranciers: "Leverancier",
  factuur_signalen: "Signaal",
  organisatie_leden: "Lid",
};

export const VELD_LABELS: Record<string, string> = {
  leverancier_id: "Leverancier (koppeling)",
  leverancier_naam: "Leverancier",
  naam: "Naam",
  factuurnummer: "Factuurnummer",
  factuurdatum: "Factuurdatum",
  vervaldatum: "Vervaldatum",
  valuta: "Valuta",
  bedrag_excl: "Bedrag excl. BTW",
  totaal_incl: "Totaal incl. BTW",
  status: "Status",
  bestand_pad: "Bestand",
  bestandsnaam: "Bestandsnaam",
  ai_model: "AI-model",
  iban: "IBAN",
  btw_nummer: "BTW-nummer",
  kvk_nummer: "KvK-nummer",
  grootboekrekening_id: "Grootboekrekening",
  codering_bron: "Bron codering",
  codering_zekerheid: "Zekerheid codering",
  gecontroleerd_door: "Gecontroleerd door",
  gecontroleerd_op: "Gecontroleerd op",
  goedgekeurd_door: "Goedgekeurd door",
  goedgekeurd_op: "Goedgekeurd op",
  betaald_op: "Betaald op",
  afkeur_reden: "Reden afkeuring",
  user_id: "Ingevoerd door",
  tarief: "Tarief",
  grondslag: "Grondslag",
  btw_bedrag: "BTW-bedrag",
  volgorde: "Volgorde",
  type: "Type",
  ernst: "Ernst",
  bericht: "Bericht",
  opgelost: "Opgelost",
  opgelost_door: "Opgelost door",
  opgelost_op: "Opgelost op",
  toelichting: "Toelichting",
  rol: "Rol",
  goedkeuringslimiet: "Goedkeuringslimiet",
};

const GEBRUIKER_VELDEN = new Set(["gecontroleerd_door", "goedgekeurd_door", "opgelost_door", "user_id"]);
const BEDRAG_VELDEN = new Set(["bedrag_excl", "totaal_incl", "grondslag", "btw_bedrag", "goedkeuringslimiet"]);
const TIJD_VELDEN = new Set(["gecontroleerd_op", "goedgekeurd_op", "betaald_op", "opgelost_op", "created_at"]);
// Technische velden die in de tijdlijn niets toevoegen
const VERBORGEN_VELDEN = new Set(["id", "organisatie_id", "factuur_id", "created_at", "updated_at", "sleutel", "details", "leverancier_id"]);

export interface WeergaveContext {
  naamVan: (userId: string) => string | undefined;
  rekeningNaam: (id: string) => string | undefined;
}

export function veldLabel(veld: string): string {
  return VELD_LABELS[veld] ?? veld;
}

export function datumTijd(iso: string): string {
  return new Date(iso).toLocaleString("nl-NL", { dateStyle: "medium", timeStyle: "short" });
}

/** Waarde leesbaar maken; leeg wordt "—". */
export function formatWaarde(veld: string, waarde: unknown, ctx: WeergaveContext): string {
  if (waarde === null || waarde === undefined || waarde === "") return "—";
  if (GEBRUIKER_VELDEN.has(veld) && typeof waarde === "string") return ctx.naamVan(waarde) ?? "onbekende gebruiker";
  if (veld === "grootboekrekening_id" && typeof waarde === "string") return ctx.rekeningNaam(waarde) ?? "onbekende rekening";
  if (veld === "status" && typeof waarde === "string") return STATUS_LABELS[waarde as FactuurStatus] ?? waarde;
  if (veld === "rol" && typeof waarde === "string") return ROL_LABELS[waarde as Rol] ?? waarde;
  if (veld === "type" && typeof waarde === "string") return SIGNAAL_LABELS[waarde as keyof typeof SIGNAAL_LABELS] ?? waarde;
  if (veld === "tarief" && typeof waarde === "number") return `${formatBedrag(waarde, waarde % 1 === 0 ? 0 : 2)}%`;
  if (veld === "codering_zekerheid" && typeof waarde === "number") return `${Math.round(waarde * 100)}%`;
  if (BEDRAG_VELDEN.has(veld) && typeof waarde === "number") return `€ ${formatBedrag(waarde)}`;
  if (TIJD_VELDEN.has(veld) && typeof waarde === "string") return datumTijd(waarde);
  if (typeof waarde === "boolean") return waarde ? "ja" : "nee";
  if (typeof waarde === "object") return JSON.stringify(waarde);
  return String(waarde);
}

export interface Wijziging {
  veld: string;
  label: string;
  van: string;
  naar: string;
}

/** De wijzigingen van één logregel als "veld: van → naar" (bij aanmaken/verwijderen alleen de gevulde velden). */
export function wijzigingen(regel: AuditRegel, ctx: WeergaveContext): Wijziging[] {
  const rij = regel.nieuw ?? regel.oud ?? {};
  const velden = regel.gewijzigde_velden ?? Object.keys(rij).filter((v) => rij[v] !== null && rij[v] !== "");
  return velden
    .filter((v) => !VERBORGEN_VELDEN.has(v))
    .map((veld) => ({
      veld,
      label: veldLabel(veld),
      van: regel.actie === "insert" ? "" : formatWaarde(veld, regel.oud?.[veld], ctx),
      naar: regel.actie === "delete" ? "" : formatWaarde(veld, regel.nieuw?.[veld], ctx),
    }));
}

/** Korte omschrijving, bijv. "Status: Gescand → Gecontroleerd" of "Signaal opgelost: IBAN afwijkend". */
export function omschrijving(regel: AuditRegel, ctx: WeergaveContext): string {
  const tabel = TABEL_LABELS[regel.tabel] ?? regel.tabel;
  if (regel.actie === "statuswijziging" || (regel.tabel === "facturen" && regel.gewijzigde_velden?.includes("status"))) {
    const van = formatWaarde("status", regel.oud?.status, ctx);
    const naar = formatWaarde("status", regel.nieuw?.status, ctx);
    return `Status: ${van} → ${naar}`;
  }
  const rij = regel.nieuw ?? regel.oud ?? {};
  if (regel.tabel === "factuur_signalen") {
    const type = typeof rij.type === "string" ? formatWaarde("type", rij.type, ctx) : "";
    if (regel.actie === "update" && regel.nieuw?.opgelost === true) return `Signaal opgelost${type ? `: ${type}` : ""}`;
    if (regel.actie === "insert") return `Signaal: ${type}`;
    if (regel.actie === "delete") return `Signaal vervallen: ${type}`;
  }
  if (regel.tabel === "organisatie_leden" && regel.record_id) {
    const wie = ctx.naamVan(regel.record_id) ?? "gebruiker";
    return `${tabel} ${wie} ${ACTIE_LABELS[regel.actie].toLowerCase()}`;
  }
  if (regel.tabel === "leveranciers" && typeof rij.naam === "string") {
    return `${tabel} ${rij.naam} ${ACTIE_LABELS[regel.actie].toLowerCase()}`;
  }
  return `${tabel} ${ACTIE_LABELS[regel.actie].toLowerCase()}`;
}

function csvVeld(waarde: string): string {
  return /[;"\n\r]/.test(waarde) ? `"${waarde.replace(/"/g, '""')}"` : waarde;
}

/** CSV (puntkomma, zoals de factuurexport) met één regel per logregel. */
export function auditCsv(regels: AuditRegel[], ctx: WeergaveContext): string {
  const kop = ["Tijdstip", "Gebruiker", "Onderdeel", "Actie", "Omschrijving", "Wijzigingen", "Toelichting", "Record-id"];
  const rijen = regels.map((r) =>
    [
      new Date(r.created_at).toISOString(),
      r.user_id ? (ctx.naamVan(r.user_id) ?? r.user_id) : "systeem",
      TABEL_LABELS[r.tabel] ?? r.tabel,
      ACTIE_LABELS[r.actie],
      omschrijving(r, ctx),
      wijzigingen(r, ctx)
        .map((w) => (r.actie === "update" || r.actie === "statuswijziging" ? `${w.label}: ${w.van} → ${w.naar}` : `${w.label}: ${w.naar || w.van}`))
        .join(" | "),
      r.toelichting ?? "",
      r.record_id ?? "",
    ]
      .map(csvVeld)
      .join(";"),
  );
  return [kop.join(";"), ...rijen].join("\r\n");
}
