// E-mailnotificaties: versturen (Resend of mock) en de email-taak in de worker. Geen imports buiten deze map
// (testbaar met Vitest); database, modus en provider worden meegegeven.
//
// Flow per taak (één notificatie):
//   1. notificatie_voor_verzending: ontvanger, facturen, en of de mail nog relevant is (anders overgeslagen,
//      bijv. "factuur is al goedgekeurd").
//   2. goedkeuren: maak_mail_actie (idempotent) → ondertekend token → links met de knoppen.
//   3. Mail opstellen en versturen. Resend krijgt de notificatie-id als Idempotency-Key (24 uur geldig), dus
//      een nieuwe poging na een time-out verstuurt de mail niet nog een keer.
//   4. markeer_notificatie (in mock ook de inhoud, alleen zichtbaar voor de ontvanger).

import type { Koppeling, Modus } from "./modus.ts";
import { DefinitieveFout, type TaakHandler } from "./taken.ts";
import { type FactuurSamenvatting, type NotificatieSoort, omschrijvingVerzonden, stelMailOp } from "./mailteksten.ts";
import { maakMailToken } from "./mailtoken.ts";

export interface UitgaandeMail {
  aan: string;
  onderwerp: string;
  html: string;
  tekst: string;
  /** Idempotentiesleutel (notificatie-id). */
  sleutel: string;
  soort: NotificatieSoort;
}

export interface MailProvider {
  /** Verstuurt de mail; geeft het id van de provider. Gooit DefinitieveFout als een nieuwe poging niets oplost. */
  verstuur(mail: UitgaandeMail): Promise<{ id: string }>;
}

export const RESEND_URL = "https://api.resend.com/emails";

/**
 * Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Fouten: 429 (limiet/quotum), 409 concurrent_idempotent_requests en 5xx → tijdelijk; 409
 * invalid_idempotent_request = met deze sleutel is al een (iets andere) mail verstuurd → geldt als verstuurd;
 * andere 4xx (sleutel ongeldig, domein niet geverifieerd, ongeldig adres) → definitief.
 */
export class ResendLive implements MailProvider {
  private readonly apiKey: string;
  private readonly afzender: string;
  private readonly fetcher: typeof fetch;

  constructor(apiKey: string, afzender: string, fetcher: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.afzender = afzender;
    this.fetcher = fetcher;
  }

