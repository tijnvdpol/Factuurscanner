import { STATUS_LABELS, type FactuurData, type FactuurStatus, type VeldFouten } from "../types";
import NummerInput from "./NummerInput";

interface Props {
  factuur: FactuurData;
  fouten: VeldFouten;
  onChange: (bijgewerkt: FactuurData) => void;
  status: FactuurStatus;
  /** Wie deed wat (ingevoerd, gecontroleerd, …), onder de status getoond. */
  statusInfo?: React.ReactNode;
  /** Melding boven de knoppen, bijv. dat opslaan de status terugzet naar gescand. */
  waarschuwing?: string | null;
  /** Betaalde facturen: velden vergrendeld, geen opslaan. */
  alleenLezen?: boolean;
  onOpslaan: () => void;
  onAnnuleren: () => void;
  bestandsnaam?: string;
  /** Het Gemini-model dat de factuur heeft herkend (automatisch gekozen door de server). */
  aiModel?: string;
  onBekijkOrigineel?: () => void;
  bewerken: boolean;
  opslaan: boolean;
  /** Extra blokken onder de btw-regels (signalen e.d.). */
  children?: React.ReactNode;
}

function Label({ children, ontbreekt }: { children: React.ReactNode; ontbreekt?: boolean }) {
  return (
    <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-600">
      {children}
      {ontbreekt && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
          niet herkend
        </span>
      )}
    </label>
  );
}

