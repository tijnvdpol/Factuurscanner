import { koppelingBadges, type KoppelingTaakStatus } from "../lib/koppelingen";

const KLASSEN = {
  wacht: "bg-amber-100 text-amber-800",
  mislukt: "bg-red-100 text-red-700 hover:bg-red-200",
};

interface Props {
  statussen: KoppelingTaakStatus[];
  onOpnieuw: (taakId: string) => void;
}

/** Problemen met koppelingen van een factuur, bijv. "Export mislukt" (klikbaar: opnieuw proberen). */
export default function KoppelingBadges({ statussen, onOpnieuw }: Props) {
  const badges = koppelingBadges(statussen);
  if (badges.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {badges.map((b) =>
        b.kanOpnieuw ? (
          <button
            key={b.taakId}
            type="button"
            title={b.titel}
            onClick={() => onOpnieuw(b.taakId)}
            className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${KLASSEN[b.soortBadge]}`}
          >
            {b.tekst} ↻
          </button>
        ) : (
          <span
            key={b.taakId}
            title={b.titel}
            className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${KLASSEN[b.soortBadge]}`}
          >
            {b.tekst}
          </span>
        ),
      )}
    </div>
  );
}
