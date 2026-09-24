// Uitvoeren van één taak uit de wachtrij (koppeling_taken). Geen imports, zodat Vitest dit kan testen.
//
// Een handler geeft een resultaat terug (komt in de audit log) of gooit een fout:
//   - DefinitieveFout: een nieuwe poging lost het niet op (bijv. ontbrekende mapping) → direct opgegeven.
//   - elke andere fout: tijdelijk (netwerk, 5xx, time-out) → nieuwe poging met oplopende wachttijd.

export class DefinitieveFout extends Error {
  constructor(melding: string) {
    super(melding);
    this.name = "DefinitieveFout";
  }
}

export interface Taak {
  id: string;
  organisatie_id: string;
  soort: string;
  factuur_id: string | null;
  sleutel: string;
  payload: Record<string, unknown>;
  pogingen: number;
  max_pogingen: number;
}

export type TaakResultaat = Record<string, unknown>;
export type TaakHandler = (taak: Taak) => Promise<TaakResultaat>;

export interface Afronding {
  gelukt: boolean;
  resultaat: TaakResultaat | null;
  fout: string | null;
  opnieuw: boolean;
}

const MAX_FOUT_LENGTE = 500;

/** Foutmelding zonder stacktrace, ingekort; tokens die in een URL-query kunnen staan worden gemaskeerd. */
export function foutTekst(err: unknown): string {
  const ruw = err instanceof Error ? err.message : typeof err === "string" ? err : "Onbekende fout.";
  const gemaskeerd = ruw.replace(/([?&](?:key|token|api_key|apikey|access_token)=)[^&\s]+/gi, "$1***");
  return gemaskeerd.length > MAX_FOUT_LENGTE ? `${gemaskeerd.slice(0, MAX_FOUT_LENGTE - 1)}…` : gemaskeerd;
}

export async function voerTaakUit(taak: Taak, handlers: Record<string, TaakHandler>): Promise<Afronding> {
  const handler = handlers[taak.soort];
  if (!handler) {
    return { gelukt: false, resultaat: null, fout: `Geen verwerking beschikbaar voor taken van soort "${taak.soort}".`, opnieuw: false };
  }
  try {
    const resultaat = await handler(taak);
    return { gelukt: true, resultaat: resultaat ?? {}, fout: null, opnieuw: false };
  } catch (err) {
    return { gelukt: false, resultaat: null, fout: foutTekst(err), opnieuw: !(err instanceof DefinitieveFout) };
  }
}

/** Vergelijkt twee geheimen in constante tijd (voorkomt timing-aanvallen op het worker-geheim). */
export function gelijkGeheim(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let verschil = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    verschil |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return verschil === 0;
}
