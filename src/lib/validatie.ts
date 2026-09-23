import type { FactuurData, VeldFouten } from "../types";

const MARGE = 0.02;
const TOEGESTANE_TARIEVEN = [0, 9, 21];

function isVandaagOfEerder(datum: string): boolean {
  const vandaag = new Date();
  vandaag.setHours(23, 59, 59, 999);
  const ingevoerd = new Date(datum + "T00:00:00");
  return ingevoerd.getTime() <= vandaag.getTime();
}

/** Controleert het IBAN-controlegetal (mod 97). */
function isGeldigeIban(invoer: string): boolean {
  const iban = invoer.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const herschikt = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const teken of herschikt) {
    const cijfers = /\d/.test(teken) ? teken : String(teken.charCodeAt(0) - 55);
    for (const c of cijfers) rest = (rest * 10 + Number(c)) % 97;
  }
  return rest === 1;
}

/** Valideert een factuur in code (nooit door de AI) en geeft per veld een foutmelding terug. */
export function valideerFactuur(factuur: FactuurData): VeldFouten {
  const fouten: VeldFouten = {};

  // Datum niet in de toekomst
  if (factuur.factuurdatum) {
    if (Number.isNaN(Date.parse(factuur.factuurdatum))) {
      fouten["factuurdatum"] = "Ongeldige datum. Gebruik het formaat JJJJ-MM-DD.";
    } else if (!isVandaagOfEerder(factuur.factuurdatum)) {
      fouten["factuurdatum"] = "Factuurdatum ligt in de toekomst.";
    }
  }

  // Vervaldatum geldig en niet vóór de factuurdatum
  if (factuur.vervaldatum) {
    if (Number.isNaN(Date.parse(factuur.vervaldatum))) {
      fouten["vervaldatum"] = "Ongeldige datum. Gebruik het formaat JJJJ-MM-DD.";
    } else if (factuur.factuurdatum && !fouten["factuurdatum"] && factuur.vervaldatum < factuur.factuurdatum) {
      fouten["vervaldatum"] = "Vervaldatum ligt vóór de factuurdatum.";
    }
  }

  // Valuta: ISO-code van 3 letters
  if (factuur.valuta && !/^[A-Z]{3}$/.test(factuur.valuta)) {
    fouten["valuta"] = "Valuta moet een code van 3 letters zijn (bijv. EUR).";
  }

  // IBAN: controlegetal
  if (factuur.iban && !isGeldigeIban(factuur.iban)) {
    fouten["iban"] = "Ongeldig IBAN (controlegetal klopt niet).";
  }

  // Per BTW-regel: tarief moet 0, 9 of 21 zijn; btw ≈ grondslag × tarief
  factuur.btw_regels.forEach((regel, i) => {
    if (regel.tarief !== null && !TOEGESTANE_TARIEVEN.includes(regel.tarief)) {
      fouten[`btw_regels.${i}.tarief`] = "Tarief moet 0%, 9% of 21% zijn.";
    }

    if (regel.tarief !== null && regel.grondslag !== null && regel.btw_bedrag !== null) {
      const verwacht = regel.grondslag * (regel.tarief / 100);
      if (Math.abs(verwacht - regel.btw_bedrag) > MARGE) {
        fouten[`btw_regels.${i}.btw_bedrag`] =
          `BTW-bedrag klopt niet met grondslag × tarief (verwacht ≈ € ${verwacht.toFixed(2).replace(".", ",")}).`;
      }
    }
  });

  // Grondslag + BTW = totaal (marge € 0,02)
  const heeftAlleRegelWaarden = factuur.btw_regels.every(
    (r) => r.grondslag !== null && r.btw_bedrag !== null,
  );
  if (factuur.totaal_incl !== null && factuur.btw_regels.length > 0 && heeftAlleRegelWaarden) {
    const somGrondslag = factuur.btw_regels.reduce((s, r) => s + (r.grondslag ?? 0), 0);
    const somBtw = factuur.btw_regels.reduce((s, r) => s + (r.btw_bedrag ?? 0), 0);
    const verschil = Math.abs(somGrondslag + somBtw - factuur.totaal_incl);
    if (verschil > MARGE) {
      fouten["totaal_incl"] =
        `Som van grondslag + BTW (€ ${(somGrondslag + somBtw).toFixed(2).replace(".", ",")}) komt niet overeen met totaal incl. BTW.`;
    }
  }

  return fouten;
}

export function heeftFouten(fouten: VeldFouten): boolean {
  return Object.keys(fouten).length > 0;
}
