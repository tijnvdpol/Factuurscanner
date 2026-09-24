// Koppelingen in de frontend: labels, status per factuur (badges) en de takenlijst.
// De lijst met koppelingen, secrets en de modusregels komen uit de gedeelde module van de Edge Functions.

export {
  KOPPELING_INFO,
  KOPPELINGEN,
  effectieveModus,
  type Koppeling,
  type KoppelingStatus,
  type Modus,
} from "../../supabase/functions/_shared/koppelingen/modus.ts";

export const TAAK_SOORTEN = ["test", "mailbox", "vies", "ecb", "kvk", "boekhouding", "betaling", "email"] as const;
export type TaakSoort = (typeof TAAK_SOORTEN)[number];
export type TaakStatus = "wachtrij" | "bezig" | "gelukt" | "opgegeven";

export const SOORT_LABELS: Record<TaakSoort, string> = {
  test: "Test",
  mailbox: "Mailbox-import",
  vies: "VIES",
  ecb: "Wisselkoers",
  kvk: "KvK",
  boekhouding: "Export",
  betaling: "Betaling",
  email: "E-mail",
};

export const TAAK_STATUS_LABELS: Record<TaakStatus, string> = {
  wachtrij: "In wachtrij",
  bezig: "Bezig",
  gelukt: "Gelukt",
  opgegeven: "Mislukt",
};

/** Laatste taak per soort voor een factuur (view factuur_koppelingstatus). */
export interface KoppelingTaakStatus {
  factuur_id: string;
  soort: TaakSoort;
  taak_id: string;
  status: TaakStatus;
  pogingen: number;
  max_pogingen: number;
  volgende_poging_op: string;
  laatste_fout: string | null;
  bijgewerkt_op: string;
}

/** Een taak in de wachtrij (pagina Koppelingen). */
export interface KoppelingTaak {
  id: string;
  soort: TaakSoort;
  factuur_id: string | null;
  status: TaakStatus;
  pogingen: number;
  max_pogingen: number;
  volgende_poging_op: string;
  laatste_fout: string | null;
  resultaat: Record<string, unknown> | null;
  created_at: string;
  bijgewerkt_op: string;
}

export interface KoppelingBadge {
  taakId: string;
  soort: TaakSoort;
  tekst: string;
  /** "wacht" = mislukt maar er volgt nog een poging; "mislukt" = opgegeven. */
  soortBadge: "wacht" | "mislukt";
  titel: string;
  kanOpnieuw: boolean;
}

const MISLUKT_TEKST: Record<TaakSoort, string> = {
  test: "Testtaak mislukt",
  mailbox: "Import mislukt",
  vies: "VIES-controle mislukt",
  ecb: "Wisselkoers ontbreekt",
  kvk: "KvK-controle mislukt",
  boekhouding: "Export mislukt",
  betaling: "Betaling mislukt",
  email: "Mail niet verzonden",
};

function tijd(iso: string): string {
  return new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Badges voor de factuurlijst. Alleen problemen: een mislukte poging waarna nog een poging volgt, of een
 * taak die is opgegeven. Gelukte, wachtende en lopende taken geven geen badge (geen ruis).
 */
export function koppelingBadges(statussen: KoppelingTaakStatus[]): KoppelingBadge[] {
  return statussen
    .filter((s) => s.status === "opgegeven" || (s.status === "wachtrij" && s.pogingen > 0))
    .sort((a, b) => TAAK_SOORTEN.indexOf(a.soort) - TAAK_SOORTEN.indexOf(b.soort))
    .map((s) =>
      s.status === "opgegeven"
        ? {
            taakId: s.taak_id,
            soort: s.soort,
            tekst: MISLUKT_TEKST[s.soort],
            soortBadge: "mislukt" as const,
            titel: `${s.laatste_fout ?? "Onbekende fout."}\nKlik om het opnieuw te proberen.`,
            kanOpnieuw: true,
          }
        : {
            taakId: s.taak_id,
            soort: s.soort,
            tekst: `${SOORT_LABELS[s.soort]}: nieuwe poging om ${tijd(s.volgende_poging_op)}`,
            soortBadge: "wacht" as const,
            titel: `Poging ${s.pogingen} van ${s.max_pogingen} mislukt: ${s.laatste_fout ?? "onbekende fout"}`,
            kanOpnieuw: false,
          },
    );
}
