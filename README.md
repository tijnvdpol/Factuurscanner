# Factuurscanner

Scan facturen (PDF/foto), laat Google Gemini de velden herkennen, controleer ze en exporteer naar CSV.
Met signalen (duplicaten, afwijkend IBAN e.d.), een coderingsvoorstel (grootboekrekening), organisaties
met rollen, een goedkeuringsworkflow met functiescheiding, een audit trail en koppelingen (zie
[Koppelingen](#koppelingen)).

- **Frontend:** React + TypeScript + Tailwind (Vite), gehost op Vercel
- **Backend:** Supabase: Postgres met Row Level Security, Auth (e-mail + wachtwoord), Storage (bucket `facturen`) en Edge Function `scan-factuur`
- **AI:** Gemini, alleen server-side aangeroepen. De API-sleutel staat als Supabase secret en komt nooit in de browser.

## Projectstructuur

| Pad | Inhoud |
|---|---|
| `src/` | Frontend |
| `src/lib/facturenApi.ts` | Database-aanroepen (lijst, opslaan via RPC, verwijderen, import) |
| `src/lib/opslag.ts` | Storage (upload, signed URL, verwijderen) |
| `src/lib/gemini.ts` | Aanroep van de Edge Function |
| `supabase/migrations/` | SQL-migraties (tabellen, RLS, RPC `sla_factuur_op`, Storage-bucket en -policies) |
| `supabase/functions/scan-factuur/` | Edge Function (Deno) die Gemini aanroept, met automatische fallback naar een ander model |
| `supabase/functions/_shared/gemini.ts` | Prompt, responsschema en normalisatie |
| `supabase/functions/verwerk-taken/` | Worker voor de takenwachtrij van de koppelingen (aangeroepen door pg_cron) |
| `supabase/functions/koppeling-actie/` | Acties op koppelingen vanuit de app (overzicht, wachtrij testen, …) |
| `supabase/functions/_shared/koppelingen/` | Gedeelde, testbare logica van de koppelingen (modus, taken, adapters) |
| `supabase/handtests/` | Testscripts voor de SQL Editor (`fase1_rls.sql`, `fase2_3_workflow.sql`, `fase4_1_koppelingen.sql`) |
| `supabase/tests/` | Geautomatiseerde databasetests (Vitest + PGlite, geen Docker nodig) |
| `src/lib/veldvalidatie.ts`, `signalen.ts`, `workflow.ts`, `codering.ts`, `audit.ts` | Pure functies (validatie, signaalregels, statusregels, coderingsvoorstel, leesbare audit log) |
| `docs/beslissingen.md` | Ontwerpbeslissingen (stap 2 en 3, koppelingen) |

## Lokaal ontwikkelen

```powershell
npm.cmd install
copy .env.example .env   # vul VITE_SUPABASE_URL en VITE_SUPABASE_ANON_KEY in
npm.cmd run dev          # http://localhost:5173
```

## Testen

```powershell
npm.cmd test              # unit-tests + databasetests (alle migraties op een lokale Postgres in WebAssembly)
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run check:functions   # typecheck van de Edge Functions (Deno via npx)
```

## Rollen

| Rol | Mag |
|---|---|
| Invoerder | scannen, bewerken, controleren, afgekeurde facturen terugzetten |
| Goedkeurder | goedkeuren (tot de goedkeuringslimiet), afkeuren, kritieke signalen oplossen |
| Controller | alles van invoerder en goedkeurder, als betaald markeren, grootboekrekeningen, audit log |
| Beheerder | alles, plus leden en organisatie beheren |

Goedkeuren kan niet voor een factuur die je zelf hebt ingevoerd of gecontroleerd (functiescheiding), niet boven je limiet, niet met een open kritiek signaal en niet zonder grootboekrekening. In een organisatie met één lid vervalt de functiescheiding (dit wordt gemeld en gelogd).

## Installatie: checklist

1. **Supabase-project aanmaken** op supabase.com (regio West-EU).
2. **Migraties uitvoeren**: plak in de SQL Editor, elk in een nieuwe, lege query, en in deze volgorde:
   1. `supabase/migrations/20260923120000_init.sql`
   2. `supabase/migrations/20260923130000_storage.sql`
   3. `supabase/migrations/20260923170000_signalen.sql`
   4. `supabase/migrations/20260923180000_grootboek.sql`
   5. `supabase/migrations/20260923190000_organisaties.sql`
   6. `supabase/migrations/20260923200000_workflow.sql`
   7. `supabase/migrations/20260923210000_audit.sql`

   Of met de CLI: `npx.cmd supabase db push`.
3. **Testen**: draai `supabase/handtests/fase1_rls.sql` en daarna `supabase/handtests/fase2_3_workflow.sql`, elk in een nieuwe query. De verwachte uitkomst is `GESLAAGD: alle 19 tests ok` en `GESLAAGD: alle 15 tests ok`.
4. **Bucket en policies controleren**: onder *Storage* hoort de bucket `facturen` **niet** public te zijn, en onder *Storage → Policies* horen vier policies te staan.
5. **Auth instellen** (*Authentication → URL Configuration*):
   - Site URL: de productie-URL (Vercel)
   - Redirect URLs: `http://localhost:5173` en de Vercel-URL
   - "Confirm email" aan laten
6. **Secret zetten**: onder *Edge Functions → Secrets* een secret `GEMINI_API_KEY` aanmaken.
   - Het model wordt automatisch gekozen:
     - De functie vraagt bij Google op welke modellen beschikbaar zijn en bewaart die lijst een uur.
     - Ze probeert eerst `gemini-3.6-flash`, daarna de overige stabiele Flash-modellen (nieuwste eerst, lite-varianten achteraan), met maximaal 4 pogingen.
     - Ze schakelt naar het volgende model als een model is ingetrokken, de limiet heeft bereikt, overbelast is of niet op tijd reageert. Een ingetrokken model wordt daarna een uur overgeslagen.
   - Optioneel stel je een eigen voorkeursvolgorde in met het secret `GEMINI_MODELLEN`, bijvoorbeeld `gemini-3.6-flash,gemini-3.5-flash`.
7. **Edge Function deployen** (vanuit deze map, commando's één voor één):
   ```powershell
   npx.cmd supabase login
   npx.cmd supabase functions deploy scan-factuur --use-api --project-ref <project-ref>
   ```
   "Verify JWT" staat uit via `supabase/config.toml`, want de functie controleert de JWT zelf.
8. **Vercel**: voeg onder *Project → Settings → Environment Variables* toe:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY` (de publishable key)

   Deploy daarna opnieuw, want Vite leest deze waarden in tijdens de build.

## Koppelingen

Elke koppeling werkt in **mock** (realistische testdata, geen externe accounts nodig) of **live**. Standaard staat
alles op mock. De modus stel je in op twee manieren:

- **Pagina Koppelingen** (beheerder): per koppeling mock of live.
- **Supabase secret** `KOPPELING_<NAAM>_MODUS` = `live` of `mock` (bijv. `KOPPELING_VIES_MODUS=live`). Dit gaat altijd voor
  en is dan in de app niet te wijzigen ("vastgezet door server"). Handig om bijvoorbeeld een testomgeving op mock vast te zetten.

Secrets staan alleen in de **Supabase secrets** (Edge Functions → Secrets), nooit in `.env` of Vercel met `VITE_`. De
pagina Koppelingen laat zien welke secrets voor live nog ontbreken (alleen de namen).

| Koppeling | `<NAAM>` | Nodig voor live | Status |
|---|---|---|---|
| Basis (wachtrij, retries) | – | `WORKER_GEHEIM` + 2 Vault-secrets (zie hieronder) | fase 4.1 ✅ |
| Verrijken: VIES | `VIES` | niets (gratis EU-API) | fase 4.2 ✅ |
| Verrijken: ECB-wisselkoersen | `ECB` | niets (gratis API) | fase 4.2 ✅ |
| Verrijken: KvK | `KVK` | `KVK_API_KEY` (productie), of `KVK_OMGEVING=test` zonder sleutel | fase 4.2 ✅ |
| Mailbox-import | `MAILBOX` | Mailgun-account (gratis plan) + `MAILGUN_SIGNING_KEY` | fase 4.3 |
| E-mailnotificaties | `EMAIL` | Resend-account + `RESEND_API_KEY`, `MAIL_AFZENDER`, `APP_URL` | fase 4.4 |
| Boekhoudpakket | `BOEKHOUDING` | Moneybird + `MONEYBIRD_TOKEN`, `MONEYBIRD_ADMINISTRATIE_ID` | fase 4.5 |
| Betaalopdrachten | `BETALING` | niets (live = SEPA-bestand downloaden) | fase 4.6 |
| Power BI | – | Power BI Desktop + een rapportagerol | fase 4.7 |

Mislukt een koppeling, dan probeert de wachtrij het automatisch opnieuw (na 1 min, 5 min, 30 min, 2 uur en 12 uur). In
de factuurlijst verschijnt dan een badge, bijv. "VIES: nieuwe poging om 14:05" of "Export mislukt" (klik om het meteen
opnieuw te proberen). Elke actie van een koppeling staat in de audit log, met de bron (bijv. "via VIES") en de gebruiker,
of "systeem".

### Basis: wachtrij en worker (fase 4.1)

Eenmalig, in deze volgorde:

1. **Migratie** `20260924100000_koppelingen_basis.sql` uitvoeren (`npx.cmd supabase db push`, of plakken in de SQL Editor).
   Die zet ook de extensies `pg_cron` en `pg_net` aan en plant de cronjob `factuurscanner-verwerk-taken` (elke minuut).
2. **Geheim maken** voor de worker (PowerShell):
   ```powershell
   $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString("x2") })
   ```
3. **Supabase secret** (Edge Functions → Secrets): `WORKER_GEHEIM` = het geheim uit stap 2.
4. **Vault** (SQL Editor, één keer; vervang de twee waarden). De cronjob leest hier de URL en het geheim:
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co', 'factuurscanner_project_url');
   select vault.create_secret('<het geheim uit stap 2>', 'factuurscanner_worker_geheim');
   ```
5. **Edge Functions deployen** (commando's één voor één):
   ```powershell
   npx.cmd supabase functions deploy verwerk-taken --use-api --project-ref <project-ref>
   npx.cmd supabase functions deploy koppeling-actie --use-api --project-ref <project-ref>
   ```
6. **Controleren:**
   - Draai `supabase/handtests/fase4_1_koppelingen.sql` in de SQL Editor. Verwacht: `GESLAAGD: alle 10 tests ok`.
   - In de app (als controller of beheerder): **Koppelingen → Test de wachtrij**. Binnen een minuut staat de testtaak op
     *Gelukt*. Blijft hij op *In wachtrij* staan, controleer dan stap 3 en 4 (zelfde geheim?) en of de cronjob bestaat:
     `select * from cron.job;` en `select * from cron.job_run_details order by start_time desc limit 5;`.

### Verrijken: VIES, ECB en KvK (fase 4.2)

Bij elke opgeslagen factuur plant de database de controles in; de worker voert ze uit:

- **VIES** (btw-nummer uit een EU-land): geldig of ongeldig volgens de Europese Commissie, met tijdstip. Het resultaat blijft
  30 dagen geldig (daarna bij een nieuwe factuur opnieuw). Ongeldig → waarschuwing *Btw-nummer ongeldig (VIES)*. Is VIES
  tijdelijk druk (`MS_MAX_CONCURRENT_REQ`, `MS_UNAVAILABLE`), dan volgt automatisch een nieuwe poging.
- **ECB** (factuur in vreemde valuta): omrekening naar euro met de ECB-referentiekoers op de factuurdatum (weekend of feestdag:
  de laatste publicatie ervóór). Koers, koersdatum en bron staan op de factuur; in de lijst staat "≈ € …". De
  **goedkeuringslimiet** geldt voor het bedrag in euro; zolang de koers ontbreekt, is goedkeuren met een limiet geblokkeerd.
- **KvK** (KvK-nummer op de factuur, nieuw of langer dan 90 dagen niet gecontroleerd): bedrijfsgegevens ophalen en vergelijken
  met de naam op de factuur (rechtsvorm, hoofdletters en leestekens tellen niet; handelsnamen tellen mee). Niet gevonden,
  uitgeschreven of een andere naam → waarschuwing *Afwijking KvK*.

**Instellen:**

1. Migratie `20260924110000_verrijking.sql` uitvoeren. Die plant ook controles in voor bestaande facturen.
2. `verwerk-taken` opnieuw deployen: `npx.cmd supabase functions deploy verwerk-taken --use-api --project-ref <project-ref>`
3. Per koppeling de modus kiezen (pagina Koppelingen, of `KOPPELING_VIES_MODUS` / `KOPPELING_ECB_MODUS` / `KOPPELING_KVK_MODUS`):
   - **VIES en ECB live:** geen account of sleutel nodig.
   - **KvK live, testomgeving** (fictieve bedrijven, geen account): secret `KVK_OMGEVING=test`. Testnummers zijn o.a. 68750110
     ("Test BV Donald") en 69599084. Echte leveranciers geven hier "niet gevonden".
   - **KvK live, productie:** abonnement op de KvK API's (developers.kvk.nl, Basisprofiel API) en secret `KVK_API_KEY`.
     Laat `KVK_OMGEVING` dan weg.
4. Controleren: draai `supabase/handtests/fase4_2_verrijking.sql` (verwacht: `GESLAAGD: alle 9 tests ok`) en sla een factuur
   op met valuta USD, een btw-nummer en een KvK-nummer. Binnen een minuut staat "≈ € …" in de lijst en staan de resultaten
   in de historie van de factuur.

**Mock-modus** (standaard), zonder internet:

| Koppeling | Gedrag |
|---|---|
| VIES | nummer eindigt op `99` → ongeldig; op `98` → VIES tijdelijk niet bereikbaar (test de retries); anders geldig |
| ECB | vaste koersen (USD 1,1622, GBP 0,8641, CHF 0,9362, JPY 178,86, …); weekend → koers van vrijdag; onbekende valuta → mislukt |
| KvK | 68750110, 12345678 en 87654321 (uitgeschreven) zijn vaste testbedrijven; eindigt op `00` → niet gevonden, op `99` → uitgeschreven, op `98` → andere naam; anders dezelfde naam als op de factuur |

## Beveiliging

- Elke tabel heeft RLS op lidmaatschap van de organisatie (`is_lid`/`heeft_rol`). `btw_regels` wordt beveiligd via de bijbehorende factuur.
- Status, "ingevoerd door" en het bekende IBAN van een leverancier zijn niet rechtstreeks te wijzigen (kolomrechten + triggers); dat gaat alleen via `wijzig_status` en `los_signaal_op`.
- De audit log kan door niemand worden gewijzigd of verwijderd, ook niet via de SQL Editor.
- Storage-bestanden staan onder `{organisatie_id}/{factuur_id}/…` (oude bestanden onder `{user_id}/…` blijven leesbaar voor de organisatie).
- De Edge Function haalt bestanden op met de JWT van de gebruiker, dus ook daar gelden de Storage-policies.
- Zet nooit secrets met het prefix `VITE_` in `.env`, want die komen in de browser-bundle terecht.
- Koppelingen: Edge Functions met de service-rolsleutel wijzigen facturen alleen via databasefuncties die dezelfde controles
  doen als de app. De service role kan de status niet rechtstreeks wijzigen (trigger). De worker is alleen aan te roepen met
  `WORKER_GEHEIM`; de takenwachtrij is voor gebruikers alleen-lezen.
