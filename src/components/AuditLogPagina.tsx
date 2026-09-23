import { useEffect, useState } from "react";
import {
  ACTIE_LABELS,
  TABEL_LABELS,
  auditCsv,
  datumTijd,
  omschrijving,
  wijzigingen,
  type AuditActie,
  type AuditRegel,
  type WeergaveContext,
} from "../lib/audit";
import { haalAuditLogOp, MAX_AUDIT_REGELS, type AuditFilter } from "../lib/auditApi";
import { downloadTekst } from "../lib/csv";
import type { OrgGebruiker } from "../types";

interface Props {
  organisatieId: string;
  gebruikers: OrgGebruiker[];
  weergave: WeergaveContext;
}

const invoerKlasse =
  "rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20";

function dagenGeleden(dagen: number): string {
  const d = new Date();
  d.setDate(d.getDate() - dagen);
  return d.toLocaleDateString("sv-SE"); // JJJJ-MM-DD in lokale tijd
}

/** Audit log van de organisatie (voor controllers en beheerders), met filters en CSV-export. */
export default function AuditLogPagina({ organisatieId, gebruikers, weergave }: Props) {
  const [filter, setFilter] = useState<AuditFilter>({ van: dagenGeleden(30), tot: "", userId: "", actie: "", tabel: "" });
  const [regels, setRegels] = useState<AuditRegel[] | null>(null);
  const [fout, setFout] = useState<string | null>(null);

  useEffect(() => {
    let actief = true;
    haalAuditLogOp(organisatieId, filter)
      .then((lijst) => {
        if (!actief) return;
        setRegels(lijst);
        setFout(null);
      })
      .catch((err) => actief && setFout(err instanceof Error ? err.message : "De audit log kon niet worden geladen."));
    return () => {
      actief = false;
    };
  }, [organisatieId, filter]);

  const zet = <K extends keyof AuditFilter>(veld: K, waarde: AuditFilter[K]) => setFilter((f) => ({ ...f, [veld]: waarde }));

  const exporteer = () => {
    if (!regels) return;
    const periode = [filter.van, filter.tot].filter(Boolean).join("_tot_") || "alles";
    downloadTekst(auditCsv(regels, weergave), `audit-log_${periode}.csv`);
  };

  const gesorteerdeGebruikers = [...gebruikers].sort((a, b) => a.email.localeCompare(b.email));

  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Audit log</h2>
          <p className="text-xs text-slate-400">
            Alle wijzigingen aan facturen, btw-regels, leveranciers, signalen en leden. De log kan door niemand worden
            aangepast of verwijderd.
          </p>
        </div>
        <button
          type="button"
          onClick={exporteer}
          disabled={!regels || regels.length === 0}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          Exporteren als CSV
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-3 text-xs text-slate-600">
        <label className="flex flex-col gap-1">
          Van
          <input type="date" value={filter.van} onChange={(e) => zet("van", e.target.value)} className={invoerKlasse} />
        </label>
        <label className="flex flex-col gap-1">
          Tot en met
          <input type="date" value={filter.tot} onChange={(e) => zet("tot", e.target.value)} className={invoerKlasse} />
        </label>
        <label className="flex flex-col gap-1">
          Gebruiker
          <select value={filter.userId} onChange={(e) => zet("userId", e.target.value)} className={invoerKlasse}>
            <option value="">Iedereen</option>
            {gesorteerdeGebruikers.map((g) => (
              <option key={g.user_id} value={g.user_id}>
                {g.email}
                {g.is_lid ? "" : " (oud-lid)"}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Actie
          <select value={filter.actie} onChange={(e) => zet("actie", e.target.value as AuditActie | "")} className={invoerKlasse}>
            <option value="">Alle acties</option>
            {(Object.keys(ACTIE_LABELS) as AuditActie[]).map((a) => (
              <option key={a} value={a}>
                {ACTIE_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Onderdeel
          <select value={filter.tabel} onChange={(e) => zet("tabel", e.target.value)} className={invoerKlasse}>
            <option value="">Alles</option>
            {Object.entries(TABEL_LABELS).map(([tabel, label]) => (
              <option key={tabel} value={tabel}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {fout && <p className="px-5 py-4 text-sm text-red-600">{fout}</p>}
      {!fout && !regels && <p className="px-5 py-6 text-center text-sm text-slate-400">Laden…</p>}
      {regels && regels.length === 0 && <p className="px-5 py-6 text-center text-sm text-slate-400">Geen regels gevonden.</p>}
      {regels && regels.length >= MAX_AUDIT_REGELS && (
        <p className="border-b border-slate-100 bg-amber-50 px-5 py-2 text-xs text-amber-800">
          Alleen de nieuwste {MAX_AUDIT_REGELS} regels worden getoond. Verklein de periode voor een volledig overzicht.
        </p>
      )}

      {regels && regels.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2.5">Tijdstip</th>
                <th className="px-5 py-2.5">Gebruiker</th>
                <th className="px-5 py-2.5">Wat</th>
                <th className="px-5 py-2.5">Wijzigingen</th>
              </tr>
            </thead>
            <tbody>
              {regels.map((r) => (
                <tr key={r.id} className="border-b border-slate-50 align-top last:border-0">
                  <td className="whitespace-nowrap px-5 py-2.5 text-xs text-slate-500">{datumTijd(r.created_at)}</td>
                  <td className="px-5 py-2.5 text-xs text-slate-700">
                    {r.user_id ? (weergave.naamVan(r.user_id) ?? "onbekende gebruiker") : "systeem"}
                  </td>
                  <td className="px-5 py-2.5">
                    <p className="text-slate-800">{omschrijving(r, weergave)}</p>
                    {r.toelichting && <p className="text-xs italic text-slate-500">“{r.toelichting}”</p>}
                  </td>
                  <td className="px-5 py-2.5 text-xs text-slate-600">
                    {wijzigingen(r, weergave)
                      .slice(0, 6)
                      .map((w) => (
                        <div key={w.veld}>
                          <span className="text-slate-500">{w.label}:</span>{" "}
                          {r.actie === "update" || r.actie === "statuswijziging" ? `${w.van} → ${w.naar}` : w.naar || w.van}
                        </div>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
