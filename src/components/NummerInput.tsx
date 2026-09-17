import { useState } from "react";
import { formatGetal, parseGetal } from "../lib/getallen";

interface Props {
  initieleWaarde: number | null;
  onChange: (waarde: number | null) => void;
  fout?: string;
  placeholder?: string;
  className?: string;
}

export default function NummerInput({ initieleWaarde, onChange, fout, placeholder, className }: Props) {
  const [tekst, setTekst] = useState(() => formatGetal(initieleWaarde));

  return (
    <div className="min-w-0">
      <input
        type="text"
        inputMode="decimal"
        value={tekst}
        placeholder={placeholder ?? "—"}
        onChange={(e) => {
          setTekst(e.target.value);
          onChange(parseGetal(e.target.value));
        }}
        className={`w-full rounded-md border px-2.5 py-1.5 text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-slate-800/20 ${
          fout ? "border-red-400 bg-red-50 text-red-900" : "border-slate-300 bg-white"
        } ${className ?? ""}`}
      />
      {fout && <p className="mt-1 text-xs text-red-600">{fout}</p>}
    </div>
  );
}
