import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import type { Lidmaatschap } from "../types";
import { haalLidmaatschappenOp, zorgVoorOrganisatie } from "../lib/organisatieApi";
import { supabase } from "../lib/supabase";

// Laatst gekozen organisatie (alleen een gemak per browser; de database bepaalt de toegang).
const ACTIEVE_ORGANISATIE = "factuurscanner_organisatie";

function leesVoorkeur(): string | null {
  try {
    return localStorage.getItem(ACTIEVE_ORGANISATIE);
  } catch {
    return null;
  }
}

function bewaarVoorkeur(id: string) {
  try {
    localStorage.setItem(ACTIEVE_ORGANISATIE, id);
  } catch {
    // niet erg: dan wordt de volgende keer de eerste organisatie gekozen
  }
}

/** Lidmaatschappen; heeft de gebruiker er (nog) geen, dan wordt eerst een persoonlijke organisatie gemaakt. */
async function haalMetVangnet(userId: string): Promise<Lidmaatschap[]> {
  const lijst = await haalLidmaatschappenOp(userId);
  if (lijst.length > 0) return lijst;
  await zorgVoorOrganisatie();
  return haalLidmaatschappenOp(userId);
}

export interface OrganisatieContext {
  lidmaatschap: Lidmaatschap;
  lidmaatschappen: Lidmaatschap[];
  onWissel: (organisatieId: string) => void;
  /** Opnieuw laden, bijv. na een gewijzigde rol of organisatienaam. */
  onVernieuw: () => Promise<void>;
}

interface Props {
  sessie: Session;
  children: (context: OrganisatieContext) => React.ReactNode;
}

/** Laadt de organisaties van de gebruiker en bepaalt de actieve organisatie. */
export default function OrganisatiePoort({ sessie, children }: Props) {
  const [lidmaatschappen, setLidmaatschappen] = useState<Lidmaatschap[] | null>(null);
  const [actiefId, setActiefId] = useState<string | null>(leesVoorkeur);
  const [fout, setFout] = useState<string | null>(null);

  const laad = useCallback(async () => {
    setLidmaatschappen(await haalMetVangnet(sessie.user.id));
    setFout(null);
  }, [sessie.user.id]);

  useEffect(() => {
    let actief = true;
    haalMetVangnet(sessie.user.id)
      .then((lijst) => actief && setLidmaatschappen(lijst))
      .catch((err) => actief && setFout(err instanceof Error ? err.message : "Je organisaties konden niet worden geladen."));
    return () => {
      actief = false;
    };
  }, [sessie.user.id]);

  if (fout) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
        <div className="max-w-md rounded-lg border border-red-200 bg-white p-5 text-sm text-red-700 shadow-sm">
          <p>{fout}</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setFout(null);
                laad().catch((err) => setFout(err instanceof Error ? err.message : "Laden is mislukt."));
              }}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
            >
              Opnieuw proberen
            </button>
            <button
              type="button"
              onClick={() => supabase.auth.signOut()}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Uitloggen
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!lidmaatschappen || lidmaatschappen.length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-800" />
      </div>
    );
  }

  const lidmaatschap = lidmaatschappen.find((l) => l.organisatie_id === actiefId) ?? lidmaatschappen[0];

  return (
    <>
      {children({
        lidmaatschap,
        lidmaatschappen,
        onWissel: (id) => {
          bewaarVoorkeur(id);
          setActiefId(id);
        },
        onVernieuw: laad,
      })}
    </>
  );
}
