import { useState } from "react";
import { MODEL_PATROON, STANDAARD_MODEL } from "../lib/gemini";

interface Props {
  model: string;
  onOpslaan: (model: string) => Promise<void>;
  onSluiten: () => void;
}

export default function InstellingenModal({ model, onOpslaan, onSluiten }: Props) {
  const [lokaalModel, setLokaalModel] = useState(model);
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);

  const opslaan = async () => {
    const nieuwModel = lokaalModel.trim() || STANDAARD_MODEL;
    if (!MODEL_PATROON.test(nieuwModel)) {
      setFout("Ongeldige modelnaam. Gebruik bijvoorbeeld gemini-3.6-flash.");
      return;
    }
    setFout(null);
    setBezig(true);
    try {
      await onOpslaan(nieuwModel);
    } catch (err) {
      setFout(err instanceof Error ? err.message : "Opslaan is mislukt.");
      setBezig(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-1 text-sm font-semibold text-slate-800">Instellingen</h2>
        <p className="mb-4 text-xs text-slate-500">
          Facturen worden server-side gescand met Google Gemini. Je hoeft zelf geen API-sleutel in te voeren. Het
          gekozen model wordt bij je account bewaard.
        </p>

        <label className="mb-1 block text-xs font-medium text-slate-600">Model</label>
        <input
          type="text"
          value={lokaalModel}
          onChange={(e) => setLokaalModel(e.target.value)}
          placeholder={STANDAARD_MODEL}
          className="mb-4 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20"
        />

        {fout && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{fout}</div>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={onSluiten}
            className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Annuleren
          </button>
          <button
            type="button"
            onClick={opslaan}
            disabled={bezig}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {bezig ? "Opslaan…" : "Opslaan"}
          </button>
        </div>
      </div>
    </div>
  );
}
