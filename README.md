# Factuurscanner

Scan facturen (PDF/foto), laat Google Gemini de velden herkennen, controleer ze en exporteer naar CSV.
Met signalen (duplicaten, afwijkend IBAN e.d.), een coderingsvoorstel (grootboekrekening), organisaties
met rollen, een goedkeuringsworkflow met functiescheiding en een audit trail.

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
| `supabase/handtests/` | Testscripts voor de SQL Editor (`fase1_rls.sql`, `fase2_3_workflow.sql`) |
| `supabase/tests/` | Geautomatiseerde databasetests (Vitest + PGlite, geen Docker nodig) |
| `src/lib/veldvalidatie.ts`, `signalen.ts`, `workflow.ts`, `codering.ts`, `audit.ts` | Pure functies (validatie, signaalregels, statusregels, coderingsvoorstel, leesbare audit log) |
| `docs/beslissingen.md` | Ontwerpbeslissingen van stap 2 en 3 |

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
npm.cmd run check:functions   # typecheck van de Edge Function (Deno via npx)
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

## Beveiliging

- Elke tabel heeft RLS op lidmaatschap van de organisatie (`is_lid`/`heeft_rol`). `btw_regels` wordt beveiligd via de bijbehorende factuur.
- Status, "ingevoerd door" en het bekende IBAN van een leverancier zijn niet rechtstreeks te wijzigen (kolomrechten + triggers); dat gaat alleen via `wijzig_status` en `los_signaal_op`.
- De audit log kan door niemand worden gewijzigd of verwijderd, ook niet via de SQL Editor.
- Storage-bestanden staan onder `{organisatie_id}/{factuur_id}/…` (oude bestanden onder `{user_id}/…` blijven leesbaar voor de organisatie).
- De Edge Function haalt bestanden op met de JWT van de gebruiker, dus ook daar gelden de Storage-policies.
- Zet nooit secrets met het prefix `VITE_` in `.env`, want die komen in de browser-bundle terecht.
