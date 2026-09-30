// Export naar het boekhoudpakket: de adapter-interface (AccountingProvider), de mock-adapters (Moneybird, Exact
// Online, SnelStart) en de boekhouding-taak in de worker. Geen imports buiten deze map (testbaar met Vitest).
//
// Flow per taak (één factuur):
//   1. export_gegevens: al geëxporteerd → klaar; niet goedgekeurd → definitief mislukt.
//   2. Mappings controleren: grootboekrekening en elk btw-tarief moeten gekoppeld zijn (anders definitief: een
//      nieuwe poging lost het niet op; na het koppelen kan "opnieuw proberen").
//   3. Leverancier: bestaande mapping, of zoeken in het pakket (KvK, btw-nummer, naam) en anders aanmaken.
//   4. Bestaat de inkoopfactuur (zelfde leverancier en referentie) al in het pakket, dan die koppelen in plaats van
//      een tweede aanmaken. Dat vangt de situatie af waarin het pakket de factuur wel aanmaakte, maar het antwoord
//      verloren ging.
//   5. registreer_export (vergrendelt de factuur), daarna het PDF als bijlage (mislukt dat, dan staat de export).

import type { Koppeling, Modus } from "./modus.ts";
import { DefinitieveFout, foutTekst, type TaakHandler } from "./taken.ts";

export const PAKKETTEN = ["moneybird", "exact", "snelstart"] as const;
export type Pakket = (typeof PAKKETTEN)[number];

export const PAKKET_NAMEN: Record<Pakket, string> = {
  moneybird: "Moneybird",
  exact: "Exact Online",
  snelstart: "SnelStart",
};

/** Een grootboekrekening of btw-code in het pakket. */
export interface ExternItem {
  id: string;
  code: string | null;
  naam: string;
  /** Alleen bij btw-codes. */
  percentage?: number | null;
}

export interface ExportLeverancier {
  naam: string;
  btw_nummer: string | null;
  kvk_nummer: string | null;
  iban: string | null;
}

export interface ExportRegel {
  omschrijving: string;
  bedragExcl: number;
  percentage: number;
  btwCodeId: string;
  grootboekId: string;
}

export interface ExportFactuur {
  leverancierId: string;
  referentie: string;
  datum: string;
  vervaldatum: string | null;
  valuta: string;
  regels: ExportRegel[];
}

export interface ExternFactuur {
  id: string;
  url: string | null;
}

export interface Bestand {
  naam: string;
  mimeType: string;
  inhoud: Uint8Array;
}

/** Eén boekhoudpakket. Gooit DefinitieveFout als een nieuwe poging niets oplost (toegang, validatie). */
export interface AccountingProvider {
  readonly pakket: Pakket;
  readonly naam: string;
  grootboekrekeningen(): Promise<ExternItem[]>;
  btwCodes(): Promise<ExternItem[]>;
  zoekOfMaakLeverancier(l: ExportLeverancier): Promise<{ id: string; naam: string; aangemaakt: boolean }>;
  zoekInkoopfactuur(leverancierId: string, referentie: string, datum: string): Promise<ExternFactuur | null>;
  maakInkoopfactuur(f: ExportFactuur): Promise<ExternFactuur>;
  voegBijlageToe(externId: string, bestand: Bestand): Promise<void>;
}

// ---------------------------------------------------------------------------
// Mock-adapters
// ---------------------------------------------------------------------------

/** Deterministisch id (FNV-1a), zodat een mock dezelfde invoer altijd hetzelfde id geeft. */
export function mockId(tekst: string, lengte = 9): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < tekst.length; i++) {
    h ^= tekst.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let uit = "";
  let x = h;
  while (uit.length < lengte) {
    uit += String(x % 10);
    x = Math.floor(x / 10) || Math.imul(x + uit.length, 2654435761) >>> 0;
  }
  return uit;
}

