// Edge Function koppeling-actie: acties op de koppelingen vanuit de app (met de JWT van de gebruiker).
//
// POST { actie: "overzicht", organisatie_id }
//   200 { koppelingen: KoppelingStatus[] }  modus per koppeling (env gaat voor), en welke secrets voor live
//       ontbreken (alleen namen, nooit waarden). Voor elk lid van de organisatie.
// POST { actie: "test_wachtrij", organisatie_id }
//   200 { taak_id }  zet een testtaak in de wachtrij en maakt de worker wakker (controller/beheerder).
//   4xx/5xx { error: string }
//
// Latere fasen voegen acties toe (verbinding testen, mapping ophalen, testmail simuleren, …).

import { CORS_HEADERS, fout, gebruikerClient, json, UUID, wekWorker } from "../_shared/server.ts";
import { koppelingOverzicht } from "../_shared/koppelingen/modus.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return fout(405, "Methode niet toegestaan.");

  const sessie = await gebruikerClient(req);
  if (sessie instanceof Response) return sessie;
  const { client, gebruiker } = sessie;

  let invoer: { actie?: unknown; organisatie_id?: unknown };
  try {
    invoer = await req.json();
  } catch {
    return fout(400, "Ongeldige aanvraag.");
  }
  const organisatieId = typeof invoer.organisatie_id === "string" && UUID.test(invoer.organisatie_id)
    ? invoer.organisatie_id
    : null;
  if (!organisatieId) return fout(400, "Organisatie ontbreekt.");

  // Lidmaatschap (RLS: je ziet alleen de leden van je eigen organisaties)
  const { data: lid } = await client
    .from("organisatie_leden")
    .select("rol")
    .eq("organisatie_id", organisatieId)
    .eq("user_id", gebruiker.id)
    .maybeSingle();
  if (!lid) return fout(403, "Geen toegang tot deze organisatie.");

  switch (invoer.actie) {
    case "overzicht": {
      const { data, error } = await client
        .from("koppeling_instellingen")
        .select("koppeling, modus, config")
        .eq("organisatie_id", organisatieId);
      if (error) return fout(500, "De instellingen konden niet worden geladen.");
      return json(200, { koppelingen: koppelingOverzicht((naam) => Deno.env.get(naam), data ?? []) });
    }
    case "test_wachtrij": {
      const { data, error } = await client.rpc("plan_testtaak", { p_organisatie_id: organisatieId });
      if (error) return fout(error.code === "42501" ? 403 : 500, error.message);
      wekWorker();
      return json(200, { taak_id: data });
    }
    default:
      return fout(400, "Onbekende actie.");
  }
});
