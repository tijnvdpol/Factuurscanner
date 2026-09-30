// Edge Function mail-actie: de knoppen Goedkeuren/Afkeuren uit een goedkeuringsmail.
//
// De knoppen in de mail openen de app (APP_URL/#mail-actie=<token>&keuze=…); die pagina roept deze functie
// aan. Zo voert een link-scanner van een mailprogramma (die links opent om ze te controleren) nooit iets uit:
// er is altijd een bevestiging op de pagina nodig. Inloggen is niet nodig: het token is de toegang.
//
// POST { actie: "bekijk", token }
//   200 { geldig, melding, mogelijk: { goedkeuren, afkeuren } (null = kan, anders de reden), factuur,
//         goedkeurder, organisatie, verloopt_op, gebruikt_op, gebruikt_actie }
// POST { actie: "uitvoeren", token, keuze: "goedkeuren" | "afkeuren", reden? }
//   200 { ok, melding }   Dezelfde controles als in de app (rol, limiet in euro, signalen, grootboekrekening) plus
//                         strikte functiescheiding; eenmalig; een geweigerde poging staat in de audit log.
//
// Token: ondertekend met MAIL_TOKEN_GEHEIM (of een sleutel afgeleid van de service-rolsleutel), zie
// _shared/koppelingen/mailtoken.ts.

import { CORS_HEADERS, fout, json, serviceClient } from "../_shared/server.ts";
import { leesMailToken, mailTokenSleutel } from "../_shared/koppelingen/mailtoken.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return fout(405, "Methode niet toegestaan.");

  let invoer: { actie?: unknown; token?: unknown; keuze?: unknown; reden?: unknown };
  try {
    invoer = await req.json();
  } catch {
    return fout(400, "Ongeldige aanvraag.");
  }

  const token = await leesMailToken(await mailTokenSleutel((naam) => Deno.env.get(naam)), invoer.token);
  if (!token.geldig) {
    return invoer.actie === "uitvoeren"
      ? json(200, { ok: false, melding: token.reden })
      : json(200, { geldig: false, melding: token.reden });
  }

  const supabase = serviceClient();
  switch (invoer.actie) {
    case "bekijk": {
      const { data, error } = await supabase.rpc("bekijk_mail_actie", { p_mail_actie_id: token.actieId });
      if (error) {
        console.error("bekijk_mail_actie:", error.message);
        return fout(500, "De factuur kon niet worden geladen. Probeer het later opnieuw.");
      }
      return json(200, data);
    }
    case "uitvoeren": {
      if (invoer.keuze !== "goedkeuren" && invoer.keuze !== "afkeuren") return fout(400, "Kies goedkeuren of afkeuren.");
      const reden = typeof invoer.reden === "string" ? invoer.reden.slice(0, 1000) : null;
      const { data, error } = await supabase.rpc("voer_mail_actie_uit", {
        p_mail_actie_id: token.actieId,
        p_actie: invoer.keuze,
        p_reden: reden,
      });
      if (error) {
        console.error("voer_mail_actie_uit:", error.message);
        return fout(500, "Er ging iets mis. Probeer het later opnieuw of gebruik de app.");
      }
      return json(200, data);
    }
    default:
      return fout(400, "Onbekende actie.");
  }
});