const REKENINGEN: Record<Pakket, [string, string][]> = {
  moneybird: [
    ["4000", "Huisvesting"], ["4100", "Autokosten"], ["4150", "Reiskosten"], ["4200", "Verkoopkosten"],
    ["4250", "Advertentiekosten"], ["4300", "Kantoorkosten"], ["4350", "Telefoon en internet"], ["4400", "Software"],
    ["4500", "Advieskosten"], ["4550", "Administratiekosten"], ["4600", "Verzekeringen"], ["4700", "Opleidingen"],
    ["4800", "Algemene kosten"], ["4900", "Bankkosten"], ["7000", "Inkopen"], ["7100", "Uitbesteed werk"],
  ],
  exact: [
    ["4000", "Huur bedrijfsruimte"], ["4100", "Brandstof en onderhoud auto"], ["4150", "Reis- en verblijfkosten"],
    ["4200", "Representatiekosten"], ["4250", "Reclamekosten"], ["4300", "Kantoorbenodigdheden"],
    ["4350", "Telefoon- en internetkosten"], ["4400", "Automatiseringskosten"], ["4500", "Advieskosten"],
    ["4550", "Accountantskosten"], ["4600", "Verzekeringen"], ["4700", "Opleidingskosten"], ["4800", "Algemene kosten"],
    ["4900", "Bankkosten"], ["7000", "Kostprijs van de omzet"], ["7100", "Uitbesteed werk"],
  ],
  snelstart: [
    ["4000", "Huisvestingskosten"], ["4100", "Autokosten"], ["4150", "Reiskosten"], ["4200", "Verkoopkosten"],
    ["4250", "Reclame"], ["4300", "Kantoorkosten"], ["4350", "Telefoonkosten"], ["4400", "Computerkosten"],
    ["4500", "Advieskosten"], ["4550", "Administratiekosten"], ["4600", "Verzekeringen"], ["4700", "Opleidingen"],
    ["4800", "Overige algemene kosten"], ["4900", "Bankkosten"], ["7000", "Inkoopwaarde omzet"], ["7100", "Uitbesteed werk"],
  ],
};

const BTW: Record<Pakket, [string, string, number][]> = {
  moneybird: [["21", "21% btw", 21], ["9", "9% btw", 9], ["0", "0% btw", 0], ["verlegd", "Btw verlegd", 0]],
  exact: [["1", "BTW hoog inkoop 21%", 21], ["2", "BTW laag inkoop 9%", 9], ["0", "Geen BTW 0%", 0]],
  snelstart: [["HOOG", "Hoog tarief (21%)", 21], ["LAAG", "Laag tarief (9%)", 9], ["GEEN", "Geen btw", 0]],
};

const MOCK_URL: Record<Pakket, (id: string) => string> = {
  moneybird: (id) => `https://moneybird.com/mock/documents/${id}`,
  exact: (id) => `https://start.exactonline.nl/mock/purchase/${id}`,
  snelstart: (id) => `https://web.snelstart.nl/mock/inkoopboekingen/${id}`,
};

/**
 * Mock van een pakket (geen internet of account nodig): realistische rekeningschema's en btw-codes per pakket,
 * deterministische id's. Fouten testen via het factuurnummer (de referentie):
 *   bevat "TIJDELIJK" → tijdelijke fout (nieuwe poging volgt)
 *   bevat "WEIGER"    → definitieve fout (het pakket keurt de factuur af)
 */
export class BoekhoudMock implements AccountingProvider {
  readonly pakket: Pakket;
  readonly naam: string;

  constructor(pakket: Pakket) {
    this.pakket = pakket;
    this.naam = `${PAKKET_NAMEN[pakket]} (mock)`;
  }

  grootboekrekeningen(): Promise<ExternItem[]> {
    return Promise.resolve(REKENINGEN[this.pakket].map(([code, naam]) => ({ id: this.id(`gb:${code}`), code, naam })));
  }

  btwCodes(): Promise<ExternItem[]> {
    return Promise.resolve(BTW[this.pakket].map(([code, naam, percentage]) => ({ id: this.id(`btw:${code}`), code, naam, percentage })));
  }

  zoekOfMaakLeverancier(l: ExportLeverancier): Promise<{ id: string; naam: string; aangemaakt: boolean }> {
    return Promise.resolve({ id: this.id(`rel:${(l.kvk_nummer ?? l.btw_nummer ?? l.naam).toLowerCase()}`), naam: l.naam, aangemaakt: true });
  }

  zoekInkoopfactuur(): Promise<ExternFactuur | null> {
    // Een mock onthoudt niets tussen aanroepen; dubbele export voorkomt de database (één export per factuur).
    return Promise.resolve(null);
  }

