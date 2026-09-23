# Factuurscanner

Scan facturen (PDF/foto), laat Google Gemini de velden herkennen, controleer ze en exporteer naar CSV.

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
| `supabase/functions/scan-factuur/` | Edge Function (Deno) die Gemini aanroept |
| `supabase/functions/_shared/gemini.ts` | Prompt, responsschema en normalisatie |
| `supabase/handtests/fase1_rls.sql` | Testscript voor RLS en duplicaatcontrole (SQL Editor) |

## Lokaal ontwikkelen

```powershell
npm.cmd install
copy .env.example .env   # vul VITE_SUPABASE_URL en VITE_SUPABASE_ANON_KEY in
npm.cmd run dev          # http://localhost:5173
```

## Installatie: checklist

1. **Supabase-project aanmaken** op supabase.com (regio West-EU).
2. **Migraties uitvoeren**: plak in de SQL Editor, elk in een nieuwe, lege query, en in deze volgorde:
   1. `supabase/migrations/20260923120000_init.sql`
   2. `supabase/migrations/20260923130000_storage.sql`
3. **Testen**: draai `supabase/handtests/fase1_rls.sql` in een nieuwe query. De verwachte uitkomst is de melding `GESLAAGD: alle 19 tests ok`.
4. **Bucket en policies controleren**: onder *Storage* hoort de bucket `facturen` **niet** public te zijn, en onder *Storage → Policies* horen vier policies te staan.
5. **Auth instellen** (*Authentication → URL Configuration*):
   - Site URL: de productie-URL (Vercel)
   - Redirect URLs: `http://localhost:5173` en de Vercel-URL
   - "Confirm email" aan laten
6. **Secret zetten**: onder *Edge Functions → Secrets* een secret `GEMINI_API_KEY` aanmaken.
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

- Elke tabel heeft RLS: een gebruiker ziet en wijzigt alleen eigen rijen. `btw_regels` wordt beveiligd via de bijbehorende factuur.
- Storage-bestanden staan onder `{user_id}/{factuur_id}/…`, en de policies staan alleen toegang tot de eigen map toe.
- De Edge Function haalt bestanden op met de JWT van de gebruiker, dus ook daar gelden de Storage-policies.
- Zet nooit secrets met het prefix `VITE_` in `.env`, want die komen in de browser-bundle terecht.
