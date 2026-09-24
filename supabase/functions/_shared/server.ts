// Gedeelde hulpfuncties voor de Edge Functions van de koppelingen (Deno).
// scan-factuur heeft (nog) zijn eigen varianten; dat gedrag blijft ongewijzigd.

import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export function fout(status: number, melding: string): Response {
  return json(status, { error: melding });
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Client met de rechten van de ingelogde gebruiker (RLS geldt), of een foutresponse. */
export async function gebruikerClient(req: Request): Promise<{ client: SupabaseClient; gebruiker: User } | Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? req.headers.get("apikey");
  if (!supabaseUrl || !anonKey) return fout(500, "De server is niet goed geconfigureerd (SUPABASE_URL ontbreekt).");

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return fout(401, "Niet ingelogd.");

  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return fout(401, "Je sessie is verlopen. Log opnieuw in.");
  return { client, gebruiker: data.user };
}

/** Client met de service role. Alleen voor RPC's die zelf controleren wat mag (claim_taken e.d.). */
export function serviceClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL of SUPABASE_SERVICE_ROLE_KEY ontbreekt.");
  return createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

/** Maakt de worker wakker zonder erop te wachten (de cronjob pakt het anders binnen een minuut op). */
export function wekWorker(): void {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const geheim = Deno.env.get("WORKER_GEHEIM");
  if (!supabaseUrl || !geheim) return;
  const verzoek = fetch(`${supabaseUrl}/functions/v1/verwerk-taken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-geheim": geheim },
    body: "{}",
    signal: AbortSignal.timeout(5_000),
  })
    .then((r) => r.body?.cancel())
    .catch((err) => console.warn("Worker wekken mislukt (cron pakt het op):", err));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(verzoek);
}
