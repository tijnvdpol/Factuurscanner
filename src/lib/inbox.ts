// Inbox (mailbox-import): typen en weergave als pure functies.

export type BerichtStatus = "te_beoordelen" | "geaccepteerd" | "geweigerd";
export type BijlageStatus = "wacht" | "wachtrij" | "verwerkt" | "duplicaat" | "mislukt" | "genegeerd";

export interface InboxBijlage {
  id: string;
  volgnummer: number;
  bestandsnaam: string;
  mime_type: string | null;
  grootte: number | null;
  pad: string | null;
  status: BijlageStatus;
  reden: string | null;
  factuur_id: string | null;
}

export interface InboxBericht {
  id: string;
  van: string;
  van_naam: string | null;
  aan: string;
  onderwerp: string | null;
  tekst: string | null;
  spf: string | null;
  dkim: string | null;
  spam: boolean;
  bekende_afzender: boolean;
  status: BerichtStatus;
  bron: "mailgun" | "mock";
  afgerond: boolean;
  ontvangen_op: string;
  beoordeeld_door: string | null;
  beoordeeld_op: string | null;
  toelichting: string | null;
  bijlagen: InboxBijlage[];
}

export interface InboxAfzender {
  id: string;
  patroon: string;
  omschrijving: string | null;
  created_at: string;
}

export const BERICHT_STATUS_LABELS: Record<BerichtStatus, string> = {
  te_beoordelen: "Te beoordelen",
  geaccepteerd: "Geaccepteerd",
  geweigerd: "Geweigerd",
};

export const BIJLAGE_STATUS_LABELS: Record<BijlageStatus, string> = {
  wacht: "Wacht op beoordeling",
  wachtrij: "Wordt verwerkt",
  verwerkt: "Factuur aangemaakt",
  duplicaat: "Duplicaat",
  mislukt: "Mislukt",
  genegeerd: "Genegeerd",
};

/** Is de afzender echt? SPF of DKIM geslaagd volgens Mailgun. */
export function echtheid(bericht: Pick<InboxBericht, "spf" | "dkim" | "spam">): { tekst: string; ok: boolean } {
  if (bericht.spam) return { tekst: "Gemarkeerd als spam", ok: false };
  const spf = (bericht.spf ?? "").toLowerCase() === "pass";
  const dkim = (bericht.dkim ?? "").toLowerCase() === "pass";
  if (spf || dkim) return { tekst: [spf && "SPF", dkim && "DKIM"].filter(Boolean).join(" + ") + " geslaagd", ok: true };
  return {
    tekst: `Afzender niet bevestigd (SPF: ${bericht.spf ?? "onbekend"}, DKIM: ${bericht.dkim ?? "onbekend"})`,
    ok: false,
  };
}

/** Waarom staat dit bericht ter beoordeling? */
export function redenBeoordeling(bericht: Pick<InboxBericht, "spf" | "dkim" | "spam" | "bekende_afzender" | "status">): string | null {
  if (bericht.status !== "te_beoordelen") return null;
  if (bericht.spam) return "De mail is als spam gemarkeerd.";
  if (!echtheid(bericht).ok) return "De afzender kon niet worden bevestigd (mogelijk vervalst).";
  return "De afzender staat niet in de lijst met vertrouwde afzenders.";
}

export function grootte(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toLocaleString("nl-NL", { maximumFractionDigits: 1 })} MB`;
}
