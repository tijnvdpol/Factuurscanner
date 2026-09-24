// Verwerking per soort taak. Elke fase voegt hier zijn soorten toe.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { modusVoor } from "../_shared/server.ts";
import { DefinitieveFout, type TaakHandler } from "../_shared/koppelingen/taken.ts";
import { verrijkingHandlers } from "../_shared/koppelingen/verrijking.ts";
import { ViesLive, ViesMock } from "../_shared/koppelingen/vies.ts";
import { EcbLive, EcbMock } from "../_shared/koppelingen/ecb.ts";
import { KVK_TEST_SLEUTEL, KVK_URL, KvkLive, KvkMock } from "../_shared/koppelingen/kvk.ts";
import { type InboxBijlageRij, mailboxHandler, mockScan } from "../_shared/koppelingen/mailbox.ts";
import { appUrlVoor, emailHandler, MailMock, ResendLive } from "../_shared/koppelingen/email.ts";
import { mailTokenSleutel } from "../_shared/koppelingen/mailtoken.ts";
import { boekhoudHandler } from "../_shared/koppelingen/boekhouding.ts";
import { kiesBoekhoudProvider } from "../_shared/koppelingen/boekhoudProvider.ts";
import { mimeTypeVoor, scanMetGemini } from "../_shared/geminiScan.ts";
import type { Rekening } from "../_shared/gemini.ts";

const BUCKET = "facturen";
/** Maximale scantijd per bijlage in de worker (de worker zelf heeft een beperkte looptijd). */
const SCAN_BUDGET_MS = 55_000;

function kvkLive(): KvkLive {
  const test = Deno.env.get("KVK_OMGEVING")?.trim().toLowerCase() === "test";
  const sleutel = Deno.env.get("KVK_API_KEY")?.trim() || (test ? KVK_TEST_SLEUTEL : "");
  if (!sleutel) {
    throw new DefinitieveFout("KvK staat op live, maar KVK_API_KEY ontbreekt (of zet KVK_OMGEVING=test voor de testomgeving).");
  }
  return new KvkLive(test ? KVK_URL.test : KVK_URL.productie, sleutel);
}

function resendLive(): ResendLive {
  const sleutel = Deno.env.get("RESEND_API_KEY")?.trim();
  const afzender = Deno.env.get("MAIL_AFZENDER")?.trim();
  if (!sleutel || !afzender) {
    throw new DefinitieveFout("E-mail staat op live, maar RESEND_API_KEY of MAIL_AFZENDER ontbreekt.");
  }
  return new ResendLive(sleutel, afzender);
}

/** Scannen zonder Gemini: als SCAN_MODUS=mock, of als er geen GEMINI_API_KEY is. */
export function scanIsMock(): boolean {
  return Deno.env.get("SCAN_MODUS")?.trim().toLowerCase() === "mock" || !Deno.env.get("GEMINI_API_KEY");
}

function mailboxDeps(supabase: SupabaseClient) {
  const opslag = () => supabase.storage.from(BUCKET);
  return mailboxHandler({
    bijlage: async (id) => {
      const { data, error } = await supabase
        .from("inbox_bijlagen")
        .select("id, organisatie_id, pad, bestandsnaam, mime_type, factuur_id, testdata, bericht:inbox_berichten!inbox_bijlagen_bericht_id_fkey(status)")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`Bijlage ophalen mislukt: ${error.message}`);
      if (!data) return null;
      const { bericht, ...rij } = data as unknown as Omit<InboxBijlageRij, "bericht_status"> & { bericht: { status: string } | null };
      return { ...rij, bericht_status: bericht?.status ?? "" };
    },
    download: async (pad) => {
      const { data, error } = await opslag().download(pad);
      if (error || !data) throw new Error(`Bijlage downloaden mislukt: ${error?.message ?? "niet gevonden"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    kopieer: async (van, naar) => {
      const { error } = await opslag().copy(van, naar);
      if (!error) return;
      // Bestaat het doel al (eerdere poging), dan is dat goed.
      const { error: bestaatNiet } = await opslag().download(naar);
      if (bestaatNiet) throw new Error(`Bestand kopiëren mislukt: ${error.message}`);
    },
    verwijder: async (pad) => {
      await opslag().remove([pad]);
    },
    scan: async (bijlage, inhoud) => {
      if (scanIsMock()) return mockScan(bijlage, new Date().toISOString().slice(0, 10));
      const { data: rekeningen } = await supabase
        .from("grootboekrekeningen")
        .select("id, code, omschrijving")
        .eq("organisatie_id", bijlage.organisatie_id)
        .eq("actief", true)
        .order("code");
      return scanMetGemini({
        bytes: inhoud,
        mimeType: mimeTypeVoor(bijlage.bestandsnaam, bijlage.mime_type ?? ""),
        rekeningen: (rekeningen ?? []) as Rekening[],
        geminiKey: Deno.env.get("GEMINI_API_KEY")!,
        start: Date.now(),
        tijdbudgetMs: SCAN_BUDGET_MS,
      });
    },
    rpc: async (functie, args) => {
      const { data, error } = await supabase.rpc(functie, args);
      if (error) throw new Error(`${functie}: ${error.message}`);
      return data;
    },
  });
}

export function maakHandlers(supabase: SupabaseClient): Record<string, TaakHandler> {
  return {
    // Controleert of de wachtrij, de cronjob en de worker werken (knop "Test de wachtrij").
    test: () => Promise.resolve({ bericht: "De wachtrij en de worker werken.", verwerkt_op: new Date().toISOString() }),

    ...verrijkingHandlers({
      modus: (organisatieId, koppeling) => modusVoor(supabase, organisatieId, koppeling),
      rpc: async (functie, args) => {
        const { data, error } = await supabase.rpc(functie, args);
        if (error) throw new Error(`${functie}: ${error.message}`);
        return data;
      },
      vies: (modus) => (modus === "live" ? new ViesLive() : new ViesMock()),
      ecb: (modus) => (modus === "live" ? new EcbLive() : new EcbMock()),
      kvk: (modus, naam) => (modus === "live" ? kvkLive() : new KvkMock(naam)),
    }),

    mailbox: mailboxDeps(supabase),

    email: emailHandler({
      modus: (organisatieId, koppeling) => modusVoor(supabase, organisatieId, koppeling),
      rpc: async (functie, args) => {
        const { data, error } = await supabase.rpc(functie, args);
        if (error) throw new Error(`${functie}: ${error.message}`);
        return data;
      },
      provider: (modus) => (modus === "live" ? resendLive() : new MailMock()),
      appUrl: (modus) => appUrlVoor(modus, Deno.env.get("APP_URL")),
      tokenSleutel: () => mailTokenSleutel((naam) => Deno.env.get(naam)),
    }),

    boekhouding: boekhoudHandler({
      modus: (organisatieId, koppeling) => modusVoor(supabase, organisatieId, koppeling),
      rpc: async (functie, args) => {
        const { data, error } = await supabase.rpc(functie, args);
        if (error) throw new Error(`${functie}: ${error.message}`);
        return data;
      },
      provider: (pakket, modus) => kiesBoekhoudProvider(pakket, modus, (naam) => Deno.env.get(naam)),
      bestand: async (pad) => {
        const { data, error } = await supabase.storage.from(BUCKET).download(pad);
        if (error || !data) throw new Error(`Bestand downloaden mislukt: ${error?.message ?? "niet gevonden"}`);
        return new Uint8Array(await data.arrayBuffer());
      },
    }),
  };
}