  async verstuur(mail: UitgaandeMail): Promise<{ id: string }> {
    let response: Response;
    try {
      response = await this.fetcher(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `factuurscanner-${mail.sleutel}`,
        },
        body: JSON.stringify({
          from: this.afzender,
          to: [mail.aan],
          subject: mail.onderwerp,
          html: mail.html,
          text: mail.tekst,
          tags: [{ name: "soort", value: mail.soort }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new Error(`Resend niet bereikbaar: ${err instanceof Error ? err.message : String(err)}`);
    }

    let body: Record<string, unknown> = {};
    try {
      body = await response.json();
    } catch {
      // geen JSON
    }
    if (response.ok && typeof body.id === "string") return { id: body.id };

    const naam = typeof body.name === "string" ? body.name : "";
    const melding = typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
    if (response.status === 409 && naam === "invalid_idempotent_request") {
      return { id: `al-verstuurd:${mail.sleutel}` };
    }
    if (response.ok || response.status === 409 || response.status === 429 || response.status >= 500) {
      throw new Error(`Resend: ${melding}${naam ? ` (${naam})` : ""}`);
    }
    throw new DefinitieveFout(`Resend weigerde de mail (${response.status}${naam ? ` ${naam}` : ""}): ${melding}`);
  }
}

/**
 * Mock: verstuurt niets; de mail komt alleen in "Mijn mails" in de app. Om retries en fouten te testen:
 *   adres met "+tijdelijk" (bijv. jan+tijdelijk@bedrijf.nl) → tijdelijke fout (nieuwe poging volgt)
 *   adres met "+ongeldig"                                     → definitieve fout
 */
export class MailMock implements MailProvider {
  verstuur(mail: UitgaandeMail): Promise<{ id: string }> {
    const lokaal = mail.aan.split("@")[0] ?? "";
    if (lokaal.includes("+tijdelijk")) return Promise.reject(new Error("Mock: mailserver tijdelijk niet bereikbaar."));
    if (lokaal.includes("+ongeldig")) return Promise.reject(new DefinitieveFout("Mock: ongeldig ontvangstadres."));
    return Promise.resolve({ id: `mock-${mail.sleutel}` });
  }
}

/** Placeholder voor de app-URL in mock-mails zonder APP_URL; de app vervangt hem bij het tonen. */
export const APP_URL_PLACEHOLDER = "{{APP_URL}}";

export interface EmailDeps {
  modus(organisatieId: string, koppeling: Koppeling): Promise<Modus>;
  rpc(functie: string, args: Record<string, unknown>): Promise<unknown>;
  provider(modus: Modus): MailProvider;
  /** Basis-URL van de app (APP_URL); in mock mag die ontbreken. */
  appUrl(modus: Modus): string;
  tokenSleutel(): Promise<string>;
}

interface Verzendgegevens {
  status: "verzenden" | "overslaan" | "afgehandeld";
  reden: string | null;
  soort: NotificatieSoort;
  organisatie_id: string;
  organisatie: string | null;
  ontvanger_email: string | null;
  details: Record<string, unknown>;
  facturen: FactuurSamenvatting[];
  blokkade: string | null;
}

export function emailHandler(d: EmailDeps): TaakHandler {
  return async (taak) => {
    const notificatieId = typeof taak.payload.notificatie_id === "string" ? taak.payload.notificatie_id : taak.sleutel;
    const g = (await d.rpc("notificatie_voor_verzending", { p_notificatie_id: notificatieId })) as Verzendgegevens;

    if (g.status === "afgehandeld") return { omschrijving: `Mail niet opnieuw verstuurd: ${g.reden ?? "al afgehandeld"}` };
    if (g.status === "overslaan") {
      await d.rpc("markeer_notificatie", { p_notificatie_id: notificatieId, p_status: "overgeslagen", p_reden: g.reden });
      return { omschrijving: `Mail niet verstuurd: ${g.reden}`, overgeslagen: true };
    }
    if (!g.ontvanger_email) throw new DefinitieveFout("Geen e-mailadres voor de ontvanger.");

    const modus = await d.modus(g.organisatie_id, "email");
    const appUrl = d.appUrl(modus);

    let actie: { token: string; verlooptOp: Date; blokkade: string | null } | undefined;
    if (g.soort === "goedkeuren") {
      const a = (await d.rpc("maak_mail_actie", { p_notificatie_id: notificatieId })) as { id: string; verloopt_op: string };
      const verlooptOp = new Date(a.verloopt_op);
      actie = { token: await maakMailToken(await d.tokenSleutel(), a.id, verlooptOp), verlooptOp, blokkade: g.blokkade };
    }

    const mail = stelMailOp({
      soort: g.soort,
      organisatie: g.organisatie ?? "je organisatie",
      ontvanger: g.ontvanger_email,
      facturen: g.facturen,
      details: g.details ?? {},
      appUrl,
      actie,
    });
    const { id } = await d.provider(modus).verstuur({ aan: g.ontvanger_email, ...mail, sleutel: notificatieId, soort: g.soort });

    await d.rpc("markeer_notificatie", {
      p_notificatie_id: notificatieId,
      p_status: "verzonden",
      p_modus: modus,
      p_ontvanger_email: g.ontvanger_email,
      p_onderwerp: mail.onderwerp,
      p_provider_id: id,
      p_reden: null,
      p_inhoud: modus === "mock" ? { html: mail.html, tekst: mail.tekst } : null,
    });
    return {
      omschrijving: `${omschrijvingVerzonden(g.soort, g.ontvanger_email)}${modus === "mock" ? " (mock)" : ""}`,
      modus,
      notificatie_id: notificatieId,
    };
  };
}

/** APP_URL zonder / aan het eind; in mock zonder APP_URL de placeholder. */
export function appUrlVoor(modus: Modus, env: string | undefined): string {
  const schoon = env?.trim().replace(/\/+$/, "");
  if (schoon) return schoon;
  if (modus === "mock") return APP_URL_PLACEHOLDER;
  throw new DefinitieveFout("E-mail staat op live, maar APP_URL ontbreekt (de URL van de app, voor de links in de mail).");
}