  maakInkoopfactuur(f: ExportFactuur): Promise<ExternFactuur> {
    if (/TIJDELIJK/i.test(f.referentie)) return Promise.reject(new Error(`${this.naam}: tijdelijk niet bereikbaar (503).`));
    if (/WEIGER/i.test(f.referentie)) {
      return Promise.reject(new DefinitieveFout(`${this.naam} weigerde de factuur: de periode van ${f.datum} is afgesloten.`));
    }
    const id = this.id(`inkoop:${f.leverancierId}:${f.referentie}`);
    return Promise.resolve({ id, url: MOCK_URL[this.pakket](id) });
  }

  voegBijlageToe(): Promise<void> {
    return Promise.resolve();
  }

  private id(sleutel: string): string {
    const ruw = mockId(`${this.pakket}:${sleutel}`, 12);
    // Exact en SnelStart gebruiken GUID's, Moneybird lange getallen
    return this.pakket === "moneybird"
      ? ruw
      : `${ruw.slice(0, 8)}-${ruw.slice(8, 12)}-4${mockId(sleutel, 3)}-8${mockId(ruw, 3)}-${mockId(sleutel + ruw, 12)}`;
  }
}

// ---------------------------------------------------------------------------
// De boekhouding-taak
// ---------------------------------------------------------------------------

interface ExportGegevens {
  status: "exporteren" | "al_geexporteerd" | "niet_toegestaan";
  reden?: string;
  provider: Pakket;
  organisatie_id: string;
  factuur: {
    id: string;
    factuurnummer: string | null;
    factuurdatum: string;
    vervaldatum: string | null;
    valuta: string;
    bedrag_excl: number | null;
    totaal_incl: number | null;
    bestand_pad: string | null;
    bestandsnaam: string | null;
  };
  btw_regels: { tarief: number | null; grondslag: number | null; btw_bedrag: number | null }[];
  leverancier: (ExportLeverancier & { id: string }) | null;
  grootboekrekening: { id: string; code: string; omschrijving: string } | null;
  mappings: {
    grootboek: { extern_id: string; extern_naam: string | null } | null;
    btw: Record<string, { extern_id: string; extern_naam: string | null }>;
    leverancier: { extern_id: string; extern_naam: string | null } | null;
  };
}

export interface BoekhoudDeps {
  modus(organisatieId: string, koppeling: Koppeling): Promise<Modus>;
  rpc(functie: string, args: Record<string, unknown>): Promise<unknown>;
  provider(pakket: Pakket, modus: Modus): AccountingProvider;
  /** Het originele bestand uit Storage. */
  bestand(pad: string): Promise<Uint8Array>;
}

/** Btw-percentage als sleutel van de mapping: 21 → "21", 9.0 → "9", 5.5 → "5.5". */
export function btwSleutel(percentage: number): string {
  return String(Math.round(percentage * 100) / 100);
}

const WAAR = "Koppel hem bij Koppelingen → Boekhoudpakket en klik daarna bij de factuur op \"Export mislukt\" om het opnieuw te proberen.";

/** De boekingsregels: één per btw-regel; zonder btw-regels alleen als excl. = incl. (0%). */
export function bouwRegels(g: ExportGegevens, pakketNaam: string): ExportRegel[] {
  const gb = g.grootboekrekening;
  if (!gb) throw new DefinitieveFout("De factuur heeft geen grootboekrekening.");
  if (!g.mappings.grootboek) {
    throw new DefinitieveFout(`Grootboekrekening ${gb.code} ${gb.omschrijving} is niet gekoppeld aan ${pakketNaam}. ${WAAR}`);
  }
  const omschrijving = `${g.leverancier?.naam ?? "Inkoop"}${g.factuur.factuurnummer ? ` ${g.factuur.factuurnummer}` : ""}`;

  let regels = g.btw_regels
    .filter((r) => r.grondslag !== null)
    .map((r) => ({ percentage: Number(r.tarief ?? 0), bedragExcl: Number(r.grondslag) }));
  if (regels.length === 0) {
    const excl = g.factuur.bedrag_excl;
    const incl = g.factuur.totaal_incl;
    if (excl !== null && incl !== null && Math.abs(Number(excl) - Number(incl)) < 0.005) {
      regels = [{ percentage: 0, bedragExcl: Number(excl) }];
    } else {
      throw new DefinitieveFout("De factuur heeft geen btw-regels. Vul de btw-specificatie aan (de factuur moet daarna opnieuw worden goedgekeurd).");
    }
  }

  return regels.map((r) => {
    const btw = g.mappings.btw[btwSleutel(r.percentage)];
    if (!btw) throw new DefinitieveFout(`Btw-tarief ${btwSleutel(r.percentage)}% is niet gekoppeld aan ${pakketNaam}. ${WAAR}`);
    return {
      omschrijving: regels.length > 1 ? `${omschrijving} (${btwSleutel(r.percentage)}% btw)` : omschrijving,
      bedragExcl: r.bedragExcl,
      percentage: r.percentage,
      btwCodeId: btw.extern_id,
      grootboekId: g.mappings.grootboek!.extern_id,
    };
  });
}

