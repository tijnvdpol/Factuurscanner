// Mailbox-import: Mailgun-webhook lezen en controleren, bijlagen beoordelen, mail registreren en per bijlage
// een factuur maken. Geen imports buiten deze map (testbaar met Vitest); database, Storage en scan worden
// meegegeven.
//
// Mailgun (inbound route met forward()): POST multipart/form-data met o.a. recipient, sender, from, subject,
// body-plain, stripped-text, message-headers (JSON: [[naam, waarde], …]), attachment-count, attachment-1..n,
// content-id-map, timestamp, token en signature. Handtekening = hex(HMAC-SHA256(signing key, timestamp + token)).
// Antwoord 200 = verwerkt, 406 = geweigerd (geen retry), anders probeert Mailgun het tot 8 uur opnieuw.

import type { FactuurData } from "../gemini.ts";
import { DefinitieveFout, type TaakHandler } from "./taken.ts";

export const MAX_BIJLAGE_BYTES = 15 * 1024 * 1024;
/** Kleinere afbeeldingen zijn vrijwel altijd logo's of handtekeningplaatjes. */
export const MIN_AFBEELDING_BYTES = 20 * 1024;
/** Hoe oud een handtekening mag zijn. Ruim, omdat Mailgun tot 8 uur opnieuw probeert. */
export const MAX_LEEFTIJD_SEC = 12 * 60 * 60;

const BRUIKBARE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

export interface Bijlage {
  naam: string;
  mimeType: string;
  inhoud: Uint8Array;
  /** true = inline afbeelding in de mailtekst (content-id), geen losse bijlage */
  inline?: boolean;
  /** Alleen bij een gesimuleerde mail: de factuurgegevens in het voorbeeld-PDF (voor de mock-scan). */
  testdata?: FactuurData;
}

export interface Mail {
  aan: string;
  van: string;
  vanNaam: string | null;
  envelopAfzender: string | null;
  onderwerp: string | null;
  tekst: string | null;
  messageId: string;
  spf: string | null;
  dkim: string | null;
  spam: boolean;
  bron: "mailgun" | "mock";
  bijlagen: Bijlage[];
}

// ---------------------------------------------------------------------------
// Handtekening
// ---------------------------------------------------------------------------

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function mailgunHandtekening(sleutel: string, timestamp: string, token: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(sleutel), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + token)));
}

function gelijk(a: string, b: string): boolean {
  let verschil = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) verschil |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return verschil === 0;
}

/** Geldig = juiste HMAC en niet ouder (of nieuwer) dan MAX_LEEFTIJD_SEC. */
export async function controleerHandtekening(
  sleutel: string,
  velden: { timestamp?: string | null; token?: string | null; signature?: string | null },
  nu: Date = new Date(),
): Promise<{ geldig: boolean; reden?: string }> {
  const { timestamp, token, signature } = velden;
  if (!timestamp || !token || !signature) return { geldig: false, reden: "handtekening ontbreekt" };
  if (!/^\d+$/.test(timestamp)) return { geldig: false, reden: "ongeldige timestamp" };
  if (Math.abs(nu.getTime() / 1000 - Number(timestamp)) > MAX_LEEFTIJD_SEC) return { geldig: false, reden: "handtekening verlopen" };
  const verwacht = await mailgunHandtekening(sleutel, timestamp, token);
  return gelijk(verwacht, signature.toLowerCase()) ? { geldig: true } : { geldig: false, reden: "handtekening klopt niet" };
}

// ---------------------------------------------------------------------------
// Webhook lezen
// ---------------------------------------------------------------------------

