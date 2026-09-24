// Ondertekend token achter de knoppen Goedkeuren/Afkeuren in een goedkeuringsmail. Geen imports (testbaar
// met Vitest).
//
// Vorm: v1.<payload>.<handtekening>, beide base64url.
//   payload      = JSON { i: id van de mail-actie (tabel mail_acties), e: verlooptijd (Unix-seconden) }
//   handtekening = HMAC-SHA256(sleutel, "v1." + payload)
//
// Het token bewijst dat de server de link heeft gemaakt en tot wanneer hij geldt. Eenmalig gebruik, de
// koppeling aan goedkeurder en factuur, en alle rechten worden daarna in de database gecontroleerd
// (voer_mail_actie_uit). Er staat geen persoonsgegeven of bedrag in het token.
//
// Sleutel: secret MAIL_TOKEN_GEHEIM; zonder dat secret een sleutel afgeleid van de service-rolsleutel (die
// elke Edge Function automatisch heeft). Dan vervallen open links als die sleutel ooit wordt vervangen.

const VERSIE = "v1";

function base64url(bytes: Uint8Array): string {
  let binair = "";
  for (const b of bytes) binair += String.fromCharCode(b);
  return btoa(binair).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function vanBase64url(tekst: string): Uint8Array {
  const b64 = tekst.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (tekst.length % 4)) % 4);
  const binair = atob(b64);
  return Uint8Array.from(binair, (c) => c.charCodeAt(0));
}

async function hmac(sleutel: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(sleutel), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

function gelijk(a: Uint8Array, b: Uint8Array): boolean {
  let verschil = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) verschil |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return verschil === 0;
}

/** De sleutel voor mail-tokens: MAIL_TOKEN_GEHEIM, anders afgeleid van de service-rolsleutel. */
export async function mailTokenSleutel(env: (naam: string) => string | undefined): Promise<string> {
  const eigen = env("MAIL_TOKEN_GEHEIM")?.trim();
  if (eigen) return eigen;
  const service = env("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!service) throw new Error("MAIL_TOKEN_GEHEIM en SUPABASE_SERVICE_ROLE_KEY ontbreken.");
  return base64url(await hmac(service, "factuurscanner-mail-token"));
}

export async function maakMailToken(sleutel: string, actieId: string, verlooptOp: Date): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ i: actieId, e: Math.floor(verlooptOp.getTime() / 1000) })));
  const handtekening = base64url(await hmac(sleutel, `${VERSIE}.${payload}`));
  return `${VERSIE}.${payload}.${handtekening}`;
}

export type TokenUitkomst = { geldig: true; actieId: string; verlooptOp: Date } | { geldig: false; reden: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Controleert vorm, handtekening en verlooptijd. */
export async function leesMailToken(sleutel: string, token: unknown, nu: Date = new Date()): Promise<TokenUitkomst> {
  if (typeof token !== "string" || token.length > 500) return { geldig: false, reden: "Deze link is ongeldig." };
  const delen = token.trim().split(".");
  if (delen.length !== 3 || delen[0] !== VERSIE) return { geldig: false, reden: "Deze link is ongeldig." };
  const [, payload, handtekening] = delen;

  let ontvangen: Uint8Array;
  try {
    ontvangen = vanBase64url(handtekening);
  } catch {
    return { geldig: false, reden: "Deze link is ongeldig." };
  }
  if (!gelijk(await hmac(sleutel, `${VERSIE}.${payload}`), ontvangen)) {
    return { geldig: false, reden: "Deze link is ongeldig of beschadigd. Kopieer de volledige link uit de mail." };
  }

  let inhoud: { i?: unknown; e?: unknown };
  try {
    inhoud = JSON.parse(new TextDecoder().decode(vanBase64url(payload)));
  } catch {
    return { geldig: false, reden: "Deze link is ongeldig." };
  }
  if (typeof inhoud.i !== "string" || !UUID.test(inhoud.i) || typeof inhoud.e !== "number") {
    return { geldig: false, reden: "Deze link is ongeldig." };
  }
  const verlooptOp = new Date(inhoud.e * 1000);
  if (verlooptOp.getTime() < nu.getTime()) return { geldig: false, reden: "Deze link is verlopen. Open de factuur in de app." };
  return { geldig: true, actieId: inhoud.i, verlooptOp };
}
