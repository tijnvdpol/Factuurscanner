// Verwerking van de verrijkingstaken (vies, ecb, kvk) in de worker. Geen imports buiten deze map, zodat de
// logica met Vitest te testen is; de database-aanroepen en providers worden meegegeven (VerrijkingDeps).

import type { Koppeling, Modus } from "./modus.ts";
import type { TaakHandler } from "./taken.ts";
import type { KoersProvider } from "./ecb.ts";
import type { KvkProvider } from "./kvk.ts";
import type { ViesProvider } from "./vies.ts";

export interface VerrijkingDeps {
  modus(organisatieId: string, koppeling: Koppeling): Promise<Modus>;
  /** Roept een databasefunctie aan (service role) en geeft het resultaat terug; gooit bij een fout. */
  rpc(functie: string, args: Record<string, unknown>): Promise<unknown>;
  vies(modus: Modus): ViesProvider;
  ecb(modus: Modus): KoersProvider;
  kvk(modus: Modus, naamOpFactuur: string | null): KvkProvider;
}

function nl(getal: number, decimalen: number): string {
  return getal.toLocaleString("nl-NL", { minimumFractionDigits: decimalen, maximumFractionDigits: decimalen });
}

function tekst(waarde: unknown): string | null {
  return typeof waarde === "string" && waarde.trim() !== "" ? waarde.trim() : null;
}

export function verrijkingHandlers(d: VerrijkingDeps): Record<string, TaakHandler> {
  return {
    async vies(taak) {
      const nummer = tekst(taak.payload.btw_nummer) ?? taak.sleutel;
      const modus = await d.modus(taak.organisatie_id, "vies");
      const r = await d.vies(modus).controleer(nummer);
      const bijgewerkt = await d.rpc("sla_verificatie_op", {
        p_organisatie_id: taak.organisatie_id,
        p_soort: "vies",
        p_sleutel: nummer,
        p_uitkomst: r.geldig ? "geldig" : "ongeldig",
        p_details: { naam: r.naam, adres: r.adres, gecontroleerd_op: r.gecontroleerdOp },
        p_bron: modus,
      });
      return {
        omschrijving: r.geldig
          ? `btw-nummer ${nummer} is geldig${r.naam ? ` (${r.naam})` : ""}`
          : `btw-nummer ${nummer} is ongeldig`,
        modus,
        facturen_bijgewerkt: bijgewerkt,
      };
    },

    async ecb(taak) {
      const valuta = tekst(taak.payload.valuta)?.toUpperCase();
      const datum = tekst(taak.payload.datum);
      if (!valuta || !datum || !taak.factuur_id) throw new Error("Taak zonder valuta, datum of factuur.");
      const modus = await d.modus(taak.organisatie_id, "ecb");
      const bron = modus === "live" ? "ecb" : "mock";

      // Cache: alleen een koers van precies deze datum (anders kan er intussen een nieuwere publicatie zijn).
      const gecachet = (await d.rpc("zoek_wisselkoers", { p_valuta: valuta, p_datum: datum, p_bron: bron })) as
        | { datum: string; koers: number | string }[]
        | null;
      const treffer = gecachet?.find((k) => k.datum === datum);
      const koers = treffer
        ? { valuta, datum: treffer.datum, koers: Number(treffer.koers) }
        : await d.ecb(modus).koers(valuta, datum);

      const euro = (await d.rpc("verwerk_wisselkoers", {
        p_factuur_id: taak.factuur_id,
        p_valuta: valuta,
        p_datum: datum,
        p_koers_datum: koers.datum,
        p_koers: koers.koers,
        p_bron: bron,
      })) as number | string | null;

      if (euro === null) {
        return { omschrijving: "factuur is intussen gewijzigd; koers niet toegepast", modus, koers: koers.koers, koers_datum: koers.datum };
      }
      return {
        omschrijving: `${valuta} omgerekend naar € ${nl(Number(euro), 2)} (koers ${nl(koers.koers, 4)} van ${koers.datum}${bron === "mock" ? ", mock" : ""})`,
        modus,
        koers: koers.koers,
        koers_datum: koers.datum,
        bedrag_eur: Number(euro),
        uit_cache: !!treffer,
      };
    },

    async kvk(taak) {
      const nummer = tekst(taak.payload.kvk_nummer) ?? taak.sleutel;
      const modus = await d.modus(taak.organisatie_id, "kvk");
      const bedrijf = await d.kvk(modus, tekst(taak.payload.naam)).basisprofiel(nummer);
      const uitkomst = !bedrijf ? "niet_gevonden" : bedrijf.datumEinde ? "uitgeschreven" : "gevonden";
      const bijgewerkt = await d.rpc("sla_verificatie_op", {
        p_organisatie_id: taak.organisatie_id,
        p_soort: "kvk",
        p_sleutel: nummer,
        p_uitkomst: uitkomst,
        p_details: bedrijf
          ? {
              naam: bedrijf.naam,
              statutaire_naam: bedrijf.statutaireNaam,
              handelsnamen: bedrijf.handelsnamen,
              datum_einde: bedrijf.datumEinde,
              adres: bedrijf.adres,
            }
          : {},
        p_bron: modus,
      });
      return {
        omschrijving:
          uitkomst === "niet_gevonden"
            ? `KvK-nummer ${nummer} niet gevonden`
            : `KvK ${nummer}: ${bedrijf?.naam ?? "onbekende naam"}${uitkomst === "uitgeschreven" ? " (uitgeschreven)" : ""}`,
        modus,
        facturen_bijgewerkt: bijgewerkt,
      };
    },
  };
}
