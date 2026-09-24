import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import FacturenPagina from "./components/FacturenPagina";
import GrootboekBeheer from "./components/GrootboekBeheer";
import LedenBeheer from "./components/LedenBeheer";
import AuditLogPagina from "./components/AuditLogPagina";
import KoppelingenPagina from "./components/KoppelingenPagina";
import type { WeergaveContext } from "./lib/audit";
import { rekeningNaam } from "./lib/codering";
import type { OrganisatieContext } from "./components/OrganisatiePoort";
import { haalRekeningenOp } from "./lib/grootboekApi";
import { haalOrgGebruikersOp } from "./lib/organisatieApi";
import { supabase } from "./lib/supabase";
import { ROL_LABELS, type Grootboekrekening, type OrgGebruiker, type Rol } from "./types";

type Pagina = "facturen" | "grootboek" | "leden" | "koppelingen" | "audit";

const PAGINAS: { sleutel: Pagina; label: string; rollen: Rol[] | null }[] = [
  { sleutel: "facturen", label: "Facturen", rollen: null },
  { sleutel: "grootboek", label: "Grootboekrekeningen", rollen: null },
  { sleutel: "leden", label: "Leden", rollen: ["beheerder"] },
  { sleutel: "koppelingen", label: "Koppelingen", rollen: ["controller", "beheerder"] },
  { sleutel: "audit", label: "Audit log", rollen: ["controller", "beheerder"] },
];

interface Props extends OrganisatieContext {
  sessie: Session;
}

export default function App({ sessie, lidmaatschap, lidmaatschappen, onWissel, onVernieuw }: Props) {
  const organisatieId = lidmaatschap.organisatie_id;
  const [pagina, setPagina] = useState<Pagina>("facturen");
  const [rekeningen, setRekeningen] = useState<Grootboekrekening[]>([]);
  const [gebruikers, setGebruikers] = useState<OrgGebruiker[]>([]);

  const vernieuwRekeningen = useCallback(async () => {
    setRekeningen(await haalRekeningenOp(organisatieId));
  }, [organisatieId]);

  const vernieuwGebruikers = useCallback(async () => {
    setGebruikers(await haalOrgGebruikersOp(organisatieId));
  }, [organisatieId]);

  useEffect(() => {
    haalRekeningenOp(organisatieId)
      .then(setRekeningen)
      .catch((err) => console.warn("Grootboekrekeningen laden mislukt:", err));
    haalOrgGebruikersOp(organisatieId)
      .then(setGebruikers)
      .catch((err) => console.warn("Leden laden mislukt:", err));
  }, [organisatieId]);

  const weergave: WeergaveContext = {
    naamVan: (userId) =>
      gebruikers.find((g) => g.user_id === userId)?.email ?? (userId === sessie.user.id ? sessie.user.email : undefined),
    rekeningNaam: (id) => {
      const rekening = rekeningen.find((r) => r.id === id);
      return rekening ? rekeningNaam(rekening) : undefined;
    },
  };

  const zichtbarePaginas = PAGINAS.filter((p) => !p.rollen || p.rollen.includes(lidmaatschap.rol));
  const actievePagina = zichtbarePaginas.some((p) => p.sleutel === pagina) ? pagina : "facturen";

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-slate-900">Factuurscanner</h1>
            {lidmaatschappen.length > 1 ? (
              <select
                value={organisatieId}
                onChange={(e) => onWissel(e.target.value)}
                aria-label="Organisatie"
                className="mt-0.5 max-w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-800/20"
              >
                {lidmaatschappen.map((l) => (
                  <option key={l.organisatie_id} value={l.organisatie_id}>
                    {l.naam} ({ROL_LABELS[l.rol].toLowerCase()})
                  </option>
                ))}
              </select>
            ) : (
              <p className="truncate text-xs text-slate-400">
                {lidmaatschap.naam} · {ROL_LABELS[lidmaatschap.rol].toLowerCase()}
              </p>
            )}
          </div>
          <nav className="flex flex-wrap items-center gap-1">
            {zichtbarePaginas.map(({ sleutel, label }) => (
              <button
                key={sleutel}
                type="button"
                onClick={() => setPagina(sleutel)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  actievePagina === sleutel ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <span className="hidden truncate text-xs text-slate-400 sm:inline">{sessie.user.email}</span>
            <button
              type="button"
              onClick={() => supabase.auth.signOut()}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Uitloggen
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        {actievePagina === "facturen" && (
          <FacturenPagina
            sessie={sessie}
            lidmaatschap={lidmaatschap}
            rekeningen={rekeningen}
            gebruikers={gebruikers}
            weergave={weergave}
          />
        )}
        {actievePagina === "grootboek" && (
          <GrootboekBeheer
            organisatieId={organisatieId}
            rekeningen={rekeningen}
            magBeheren={lidmaatschap.rol === "beheerder" || lidmaatschap.rol === "controller"}
            onGewijzigd={vernieuwRekeningen}
          />
        )}
        {actievePagina === "koppelingen" && (
          <KoppelingenPagina organisatieId={organisatieId} magBeheren={lidmaatschap.rol === "beheerder"} />
        )}
        {actievePagina === "audit" && (
          <AuditLogPagina organisatieId={organisatieId} gebruikers={gebruikers} weergave={weergave} />
        )}
        {actievePagina === "leden" && (
          <LedenBeheer
            lidmaatschap={lidmaatschap}
            gebruikers={gebruikers}
            eigenUserId={sessie.user.id}
            onGewijzigd={async () => {
              await vernieuwGebruikers();
              await onVernieuw();
            }}
          />
        )}
      </main>
    </div>
  );
}