/** "Jan Jansen <jan@voorbeeld.nl>" → { adres: "jan@voorbeeld.nl", naam: "Jan Jansen" } */
export function leesAdres(waarde: string | null | undefined): { adres: string; naam: string | null } | null {
  if (!waarde) return null;
  const hoek = waarde.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  const adres = (hoek?.[1] ?? waarde.match(/[^\s<>"',;]+@[^\s<>"',;]+/)?.[0] ?? "").toLowerCase();
  if (!adres.includes("@")) return null;
  const naam = hoek ? waarde.slice(0, waarde.indexOf("<")).replace(/^[\s"']+|[\s"']+$/g, "") : "";
  return { adres, naam: naam || null };
}

/** Waarde van een header uit message-headers (hoofdletterongevoelig; de laatste telt). */
export function header(headers: [string, string][], naam: string): string | null {
  const gevonden = headers.filter(([n]) => n.toLowerCase() === naam.toLowerCase());
  return gevonden.length ? gevonden[gevonden.length - 1][1] : null;
}

async function sha256(tekst: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tekst)));
}

/** Zet het formulier van Mailgun om naar een Mail (bijlagen als File in `velden`). */
export async function leesMailgunFormulier(velden: FormData): Promise<Mail> {
  const tekst = (naam: string) => {
    const w = velden.get(naam);
    return typeof w === "string" ? w : null;
  };
  let headers: [string, string][] = [];
  try {
    const ruw = JSON.parse(tekst("message-headers") ?? "[]");
    if (Array.isArray(ruw)) headers = ruw.filter((h) => Array.isArray(h) && h.length >= 2).map((h) => [String(h[0]), String(h[1])]);
  } catch {
    // geen headers: SPF/DKIM onbekend → onbekende afzender
  }
  let inlineNamen = new Set<string>();
  try {
    const map = JSON.parse(tekst("content-id-map") ?? "{}") as Record<string, string>;
    inlineNamen = new Set(Object.values(map));
  } catch {
    // geen inline afbeeldingen
  }

  const van = leesAdres(tekst("from") ?? header(headers, "From")) ?? leesAdres(tekst("sender"));
  if (!van) throw new Error("Afzender ontbreekt.");
  const aan = leesAdres(tekst("recipient"))?.adres;
  if (!aan) throw new Error("Ontvanger ontbreekt.");
  const onderwerp = tekst("subject") ?? header(headers, "Subject");
  const messageId = (tekst("Message-Id") ?? header(headers, "Message-Id"))?.trim()
    || `geen-message-id-${await sha256([van.adres, aan, onderwerp, header(headers, "Date"), tekst("timestamp")].join("|"))}`;

  const aantal = Number(tekst("attachment-count") ?? "0");
  const bijlagen: Bijlage[] = [];
  for (let i = 1; i <= Math.min(aantal, 50); i++) {
    const veld = `attachment-${i}`;
    const bestand = velden.get(veld);
    if (!bestand || typeof bestand === "string") continue;
    bijlagen.push({
      naam: bestand.name || `bijlage-${i}`,
      mimeType: bestand.type || "application/octet-stream",
      inhoud: new Uint8Array(await bestand.arrayBuffer()),
      inline: inlineNamen.has(veld),
    });
  }

  return {
    aan,
    van: van.adres,
    vanNaam: van.naam,
    envelopAfzender: leesAdres(tekst("sender"))?.adres ?? null,
    onderwerp,
    tekst: tekst("stripped-text") ?? tekst("body-plain"),
    messageId,
    spf: header(headers, "X-Mailgun-Spf"),
    dkim: header(headers, "X-Mailgun-Dkim-Check-Result"),
    spam: (header(headers, "X-Mailgun-Sflag") ?? "").toLowerCase() === "yes",
    bron: "mailgun",
    bijlagen,
  };
}

// ---------------------------------------------------------------------------
// Bijlagen
// ---------------------------------------------------------------------------

/** Mag deze bijlage een factuur worden? (pdf of afbeelding, niet te groot, geen logo of inline plaatje) */
export function beoordeelBijlage(b: Pick<Bijlage, "naam" | "mimeType" | "inline"> & { grootte: number }): {
  bruikbaar: boolean;
  mimeType: string;
  reden?: string;
} {
  const extensie = b.naam.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = b.mimeType && b.mimeType !== "application/octet-stream" ? b.mimeType.toLowerCase() : (BRUIKBARE_TYPES[extensie] ?? b.mimeType);
  const isPdf = mimeType === "application/pdf";
  const isAfbeelding = /^image\/(jpeg|png|webp|heic|heif)$/.test(mimeType);
  if (!isPdf && !isAfbeelding) return { bruikbaar: false, mimeType, reden: "Geen pdf of afbeelding." };
  if (b.grootte > MAX_BIJLAGE_BYTES) return { bruikbaar: false, mimeType, reden: "Groter dan 15 MB." };
  if (isAfbeelding && b.inline) return { bruikbaar: false, mimeType, reden: "Afbeelding in de mailtekst (bijv. een logo)." };
  if (isAfbeelding && b.grootte < MIN_AFBEELDING_BYTES) return { bruikbaar: false, mimeType, reden: "Te kleine afbeelding (waarschijnlijk een logo)." };
  return { bruikbaar: true, mimeType };
}

/** Storage-paden staan geen accenten en de meeste speciale tekens toe (zelfde regel als de app). */
export function veiligeBestandsnaam(naam: string): string {
  const zonderAccenten = naam.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const veilig = zonderAccenten.replace(/[^\w.()-]+/g, "_").replace(/^_+|_+$/g, "");
  return !veilig || veilig.startsWith(".") ? `factuur${veilig}` : veilig;
}

// ---------------------------------------------------------------------------
// Mail verwerken (webhook en simulatie)
// ---------------------------------------------------------------------------

export interface InboxDeps {
  registreer(bericht: Record<string, unknown>): Promise<{ status: "onbekend_adres" | "duplicaat" | "nieuw"; bericht_id?: string; organisatie_id?: string; bekend?: boolean }>;
  upload(pad: string, inhoud: Uint8Array, mimeType: string): Promise<void>;
  rondAf(berichtId: string, bijlagen: Record<string, unknown>[]): Promise<number>;
}

export type InboxUitkomst =
  | { status: "onbekend_adres" }
  | { status: "duplicaat"; berichtId: string }
  | { status: "nieuw"; berichtId: string; bekend: boolean; bruikbaar: number; genegeerd: number };

export async function verwerkMail(mail: Mail, deps: InboxDeps): Promise<InboxUitkomst> {
  const r = await deps.registreer({
    aan: mail.aan,
    van: mail.van,
    van_naam: mail.vanNaam,
    envelop_afzender: mail.envelopAfzender,
    onderwerp: mail.onderwerp,
    tekst: mail.tekst,
    message_id: mail.messageId,
    spf: mail.spf,
    dkim: mail.dkim,
    spam: mail.spam,
    bron: mail.bron,
  });
  if (r.status === "onbekend_adres") return { status: "onbekend_adres" };
  if (r.status === "duplicaat") return { status: "duplicaat", berichtId: r.bericht_id! };

  const berichtId = r.bericht_id!;
  const organisatieId = r.organisatie_id!;
  const bijlagen: Record<string, unknown>[] = [];
  let volgnummer = 0;
  for (const b of mail.bijlagen) {
    volgnummer++;
    const oordeel = beoordeelBijlage({ naam: b.naam, mimeType: b.mimeType, inline: b.inline, grootte: b.inhoud.byteLength });
    let pad: string | null = null;
    if (oordeel.bruikbaar) {
      pad = `${organisatieId}/inbox/${berichtId}/${volgnummer}-${veiligeBestandsnaam(b.naam)}`;
      await deps.upload(pad, b.inhoud, oordeel.mimeType);
    }
    bijlagen.push({
      volgnummer,
      bestandsnaam: b.naam,
      mime_type: oordeel.mimeType,
      grootte: b.inhoud.byteLength,
      pad,
      reden: oordeel.reden ?? null,
      testdata: b.testdata ?? null,
    });
  }
  const bruikbaar = await deps.rondAf(berichtId, bijlagen);
  return { status: "nieuw", berichtId, bekend: !!r.bekend, bruikbaar, genegeerd: bijlagen.length - bruikbaar };
}

// ---------------------------------------------------------------------------
// Taak "mailbox": één bijlage scannen en er een factuur van maken
// ---------------------------------------------------------------------------

export interface InboxBijlageRij {
  id: string;
  organisatie_id: string;
  pad: string | null;
  bestandsnaam: string;
  mime_type: string | null;
  factuur_id: string | null;
  testdata: FactuurData | null;
  bericht_status: string;
}

export type ScanResultaat =
  | { ok: true; factuur: FactuurData; model: string; codering: { grootboekrekening_id: string; zekerheid: number } | null }
  | { ok: false; status: number; melding: string };

export interface MailboxTaakDeps {
  bijlage(id: string): Promise<InboxBijlageRij | null>;
  download(pad: string): Promise<Uint8Array>;
  /** Kopieert in Storage; een bestaand doel is geen fout (eerdere poging). */
  kopieer(van: string, naar: string): Promise<void>;
  verwijder(pad: string): Promise<void>;
  scan(bijlage: InboxBijlageRij, inhoud: Uint8Array): Promise<ScanResultaat>;
  rpc(functie: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Scanfouten die een nieuwe poging niet oplost (onleesbaar bestand, ongeldige sleutel). */
function scanFoutIsDefinitief(status: number): boolean {
  return status === 400 || status === 413 || status === 415 || status === 422 || status === 500;
}

export function mailboxHandler(d: MailboxTaakDeps): TaakHandler {
  return async (taak) => {
    const bijlageId = typeof taak.payload.bijlage_id === "string" ? taak.payload.bijlage_id : taak.sleutel;
    const bijlage = await d.bijlage(bijlageId);
    if (!bijlage) throw new DefinitieveFout("De bijlage bestaat niet meer.");
    if (bijlage.factuur_id) return { omschrijving: "al verwerkt", factuur_id: bijlage.factuur_id };
    if (bijlage.bericht_status !== "geaccepteerd") throw new DefinitieveFout("De mail is niet (meer) goedgekeurd voor verwerking.");
    if (!bijlage.pad) throw new DefinitieveFout("De bijlage heeft geen bestand.");

    const inhoud = await d.download(bijlage.pad);
    const scan = await d.scan(bijlage, inhoud);
    if (!scan.ok) {
      const melding = `Scannen mislukt: ${scan.melding}`;
      if (scanFoutIsDefinitief(scan.status)) throw new DefinitieveFout(melding);
      throw new Error(melding);
    }

    // De factuur krijgt het id van de bijlage: zo is een nieuwe poging idempotent.
    const doelPad = `${bijlage.organisatie_id}/${bijlage.id}/${veiligeBestandsnaam(bijlage.bestandsnaam)}`;
    await d.kopieer(bijlage.pad, doelPad);
    const r = (await d.rpc("maak_factuur_uit_inbox", {
      p_bijlage_id: bijlage.id,
      p_factuur_id: bijlage.id,
      p_factuur: scan.factuur,
      p_pad: doelPad,
      p_ai_model: scan.model,
      p_codering: scan.codering,
    })) as { status: "verwerkt" | "duplicaat"; factuur_id: string };

    if (r.status === "duplicaat") {
      await d.verwijder(doelPad).catch(() => undefined);
      return { omschrijving: `duplicaat van een bestaande factuur (${scan.factuur.factuurnummer ?? "zonder nummer"})`, factuur_id: r.factuur_id };
    }
    return {
      omschrijving: `factuur ${scan.factuur.factuurnummer ?? "zonder nummer"} van ${scan.factuur.leverancier ?? "onbekende leverancier"} aangemaakt`,
      factuur_id: r.factuur_id,
      model: scan.model,
    };
  };
}

// ---------------------------------------------------------------------------
// Mock-scan (geen Gemini nodig)
// ---------------------------------------------------------------------------

/** Gegevens uit het voorbeeld-PDF (gesimuleerde mail), of herkenbare testgegevens voor een andere bijlage. */
export function mockScan(bijlage: Pick<InboxBijlageRij, "id" | "bestandsnaam" | "testdata">, vandaag: string): ScanResultaat {
  if (bijlage.testdata) return { ok: true, factuur: bijlage.testdata, model: "mock", codering: null };
  return {
    ok: true,
    model: "mock",
    codering: null,
    factuur: {
      leverancier: "Onbekende leverancier (mock-scan)",
      factuurnummer: `MOCK-${bijlage.id.slice(0, 8).toUpperCase()}`,
      factuurdatum: vandaag,
      vervaldatum: null,
      bedrag_excl: 100,
      btw_regels: [{ tarief: 21, grondslag: 100, btw_bedrag: 21 }],
      totaal_incl: 121,
      valuta: "EUR",
      iban: null,
      btw_nummer: null,
      kvk_nummer: null,
    },
  };
}
