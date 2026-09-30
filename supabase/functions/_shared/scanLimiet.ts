// Dagelijkse limiet op AI-scans, gedeeld door scan-factuur (upload) en verwerk-taken (mailbox).
// De teller staat in de database (public.claim_scan); de limiet is standaard 5 per dag en kan met het
// secret SCAN_LIMIET_PER_DAG worden aangepast. Gerekend per organisatie, per dag in Nederlandse tijd.

import type { ScanUitkomst } from "./openaiScan.ts";

export const STANDAARD_SCANLIMIET = 5;

/** Het deel van de Supabase-client dat hier nodig is (met de service role-sleutel aangemaakt). */
export interface RpcClient {
  rpc(functie: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export function scanLimietPerDag(): number {
  const waarde = Number(Deno.env.get("SCAN_LIMIET_PER_DAG"));
  return Number.isInteger(waarde) && waarde >= 1 ? waarde : STANDAARD_SCANLIMIET;
}

/** Voert de scan uit als de daglimiet dat toelaat; een mislukte scan telt niet mee. */
export async function metDagLimiet(
  client: RpcClient,
  sleutel: string,
  scan: () => Promise<ScanUitkomst>,
): Promise<ScanUitkomst> {
  const limiet = scanLimietPerDag();
  const { data, error } = await client.rpc("claim_scan", { p_sleutel: sleutel, p_limiet: limiet });
  if (error) {
    console.error("Daglimiet controleren mislukt:", error.message);
    return { ok: false, status: 500, melding: "De dagelijkse scanlimiet kon niet worden gecontroleerd. Probeer het later opnieuw." };
  }
  if (data !== true) {
    return {
      ok: false,
      status: 429,
      melding: `De dagelijkse limiet van ${limiet} scans is bereikt. Probeer het morgen opnieuw of vul de gegevens handmatig in.`,
    };
  }

  const uitkomst = await scan();
  if (!uitkomst.ok) {
    const { error: terugFout } = await client.rpc("geef_scan_terug", { p_sleutel: sleutel });
    if (terugFout) console.warn("Scan terugboeken mislukt:", terugFout.message);
  }
  return uitkomst;
}
