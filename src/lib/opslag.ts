import { supabase } from "./supabase";

const BUCKET = "facturen";
const MAX_BYTES = 15 * 1024 * 1024;
const BEKIJK_URL_GELDIG_SEC = 300;

export class OpslagError extends Error {}

/** Storage-paden staan geen accenten en de meeste speciale tekens toe; de originele naam bewaren we apart. */
function veiligeBestandsnaam(naam: string): string {
  const zonderAccenten = naam.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const veilig = zonderAccenten.replace(/[^\w.()-]+/g, "_").replace(/^_+|_+$/g, "");
  return !veilig || veilig.startsWith(".") ? `factuur${veilig}` : veilig;
}

/** Uploadt het originele bestand naar {user_id}/{factuur_id}/{bestandsnaam} en geeft het pad terug. */
export async function uploadFactuurBestand(userId: string, factuurId: string, bestand: File): Promise<string> {
  if (bestand.size > MAX_BYTES) {
    throw new OpslagError("Bestand is groter dan 15 MB. Comprimeer het bestand en probeer opnieuw.");
  }

  const pad = `${userId}/${factuurId}/${veiligeBestandsnaam(bestand.name)}`;
  const { error } = await supabase.storage.from(BUCKET).upload(pad, bestand, {
    contentType: bestand.type || undefined,
    upsert: false,
  });
  if (error) {
    throw new OpslagError(`Uploaden van het bestand is mislukt: ${error.message}`);
  }
  return pad;
}

export async function verwijderBestand(pad: string): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).remove([pad]);
  if (error) {
    throw new OpslagError(`Verwijderen van het bestand is mislukt: ${error.message}`);
  }
}

/** Opent het originele bestand via een tijdelijke signed URL in een nieuw tabblad. */
export async function openOrigineel(pad: string): Promise<void> {
  // Tabblad openen vóór de await: anders blokkeren sommige browsers (o.a. Safari) de popup.
  const venster = window.open("", "_blank");
  try {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(pad, BEKIJK_URL_GELDIG_SEC);
    if (error || !data) {
      throw new OpslagError("Het originele bestand kon niet worden geopend (niet gevonden of geen toegang).");
    }
    if (venster) {
      venster.opener = null;
      venster.location.href = data.signedUrl;
    } else {
      window.location.assign(data.signedUrl);
    }
  } catch (err) {
    venster?.close();
    throw err;
  }
}
