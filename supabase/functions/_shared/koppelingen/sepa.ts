// SEPA-betaalbestand (pain.001.001.03, Customer Credit Transfer Initiation). Geen imports buiten deze map, zodat
// de frontend (download) en de worker (mock-bank) hetzelfde bestand maken.
//
// De database valideert bij het maken van de batch (IBAN, bedrag, euro, SEPA-land, kritieke signalen); dit bestand
// controleert het nog een keer vlak voor het schrijven, zodat er nooit een ongeldig bestand naar de bank gaat.
// Tekens: alleen de SEPA-tekenset (a-z A-Z 0-9 / - ? : ( ) . , ' + spatie); accenten worden weggehaald.

import { DefinitieveFout } from "./taken.ts";

export interface SepaPost {
  endToEndId: string;
  /** In euro, maximaal 2 decimalen. */
  bedrag: number;
  naam: string;
  iban: string;
  bic?: string | null;
  omschrijving: string;
}

export interface SepaBatch {
  /** Uniek per opdrachtgever (MsgId), maximaal 35 tekens. */
  msgId: string;
  aangemaaktOp: string | Date;
  /** Gewenste uitvoerdatum (JJJJ-MM-DD). */
  uitvoerdatum: string;
  debiteur: { naam: string; iban: string; bic: string | null };
  posten: SepaPost[];
}

const MAX_BEDRAG_CENTEN = 99_999_999_999;

/** Tekst in de SEPA-tekenset, ingekort tot max tekens. */
export function sepaTekst(tekst: string | null | undefined, max: number): string {
  const schoon = (tekst ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[æÆ]/g, "ae")
    .replace(/[øØ]/g, "o")
    .replace(/&/g, "+")
    .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return schoon.slice(0, max).trim();
}

export function schoonIban(iban: string): string {
  return iban.replace(/\s/g, "").toUpperCase();
}

/** Formaat en mod-97-controle (ISO 13616). */
export function isGeldigIban(iban: string): boolean {
  const i = schoonIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(i)) return false;
  const verschoven = i.slice(4) + i.slice(0, 4);
  let rest = 0;
  for (const teken of verschoven) {
    const waarde = /\d/.test(teken) ? teken : String(teken.charCodeAt(0) - 55);
    for (const cijfer of waarde) rest = (rest * 10 + Number(cijfer)) % 97;
  }
  return rest === 1;
}

export function isGeldigeBic(bic: string): boolean {
  return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic.trim().toUpperCase());
}

export function naarCenten(bedrag: number): number {
  return Math.round(bedrag * 100);
}

function bedragTekst(centen: number): string {
  return `${Math.floor(centen / 100)}.${String(centen % 100).padStart(2, "0")}`;
}

function xml(tekst: string): string {
  return tekst.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "2026-09-24T14:30:05" in Nederlandse tijd (zoals de Nederlandse banken het in hun voorbeelden gebruiken). */
function lokaleTijd(moment: string | Date): string {
  const delen = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(new Date(moment)).map((p) => [p.type, p.value]),
  );
  return `${delen.year}-${delen.month}-${delen.day}T${delen.hour === "24" ? "00" : delen.hour}:${delen.minute}:${delen.second}`;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,34}$/;

/** Controleert de batch; gooit DefinitieveFout met alle problemen tegelijk. */
export function controleerBatch(b: SepaBatch): void {
  const fouten: string[] = [];
  if (!ID.test(b.msgId)) fouten.push(`Ongeldig batchnummer: ${b.msgId}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.uitvoerdatum)) fouten.push(`Ongeldige uitvoerdatum: ${b.uitvoerdatum}`);
  if (!sepaTekst(b.debiteur.naam, 70)) fouten.push("De naam van de betalende rekening ontbreekt.");
  if (!isGeldigIban(b.debiteur.iban)) fouten.push(`Het IBAN van de betalende rekening (${b.debiteur.iban}) is ongeldig.`);
  if (b.debiteur.bic && !isGeldigeBic(b.debiteur.bic)) fouten.push(`De BIC van de betalende rekening (${b.debiteur.bic}) is ongeldig.`);
  if (b.posten.length === 0) fouten.push("De batch bevat geen betalingen.");

  const ids = new Set<string>();
  for (const p of b.posten) {
    const wie = `${p.naam} (${p.omschrijving})`;
    if (!ID.test(p.endToEndId) || ids.has(p.endToEndId)) fouten.push(`${wie}: ongeldig of dubbel kenmerk ${p.endToEndId}`);
    ids.add(p.endToEndId);
    const centen = naarCenten(p.bedrag);
    if (!Number.isFinite(p.bedrag) || Math.abs(p.bedrag * 100 - centen) > 1e-6) fouten.push(`${wie}: bedrag heeft meer dan 2 decimalen`);
    if (centen <= 0 || centen > MAX_BEDRAG_CENTEN) fouten.push(`${wie}: bedrag moet tussen € 0,01 en € 999.999.999,99 liggen`);
    if (!isGeldigIban(p.iban)) fouten.push(`${wie}: IBAN ${p.iban} is ongeldig`);
    if (!sepaTekst(p.naam, 70)) fouten.push(`${wie}: naam van de ontvanger ontbreekt`);
  }
  if (fouten.length > 0) throw new DefinitieveFout(`Het betaalbestand kan niet worden gemaakt: ${fouten.join("; ")}.`);
}

/** pain.001.001.03 als XML-tekst. Zelfde batch → exact hetzelfde bestand. */
export function maakPain001(b: SepaBatch): string {
  controleerBatch(b);
  const totaal = b.posten.reduce((som, p) => som + naarCenten(p.bedrag), 0);
  const naam = xml(sepaTekst(b.debiteur.naam, 70));
  const bic = b.debiteur.bic?.trim().toUpperCase();

  const transacties = b.posten
    .map((p) => {
      const bicOntvanger = p.bic?.trim().toUpperCase();
      return `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${xml(p.endToEndId)}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="EUR">${bedragTekst(naarCenten(p.bedrag))}</InstdAmt></Amt>${
        bicOntvanger && isGeldigeBic(bicOntvanger) ? `\n        <CdtrAgt><FinInstnId><BIC>${xml(bicOntvanger)}</BIC></FinInstnId></CdtrAgt>` : ""}
        <Cdtr><Nm>${xml(sepaTekst(p.naam, 70))}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${xml(schoonIban(p.iban))}</IBAN></Id></CdtrAcct>
        <RmtInf><Ustrd>${xml(sepaTekst(p.omschrijving, 140) || p.endToEndId)}</Ustrd></RmtInf>
      </CdtTrfTxInf>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${xml(b.msgId)}</MsgId>
      <CreDtTm>${lokaleTijd(b.aangemaaktOp)}</CreDtTm>
      <NbOfTxs>${b.posten.length}</NbOfTxs>
      <CtrlSum>${bedragTekst(totaal)}</CtrlSum>
      <InitgPty><Nm>${naam}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${xml(`${b.msgId}-1`.slice(0, 35))}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <BtchBookg>true</BtchBookg>
      <NbOfTxs>${b.posten.length}</NbOfTxs>
      <CtrlSum>${bedragTekst(totaal)}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
      <ReqdExctnDt>${b.uitvoerdatum}</ReqdExctnDt>
      <Dbtr><Nm>${naam}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${xml(schoonIban(b.debiteur.iban))}</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId>${bic ? `<BIC>${xml(bic)}</BIC>` : "<Othr><Id>NOTPROVIDED</Id></Othr>"}</FinInstnId></DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
${transacties}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}