export default function FactuurFormulier({
  factuur,
  fouten,
  onChange,
  status,
  statusInfo,
  waarschuwing,
  alleenLezen = false,
  onOpslaan,
  onAnnuleren,
  bestandsnaam,
  aiModel,
  onBekijkOrigineel,
  bewerken,
  opslaan,
  children,
}: Props) {
  const zet = <K extends keyof FactuurData>(veld: K, waarde: FactuurData[K]) =>
    onChange({ ...factuur, [veld]: waarde });

  const zetRegel = (i: number, veld: "tarief" | "grondslag" | "btw_bedrag", waarde: number | null) => {
    const regels = factuur.btw_regels.map((r, idx) => (idx === i ? { ...r, [veld]: waarde } : r));
    onChange({ ...factuur, btw_regels: regels });
  };

  const voegRegelToe = () => {
    onChange({
      ...factuur,
      btw_regels: [...factuur.btw_regels, { tarief: null, grondslag: null, btw_bedrag: null }],
    });
  };

  const verwijderRegel = (i: number) => {
    onChange({ ...factuur, btw_regels: factuur.btw_regels.filter((_, idx) => idx !== i) });
  };

  const inputKlasse = (fout?: string) =>
    `w-full rounded-md border px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20 ${
      fout ? "border-red-400 bg-red-50 text-red-900" : "border-slate-300 bg-white"
    }`;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">
            {alleenLezen ? "Factuur bekijken" : bewerken ? "Factuur bewerken" : "Controleer gescande gegevens"}
          </h2>
          {aiModel && <p className="text-xs text-slate-400">Herkend door {aiModel}</p>}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {bestandsnaam && <span className="truncate text-xs text-slate-400">{bestandsnaam}</span>}
          {onBekijkOrigineel && (
            <button
              type="button"
              onClick={onBekijkOrigineel}
              className="shrink-0 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Origineel bekijken
            </button>
          )}
        </div>
      </div>

      {alleenLezen && (
        <p className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Deze factuur is betaald en kan niet meer worden gewijzigd.
        </p>
      )}

      <fieldset disabled={alleenLezen} className="min-w-0">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label ontbreekt={!factuur.leverancier}>Leverancier</Label>
          <input
            type="text"
            value={factuur.leverancier ?? ""}
            onChange={(e) => zet("leverancier", e.target.value || null)}
            className={inputKlasse()}
            placeholder="—"
          />
        </div>

        <div>
          <Label ontbreekt={!factuur.factuurnummer}>Factuurnummer</Label>
          <input
            type="text"
            value={factuur.factuurnummer ?? ""}
            onChange={(e) => zet("factuurnummer", e.target.value || null)}
            className={inputKlasse()}
            placeholder="—"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:col-span-2 sm:grid-cols-3">
          <div>
            <Label ontbreekt={!factuur.factuurdatum}>Factuurdatum</Label>
            <input
              type="date"
              value={factuur.factuurdatum ?? ""}
              onChange={(e) => zet("factuurdatum", e.target.value || null)}
              className={inputKlasse(fouten["factuurdatum"])}
            />
            {fouten["factuurdatum"] && <p className="mt-1 text-xs text-red-600">{fouten["factuurdatum"]}</p>}
          </div>

          <div>
            <Label ontbreekt={!factuur.vervaldatum}>Vervaldatum</Label>
            <input
              type="date"
              value={factuur.vervaldatum ?? ""}
              onChange={(e) => zet("vervaldatum", e.target.value || null)}
              className={inputKlasse(fouten["vervaldatum"])}
            />
            {fouten["vervaldatum"] && <p className="mt-1 text-xs text-red-600">{fouten["vervaldatum"]}</p>}
          </div>

          <div>
            <Label ontbreekt={!factuur.valuta}>Valuta</Label>
            <input
              type="text"
              value={factuur.valuta ?? ""}
              onChange={(e) => zet("valuta", e.target.value.toUpperCase() || null)}
              className={inputKlasse(fouten["valuta"])}
              placeholder="EUR"
              maxLength={3}
            />
            {fouten["valuta"] && <p className="mt-1 text-xs text-red-600">{fouten["valuta"]}</p>}
          </div>
        </div>

        <div>
          <Label ontbreekt={factuur.bedrag_excl === null}>Bedrag excl. BTW</Label>
          <NummerInput
            initieleWaarde={factuur.bedrag_excl}
            onChange={(v) => zet("bedrag_excl", v)}
          />
        </div>

        <div>
          <Label ontbreekt={factuur.totaal_incl === null}>Totaal incl. BTW</Label>
          <NummerInput
            initieleWaarde={factuur.totaal_incl}
            onChange={(v) => zet("totaal_incl", v)}
            fout={fouten["totaal_incl"]}
          />
        </div>
      </div>

      <div className="mt-5">
        <h3 className="mb-2 text-xs font-semibold text-slate-600">Leveranciersgegevens</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <Label ontbreekt={!factuur.iban}>IBAN</Label>
            <input
              type="text"
              value={factuur.iban ?? ""}
              onChange={(e) => zet("iban", e.target.value || null)}
              className={inputKlasse(fouten["iban"])}
              placeholder="—"
            />
            {fouten["iban"] && <p className="mt-1 text-xs text-red-600">{fouten["iban"]}</p>}
          </div>

          <div>
            <Label ontbreekt={!factuur.btw_nummer}>BTW-nummer</Label>
            <input
              type="text"
              value={factuur.btw_nummer ?? ""}
              onChange={(e) => zet("btw_nummer", e.target.value || null)}
              className={inputKlasse(fouten["btw_nummer"])}
              placeholder="—"
            />
            {fouten["btw_nummer"] && <p className="mt-1 text-xs text-red-600">{fouten["btw_nummer"]}</p>}
          </div>

          <div>
            <Label ontbreekt={!factuur.kvk_nummer}>KvK-nummer</Label>
            <input
              type="text"
              value={factuur.kvk_nummer ?? ""}
              onChange={(e) => zet("kvk_nummer", e.target.value || null)}
              className={inputKlasse(fouten["kvk_nummer"])}
              placeholder="—"
            />
            {fouten["kvk_nummer"] && <p className="mt-1 text-xs text-red-600">{fouten["kvk_nummer"]}</p>}
          </div>
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-slate-600">BTW-regels</h3>
          <button
            type="button"
            onClick={voegRegelToe}
            className="text-xs font-medium text-slate-600 underline decoration-dotted hover:text-slate-900"
          >
            + Regel toevoegen
          </button>
        </div>

        {factuur.btw_regels.length === 0 && (
          <p className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-400">
            Geen BTW-regels. Voeg er handmatig een toe indien nodig.
          </p>
        )}

        <div className="space-y-2">
          {factuur.btw_regels.map((regel, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,4.5rem)_1fr_1fr_auto] items-start gap-2">
              <NummerInput
                initieleWaarde={regel.tarief}
                onChange={(v) => zetRegel(i, "tarief", v)}
                fout={fouten[`btw_regels.${i}.tarief`]}
                placeholder="%"
              />
              <NummerInput
                initieleWaarde={regel.grondslag}
                onChange={(v) => zetRegel(i, "grondslag", v)}
                placeholder="grondslag"
              />
              <NummerInput
                initieleWaarde={regel.btw_bedrag}
                onChange={(v) => zetRegel(i, "btw_bedrag", v)}
                fout={fouten[`btw_regels.${i}.btw_bedrag`]}
                placeholder="btw"
              />
              <button
                type="button"
                onClick={() => verwijderRegel(i)}
                aria-label="Regel verwijderen"
                className="mt-1 rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
      </fieldset>

      {children}

      {waarschuwing && !alleenLezen && (
        <p className="mt-5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{waarschuwing}</p>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <div className="text-xs text-slate-600">
          <span className="font-medium">Status:</span>{" "}
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
            {bewerken ? STATUS_LABELS[status] : "Nieuw (wordt Gescand)"}
          </span>
          {statusInfo && <div className="mt-1 text-slate-400">{statusInfo}</div>}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onAnnuleren}
            disabled={opslaan}
            className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300"
          >
            {alleenLezen ? "Sluiten" : "Annuleren"}
          </button>
          {!alleenLezen && (
          <button
            type="button"
            onClick={onOpslaan}
            disabled={opslaan}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {opslaan ? "Opslaan…" : bewerken ? "Wijzigingen opslaan" : "Toevoegen aan overzicht"}
          </button>
          )}
        </div>
      </div>
    </div>
  );
}
