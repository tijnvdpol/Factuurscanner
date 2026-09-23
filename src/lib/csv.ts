import { STATUS_LABELS, type Factuur, type Grootboekrekening } from "../types";
import { heeftFouten, valideerFactuur } from "./validatie";

const TARIEVEN = [0, 9, 21] as const;

function csvGetal(waarde: number | null): string {
  if (waarde === null || Number.isNaN(waarde)) return "";
  return waarde.toFixed(2).replace(".", ",");
}

function csvVeld(waarde: string | null): string {
  if (waarde === null) return "";
  const moetQuoten = /[;"\n]/.test(waarde);
  const veilig = waarde.replace(/"/g, '""');
  return moetQuoten ? `"${veilig}"` : veilig;
}

function somPerTarief(factuur: Factuur, tarief: number, veld: "grondslag" | "btw_bedrag"): number | null {
  const regels = factuur.btw_regels.filter((r) => r.tarief === tarief);
  if (regels.length === 0) return null;
  return regels.reduce((s, r) => s + (r[veld] ?? 0), 0);
}

export function genereerCsv(facturen: Factuur[], rekeningen: Grootboekrekening[] = []): string {
  const rekeningPerId = new Map(rekeningen.map((r) => [r.id, r]));
  const kolommen = [
    "Leverancier",
    "Factuurnummer",
    "Factuurdatum",
    "Bedrag excl. BTW",
    ...TARIEVEN.flatMap((t) => [`Grondslag ${t}%`, `BTW ${t}%`]),
    "Totaal incl. BTW",
    "Valuta",
    "Status",
    // Nieuwe kolommen achteraan, zodat bestaande imports op kolomvolgorde blijven werken
    "Verwerkingsstatus",
    "Vervaldatum",
    "IBAN leverancier",
    "BTW-nummer leverancier",
    "KvK-nummer leverancier",
    "Grootboekrekening",
    "Omschrijving grootboekrekening",
  ];

  const regels = facturen.map((f) => {
    const fouten = valideerFactuur(f);
    const status = heeftFouten(fouten) ? "Controleren" : "OK";
    const rekening = f.codering.grootboekrekening_id ? rekeningPerId.get(f.codering.grootboekrekening_id) : undefined;

    const rij = [
      csvVeld(f.leverancier),
      csvVeld(f.factuurnummer),
      csvVeld(f.factuurdatum),
      csvGetal(f.bedrag_excl),
      ...TARIEVEN.flatMap((t) => [
        csvGetal(somPerTarief(f, t, "grondslag")),
        csvGetal(somPerTarief(f, t, "btw_bedrag")),
      ]),
      csvGetal(f.totaal_incl),
      csvVeld(f.valuta),
      status,
      STATUS_LABELS[f.status],
      csvVeld(f.vervaldatum),
      csvVeld(f.iban),
      csvVeld(f.btw_nummer),
      csvVeld(f.kvk_nummer),
      csvVeld(rekening?.code ?? null),
      csvVeld(rekening?.omschrijving ?? null),
    ];
    return rij.join(";");
  });

  return [kolommen.join(";"), ...regels].join("\r\n");
}

export function downloadCsv(
  facturen: Factuur[],
  rekeningen: Grootboekrekening[] = [],
  bestandsnaam = "facturen.csv",
): void {
  downloadTekst(genereerCsv(facturen, rekeningen), bestandsnaam);
}

/** Biedt een CSV-tekst aan als download. */
export function downloadTekst(inhoud: string, bestandsnaam: string): void {
  // BOM zodat Excel de UTF-8 tekens (bijv. €) correct interpreteert
  const blob = new Blob(["﻿" + inhoud], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = bestandsnaam;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
