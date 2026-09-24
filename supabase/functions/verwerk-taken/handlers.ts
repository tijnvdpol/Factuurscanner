// Verwerking per soort taak. Elke fase voegt hier zijn soorten toe.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { effectieveModus, envNaamModus, type Koppeling, type Modus } from "../_shared/koppelingen/modus.ts";
import { DefinitieveFout, type TaakHandler } from "../_shared/koppelingen/taken.ts";
import { verrijkingHandlers } from "../_shared/koppelingen/verrijking.ts";
import { ViesLive, ViesMock } from "../_shared/koppelingen/vies.ts";
import { EcbLive, EcbMock } from "../_shared/koppelingen/ecb.ts";
import { KVK_TEST_SLEUTEL, KVK_URL, KvkLive, KvkMock } from "../_shared/koppelingen/kvk.ts";

/** Geldende modus: env (KOPPELING_<NAAM>_MODUS) gaat voor, dan de instelling van de organisatie, anders mock. */
export async function modusVoor(supabase: SupabaseClient, organisatieId: string, koppeling: Koppeling): Promise<Modus> {
  const { data, error } = await supabase
    .from("koppeling_instellingen")
    .select("modus")
    .eq("organisatie_id", organisatieId)
    .eq("koppeling", koppeling)
    .maybeSingle();
  if (error) throw new Error(`Instelling van ${koppeling} niet leesbaar: ${error.message}`);
  return effectieveModus(Deno.env.get(envNaamModus(koppeling)), data?.modus).modus;
}

function kvkLive(): KvkLive {
  const test = Deno.env.get("KVK_OMGEVING")?.trim().toLowerCase() === "test";
  const sleutel = Deno.env.get("KVK_API_KEY")?.trim() || (test ? KVK_TEST_SLEUTEL : "");
  if (!sleutel) {
    throw new DefinitieveFout("KvK staat op live, maar KVK_API_KEY ontbreekt (of zet KVK_OMGEVING=test voor de testomgeving).");
  }
  return new KvkLive(test ? KVK_URL.test : KVK_URL.productie, sleutel);
}

export function maakHandlers(supabase: SupabaseClient): Record<string, TaakHandler> {
  return {
    // Controleert of de wachtrij, de cronjob en de worker werken (knop "Test de wachtrij").
    test: () => Promise.resolve({ bericht: "De wachtrij en de worker werken.", verwerkt_op: new Date().toISOString() }),

    ...verrijkingHandlers({
      modus: (organisatieId, koppeling) => modusVoor(supabase, organisatieId, koppeling),
      rpc: async (functie, args) => {
        const { data, error } = await supabase.rpc(functie, args);
        if (error) throw new Error(`${functie}: ${error.message}`);
        return data;
      },
      vies: (modus) => (modus === "live" ? new ViesLive() : new ViesMock()),
      ecb: (modus) => (modus === "live" ? new EcbLive() : new EcbMock()),
      kvk: (modus, naam) => (modus === "live" ? kvkLive() : new KvkMock(naam)),
    }),
  };
}
