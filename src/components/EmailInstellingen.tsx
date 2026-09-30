import { useState } from "react";
import type { KoppelingStatus } from "../lib/koppelingen";
import { leesEmailConfig } from "../lib/notificaties";
import { slaEmailConfigOp, stuurTestmail } from "../lib/notificatiesApi";

interface Props {
  organisatieId: string;
  magBeheren: boolean;
  status: KoppelingStatus;
  onOpgeslagen: () => Promise<void>;
}

const invoerKlasse =
  "w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20 disabled:bg-slate-50";

/** Instellingen van de e-mailnotificaties en een testmail aan jezelf (pagina Koppelingen). */
export default function EmailInstellingen({ organisatieId, magBeheren, status, onOpgeslagen }: Props) {
  const huidig = leesEmailConfig(status.config);
  const [dagen, setDagen] = useState(String(huidig.dagen_voor_vervaldatum));
  const [uren, setUren] = useState(String(huidig.link_geldig_uren));
  const [bezig, setBezig] = useState<"test" | "opslaan" | null>(null);
  const [melding, setMelding] = useState<{ ok: boolean; tekst: string } | null>(null);

  const test = async () => {
    setBezig("test");
    setMelding(null);
    try {
      setMelding({ ok: true, tekst: await stuurTestmail(organisatieId) });
    } catch (err) {
      setMelding({ ok: false, tekst: err instanceof Error ? err.message : "De testmail kon niet worden aangemaakt." });
    } finally {
      setBezig(null);
    }
  };

  const opslaan = async () => {
    const config = leesEmailConfig({ dagen_voor_vervaldatum: Number(dagen), link_geldig_uren: Number(uren) });
    setDagen(String(config.dagen_voor_vervaldatum));
    setUren(String(config.link_geldig_uren));
    setBezig("opslaan");
    setMelding(null);
    try {
      await slaEmailConfigOp(organisatieId, config);
      setMelding({ ok: true, tekst: "Instellingen voor e-mail opgeslagen." });
      await onOpgeslagen();
    } catch (err) {
      setMelding({ ok: false, tekst: err instanceof Error ? err.message : "Opslaan is mislukt." });
    } finally {
      setBezig(null);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="text-sm font-semibold text-slate-800">E-mailnotificaties</h2>
        <p className="text-xs text-slate-400">
          Goedkeurders krijgen een mail met de knoppen Goedkeuren en Afkeuren zodra een factuur binnen hun limiet is
          gecontroleerd. Controllers en beheerders krijgen een mail bij mislukte exports en facturen die bijna vervallen
          (dagelijks om 08:00); invoerder en controleur bij een afgekeurde factuur.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-4 px-5 py-4 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">Herinnering, dagen vóór vervaldatum</span>
          <input type="number" min={1} max={30} value={dagen} disabled={!magBeheren} onChange={(e) => setDagen(e.target.value)} className={invoerKlasse} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">Knoppen in de mail geldig (uren)</span>
          <input type="number" min={1} max={336} value={uren} disabled={!magBeheren} onChange={(e) => setUren(e.target.value)} className={invoerKlasse} />
        </label>
        {magBeheren && (
          <button
            type="button"
            onClick={opslaan}
            disabled={bezig !== null}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300"
          >
            Opslaan
          </button>
        )}
        <button
          type="button"
          onClick={test}
          disabled={bezig !== null}
          className="ml-auto rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          Stuur een testmail naar mezelf
        </button>
      </div>
      {melding && (
        <p className={`border-t border-slate-100 px-5 py-2 text-xs ${melding.ok ? "text-emerald-700" : "text-red-700"}`}>{melding.tekst}</p>
      )}
    </div>
  );
}
