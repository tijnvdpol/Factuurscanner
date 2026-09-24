// Verwerking per soort taak. Elke fase voegt hier zijn soort toe (vies, ecb, kvk, boekhouding, …).

import type { TaakHandler } from "../_shared/koppelingen/taken.ts";

export const HANDLERS: Record<string, TaakHandler> = {
  // Controleert of de wachtrij, de cronjob en de worker werken (knop "Test de wachtrij").
  test: () => Promise.resolve({ bericht: "De wachtrij en de worker werken.", verwerkt_op: new Date().toISOString() }),
};
