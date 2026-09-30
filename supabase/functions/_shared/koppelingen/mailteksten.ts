// Teksten van de notificatiemails (onderwerp, HTML en platte tekst). Geen imports (testbaar met Vitest).
// Alles wat uit een factuur komt (leveranciersnaam, nummer, signalen) is onbetrouwbare invoer: in HTML altijd
// via esc().

export interface FactuurSamenvatting {
  id: string;
  leverancier: string | null;
  factuurnummer: string | null;
  factuurdatum: string | null;
  vervaldatum: string | null;
  valuta: string;
  totaal_incl: number | null;
  bedrag_eur: number | null;
  status: string;
  bron: string;
  grootboekrekening: string | null;
  ingevoerd_door: string | null;
  gecontroleerd_door: string | null;
  afkeur_reden: string | null;
  signalen: { ernst: string; bericht: string }[];
}

export type NotificatieSoort = "goedkeuren" | "afgekeurd" | "export_mislukt" | "bijna_vervallen" | "test";

export interface MailGegevens {
  soort: NotificatieSoort;
  organisatie: string;
  ontvanger: string;
  facturen: FactuurSamenvatting[];
  details: Record<string, unknown>;
  /** Basis-URL van de app, zonder / aan het eind. */
  appUrl: string;
  /** Alleen bij goedkeuren. */
  actie?: { token: string; verlooptOp: Date; blokkade: string | null };
}

export interface OpgesteldeMail {
  onderwerp: string;
  html: string;
  tekst: string;
}

const STATUS: Record<string, string> = {
  gescand: "Gescand",
  gecontroleerd: "Gecontroleerd",
  goedgekeurd: "Goedgekeurd",
  betaald: "Betaald",
  afgekeurd: "Afgekeurd",
};

