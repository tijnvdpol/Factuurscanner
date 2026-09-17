import { useState } from "react";

interface Props {
  apiKey: string;
  model: string;
  onOpslaan: (apiKey: string, model: string) => void;
  onSluiten: () => void;
}

export default function InstellingenModal({ apiKey, model, onOpslaan, onSluiten }: Props) {
  const [lokaleKey, setLokaleKey] = useState(apiKey);
  const [lokaalModel, setLokaalModel] = useState(model);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-1 text-sm font-semibold text-slate-800">Instellingen</h2>
        <p className="mb-4 text-xs text-slate-500">
          Voor het scannen van facturen is een Gemini API-sleutel nodig. Deze wordt alleen lokaal in je
          browser opgeslagen.
        </p>

        <label className="mb-1 block text-xs font-medium text-slate-600">Gemini API-sleutel</label>
        <input
          type="password"
          value={lokaleKey}
          onChange={(e) => setLokaleKey(e.target.value)}
          placeholder="AIza…"
          className="mb-4 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20"
        />

        <label className="mb-1 block text-xs font-medium text-slate-600">Model</label>
        <input
          type="text"
          value={lokaalModel}
          onChange={(e) => setLokaalModel(e.target.value)}
          placeholder="gemini-3.6-flash"
          className="mb-6 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20"
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onSluiten}
            className="rounded-md px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Annuleren
          </button>
          <button
            type="button"
            onClick={() => onOpslaan(lokaleKey.trim(), lokaalModel.trim() || "gemini-2.5-flash")}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Opslaan
          </button>
        </div>
      </div>
    </div>
  );
}
