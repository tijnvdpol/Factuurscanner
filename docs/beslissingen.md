# Beslissingen stap 2 en 3

Per keuze: **wat** er gekozen is, **waarom**, en welk **alternatief** is afgewogen.

## Algemeen

### B1. Databasetests met PGlite in plaats van `supabase start`
- **Wat:** Docker is niet geïnstalleerd op deze machine, dus `supabase start`/`db reset` kan niet. De migraties en RLS worden getest met [PGlite](https://pglite.dev) (echte Postgres 18, gecompileerd naar WebAssembly) binnen Vitest. `supabase/tests/platform.sql` bootst na wat de migraties van Supabase gebruiken: de rollen `anon`/`authenticated`/`service_role`, de standaardrechten van Supabase op `public` (alle rechten voor `anon` en `authenticated`, zodat een vergeten `revoke` opvalt), `auth.users` + `auth.uid()` en `storage.buckets`/`storage.objects` + `storage.foldername()`.
- **Waarom:** zo draaien alle migraties plus de RLS- en workflowtests automatisch bij `npm test`, zonder Docker.
- **Alternatief:** de SQL alleen schrijven en als "niet lokaal getest" markeren. Dat is minder zeker. Beperking: productie draait Postgres 15/17 en de echte Storage-API wordt niet nagebootst. Daarom staat er ook een handtest-script voor de SQL Editor in `supabase/handtests/`.

### B2. Handtest-scripts dienen ook als geautomatiseerde test
- **Wat:** `supabase/tests/handtests.test.ts` draait elk script in `supabase/handtests/` op PGlite en verwacht de melding `GESLAAGD`.
- **Waarom:** er is één bron van waarheid die je zowel lokaal (automatisch) als in de SQL Editor van productie kunt draaien.

### B3. Deno via npx voor de Edge Function
- **Wat:** `npm run check:functions` draait `deno check` via `npx deno`. Deno hoeft daarvoor niet geïnstalleerd te zijn.

## Fase 2.1: extra velden en validatie

### B4. Extractie bestond al; alleen validatie toegevoegd
- **Wat:** `scan-factuur` extraheerde in stap 1 al `vervaldatum`, `iban`, `btw_nummer` en `kvk_nummer`, en het formulier toonde ze al met het label "niet herkend". Fase 2.1 voegt daarom alleen de validatiemodule `src/lib/veldvalidatie.ts` (pure functies) en de inline foutmeldingen voor btw- en KvK-nummer toe.
- **Alternatief:** de prompt herschrijven. Dat was niet nodig.

### B5. Btw-nummer: strikt voor NL, globaal voor andere landen
- **Wat:** begint het nummer met `NL`, dan moet het exact `NL` + 9 cijfers + `B` + 2 cijfers zijn. Buitenlandse nummers worden alleen op het globale EU-formaat gecontroleerd: landcode + 2–13 letters/cijfers.
- **Waarom:** de opdracht vraagt om NL-formaatcontrole. Een Duitse leverancier (`DE123456789`) mag geen foutmelding opleveren.

### B6. IBAN: lengte per land plus mod-97
- **Wat:** tabel met IBAN-lengtes uit het SWIFT-register (±90 landen). Een onbekende landcode is een fout. Normalisatie (spaties weg, hoofdletters) is gelijk aan die in de database.
- **Opmerking:** het IBAN `NL02RABO0123456789` uit het testscript van fase 1 is ongeldig. In nieuwe tests wordt `NL44RABO0123456789` gebruikt.

### B7. Strengere datumcontrole
- **Wat:** `isGeldigeDatum` weigert niet-bestaande datums zoals 2026-02-30. Voorheen accepteerde `Date.parse` die en schoof ze stilletjes door naar een andere dag.
