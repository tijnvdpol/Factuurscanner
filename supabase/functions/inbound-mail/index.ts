// Edge Function inbound-mail: webhook voor inkomende mail (Mailgun inbound route met forward()).
//
// POST multipart/form-data van Mailgun (zie _shared/koppelingen/mailbox.ts)
//   1. Handtekening controleren (HMAC-SHA256 met MAILGUN_SIGNING_KEY, niet ouder dan 12 uur).
//   2. Ontvangstadres → organisatie. Staat de mailbox van die organisatie op mock, dan wordt de mail
//      geweigerd (406): in mock-modus komen alleen gesimuleerde mails binnen.
//   3. Mail registreren (dubbel op Message-Id = al verwerkt), bruikbare bijlagen in Storage zetten
//      ({organisatie_id}/inbox/{bericht_id}/…) en afronden. Bekende afzender → bijlagen gaan de wachtrij in
//      (worker scant en maakt de factuur); onbekende afzender → wacht op beoordeling in de app.
//   200 = verwerkt of al eerder ontvangen; 406 = geweigerd (Mailgun probeert niet opnieuw);
//   401 = ongeldige handtekening; 500 = tijdelijke fout (Mailgun probeert het tot 8 uur opnieuw).
//
// Secrets: MAILGUN_SIGNING_KEY (Mailgun → Sending → Webhooks → HTTP webhook signing key), WORKER_GEHEIM.

import { fout, json, modusVoor, serviceClient, wekWorker } from "../_shared/server.ts";
import { controleerHandtekening, leesMailgunFormulier, verwerkMail } from "../_shared/koppelingen/mailbox.ts";

const BUCKET = "facturen";

Deno.serve(async (req) => {
  if (req.method !== "POST") return fout(405, "Methode niet toegestaan.");

  const sleutel = Deno.env.get("MAILGUN_SIGNING_KEY");
  if (!sleutel) {
    console.error("MAILGUN_SIGNING_KEY ontbreekt");
    return fout(500, "Niet geconfigureerd.");
  }

  let velden: FormData;
  try {
    velden = await req.formData();
  } catch {
    return fout(406, "Ongeldig formulier.");
  }

  const tekst = (naam: string) => (typeof velden.get(naam) === "string" ? (velden.get(naam) as string) : null);
  const handtekening = await controleerHandtekening(sleutel, {
    timestamp: tekst("timestamp"),
    token: tekst("token"),
    signature: tekst("signature"),
  });
  if (!handtekening.geldig) {
    console.warn("Inkomende mail geweigerd:", handtekening.reden);
    return fout(401, "Ongeldige handtekening.");
  }

  let mail;
  try {
    mail = await leesMailgunFormulier(velden);
  } catch (err) {
    console.warn("Onleesbare mail:", err);
    return fout(406, err instanceof Error ? err.message : "Onleesbare mail.");
  }

  const supabase = serviceClient();

  // Modus van de organisatie achter dit adres (in mock-modus geen echte mail verwerken)
  const { data: adres } = await supabase.from("inbox_adressen").select("organisatie_id").eq("adres", mail.aan).maybeSingle();
  if (!adres) {
    console.warn("Mail voor onbekend ontvangstadres:", mail.aan);
    return fout(406, "Onbekend ontvangstadres.");
  }
  if ((await modusVoor(supabase, adres.organisatie_id, "mailbox")) !== "live") {
    console.warn("Mailbox staat op mock; echte mail geweigerd voor", mail.aan);
    return fout(406, "De mailbox staat op mock.");
  }

  try {
    const uitkomst = await verwerkMail(mail, {
      registreer: async (bericht) => {
        const { data, error } = await supabase.rpc("registreer_inbox_bericht", { p_bericht: bericht });
        if (error) throw new Error(error.message);
        return data;
      },
      upload: async (pad, inhoud, mimeType) => {
        const { error } = await supabase.storage.from(BUCKET).upload(pad, inhoud, { contentType: mimeType, upsert: true });
        if (error) throw new Error(`Opslaan van de bijlage mislukt: ${error.message}`);
      },
      rondAf: async (berichtId, bijlagen) => {
        const { data, error } = await supabase.rpc("rond_inbox_bericht_af", { p_bericht_id: berichtId, p_bijlagen: bijlagen });
        if (error) throw new Error(error.message);
        return data as number;
      },
    });
    if (uitkomst.status === "onbekend_adres") return fout(406, "Onbekend ontvangstadres.");
    if (uitkomst.status === "nieuw" && uitkomst.bekend) wekWorker();
    return json(200, uitkomst);
  } catch (err) {
    // Tijdelijk (database of opslag): Mailgun probeert het opnieuw; dubbele verwerking voorkomt de Message-Id.
    console.error("Inkomende mail verwerken mislukt:", err);
    return fout(500, "Tijdelijke fout.");
  }
});
