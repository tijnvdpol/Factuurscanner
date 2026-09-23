import type { Signaal, SignaalErnst } from "../types";
import { ERNST_LABELS, SIGNAAL_LABELS, telOpenSignalen } from "../lib/signalen";
import { ERNST_KLASSEN } from "../lib/stijl";

const VOLGORDE: SignaalErnst[] = ["kritiek", "waarschuwing", "info"];

/** Compacte badges met het aantal open signalen per ernst (voor de factuurlijst). */
export default function SignaalBadges({ signalen }: { signalen: Signaal[] }) {
  const telling = telOpenSignalen(signalen);
  const open = signalen.filter((s) => !s.opgelost);
  if (open.length === 0) return <span className="text-xs text-slate-300">—</span>;

  return (
    <div className="flex flex-wrap gap-1">
      {VOLGORDE.filter((e) => telling[e] > 0).map((ernst) => (
        <span
          key={ernst}
          title={open
            .filter((s) => s.ernst === ernst)
            .map((s) => `${SIGNAAL_LABELS[s.type]}: ${s.bericht}`)
            .join("\n")}
          className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${ERNST_KLASSEN[ernst]}`}
        >
          {telling[ernst]} {ERNST_LABELS[ernst].toLowerCase()}
        </span>
      ))}
    </div>
  );
}
