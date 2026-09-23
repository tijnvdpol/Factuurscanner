import { useState } from "react";
import { ROLLEN, ROL_LABELS, type Lidmaatschap, type OrgGebruiker, type Rol } from "../types";
import { hernoemOrganisatie, verwijderLid, voegLidToe, wijzigLid } from "../lib/organisatieApi";
import { formatGetal, parseGetal } from "../lib/getallen";

interface Props {
  lidmaatschap: Lidmaatschap;
  gebruikers: OrgGebruiker[];
  eigenUserId: string;
  onGewijzigd: () => Promise<void>;
}

const invoerKlasse =
  "rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20";

const ROL_UITLEG: Record<Rol, string> = {
  invoerder: "scant en controleert facturen",
  goedkeurder: "keurt facturen goed (tot de limiet)",
  controller: "controleert, keurt goed, markeert als betaald, beheert rekeningen",
  beheerder: "alles, plus leden en organisatie beheren",
};

function foutTekst(err: unknown): string {
  return err instanceof Error ? err.message : "Er ging iets mis.";
}

/** "" = onbeperkt; anders een bedrag ≥ 0. undefined = ongeldige invoer. */
function leesLimiet(tekst: string): number | null | undefined {
  if (!tekst.trim()) return null;
  const waarde = parseGetal(tekst);
  return waarde === null || waarde < 0 ? undefined : waarde;
}

