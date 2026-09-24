// Koppelingen: welke er zijn, welke secrets ze in live-modus nodig hebben en welke modus geldt.
// Geen imports, zodat de frontend (Vite) en de tests (Vitest) dit bestand ook kunnen gebruiken.
//
// Modus per koppeling:
//   1. KOPPELING_<NAAM>_MODUS in de Supabase secrets ("live" of "mock") gaat altijd voor ("vastgezet").
//   2. Anders de instelling van de organisatie (tabel koppeling_instellingen, pagina Koppelingen).
//   3. Anders mock.

export const KOPPELINGEN = ["mailbox", "vies", "ecb", "kvk", "boekhouding", "betaling", "email"] as const;
export type Koppeling = (typeof KOPPELINGEN)[number];
export type Modus = "live" | "mock";

export interface KoppelingInfo {
  naam: string;
  omschrijving: string;
  /** Secrets die in live-modus nodig zijn (namen, nooit waarden). */
  secrets: string[];
  /** Wat "live" voor deze koppeling betekent, als dat niet vanzelf spreekt. */
  live?: string;
}

export const KOPPELING_INFO: Record<Koppeling, KoppelingInfo> = {
  mailbox: {
    naam: "Mailbox-import",
    omschrijving: "Facturen die naar het vaste ontvangstadres worden gemaild, komen automatisch binnen.",
    secrets: ["MAILGUN_SIGNING_KEY"],
  },
  vies: {
    naam: "VIES (btw-nummer)",
    omschrijving: "Controleert btw-nummers bij de Europese Commissie.",
    secrets: [],
  },
  ecb: {
    naam: "ECB-wisselkoersen",
    omschrijving: "Rekent facturen in vreemde valuta om naar euro op de factuurdatum.",
    secrets: [],
  },
  kvk: {
    naam: "KvK",
    omschrijving: "Haalt bedrijfsgegevens van nieuwe leveranciers op en vergelijkt ze met de factuur.",
    secrets: ["KVK_API_KEY"],
  },
  boekhouding: {
    naam: "Boekhoudpakket",
    omschrijving: "Exporteert goedgekeurde facturen naar het boekhoudpakket.",
    secrets: ["MONEYBIRD_TOKEN", "MONEYBIRD_ADMINISTRATIE_ID"],
    live: "Moneybird (Exact Online en SnelStart zijn alleen als mock beschikbaar).",
  },
  betaling: {
    naam: "Betaalopdrachten",
    omschrijving: "Maakt SEPA-betaalbestanden voor goedgekeurde facturen.",
    secrets: [],
    live: "Het betaalbestand downloaden en zelf uploaden bij de bank. Mock simuleert een bank-API.",
  },
  email: {
    naam: "E-mailnotificaties",
    omschrijving: "Mails voor goedkeuren, afwijzingen, mislukte exports en bijna vervallen facturen.",
    secrets: ["RESEND_API_KEY", "MAIL_AFZENDER", "APP_URL"],
  },
};

export function isKoppeling(waarde: unknown): waarde is Koppeling {
  return typeof waarde === "string" && (KOPPELINGEN as readonly string[]).includes(waarde);
}

export function envNaamModus(koppeling: Koppeling): string {
  return `KOPPELING_${koppeling.toUpperCase()}_MODUS`;
}

function alsModus(waarde: string | null | undefined): Modus | null {
  const schoon = waarde?.trim().toLowerCase();
  return schoon === "live" || schoon === "mock" ? schoon : null;
}

/** De geldende modus: env gaat voor (vastgezet), dan de instelling, anders mock. */
export function effectieveModus(
  envWaarde: string | null | undefined,
  instelling: string | null | undefined,
): { modus: Modus; vastgezet: boolean } {
  const env = alsModus(envWaarde);
  if (env) return { modus: env, vastgezet: true };
  return { modus: alsModus(instelling) ?? "mock", vastgezet: false };
}

export interface KoppelingStatus {
  koppeling: Koppeling;
  modus: Modus;
  /** true = de modus staat vast via een env-variabele en is niet in de app te wijzigen. */
  vastgezet: boolean;
  /** Namen van secrets die voor live-modus ontbreken. */
  ontbrekend: string[];
  /** Kan de koppeling in de huidige modus werken? (Mock kan altijd.) */
  klaar: boolean;
  config: Record<string, unknown>;
}

/**
 * Overzicht van alle koppelingen voor één organisatie.
 * env: leest een env-variabele (in de Edge Function: Deno.env.get); geeft nooit waarden terug, alleen of ze gezet zijn.
 */
export function koppelingOverzicht(
  env: (naam: string) => string | undefined,
  instellingen: { koppeling: string; modus: string; config?: Record<string, unknown> | null }[],
): KoppelingStatus[] {
  return KOPPELINGEN.map((koppeling) => {
    const instelling = instellingen.find((i) => i.koppeling === koppeling);
    const { modus, vastgezet } = effectieveModus(env(envNaamModus(koppeling)), instelling?.modus);
    const ontbrekend = KOPPELING_INFO[koppeling].secrets.filter((naam) => !env(naam)?.trim());
    return {
      koppeling,
      modus,
      vastgezet,
      ontbrekend,
      klaar: modus === "mock" || ontbrekend.length === 0,
      config: instelling?.config ?? {},
    };
  });
}
