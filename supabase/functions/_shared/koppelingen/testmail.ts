// Testmail voor de mock-modus van de mailbox: een realistische mail met een echte PDF-factuur als bijlage.
// Het PDF wordt hier gemaakt (één pagina, standaardlettertype), met elke keer een ander factuurnummer, zodat
// dezelfde pipeline (opslaan, scannen, controleren) ermee werkt, ook met Gemini. Geen imports buiten deze map.

import type { FactuurData } from "../gemini.ts";
import type { Mail } from "./mailbox.ts";

export type TestmailSoort = "bekend" | "onbekend";

/** Afzenders van de testmails. De bekende wordt bij het simuleren aan de vertrouwde afzenders toegevoegd. */
export const TEST_AFZENDER = {
  bekend: { adres: "facturen@voorbeeld-kantoor.nl", naam: "Voorbeeld Kantoorartikelen", domein: "@voorbeeld-kantoor.nl" },
  onbekend: { adres: "billing@snel-webdesign.example", naam: "Snel Webdesign", domein: "@snel-webdesign.example" },
} as const;

function pdfTekst(tekst: string): string {
  // Standaard-PDF-lettertypen: alleen ASCII; haakjes en backslashes escapen.
  return tekst.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/([\\()])/g, "\\$1");
}

/** Minimale, geldige PDF (1 pagina, Helvetica) met de opgegeven regels. y = afstand vanaf de bovenkant. */
export function maakPdf(regels: { tekst: string; x: number; y: number; grootte?: number; vet?: boolean }[]): Uint8Array {
  const inhoud = regels
    .map((r) => `BT /${r.vet ? "F2" : "F1"} ${r.grootte ?? 10} Tf ${r.x} ${842 - r.y} Td (${pdfTekst(r.tekst)}) Tj ET`)
    .join("\n");
  const objecten = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
    `<< /Length ${inhoud.length} >>\nstream\n${inhoud}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  let pdf = "%PDF-1.4\n";
  const posities: number[] = [];
  objecten.forEach((obj, i) => {
    posities.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objecten.length + 1}\n0000000000 65535 f \n`;
  pdf += posities.map((p) => `${String(p).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objecten.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

function bedrag(n: number): string {
  return n.toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function datumNl(iso: string): string {
  const [j, m, d] = iso.split("-");
  return `${d}-${m}-${j}`;
}

function dagenErbij(iso: string, dagen: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dagen);
  return d.toISOString().slice(0, 10);
}

interface Regel {
  omschrijving: string;
  aantal: number;
  prijs: number;
}

/** De factuurgegevens van de testmail (deze staan ook in het PDF). */
export function testFactuur(soort: TestmailSoort, vandaag: string, volgnummer: string): FactuurData & { regels: Regel[]; adres: string } {
  const bekend = soort === "bekend";
  const regels: Regel[] = bekend
    ? [
        { omschrijving: "Printpapier A4 80 grams (doos 5 x 500 vel)", aantal: 6, prijs: 27.5 },
        { omschrijving: "Toner HP 59A zwart", aantal: 1, prijs: 85.0 },
      ]
    : [
        { omschrijving: "Onderhoud website september", aantal: 1, prijs: 750.0 },
        { omschrijving: "Hosting (jaarabonnement)", aantal: 1, prijs: 250.0 },
      ];
  const excl = regels.reduce((s, r) => s + r.aantal * r.prijs, 0);
  const btw = Math.round(excl * 21) / 100;
  return {
    regels,
    adres: bekend ? "Stationsplein 1, 3511 ED Utrecht" : "Kerkstraat 12, 9711 AB Groningen",
    leverancier: bekend ? "Voorbeeld Kantoorartikelen B.V." : "Snel Webdesign",
    factuurnummer: `${bekend ? "VK" : "SW"}-${vandaag.slice(0, 4)}-${volgnummer}`,
    factuurdatum: vandaag,
    vervaldatum: dagenErbij(vandaag, bekend ? 30 : 14),
    bedrag_excl: excl,
    btw_regels: [{ tarief: 21, grondslag: excl, btw_bedrag: btw }],
    totaal_incl: Math.round((excl + btw) * 100) / 100,
    valuta: "EUR",
    iban: bekend ? "NL91ABNA0417164300" : "NL02ABNA0123456789",
    btw_nummer: bekend ? "NL123456789B01" : null,
    kvk_nummer: bekend ? "12345678" : "11111198",
  };
}

export function testFactuurPdf(f: ReturnType<typeof testFactuur>): Uint8Array {
  const regels: Parameters<typeof maakPdf>[0] = [
    { tekst: f.leverancier ?? "", x: 50, y: 60, grootte: 16, vet: true },
    { tekst: f.adres, x: 50, y: 80 },
    { tekst: [f.kvk_nummer && `KvK ${f.kvk_nummer}`, f.btw_nummer && `Btw ${f.btw_nummer}`].filter(Boolean).join("   "), x: 50, y: 95 },
    { tekst: "FACTUUR", x: 50, y: 150, grootte: 20, vet: true },
    { tekst: `Factuurnummer: ${f.factuurnummer}`, x: 50, y: 180 },
    { tekst: `Factuurdatum: ${datumNl(f.factuurdatum!)}`, x: 50, y: 195 },
    { tekst: `Vervaldatum: ${datumNl(f.vervaldatum!)}`, x: 50, y: 210 },
    { tekst: "Omschrijving", x: 50, y: 250, vet: true },
    { tekst: "Aantal", x: 360, y: 250, vet: true },
    { tekst: "Bedrag (EUR)", x: 450, y: 250, vet: true },
  ];
  f.regels.forEach((r, i) => {
    const y = 270 + i * 16;
    regels.push({ tekst: r.omschrijving, x: 50, y }, { tekst: String(r.aantal), x: 360, y }, { tekst: bedrag(r.aantal * r.prijs), x: 450, y });
  });
  const y = 290 + f.regels.length * 16;
  regels.push(
    { tekst: "Subtotaal excl. btw", x: 300, y },
    { tekst: bedrag(f.bedrag_excl!), x: 450, y },
    { tekst: "Btw 21%", x: 300, y: y + 16 },
    { tekst: bedrag(f.btw_regels[0].btw_bedrag!), x: 450, y: y + 16 },
    { tekst: "Totaal incl. btw", x: 300, y: y + 34, vet: true },
    { tekst: `EUR ${bedrag(f.totaal_incl!)}`, x: 450, y: y + 34, vet: true },
    { tekst: `Graag betalen voor ${datumNl(f.vervaldatum!)} op ${f.iban} t.n.v. ${f.leverancier}, o.v.v. ${f.factuurnummer}.`, x: 50, y: y + 80, grootte: 9 },
  );
  return maakPdf(regels);
}

/** Een complete testmail naar het ontvangstadres, met de PDF-factuur (en bij "bekend" ook een logo, dat genegeerd wordt). */
export function maakTestmail(soort: TestmailSoort, aan: string, nu: Date = new Date(), volgnummer?: string): Mail {
  const vandaag = nu.toISOString().slice(0, 10);
  const nummer = volgnummer ?? String(Math.floor(1000 + Math.random() * 9000));
  const factuur = testFactuur(soort, vandaag, nummer);
  const testdata: FactuurData = {
    leverancier: factuur.leverancier,
    factuurnummer: factuur.factuurnummer,
    factuurdatum: factuur.factuurdatum,
    vervaldatum: factuur.vervaldatum,
    bedrag_excl: factuur.bedrag_excl,
    btw_regels: factuur.btw_regels,
    totaal_incl: factuur.totaal_incl,
    valuta: factuur.valuta,
    iban: factuur.iban,
    btw_nummer: factuur.btw_nummer,
    kvk_nummer: factuur.kvk_nummer,
  };
  const afzender = TEST_AFZENDER[soort];
  return {
    aan,
    van: afzender.adres,
    vanNaam: afzender.naam,
    envelopAfzender: afzender.adres,
    onderwerp: `Factuur ${factuur.factuurnummer}`,
    tekst: `Beste klant,\n\nIn de bijlage vindt u factuur ${factuur.factuurnummer}.\n\nMet vriendelijke groet,\n${afzender.naam}`,
    messageId: `<test-${nu.getTime()}-${nummer}@${afzender.domein.slice(1)}>`,
    // Mock: de bekende afzender doorstaat de echtheidscontrole, de onbekende niet (zoals bij echte spoofing)
    spf: soort === "bekend" ? "Pass" : "SoftFail",
    dkim: soort === "bekend" ? "Pass" : null,
    spam: false,
    bron: "mock",
    bijlagen: [
      { naam: `Factuur ${factuur.factuurnummer}.pdf`, mimeType: "application/pdf", inhoud: testFactuurPdf(factuur), testdata },
      ...(soort === "bekend" ? [{ naam: "logo.png", mimeType: "image/png", inhoud: new Uint8Array(1200), inline: true }] : []),
    ],
  };
}
