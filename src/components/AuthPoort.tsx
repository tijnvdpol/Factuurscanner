import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import Inloggen from "./Inloggen";

interface Props {
  children: (sessie: Session) => React.ReactNode;
}

/** Toont de app alleen aan ingelogde gebruikers; anders het inlogscherm. */
export default function AuthPoort({ children }: Props) {
  const [sessie, setSessie] = useState<Session | null>(null);
  const [laden, setLaden] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSessie(data.session);
      setLaden(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nieuweSessie) => {
      setSessie(nieuweSessie);
      setLaden(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (laden) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-800" />
      </div>
    );
  }

  if (!sessie) return <Inloggen />;

  return <>{children(sessie)}</>;
}
