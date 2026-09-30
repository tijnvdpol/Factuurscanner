// Moneybird (live): https://developer.moneybird.com. Geen imports buiten deze map (testbaar met Vitest).
//
// Base: https://moneybird.com/api/v2/{administratie_id}/…  met Authorization: Bearer <API-token> (scope documents,
// settings en sales_invoices/contacts). Limiet: 150 verzoeken per 5 minuten (429 → nieuwe poging via de wachtrij).
//   Grootboek:      GET  /ledger_accounts.json                 (alleen kostenrekeningen)
//   Btw:            GET  /tax_rates.json?filter=tax_rate_type:purchase_invoice,active:true
//   Contacten:      GET  /contacts/filter.json?query=…         POST /contacts.json
//   Inkoopfactuur:  GET  /documents/purchase_invoices.json?filter=contact_id:…,period:JJJJMMDD..JJJJMMDD
//                   POST /documents/purchase_invoices.json     POST /documents/purchase_invoices/{id}/attachments.json

import type { AccountingProvider, Bestand, ExportFactuur, ExportLeverancier, ExternFactuur, ExternItem } from "./boekhouding.ts";
import { DefinitieveFout } from "./taken.ts";

export const MONEYBIRD_URL = "https://moneybird.com/api/v2";

const KOSTEN_TYPES = new Set(["expenses", "direct_costs", "other_income_expenses", "non_current_assets"]);

function schoon(waarde: unknown): string {
  return String(waarde ?? "").replace(/[\s.-]/g, "").toUpperCase();
}

function melding(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  if (typeof b.error === "string") return b.error;
  if (b.error && typeof b.error === "object") {
    return Object.entries(b.error as Record<string, unknown>)
      .map(([veld, fouten]) => `${veld} ${Array.isArray(fouten) ? fouten.join(", ") : String(fouten)}`)
      .join("; ");
  }
  return "";
}

export class MoneybirdLive implements AccountingProvider {
  readonly pakket = "moneybird" as const;
  readonly naam = "Moneybird";
  private readonly token: string;
  private readonly administratie: string;
  private readonly fetcher: typeof fetch;

  constructor(token: string, administratieId: string, fetcher: typeof fetch = fetch) {
    this.token = token;
    this.administratie = administratieId.trim();
    this.fetcher = fetcher;
  }