function LidRij({
  lid,
  organisatieId,
  isZelf,
  onGewijzigd,
}: {
  lid: OrgGebruiker;
  organisatieId: string;
  isZelf: boolean;
  onGewijzigd: () => Promise<void>;
}) {
  const [rol, setRol] = useState<Rol>(lid.rol ?? "invoerder");
  const [limiet, setLimiet] = useState(formatGetal(lid.goedkeuringslimiet));
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);

  const gewijzigd = rol !== lid.rol || leesLimiet(limiet) !== lid.goedkeuringslimiet;

  const voerUit = async (actie: () => Promise<void>) => {
    setBezig(true);
    setFout(null);
    try {
      await actie();
      await onGewijzigd();
    } catch (err) {
      setFout(foutTekst(err));
    } finally {
      setBezig(false);
    }
  };

  const opslaan = () => {
    const waarde = leesLimiet(limiet);
    if (waarde === undefined) {
      setFout("Vul een geldig bedrag in, of laat de limiet leeg voor onbeperkt.");
      return;
    }
    void voerUit(() => wijzigLid(organisatieId, lid.user_id, rol, waarde));
  };

  const verwijder = () => {
    const wie = isZelf ? "jezelf" : lid.email;
    if (!window.confirm(`Weet je zeker dat je ${wie} uit de organisatie wilt verwijderen?`)) return;
    void voerUit(() => verwijderLid(organisatieId, lid.user_id));
  };

  return (
    <tr className="border-b border-slate-50 align-top last:border-0">
      <td className="px-5 py-2.5 text-slate-800">
        {lid.email}
        {isZelf && <span className="ml-1.5 text-xs text-slate-400">(jij)</span>}
        {fout && <p className="mt-1 text-xs text-red-600">{fout}</p>}
      </td>
      <td className="px-5 py-2">
        <select value={rol} onChange={(e) => setRol(e.target.value as Rol)} className={invoerKlasse} aria-label="Rol">
          {ROLLEN.map((r) => (
            <option key={r} value={r}>
              {ROL_LABELS[r]}
            </option>
          ))}
        </select>
      </td>
      <td className="px-5 py-2">
        <input
          value={limiet}
          onChange={(e) => setLimiet(e.target.value)}
          placeholder="onbeperkt"
          inputMode="decimal"
          aria-label="Goedkeuringslimiet"
          className={`${invoerKlasse} w-32 text-right tabular-nums`}
        />
      </td>
      <td className="px-5 py-2 text-right">
        <div className="flex justify-end gap-1">
          <button
            type="button"
            disabled={bezig || !gewijzigd}
            onClick={opslaan}
            className="rounded bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:bg-slate-300"
          >
            Opslaan
          </button>
          <button
            type="button"
            disabled={bezig}
            onClick={verwijder}
            className="rounded p-1.5 text-xs font-medium text-slate-500 hover:bg-red-50 hover:text-red-600"
          >
            Verwijderen
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Ledenbeheer (alleen voor beheerders): leden bekijken, toevoegen, rol/limiet wijzigen en verwijderen. */
export default function LedenBeheer({ lidmaatschap, gebruikers, eigenUserId, onGewijzigd }: Props) {
  const organisatieId = lidmaatschap.organisatie_id;
  const leden = gebruikers.filter((g) => g.is_lid).sort((a, b) => a.email.localeCompare(b.email));
  const [email, setEmail] = useState("");
  const [rol, setRol] = useState<Rol>("invoerder");
  const [limiet, setLimiet] = useState("");
  const [naam, setNaam] = useState(lidmaatschap.naam);
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);

  const voerUit = async (actie: () => Promise<void>, gelukt: string) => {
    setBezig(true);
    setFout(null);
    setMelding(null);
    try {
      await actie();
      await onGewijzigd();
      setMelding(gelukt);
    } catch (err) {
      setFout(foutTekst(err));
    } finally {
      setBezig(false);
    }
  };

  const toevoegen = (e: React.FormEvent) => {
    e.preventDefault();
    const waarde = leesLimiet(limiet);
    if (waarde === undefined) {
      setFout("Vul een geldige goedkeuringslimiet in, of laat hem leeg voor onbeperkt.");
      return;
    }
    void voerUit(async () => {
      await voegLidToe(organisatieId, email.trim(), rol, waarde);
      setEmail("");
      setLimiet("");
    }, `${email.trim()} is toegevoegd als ${ROL_LABELS[rol].toLowerCase()}.`);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-800">Organisatie</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void voerUit(() => hernoemOrganisatie(organisatieId, naam), "De naam is gewijzigd.");
          }}
          className="mt-2 flex flex-wrap gap-2"
        >
          <input value={naam} onChange={(e) => setNaam(e.target.value)} aria-label="Naam" className={`${invoerKlasse} min-w-0 flex-1`} />
          <button
            type="submit"
            disabled={bezig || !naam.trim() || naam.trim() === lidmaatschap.naam}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Naam wijzigen
          </button>
        </form>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-800">Leden</h2>
          <ul className="mt-1 space-y-0.5 text-xs text-slate-400">
            {ROLLEN.map((r) => (
              <li key={r}>
                <span className="font-medium text-slate-500">{ROL_LABELS[r]}</span>: {ROL_UITLEG[r]}
              </li>
            ))}
            <li>Een lege goedkeuringslimiet betekent onbeperkt.</li>
          </ul>
        </div>

        <form onSubmit={toevoegen} className="flex flex-wrap items-start gap-2 border-b border-slate-100 px-5 py-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="E-mailadres van een bestaand account"
            aria-label="E-mailadres"
            className={`${invoerKlasse} min-w-0 flex-1`}
          />
          <select value={rol} onChange={(e) => setRol(e.target.value as Rol)} aria-label="Rol" className={invoerKlasse}>
            {ROLLEN.map((r) => (
              <option key={r} value={r}>
                {ROL_LABELS[r]}
              </option>
            ))}
          </select>
          <input
            value={limiet}
            onChange={(e) => setLimiet(e.target.value)}
            placeholder="Limiet (leeg = onbeperkt)"
            inputMode="decimal"
            aria-label="Goedkeuringslimiet"
            className={`${invoerKlasse} w-48`}
          />
          <button
            type="submit"
            disabled={bezig || !email.trim()}
            className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Lid toevoegen
          </button>
          <p className="w-full text-xs text-slate-400">
            De persoon moet eerst zelf een account aanmaken (registreren) met dit e-mailadres.
          </p>
        </form>

        {fout && <p className="border-b border-slate-100 px-5 py-2 text-sm text-red-600">{fout}</p>}
        {melding && <p className="border-b border-slate-100 px-5 py-2 text-sm text-emerald-700">{melding}</p>}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-medium uppercase tracking-wide text-slate-400">
                <th className="px-5 py-2.5">E-mailadres</th>
                <th className="px-5 py-2.5">Rol</th>
                <th className="px-5 py-2.5">Goedkeuringslimiet (€)</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {leden.map((lid) => (
                <LidRij
                  key={`${lid.user_id}-${lid.rol}-${lid.goedkeuringslimiet}`}
                  lid={lid}
                  organisatieId={organisatieId}
                  isZelf={lid.user_id === eigenUserId}
                  onGewijzigd={onGewijzigd}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
