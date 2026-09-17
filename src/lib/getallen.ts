/** Parseert een door de gebruiker ingetypt getal, met NL-notatie (komma als decimaalteken,
 * punt als duizendtal-scheiding) of internationale notatie (punt als decimaalteken). */
export function parseGetal(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  let genormaliseerd = trimmed.replace(/\s/g, "");

  const heeftKomma = genormaliseerd.includes(",");
  const heeftPunt = genormaliseerd.includes(".");

  if (heeftKomma && heeftPunt) {
    // Laatste scheidingsteken is het decimaalteken; het andere is duizendtal-scheiding.
    const laatsteKomma = genormaliseerd.lastIndexOf(",");
    const laatstePunt = genormaliseerd.lastIndexOf(".");
    if (laatsteKomma > laatstePunt) {
      genormaliseerd = genormaliseerd.replace(/\./g, "").replace(",", ".");
    } else {
      genormaliseerd = genormaliseerd.replace(/,/g, "");
    }
  } else if (heeftKomma) {
    genormaliseerd = genormaliseerd.replace(",", ".");
  }

  const getal = Number(genormaliseerd);
  return Number.isFinite(getal) ? getal : null;
}

/** Formatteert een getal in NL-notatie (komma decimaal) voor weergave in invoervelden. */
export function formatGetal(waarde: number | null, decimalen = 2): string {
  if (waarde === null || Number.isNaN(waarde)) return "";
  return waarde
    .toFixed(decimalen)
    .replace(".", ",");
}

/** Formatteert een bedrag met duizendtal-scheiding voor weergave in de tabel/CSV. */
export function formatBedrag(waarde: number | null, decimalen = 2): string {
  if (waarde === null || Number.isNaN(waarde)) return "";
  return new Intl.NumberFormat("nl-NL", {
    minimumFractionDigits: decimalen,
    maximumFractionDigits: decimalen,
  }).format(waarde);
}