export function esc(waarde: unknown): string {
  return String(waarde ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function bedrag(waarde: number | null, valuta = "EUR"): string {
  if (waarde === null || waarde === undefined) return "onbekend";
  try {
    return new Intl.NumberFormat("nl-NL", { style: "currency", currency: valuta }).format(Number(waarde));
  } catch {
    return `${valuta} ${Number(waarde).toFixed(2)}`;
  }
}

export function datum(iso: string | null): string {
  if (!iso) return "onbekend";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

/** "25-09-2026 om 14:00" (Nederlandse tijd). */
function datumTijd(d: Date): string {
  const zone = { timeZone: "Europe/Amsterdam" } as const;
  const dag = d.toLocaleDateString("nl-NL", { ...zone, day: "2-digit", month: "2-digit", year: "numeric" });
  const tijd = d.toLocaleTimeString("nl-NL", { ...zone, hour: "2-digit", minute: "2-digit" });
  return `${dag} om ${tijd}`;
}

/** "€ 1.210,00", of "$ 400,00 (≈ € 344,18)" bij vreemde valuta. */
export function bedragMetEuro(f: FactuurSamenvatting): string {
  const hoofd = bedrag(f.totaal_incl, f.valuta);
  if (f.valuta === "EUR") return hoofd;
  return f.bedrag_eur === null ? `${hoofd} (koers volgt)` : `${hoofd} (≈ ${bedrag(f.bedrag_eur)})`;
}

function naamFactuur(f: FactuurSamenvatting): string {
  return `${f.leverancier ?? "Onbekende leverancier"}${f.factuurnummer ? ` ${f.factuurnummer}` : ""}`;
}

export function mailActieLink(appUrl: string, token: string, keuze: "goedkeuren" | "afkeuren"): string {
  return `${appUrl}/#mail-actie=${encodeURIComponent(token)}&keuze=${keuze}`;
}

// ---------------------------------------------------------------------------
// Opmaak
// ---------------------------------------------------------------------------

function knop(href: string, tekst: string, kleur: string): string {
  return `<a href="${esc(href)}" style="display:inline-block;padding:10px 20px;margin:0 8px 8px 0;border-radius:6px;background:${kleur};color:#ffffff;font-weight:600;text-decoration:none">${esc(tekst)}</a>`;
}

function tabel(rijen: [string, string][]): string {
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:12px 0;font-size:14px">${rijen
    .map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#64748b;vertical-align:top">${esc(k)}</td><td style="padding:4px 0;color:#0f172a">${esc(v)}</td></tr>`)
    .join("")}</table>`;
}

function opmaak(titel: string, inhoud: string, voet: string): string {
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(titel)}</title></head>
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:24px">
<p style="margin:0 0 4px;font-size:12px;color:#94a3b8">Factuurscanner</p>
<h1 style="margin:0 0 16px;font-size:18px">${esc(titel)}</h1>
${inhoud}
<p style="margin:24px 0 0;font-size:12px;color:#94a3b8">${voet}</p>
</div></body></html>`;
}

function factuurRijen(f: FactuurSamenvatting): [string, string][] {
  return [
    ["Leverancier", f.leverancier ?? "onbekend"],
    ["Factuurnummer", f.factuurnummer ?? "onbekend"],
    ["Factuurdatum", datum(f.factuurdatum)],
    ["Vervaldatum", datum(f.vervaldatum)],
    ["Bedrag incl. btw", bedragMetEuro(f)],
    ["Grootboekrekening", f.grootboekrekening ?? "nog niet gekozen"],
    ["Ingevoerd door", f.ingevoerd_door ?? (f.bron === "mailbox" ? "via de mailbox" : "onbekend")],
    ["Gecontroleerd door", f.gecontroleerd_door ?? "nog niet"],
  ];
}

function tekstRijen(rijen: [string, string][]): string {
  return rijen.map(([k, v]) => `${k}: ${v}`).join("\n");
}

const ERNST: Record<string, string> = { kritiek: "Kritiek", waarschuwing: "Waarschuwing", info: "Info" };

function signalenHtml(f: FactuurSamenvatting): string {
  if (f.signalen.length === 0) return "";
  return `<p style="margin:16px 0 4px;font-weight:600">Aandachtspunten</p><ul style="margin:0;padding-left:20px;font-size:14px">${f.signalen
    .slice(0, 6)
    .map((s) => `<li style="margin:2px 0"><strong>${esc(ERNST[s.ernst] ?? s.ernst)}:</strong> ${esc(s.bericht)}</li>`)
    .join("")}</ul>`;
}

function signalenTekst(f: FactuurSamenvatting): string {
  if (f.signalen.length === 0) return "";
  return `\n\nAandachtspunten:\n${f.signalen.slice(0, 6).map((s) => `- ${ERNST[s.ernst] ?? s.ernst}: ${s.bericht}`).join("\n")}`;
}

// ---------------------------------------------------------------------------
// Per soort
// ---------------------------------------------------------------------------

function goedkeuren(g: MailGegevens): OpgesteldeMail {
  const f = g.facturen[0];
  if (!f || !g.actie) throw new Error("Goedkeuringsmail zonder factuur of actie.");
  const titel = `Goedkeuren: ${naamFactuur(f)}`;
  const ja = mailActieLink(g.appUrl, g.actie.token, "goedkeuren");
  const nee = mailActieLink(g.appUrl, g.actie.token, "afkeuren");
  const geldig = datumTijd(g.actie.verlooptOp);
  const blokkade = g.actie.blokkade;

  const html = opmaak(
    titel,
    `<p style="margin:0;font-size:14px">Er staat een factuur klaar die je kunt goedkeuren (${esc(g.organisatie)}).</p>
${tabel(factuurRijen(f))}
${signalenHtml(f)}
${blokkade ? `<p style="margin:16px 0;padding:10px 12px;border-radius:6px;background:#fef3c7;color:#92400e;font-size:14px">Goedkeuren kan nu nog niet: ${esc(blokkade)} Open de factuur in de app.</p>` : ""}
<div style="margin:20px 0 8px">${blokkade ? "" : knop(ja, "Goedkeuren", "#047857")}${knop(nee, "Afkeuren", "#b91c1c")}</div>
<p style="margin:8px 0 0;font-size:14px"><a href="${esc(g.appUrl)}/" style="color:#334155">Bekijk de factuur in de app</a></p>`,
    `Je bevestigt de keuze op de volgende pagina. De knoppen werken één keer en zijn geldig tot ${esc(geldig)}. ` +
      `Stuur deze mail niet door: met deze knoppen keur je goed of af op jouw naam.`,
  );
  const tekst = `Er staat een factuur klaar die je kunt goedkeuren (${g.organisatie}).

${tekstRijen(factuurRijen(f))}${signalenTekst(f)}
${blokkade ? `\nGoedkeuren kan nu nog niet: ${blokkade} Open de factuur in de app.\n` : `\nGoedkeuren: ${ja}`}
Afkeuren: ${nee}

De links werken één keer en zijn geldig tot ${geldig}. Stuur deze mail niet door.
App: ${g.appUrl}/`;
  return { onderwerp: `${titel} (${bedragMetEuro(f)})`, html, tekst };
}

function afgekeurd(g: MailGegevens): OpgesteldeMail {
  const f = g.facturen[0];
  if (!f) throw new Error("Afkeurmail zonder factuur.");
  const reden = typeof g.details.reden === "string" ? g.details.reden : (f.afkeur_reden ?? "geen reden opgegeven");
  const door = typeof g.details.afgekeurd_door_email === "string" ? g.details.afgekeurd_door_email : "een collega";
  const titel = `Afgekeurd: ${naamFactuur(f)}`;
  const rijen: [string, string][] = [["Reden", reden], ["Afgekeurd door", door], ...factuurRijen(f).slice(0, 5)];
  return {
    onderwerp: titel,
    html: opmaak(
      titel,
      `<p style="margin:0;font-size:14px">Een factuur die jij hebt ingevoerd of gecontroleerd is afgekeurd (${esc(g.organisatie)}).</p>
${tabel(rijen)}
<p style="margin:16px 0 0;font-size:14px">Corrigeer de factuur en zet hem terug naar "Gescand", of laat hem afgekeurd staan.</p>
<div style="margin:16px 0 0">${knop(`${g.appUrl}/`, "Open de app", "#0f172a")}</div>`,
      "Je krijgt deze mail omdat je de factuur hebt ingevoerd of gecontroleerd.",
    ),
    tekst: `Een factuur die jij hebt ingevoerd of gecontroleerd is afgekeurd (${g.organisatie}).

${tekstRijen(rijen)}

Open de app: ${g.appUrl}/`,
  };
}

function exportMislukt(g: MailGegevens): OpgesteldeMail {
  const f = g.facturen[0];
  const fout = typeof g.details.fout === "string" ? g.details.fout : "onbekende fout";
  const titel = f ? `Export mislukt: ${naamFactuur(f)}` : "Export naar het boekhoudpakket mislukt";
  const rijen: [string, string][] = [["Fout", fout], ...(f ? factuurRijen(f).slice(0, 5) : [])];
  return {
    onderwerp: titel,
    html: opmaak(
      titel,
      `<p style="margin:0;font-size:14px">Een export naar het boekhoudpakket is na alle automatische pogingen mislukt (${esc(g.organisatie)}).</p>
${tabel(rijen)}
<p style="margin:16px 0 0;font-size:14px">Los de oorzaak op (bijv. de mapping) en klik in de factuurlijst op de badge "Export mislukt" om het opnieuw te proberen.</p>
<div style="margin:16px 0 0">${knop(`${g.appUrl}/`, "Open de app", "#0f172a")}</div>`,
      "Je krijgt deze mail als controller of beheerder.",
    ),
    tekst: `Een export naar het boekhoudpakket is na alle automatische pogingen mislukt (${g.organisatie}).

${tekstRijen(rijen)}

Los de oorzaak op en klik in de factuurlijst op "Export mislukt" om het opnieuw te proberen.
Open de app: ${g.appUrl}/`,
  };
}

function bijnaVervallen(g: MailGegevens): OpgesteldeMail {
  const n = g.facturen.length;
  const dagen = typeof g.details.dagen === "number" ? g.details.dagen : 3;
  const titel = n === 1 ? "1 factuur vervalt binnenkort" : `${n} facturen vervallen binnenkort`;
  const totaal = g.facturen.reduce((som, f) => som + (f.bedrag_eur ?? 0), 0);
  const rijenHtml = g.facturen
    .map(
      (f) => `<tr>
<td style="padding:6px 12px 6px 0;border-top:1px solid #e2e8f0">${esc(datum(f.vervaldatum))}</td>
<td style="padding:6px 12px 6px 0;border-top:1px solid #e2e8f0">${esc(naamFactuur(f))}</td>
<td style="padding:6px 12px 6px 0;border-top:1px solid #e2e8f0;text-align:right;white-space:nowrap">${esc(bedragMetEuro(f))}</td>
<td style="padding:6px 0;border-top:1px solid #e2e8f0;color:#64748b">${esc(STATUS[f.status] ?? f.status)}</td></tr>`,
    )
    .join("");
  return {
    onderwerp: `${titel} (${g.organisatie})`,
    html: opmaak(
      titel,
      `<p style="margin:0;font-size:14px">Deze openstaande facturen vervallen binnen ${dagen} dag${dagen === 1 ? "" : "en"} (${esc(g.organisatie)}).</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:12px 0;font-size:14px;width:100%">
<tr style="color:#64748b;text-align:left"><th style="padding:4px 12px 4px 0;font-weight:500">Vervalt</th><th style="padding:4px 12px 4px 0;font-weight:500">Factuur</th><th style="padding:4px 12px 4px 0;font-weight:500;text-align:right">Bedrag</th><th style="padding:4px 0;font-weight:500">Status</th></tr>
${rijenHtml}</table>
<p style="margin:0;font-size:14px">Totaal ≈ ${esc(bedrag(totaal))}</p>
<div style="margin:16px 0 0">${knop(`${g.appUrl}/`, "Open de app", "#0f172a")}</div>`,
      "Je krijgt deze herinnering één keer per factuur, als controller of beheerder.",
    ),
    tekst: `Deze openstaande facturen vervallen binnen ${dagen} dag${dagen === 1 ? "" : "en"} (${g.organisatie}):

${g.facturen.map((f) => `- ${datum(f.vervaldatum)}  ${naamFactuur(f)}  ${bedragMetEuro(f)}  (${STATUS[f.status] ?? f.status})`).join("\n")}

Totaal ≈ ${bedrag(totaal)}
Open de app: ${g.appUrl}/`,
  };
}

function test(g: MailGegevens): OpgesteldeMail {
  const titel = "Testmail van de Factuurscanner";
  return {
    onderwerp: titel,
    html: opmaak(
      titel,
      `<p style="margin:0;font-size:14px">De e-mailnotificaties van ${esc(g.organisatie)} werken. Deze mail is verstuurd naar ${esc(g.ontvanger)}.</p>
<div style="margin:16px 0 0">${knop(`${g.appUrl}/`, "Open de app", "#0f172a")}</div>`,
      "Aangevraagd via de pagina Koppelingen.",
    ),
    tekst: `De e-mailnotificaties van ${g.organisatie} werken. Deze mail is verstuurd naar ${g.ontvanger}.\n\nOpen de app: ${g.appUrl}/`,
  };
}

export function stelMailOp(g: MailGegevens): OpgesteldeMail {
  switch (g.soort) {
    case "goedkeuren":
      return goedkeuren(g);
    case "afgekeurd":
      return afgekeurd(g);
    case "export_mislukt":
      return exportMislukt(g);
    case "bijna_vervallen":
      return bijnaVervallen(g);
    case "test":
      return test(g);
  }
}

/** Korte omschrijving voor de audit log, bijv. "Goedkeuringsverzoek gemaild aan jan@bedrijf.nl". */
export function omschrijvingVerzonden(soort: NotificatieSoort, aan: string): string {
  const wat: Record<NotificatieSoort, string> = {
    goedkeuren: "Goedkeuringsverzoek",
    afgekeurd: "Melding afgekeurd",
    export_mislukt: "Melding export mislukt",
    bijna_vervallen: "Herinnering vervaldatum",
    test: "Testmail",
  };
  return `${wat[soort]} gemaild aan ${aan}`;
}