function mimeType(naam: string | null): string {
  const ext = (naam ?? "").toLowerCase().split(".").pop();
  return ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
}

export function boekhoudHandler(d: BoekhoudDeps): TaakHandler {
  return async (taak) => {
    const factuurId = taak.factuur_id ?? taak.sleutel;
    const g = (await d.rpc("export_gegevens", { p_factuur_id: factuurId })) as ExportGegevens;
    if (g.status === "al_geexporteerd") return { omschrijving: g.reden ?? "Al geëxporteerd." };
    if (g.status === "niet_toegestaan") throw new DefinitieveFout(g.reden ?? "Deze factuur mag niet worden geëxporteerd.");

    const modus = await d.modus(g.organisatie_id, "boekhouding");
    const p = d.provider(g.provider, modus);
    const regels = bouwRegels(g, p.naam);
    if (!g.leverancier) throw new DefinitieveFout("De factuur heeft geen leverancier.");

    // Leverancier (contact/relatie) in het pakket
    let leverancierId = g.mappings.leverancier?.extern_id ?? null;
    let leverancierNieuw = false;
    if (!leverancierId) {
      const gevonden = await p.zoekOfMaakLeverancier(g.leverancier);
      leverancierId = gevonden.id;
      leverancierNieuw = gevonden.aangemaakt;
      await d.rpc("sla_leverancier_mapping_op", {
        p_organisatie_id: g.organisatie_id,
        p_provider: g.provider,
        p_leverancier_id: g.leverancier.id,
        p_extern_id: gevonden.id,
        p_extern_naam: gevonden.naam,
      });
    }

    const referentie = g.factuur.factuurnummer ?? `FS-${g.factuur.id.slice(0, 8)}`;
    const bestaand = await p.zoekInkoopfactuur(leverancierId, referentie, g.factuur.factuurdatum);
    const extern = bestaand ??
      (await p.maakInkoopfactuur({
        leverancierId,
        referentie,
        datum: g.factuur.factuurdatum,
        vervaldatum: g.factuur.vervaldatum,
        valuta: g.factuur.valuta,
        regels,
      }));

    await d.rpc("registreer_export", {
      p_factuur_id: g.factuur.id,
      p_provider: g.provider,
      p_modus: modus,
      p_extern_id: extern.id,
      p_extern_url: extern.url,
      p_details: { leverancier_extern_id: leverancierId, leverancier_aangemaakt: leverancierNieuw, al_aanwezig: !!bestaand, regels: regels.length },
    });

    // Bijlage na het registreren: mislukt die, dan staat de export toch (en komt er geen tweede boeking).
    let bijlage = "";
    if (!bestaand && g.factuur.bestand_pad) {
      try {
        await p.voegBijlageToe(extern.id, {
          naam: g.factuur.bestandsnaam ?? "factuur.pdf",
          mimeType: mimeType(g.factuur.bestandsnaam),
          inhoud: await d.bestand(g.factuur.bestand_pad),
        });
      } catch (err) {
        bijlage = `; bijlage niet toegevoegd: ${foutTekst(err)}`;
      }
    }

    return {
      omschrijving: `Geëxporteerd naar ${p.naam} (${extern.id})${bestaand ? ", stond er al en is gekoppeld" : ""}` +
        `${leverancierNieuw ? `; leverancier ${g.leverancier.naam} aangemaakt` : ""}${bijlage}`,
      pakket: g.provider,
      modus,
      extern_id: extern.id,
    };
  };
}
