// Edge Function verwerk-taken: verwerkt de wachtrij koppeling_taken (VIES, ECB, KvK, export, mails, …).
//
// POST {}  met header x-worker-geheim = secret WORKER_GEHEIM
//   Wordt elke minuut aangeroepen door pg_cron (via pg_net, zie migratie 20260924100000) en direct na het
//   aanmaken van een taak. Claimt taken via claim_taken (for update skip locked, dus meerdere gelijktijdige
//   aanroepen zitten elkaar niet in de weg), voert ze uit en rondt af via rond_taak_af (retries met
//   oplopende wachttijd, eindresultaat in de audit log).
//   200 { verwerkt: number, gelukt: number, mislukt: number }
//
// Secrets: WORKER_GEHEIM (zelf instellen; zelfde waarde als het Vault-secret factuurscanner_worker_geheim).
// SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY zet Supabase automatisch.

import { fout, json, serviceClient } from "../_shared/server.ts";
import { gelijkGeheim, type Taak, voerTaakUit } from "../_shared/koppelingen/taken.ts";
import { maakHandlers } from "./handlers.ts";

// Edge Functions hebben een maximale looptijd; binnen dit budget nieuwe taken claimen.
const TIJDBUDGET_MS = 90_000;
const PER_KEER = 5;

Deno.serve(async (req) => {
  const start = Date.now();
  if (req.method !== "POST") return fout(405, "Methode niet toegestaan.");
  if (!gelijkGeheim(req.headers.get("x-worker-geheim"), Deno.env.get("WORKER_GEHEIM"))) {
    return fout(401, "Niet toegestaan.");
  }

  const supabase = serviceClient();
  const handlers = maakHandlers(supabase);
  // Alleen soorten claimen waarvoor deze versie van de functie een verwerking heeft. Zo blijven taken
  // van een nog niet gedeployde fase gewoon in de wachtrij staan.
  const soorten = Object.keys(handlers);
  let gelukt = 0;
  let mislukt = 0;

  while (Date.now() - start < TIJDBUDGET_MS) {
    const { data, error } = await supabase.rpc("claim_taken", { p_max: PER_KEER, p_soorten: soorten });
    if (error) {
      console.error("Taken claimen mislukt:", error.message);
      return fout(500, "Taken claimen mislukt.");
    }
    const taken = (data ?? []) as Taak[];
    if (taken.length === 0) break;

    await Promise.all(
      taken.map(async (taak) => {
        const afronding = await voerTaakUit(taak, handlers);
        if (afronding.gelukt) gelukt++;
        else {
          mislukt++;
          console.warn(`Taak ${taak.id} (${taak.soort}) mislukt:`, afronding.fout);
        }
        const { error: afrondFout } = await supabase.rpc("rond_taak_af", {
          p_taak_id: taak.id,
          p_gelukt: afronding.gelukt,
          p_resultaat: afronding.resultaat,
          p_fout: afronding.fout,
          p_opnieuw: afronding.opnieuw,
        });
        // Lukt afronden niet, dan zet claim_taken de taak na 10 minuten terug in de wachtrij.
        if (afrondFout) console.error(`Taak ${taak.id} afronden mislukt:`, afrondFout.message);
      }),
    );
  }

  return json(200, { verwerkt: gelukt + mislukt, gelukt, mislukt });
});
