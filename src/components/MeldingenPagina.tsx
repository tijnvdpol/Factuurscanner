import { useCallback, useEffect, useState } from "react";
import type { Rol } from "../types";
import { datumTijd } from "../lib/audit";
import {
  SOORT_LABELS,
  STATUS_LABELS,
  mailVoorWeergave,
  type Notificatie,
  type NotificatieInhoud,
  type NotificatieStatus,
} from "../lib/notificaties";
import { haalInhoudOp, haalNotificatiesOp } from "../lib/notificatiesApi";

interface Props {
  organisatieId: string;
  userId: string;
  rol: Rol;
  naamVan: (userId: string) => string | undefined;
}

const STATUS_KLASSEN: Record<NotificatieStatus, string> = {
  wachtrij: "bg-slate-100 text-slate-600",
  verzonden: "bg-emerald-100 text-emerald-700",
  overgeslagen: "bg-slate-100 text-slate-500",
  mislukt: "bg-red-100 text-red-700",
};

function foutTekst(err: unknown, standaard: string): string {
  return err instanceof Error && err.message ? err.message : standaard;
}

/**
 * E-mailnotificaties: "Mijn mails" voor iedereen (in mock-modus met de volledige mail, inclusief werkende
 * knoppen) en voor controller/beheerder een overzicht van alle mails (zonder inhoud).
 */
export default function MeldingenPagina({ organisatieId, userId, rol, naamVan }: Props) {
  const magAlles = rol === "controller" || rol === "beheerder";
  const [tab, setTab] = useState<"mijn" | "alle">("mijn");
  const [lijst, setLijst] = useState<Notificatie[] | null>(null);
  const [fout, setFout] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; inhoud: NotificatieInhoud | null } | null>(null);

  const laad = useCallback(async () => {
    setFout(null);
    try {
      setLijst(await haalNotificatiesOp(organisatieId, tab === "mijn" ? userId : null));
    } catch (err) {
      setFout(foutTekst(err, "De meldingen konden niet worden geladen."));
    }
  }, [organisatieId, userId, tab]);

  useEffect(() => {
    let actief = true;
    haalNotificatiesOp(organisatieId, tab === "mijn" ? userId : null)
      .then((l) => actief && setLijst(l))
      .catch((err) => actief && setFout(foutTekst(err, "De meldingen konden niet worden geladen.")));
    return () => {
      actief = false;
    };
  }, [organisatieId, userId, tab]);

  const toon = async (n: Notificatie) => {
    if (open?.id === n.id) {
      setOpen(null);
      return;
    }
    try {
      setOpen({ id: n.id, inhoud: n.modus === "mock" && n.ontvanger_id === userId ? await haalInhoudOp(n.id) : null });
    } catch (err) {
      setFout(foutTekst(err, "De mail kon niet worden geladen."));
    }
  };

  const wisselTab = (nieuw: "mijn" | "alle") => {
    setTab(nieuw);
    setLijst(null);
    setOpen(null);
  };

  return (
    <div className="space-y-4">
      {fout && <p className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">{fout}</p>}

      <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Meldingen per e-mail</h2>
            <p className="text-xs text-slate-400">
              Goedkeuringsverzoeken, afgekeurde facturen, mislukte exports en facturen die bijna vervallen. In mock-modus
              wordt er niets echt gemaild: je leest je mails hier.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => wisselTab("mijn")}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === "mijn" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
            >
              Mijn mails
            </button>
            {magAlles && (
              <button
                type="button"
                onClick={() => wisselTab("alle")}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === "alle" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
              >
                Alle mails
              </button>
            )}
            <button type="button" onClick={laad} className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
              Vernieuwen
            </button>
          </div>
        </div>

        {!lijst && <p className="px-5 py-6 text-center text-sm text-slate-400">Laden…</p>}
        {lijst && lijst.length === 0 && <p className="px-5 py-6 text-center text-sm text-slate-400">Nog geen mails.</p>}
        {lijst && lijst.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {lijst.map((n) => (
              <li key={n.id} className="px-5 py-3">
                <button type="button" onClick={() => toon(n)} className="flex w-full flex-wrap items-start justify-between gap-2 text-left">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{n.onderwerp ?? SOORT_LABELS[n.soort]}</p>
                    <p className="text-xs text-slate-500">
                      {SOORT_LABELS[n.soort]}
                      {tab === "alle" && ` · aan ${n.ontvanger_email ?? (n.ontvanger_id ? naamVan(n.ontvanger_id) : null) ?? "onbekend"}`}
                      {" · "}
                      {datumTijd(n.verzonden_op ?? n.created_at)}
                      {n.modus === "mock" && " · mock"}
                    </p>
                    {n.reden && <p className="text-xs text-slate-500">{n.reden}</p>}
                  </div>
                  <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_KLASSEN[n.status]}`}>
                    {STATUS_LABELS[n.status]}
                  </span>
                </button>

                {open?.id === n.id && (
                  <div className="mt-3">
                    {open.inhoud ? (
                      <iframe
                        title={open.inhoud.onderwerp}
                        srcDoc={mailVoorWeergave(open.inhoud.html, window.location.origin)}
                        sandbox="allow-popups allow-popups-to-escape-sandbox"
                        className="h-[560px] w-full rounded-md border border-slate-200 bg-white"
                      />
                    ) : (
                      <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
                        {n.status !== "verzonden"
                          ? "Deze mail is niet verstuurd."
                          : n.modus === "live"
                            ? `Echt verstuurd naar ${n.ontvanger_email ?? "de ontvanger"}; de inhoud wordt niet bewaard.`
                            : "Alleen de ontvanger kan de inhoud van deze mail lezen."}
                      </p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