  /** Aanroep met foutvertaling: 429/5xx/netwerk → tijdelijk; 401/402/403/404/400/422 → definitief. */
  private async api<T>(methode: string, pad: string, body?: unknown): Promise<T> {
    const isFormulier = body instanceof FormData;
    let response: Response;
    try {
      response = await this.fetcher(`${MONEYBIRD_URL}/${encodeURIComponent(this.administratie)}${pad}`, {
        method: methode,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body !== undefined && !isFormulier ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : isFormulier ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`Moneybird niet bereikbaar: ${err instanceof Error ? err.message : String(err)}`);
    }

    const tekst = await response.text();
    let data: unknown = null;
    try {
      data = tekst ? JSON.parse(tekst) : null;
    } catch {
      // geen JSON
    }
    if (response.ok) return data as T;

    const uitleg = melding(data);
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`Moneybird: HTTP ${response.status}${uitleg ? ` (${uitleg})` : ""}. Nieuwe poging volgt.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new DefinitieveFout("Moneybird weigert de toegang. Controleer MONEYBIRD_TOKEN (scopes: documents, settings, sales_invoices).");
    }
    if (response.status === 402) throw new DefinitieveFout("Moneybird: voor deze actie is een (ander) abonnement nodig.");
    if (response.status === 404) {
      throw new DefinitieveFout(`Moneybird: niet gevonden (${pad.split("?")[0]}). Controleer MONEYBIRD_ADMINISTRATIE_ID.`);
    }
    throw new DefinitieveFout(`Moneybird weigerde het verzoek (HTTP ${response.status})${uitleg ? `: ${uitleg}` : ""}.`);
  }

  async grootboekrekeningen(): Promise<ExternItem[]> {
    const lijst = await this.api<Record<string, unknown>[]>("GET", "/ledger_accounts.json");
    return (lijst ?? [])
      .filter((r) => KOSTEN_TYPES.has(String(r.account_type)))
      .filter((r) => !Array.isArray(r.allowed_document_types) || r.allowed_document_types.length === 0 ||
        (r.allowed_document_types as unknown[]).includes("purchase_invoice"))
      .map((r) => ({ id: String(r.id), code: r.account_id ? String(r.account_id) : null, naam: String(r.name ?? "") }))
      .sort((a, b) => (a.code ?? a.naam).localeCompare(b.code ?? b.naam, "nl"));
  }

  async btwCodes(): Promise<ExternItem[]> {
    const lijst = await this.api<Record<string, unknown>[]>("GET", "/tax_rates.json?filter=tax_rate_type:purchase_invoice,active:true&per_page=100");
    return (lijst ?? []).map((r) => ({
      id: String(r.id),
      code: null,
      naam: String(r.name ?? ""),
      percentage: r.percentage === null || r.percentage === undefined ? null : Number(r.percentage),
    }));
  }

  async zoekOfMaakLeverancier(l: ExportLeverancier): Promise<{ id: string; naam: string; aangemaakt: boolean }> {
    const kvk = l.kvk_nummer ? schoon(l.kvk_nummer) : null;
    const btw = l.btw_nummer ? schoon(l.btw_nummer) : null;
    const naam = l.naam.trim().toLowerCase();

    for (const zoekterm of [kvk, btw, l.naam.trim()].filter((z): z is string => !!z)) {
      const lijst = await this.api<Record<string, unknown>[]>(
        "GET", `/contacts/filter.json?query=${encodeURIComponent(zoekterm)}&per_page=100`,
      );
      const treffer = (lijst ?? []).find((c) =>
        (kvk && schoon(c.chamber_of_commerce) === kvk) ||
        (btw && schoon(c.tax_number) === btw) ||
        String(c.company_name ?? "").trim().toLowerCase() === naam
      );
      if (treffer) return { id: String(treffer.id), naam: String(treffer.company_name ?? l.naam), aangemaakt: false };
    }

    const nieuw = await this.api<Record<string, unknown>>("POST", "/contacts.json", {
      contact: {
        company_name: l.naam,
        tax_number: l.btw_nummer ?? undefined,
        chamber_of_commerce: l.kvk_nummer ?? undefined,
        bank_account: l.iban ?? undefined,
      },
    });
    return { id: String(nieuw.id), naam: String(nieuw.company_name ?? l.naam), aangemaakt: true };
  }

  async zoekInkoopfactuur(leverancierId: string, referentie: string, datum: string): Promise<ExternFactuur | null> {
    // Periode ruim rond de factuurdatum (standaard filtert Moneybird op "dit jaar").
    const jaar = Number(datum.slice(0, 4)) || new Date().getFullYear();
    const filter = `contact_id:${leverancierId},period:${jaar - 1}0101..${jaar + 1}1231`;
    const lijst = await this.api<Record<string, unknown>[]>(
      "GET", `/documents/purchase_invoices.json?filter=${encodeURIComponent(filter)}&per_page=100`,
    );
    const treffer = (lijst ?? []).find((f) => String(f.reference ?? "").trim() === referentie.trim());
    return treffer ? { id: String(treffer.id), url: this.documentUrl(String(treffer.id)) } : null;
  }

  async maakInkoopfactuur(f: ExportFactuur): Promise<ExternFactuur> {
    const factuur = await this.api<Record<string, unknown>>("POST", "/documents/purchase_invoices.json", {
      purchase_invoice: {
        contact_id: f.leverancierId,
        reference: f.referentie,
        date: f.datum,
        due_date: f.vervaldatum ?? undefined,
        currency: f.valuta,
        prices_are_incl_tax: false,
        details_attributes: f.regels.map((r) => ({
          description: r.omschrijving,
          price: r.bedragExcl.toFixed(2),
          amount: "1",
          tax_rate_id: r.btwCodeId,
          ledger_account_id: r.grootboekId,
        })),
      },
    });
    return { id: String(factuur.id), url: this.documentUrl(String(factuur.id)) };
  }

  async voegBijlageToe(externId: string, bestand: Bestand): Promise<void> {
    const formulier = new FormData();
    formulier.append("file", new Blob([new Uint8Array(bestand.inhoud)], { type: bestand.mimeType }), bestand.naam);
    await this.api("POST", `/documents/purchase_invoices/${encodeURIComponent(externId)}/attachments.json`, formulier);
  }

  private documentUrl(id: string): string {
    return `https://moneybird.com/${encodeURIComponent(this.administratie)}/documents/${encodeURIComponent(id)}`;
  }
}
