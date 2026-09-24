// Edge Function koppeling-actie: acties op de koppelingen vanuit de app (met de JWT van de gebruiker).
//
// POST { actie: "overzicht", organisatie_id }
//   200 { koppelingen: KoppelingStatus[] }  modus per koppeling (env gaat voor), en welke secrets voor live
//       ontbreken (alleen namen, nooit waarden). Voor elk lid van de organisatie.
// POST { actie: "test_wachtrij", organisatie_id }
//   200 { taak_id }  zet een testtaak in de wachtrij en maakt de worker wakker (controller/beheerder).
// POST { actie: "simuleer_mail", organisatie_id, soort: "bekend" | "onbekend" }
//   200 { uitkomst, melding }  alleen als de mailbox op mock staat (controller/beheerder): een testmail met
//       een PDF-factuur gaat door dezelfde verwerking als echte mail. Bij "bekend" wordt het testdomein
//       aan de vertrouwde afzenders toegevoegd (staat in de audit log).
//   4xx/5xx { error: string }
//
// Latere fasen voegen acties toe (verbinding testen, mapping ophalen, …).

import { CORS_HEADERS, fout, gebruikerClient, json, serviceClient, UUID, wekWorker } from "../_shared/server.ts";
import { effectieveModus, envNaamModus, koppelingOverzicht } from "../_shared/koppelingen/modus.ts";
import { verwerkMail } from "../_shared/koppelingen/mailbox.ts";
import { maakTestmail, TEST_AFZENDER } from "../_shared/koppelingen/testmail.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return fout(405, "Methode niet toegestaan.");

  const sessie = await gebruikerClient(req);
  if (sessie instanceof Response) return sessie;
  const { client, gebruiker } = sessie;

  let invoer: { actie?: unknown; organisatie_id?: unknown; soort?: unknown };
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
    case "simuleer_mail": {
      if (lid.rol !== "controller" && lid.rol !== "beheerder") {
        return fout(403, "Alleen een controller of beheerder kan een testmail simuleren.");
      }
      const soort = invoer.soort === "onbekend" ? "onbekend" : "bekend";
      const { data: instelling } = await client
        .from("koppeling_instellingen")
        .select("modus")
        .eq("organisatie_id", organisatieId)
        .eq("koppeling", "mailbox")
        .maybeSingle();
      if (effectieveModus(Deno.env.get(envNaamModus("mailbox")), instelling?.modus).modus !== "mock") {
        return fout(409, "De mailbox staat op live. Een testmail simuleren kan alleen in mock-modus.");
      }
      const { data: adres } = await client.from("inbox_adressen").select("adres").eq("organisatie_id", organisatieId).maybeSingle();
      if (!adres) return fout(409, "Stel eerst een ontvangstadres in (pagina Inbox).");

      if (soort === "bekend") {
        const { error } = await client.rpc("voeg_inbox_afzender_toe", {
          p_organisatie_id: organisatieId,
          p_patroon: TEST_AFZENDER.bekend.domein,
          p_omschrijving: "Testafzender (mock)",
        });
        if (error) return fout(500, error.message);
      }

      const service = serviceClient();
      try {
        const uitkomst = await verwerkMail(maakTestmail(soort, adres.adres), {
          registreer: async (bericht) => {
            const { data, error } = await service.rpc("registreer_inbox_bericht", { p_bericht: bericht });
            if (error) throw new Error(error.message);
            return data;
          },
          upload: async (pad, inhoud, mimeType) => {
            const { error } = await service.storage.from("facturen").upload(pad, inhoud, { contentType: mimeType, upsert: true });
            if (error) throw new Error(`Opslaan van de bijlage mislukt: ${error.message}`);
          },
          rondAf: async (berichtId, bijlagen) => {
            const { data, error } = await service.rpc("rond_inbox_bericht_af", { p_bericht_id: berichtId, p_bijlagen: bijlagen });
            if (error) throw new Error(error.message);
            return data as number;
          },
        });
        if (uitkomst.status === "nieuw" && uitkomst.bekend) wekWorker();
        const melding = uitkomst.status !== "nieuw"
          ? "De testmail is niet verwerkt."
          : uitkomst.bekend
          ? "Testmail van een bekende afzender ontvangen. De factuur verschijnt binnen een minuut in het overzicht."
          : "Testmail van een onbekende afzender ontvangen. Die staat nu in de inbox ter beoordeling.";
        return json(200, { uitkomst, melding });
      } catch (err) {
        console.error("Testmail simuleren mislukt:", err);
        return fout(500, err instanceof Error ? err.message : "Testmail simuleren mislukt.");
      }
    }
    default:
      return fout(400, "Onbekende actie.");
  }
});
