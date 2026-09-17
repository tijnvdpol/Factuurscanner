import { useRef, useState } from "react";

interface Props {
  onFile: (bestand: File) => void;
  bezig: boolean;
}

const TOEGESTAAN = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];

export default function UploadZone({ onFile, bezig }: Props) {
  const [sleept, setSleept] = useState(false);
  const bestandInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const verwerkBestanden = (lijst: FileList | null) => {
    if (!lijst || lijst.length === 0) return;
    const bestand = lijst[0];
    if (!TOEGESTAAN.includes(bestand.type) && !bestand.type.startsWith("image/")) {
      window.alert("Alleen afbeeldingen (JPG, PNG, WEBP, HEIC) of PDF worden ondersteund.");
      return;
    }
    onFile(bestand);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setSleept(true);
      }}
      onDragLeave={() => setSleept(false)}
      onDrop={(e) => {
        e.preventDefault();
        setSleept(false);
        verwerkBestanden(e.dataTransfer.files);
      }}
      className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
        sleept ? "border-slate-600 bg-slate-100" : "border-slate-300 bg-white"
      }`}
    >
      {bezig ? (
        <>
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-800" />
          <p className="text-sm font-medium text-slate-700">Factuur wordt gescand…</p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-slate-700">
            Sleep een factuur (afbeelding of PDF) hierheen
          </p>
          <p className="text-xs text-slate-400">of kies een optie</p>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => bestandInputRef.current?.click()}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Bestand kiezen
            </button>
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Foto maken
            </button>
          </div>
        </>
      )}

      <input
        ref={bestandInputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          verwerkBestanden(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          verwerkBestanden(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
