// E-mailnotificaties in de frontend: labels, de mail-link (#mail-actie=…) en mock-mails tonen.

export type NotificatieSoort = "goedkeuren" | "afgekeurd" | "export_mislukt" | "bijna_vervallen" | "test";
export type NotificatieStatus = "wachtrij" | "verzonden" | "overgeslagen" | "mislukt";

export interface Notificatie {
  id: string;
  soort: NotificatieSoort;
  ontvanger_id: string | null;
  ontvanger_email: string | null;
  factuur_id: string | null;
  status: NotificatieStatus;
  modus: "live" | "mock" | null;
  onderwerp: string | null;
  reden: string | null;
  created_at: string;
  verzonden_op: string | null;
}

export interface NotificatieInhoud {
  notificatie_id: string;
  onderwerp: string;
  html: string;
  tekst: string;
}

export const SOORT_LABELS: Record<NotificatieSoort, string> = {
  goedkeuren: "Goedkeuringsverzoek",
  afgekeurd: "Afgekeurd",
  export_mislukt: "Export mislukt",
  bijna_vervallen: "Bijna vervallen",
  test: "Testmail",
};

export const STATUS_LABELS: Record<NotificatieStatus, string> = {
  wachtrij: "In wachtrij",
  verzonden: "Verzonden",
  overgeslagen: "Niet nodig",
  mislukt: "Mislukt",
};

/** Instellingen van de koppeling email (config in koppeling_instellingen). */
export interface EmailConfig {
  dagen_voor_vervaldatum: number;
  link_geldig_uren: number;
}

export const EMAIL_CONFIG_STANDAARD: EmailConfig = { dagen_voor_vervaldatum: 3, link_geldig_uren: 72 };

function geheelGetal(waarde: unknown, min: number, max: number, standaard: number): number {
  const n = typeof waarde === "number" ? waarde : typeof waarde === "string" ? Number(waarde) : NaN;
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : standaard;
}

/** Zelfde grenzen als in de database (1–30 dagen, 1–336 uur). */
export function leesEmailConfig(config: Record<string, unknown> | null | undefined): EmailConfig {
  return {
    dagen_voor_vervaldatum: geheelGetal(config?.dagen_voor_vervaldatum, 1, 30, EMAIL_CONFIG_STANDAARD.dagen_voor_vervaldatum),
    link_geldig_uren: geheelGetal(config?.link_geldig_uren, 1, 336, EMAIL_CONFIG_STANDAARD.link_geldig_uren),
  };
}

/** "#mail-actie=<token>&keuze=goedkeuren" → { token, keuze }; anders null. */
export function leesMailActieHash(hash: string): { token: string; keuze: "goedkeuren" | "afkeuren" | null } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("mail-actie");
  if (!token) return null;
  const keuze = params.get("keuze");
  return { token, keuze: keuze === "goedkeuren" || keuze === "afkeuren" ? keuze : null };
}

/** Mock-mails zonder APP_URL bevatten een placeholder; vervang die door het adres van deze app. */
export function vulAppUrl(html: string, origin: string): string {
  return html.split("{{APP_URL}}").join(origin.replace(/\/+$/, ""));
}

/** Mail-HTML voor een iframe: links openen in een nieuw tabblad (de app blijft staan). */
export function mailVoorWeergave(html: string, origin: string): string {
  const basis = `<base target="_blank">`;
  const gevuld = vulAppUrl(html, origin);
  return gevuld.includes("<head>") ? gevuld.replace("<head>", `<head>${basis}`) : basis + gevuld;
}
