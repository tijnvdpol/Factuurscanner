import { useState } from "react";
import type { AuthError } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";

type Modus = "inloggen" | "registreren";

const MIN_WACHTWOORD = 8;

function vertaalAuthFout(fout: AuthError): string {
  switch (fout.code) {
    case "invalid_credentials":
      return "Onjuist e-mailadres of wachtwoord.";
    case "email_not_confirmed":
      return "Je e-mailadres is nog niet bevestigd. Klik op de link in de bevestigingsmail.";
    case "user_already_exists":
    case "email_exists":
      return "Er bestaat al een account met dit e-mailadres. Log in.";
    case "weak_password":
      return "Dit wachtwoord is te zwak. Kies een langer of sterker wachtwoord.";
    case "email_address_invalid":
      return "Dit e-mailadres is ongeldig.";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "Te veel pogingen. Wacht even en probeer het opnieuw.";
    case "signup_disabled":
      return "Registreren is momenteel uitgeschakeld.";
    default:
      return `Er ging iets mis: ${fout.message}`;
  }
}

export default function Inloggen() {
  const [modus, setModus] = useState<Modus>("inloggen");
  const [email, setEmail] = useState("");
  const [wachtwoord, setWachtwoord] = useState("");
  const [herhaling, setHerhaling] = useState("");
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);
  const [melding, setMelding] = useState<string | null>(null);

  const registreren = modus === "registreren";

  const wisselModus = () => {
    setModus(registreren ? "inloggen" : "registreren");
    setFout(null);
    setMelding(null);
    setWachtwoord("");
    setHerhaling("");
  };

  const verstuur = async (e: React.FormEvent) => {
    e.preventDefault();
    setFout(null);
    setMelding(null);

    if (registreren) {
      if (wachtwoord.length < MIN_WACHTWOORD) {
        setFout(`Wachtwoord moet minimaal ${MIN_WACHTWOORD} tekens zijn.`);
        return;
      }
      if (wachtwoord !== herhaling) {
        setFout("De wachtwoorden komen niet overeen.");
        return;
      }
    }

    setBezig(true);
    try {
      if (registreren) {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password: wachtwoord,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) {
          setFout(vertaalAuthFout(error));
        } else if (data.user && data.user.identities?.length === 0) {
          // Supabase geeft bij een bestaand (bevestigd) adres geen fout terug, maar een gebruiker zonder identities.
          setFout("Er bestaat al een account met dit e-mailadres. Log in.");
        } else if (!data.session) {
          setMelding("Account aangemaakt. Bevestig je e-mailadres via de link in je mail en log daarna in.");
          setModus("inloggen");
          setWachtwoord("");
          setHerhaling("");
        }
        // Met sessie (e-mailbevestiging uitgeschakeld) schakelt AuthPoort vanzelf door naar de app.
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: wachtwoord });
        if (error) setFout(vertaalAuthFout(error));
      }
    } catch {
      setFout("Kon geen verbinding maken met de server. Controleer je internetverbinding.");
    } finally {
      setBezig(false);
    }
  };

  const inputKlasse =
    "w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-800/20";

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Factuurscanner</h1>
          <p className="text-xs text-slate-400">Scan, controleer en exporteer facturen</p>
        </div>

        <form onSubmit={verstuur} className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-sm font-semibold text-slate-800">
            {registreren ? "Account aanmaken" : "Inloggen"}
          </h2>

          <label htmlFor="email" className="mb-1 block text-xs font-medium text-slate-600">
            E-mailadres
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`${inputKlasse} mb-4`}
          />

          <label htmlFor="wachtwoord" className="mb-1 block text-xs font-medium text-slate-600">
            Wachtwoord
          </label>
          <input
            id="wachtwoord"
            type="password"
            required
            autoComplete={registreren ? "new-password" : "current-password"}
            value={wachtwoord}
            onChange={(e) => setWachtwoord(e.target.value)}
            className={`${inputKlasse} mb-4`}
          />

          {registreren && (
            <>
              <label htmlFor="herhaling" className="mb-1 block text-xs font-medium text-slate-600">
                Wachtwoord herhalen
              </label>
              <input
                id="herhaling"
                type="password"
                required
                autoComplete="new-password"
                value={herhaling}
                onChange={(e) => setHerhaling(e.target.value)}
                className={`${inputKlasse} mb-4`}
              />
            </>
          )}

          {fout && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {fout}
            </div>
          )}
          {melding && (
            <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              {melding}
            </div>
          )}

          <button
            type="submit"
            disabled={bezig}
            className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {bezig ? "Even geduld…" : registreren ? "Account aanmaken" : "Inloggen"}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-500">
          {registreren ? "Heb je al een account?" : "Nog geen account?"}{" "}
          <button
            type="button"
            onClick={wisselModus}
            className="font-medium text-slate-700 underline decoration-dotted hover:text-slate-900"
          >
            {registreren ? "Inloggen" : "Registreren"}
          </button>
        </p>
      </div>
    </div>
  );
}
