# Rapport: Factuurscanner stap 2 en 3

Branch: `feature/stap-2-3` (niet gepusht). Eén commit per fase, plus deze afsluitende commit.

Voorwaarde (stap 1) was aanwezig: migraties voor `leveranciers`/`facturen`/`btw_regels` met RLS, Supabase Auth in de frontend, bucket `facturen`, Edge Function `scan-factuur`, en localStorage alleen nog voor een eenmalige import.

## 1. Samenvatting per fase

| Fase | Status | Wat er gebouwd is |
|---|---|---|
| 2.1 Extra velden en validatie | ✅ | `scan-factuur` extraheerde vervaldatum, IBAN, btw- en KvK-nummer al (stap 1). Nieuw: validatiemodule `src/lib/veldvalidatie.ts` (IBAN-lengte per land + mod-97, NL-btw-formaat, KvK = 8 cijfers, vervaldatum ≥ factuurdatum), inline getoond. |
| 2.2 Signalen | ✅ | Tabel `factuur_signalen`. Bepaald bij elke save in Postgres: mogelijk duplicaat, IBAN afwijkend (kritiek), nieuwe leverancier, rond bedrag, validatiefout. Het IBAN wordt per factuur bewaard; het bekende IBAN van de leverancier wordt nooit automatisch overschreven. "Oplossen" met verplichte toelichting en een optie om het nieuwe IBAN over te nemen. Badges per ernst in de lijst, een signalenblok in het bewerkscherm en een voorproef vóór het opslaan. |
| 2.3 Coderingsvoorstel | ✅ | Tabel `grootboekrekeningen` met een standaardset van 16 rekeningen (trigger + backfill). Voorstel: eerst historie (meest gebruikte handmatig bevestigde rekening), anders AI (Gemini kiest uit de actieve rekeningen, in dezelfde scan-aanroep). Label "Voorgesteld (historie/AI, xx%)" met knop Bevestigen. Beheerscherm voor rekeningen. Twee nieuwe kolommen in de CSV-export. |
| 3.1 Organisaties en rollen | ✅ | `organisaties` en `organisatie_leden` (4 rollen + goedkeuringslimiet). Backfill: een persoonlijke organisatie per gebruiker. `organisatie_id` op alle tabellen. RLS via `is_lid`/`heeft_rol` (security definer). Storage onder `{organisatie_id}/…`, met oude paden leesbaar. Trigger op `auth.users` plus een vangnet bij de eerste login. Ledenbeheer (alleen beheerder, laatste beheerder beschermd) en een organisatiekiezer in de header. |
| 3.2 Statusworkflow | ✅ | Statussen inclusief `afgekeurd`, workflowkolommen, en `wijzig_status()` die rol, functiescheiding, limiet, kritieke signalen en grootboekrekening controleert. Status is niet direct te wijzigen (kolomrechten + trigger). Automatische terugval naar gescand na een inhoudelijke wijziging (ook btw-regels). Uitzondering voor een organisatie met één lid, met melding. Signaal `net_onder_limiet`. UI: tabs, knoppen per rol en de reden bij een blokkade. |
| 3.3 Audit trail | ✅ | `audit_log`, alleen te vullen via triggers op 5 tabellen; bij updates alleen de gewijzigde velden. UPDATE/DELETE/TRUNCATE geweigerd, ook voor de service role. Tab "Historie" per factuur (tijdlijn, van → naar, Nederlandse veldnamen) en een scherm "Audit log" (controller/beheerder) met filters en CSV-export. |

Omdat Docker niet beschikbaar was, is alles tegen PGlite getest, niet tegen een echte Supabase. Zie §3 voor wat daardoor nog niet getest is.

## 2. Beslissingen

Alle keuzes staan in [`docs/beslissingen.md`](beslissingen.md) (B1–B50). De vijf belangrijkste:

1. **Databasetests met PGlite (B1).** Docker ontbrak, dus draaien alle migraties plus de RLS- en workflowtests op een echte Postgres in WebAssembly, met een nabootsing van `auth`, `storage` en de standaardrechten van Supabase. Alles draait mee met `npm test`.
2. **Signalen in Postgres, in dezelfde transactie als het opslaan (B8).** Een factuur kan niet zonder signaalbepaling worden opgeslagen. Signalen zijn alleen via functies te schrijven, zodat niemand een kritiek signaal kan wissen (B12).
3. **IBAN per factuur; het bekende IBAN wijzigt alleen via "Oplossen" (B10, B28).** Kolomrechten verbieden het rechtstreeks wijzigen van `leveranciers.iban`, het verwijderen van leveranciers en het wijzigen van "ingevoerd door". Dat zijn precies de gaten waarlangs fraude of het omzeilen van de functiescheiding anders mogelijk zou zijn.
4. **Workflow afgedwongen in de database (B34).** Kolomrechten plus een trigger blokkeren directe statuswijzigingen. `wijzig_status` (security definer) is de enige route. "Bevoegd" wordt bepaald met `current_user`, zodat interne functies wel mogen.
5. **Eén lid: geen functiescheiding, wel limiet, kritieke signalen en grootboekrekening (B36).** Rol en functiescheiding vervallen, en de melding komt in de audit trail. Inhoudelijke controles blijven gelden.

## 3. Testresultaten

**Automatisch:** 177 tests, allemaal geslaagd (`npm test`). Daarnaast slagen `npm run typecheck`, `npm run lint` (0 waarschuwingen), `npm run build` en `npm run check:functions` (Deno-typecheck van de Edge Function).

| Bestand | Tests | Inhoud |
|---|---|---|
| `src/lib/veldvalidatie.test.ts` | 29 | geldige/ongeldige IBAN's (lengte, landcode, controlegetal), btw-nummers, KvK, datums |
| `src/lib/signalen.test.ts` | 19 | normalisatie van factuurnummers, duplicaten, rond bedrag, net onder limiet, IBAN afwijkend, voorspelling |
| `src/lib/workflow.test.ts` | 23 | knoppen per rol × status, redenen bij blokkade (functiescheiding, limiet, kritiek, grootboek), één lid, verwijderen, terugval, filters |
| `src/lib/codering.test.ts`, `scanPrompt.test.ts`, `csv.test.ts`, `audit.test.ts` | 15 | historie vóór AI, label "Voorgesteld (AI, 82%)", prompt/schema/normalisatie van de AI-codering, CSV-kolommen, leesbare audit log en CSV |
| `supabase/tests/signalen.test.ts` | 39 | SQL-regels gelijk aan TS; alle signaaltypen; IBAN niet overschreven; oplossen (toelichting, rechten); signalen niet rechtstreeks te wijzigen |
| `supabase/tests/grootboek.test.ts` | 7 | standaardset, geen delete, isolatie, historievoorstel |
| `supabase/tests/organisaties.test.ts` | 14 | **backfill** (database vóór de organisatie-migratie met data, daarna migreren), **RLS: organisatie A ziet niets van B**, ledenbeheer, laatste beheerder, kolomrechten, storage-policies |
| `supabase/tests/workflow.test.ts` | 17 | **functiescheiding** (invoerder/controleur kan niet goedkeuren), **goedkeuringslimiet**, **blokkade door kritiek signaal**, rollen, terugval, betaald vergrendeld, afkeuren, één lid |
| `supabase/tests/audit.test.ts` | 12 | alleen gewijzigde velden, statuswijziging met toelichting, **audit_log niet aan te passen of te verwijderen** (ook niet als superuser), geen ruis bij cascade |
| `supabase/tests/handtests.test.ts` | 2 | draait `fase1_rls.sql` (19 tests) en `fase2_3_workflow.sql` (15 tests) en verwacht "GESLAAGD" |

**Lokaal getest:** alle migraties in volgorde op een lege database én een backfill met bestaande data (PGlite = Postgres 18).

**Niet getest (kon niet zonder Docker of productie):**
- Tegen een echte Supabase-stack: PostgREST (embeddings; ik heb expliciete FK-hints toegevoegd om ambiguïteit te voorkomen), de echte Storage-API, de Auth-trigger met de rol `supabase_auth_admin` en Postgres 15/17. De gebruikte features (`nulls not distinct`, `on delete set null (kolom)`) werken vanaf Postgres 15.
- De Edge Function end-to-end met Gemini (geen API-sleutel lokaal). De prompt, het schema en de verwerking van het antwoord zijn wel unit-getest en de functie is typecorrect.
- De UI in een browser. Typecheck, lint en build slagen, maar er is niet geklikt. Doorloop daarvoor het testscenario in §5.

**Aangepast bestaand testscript:** in `supabase/handtests/fase1_rls.sql` zijn test 7b, 8, 9, 10a, 12a en 16 aangepast aan bewust veranderd gedrag: het IBAN wordt niet meer overschreven, de status gaat alleen via `wijzig_status`, en een factuur hoort bij een organisatie.

## 4. Handmatige stappen voor jou (in deze volgorde)

> Maak eerst een back-up (Supabase-dashboard → Database → Backups). Stap 5 van de migraties (organisaties) herschrijft eigendom en RLS.

1. **Migraties naar productie**
   - Kijk eerst wat Supabase denkt dat er al staat:
     ```powershell
     npx.cmd supabase login
     npx.cmd supabase link --project-ref apehfdoikvbnyuutnutq
     npx.cmd supabase migration list
     ```
   - Staan `20260923120000` en `20260923130000` remote **niet** als toegepast? Dat is waarschijnlijk, want je hebt ze in de SQL Editor geplakt. Markeer ze dan eerst, anders probeert `db push` ze opnieuw uit te voeren:
     ```powershell
     npx.cmd supabase migration repair --status applied 20260923120000 20260923130000
     npx.cmd supabase db push
     ```
   - Of plak in de SQL Editor, elk in een nieuwe query en in deze volgorde: `20260923170000_signalen.sql`, `20260923180000_grootboek.sql`, `20260923190000_organisaties.sql`, `20260923200000_workflow.sql`, `20260923210000_audit.sql`.
   - Controleer daarna: draai `supabase/handtests/fase1_rls.sql` en `supabase/handtests/fase2_3_workflow.sql`. Verwacht resultaat: `GESLAAGD: alle 19 tests ok` en `GESLAAGD: alle 15 tests ok`.
2. **Edge Function deployen** (vóór de frontend; de oude functie weigert paden onder `{organisatie_id}/`):
   ```powershell
   npx.cmd supabase functions deploy scan-factuur --use-api --project-ref apehfdoikvbnyuutnutq
   ```
3. **Secrets en env-variabelen:** geen nieuwe. `GEMINI_API_KEY` (en optioneel `GEMINI_MODELLEN`) blijven zoals ze zijn. `.env.example` hoefde niet te veranderen.
4. **Branch pushen en mergen:**
   ```powershell
   git push -u origin feature/stap-2-3
   ```
   Maak een pull request, merge naar `main` en laat Vercel deployen. Doe stap 1–4 kort na elkaar. De database blijft grotendeels compatibel met de oude frontend (opslaan zonder `organisatie_id` werkt nog), maar schermen van de oude frontend kunnen tussendoor fouten tonen.

## 5. Testscenario met 2 accounts

Account **A** is je bestaande account. Na de migratie is dat de beheerder van "Organisatie van {jouw e-mail}". Het speelt hier de **invoerder**. Account **B** wordt **goedkeurder**. A blijft beheerder, omdat een organisatie altijd een beheerder moet hebben. Als beheerder mag A ook goedkeuren, maar de functiescheiding houdt A tegen bij eigen facturen. Dat is precies wat je wilt zien.

1. **B registreren** met een tweede e-mailadres en de bevestigingsmail openen.
2. **A → Leden:** voeg B toe als *Goedkeurder* met limiet *5000*. Hernoem de organisatie eventueel.
3. **A → Facturen:** scan een factuur.
   - Controleer de nieuwe velden en de codering ("Voorgesteld (AI, xx%)"), en klik **Bevestigen**.
   - Onder "Bij opslaan verwacht" staat *Nieuwe leverancier*. Sla op.
   - In de lijst: status *Gescand*, blauwe badge "1 info".
4. **A:** klik **Controleren**. De knop **Goedkeuren** staat grijs met *"Functiescheiding: je hebt deze factuur zelf ingevoerd"*.
5. **B:** log in (in een andere browser of incognito), open de tab *Te keuren* en klik **Goedkeuren**. Status: *Goedgekeurd*.
6. **Duplicaat:** A scant dezelfde factuur nog eens.
   - Met exact hetzelfde nummer verschijnt de melding "staat al in je overzicht" (harde blokkade).
   - Pas het nummer aan naar een variant, bijv. `2026-001` → `2026 1`. Het blok "Bij opslaan verwacht" toont *Mogelijk duplicaat*. Sla op; de lijst toont een oranje badge.
7. **Afwijkend IBAN:** A maakt een factuur van dezelfde leverancier en zet het IBAN op een ander geldig nummer, bijv. `NL44RABO0123456789`.
   - Verwacht: *IBAN afwijkend* (kritiek, rood). Sla op en klik **Controleren**.
   - B: **Goedkeuren** staat grijs met *"Er is nog een open kritiek signaal"*.
   - B opent de factuur → Signalen → **Oplossen**. Zonder toelichting lukt het niet. Vul een toelichting in, en vink eventueel "Nieuw IBAN opslaan als bekend IBAN" aan.
   - Daarna kan B goedkeuren.
8. **Boven de limiet:** A bewerkt een factuur naar totaal € 6.000 (pas de btw-regel aan) en klikt **Controleren**.
   - B: **Goedkeuren** staat grijs met *"Boven je goedkeuringslimiet van € 5.000"*.
   - Een factuur van € 4.900 krijgt het signaal *Net onder limiet*.
9. **Terugval:** open een goedgekeurde factuur en wijzig het bedrag. Er verschijnt een waarschuwing; na het opslaan is de status *Gescand*.
10. **Afkeuren:** B klikt **Afkeuren** en vult een reden in. De factuur staat nu in de tab *Afgekeurd*. A zet hem terug met **Terug naar gescand**.
11. **Betaald:** A (beheerder) zet een goedgekeurde factuur op **Betaald**. Het formulier wordt dan alleen-lezen ("Bekijken").
12. **Audit trail:**
    - Open een factuur → tab **Historie**: een tijdlijn met wie, wanneer, "Status: Gecontroleerd → Goedgekeurd", "van → naar" en de toelichtingen.
    - A → **Audit log**: filter op B en actie *Statuswijziging*, exporteer naar CSV en open het bestand in Excel.
    - Optioneel in de SQL Editor: `update audit_log set toelichting = 'x';` geeft *"De audit log kan niet worden gewijzigd of verwijderd."*

## 6. Bekende beperkingen en ideeën

**Beperkingen**
- Niet getest tegen een echte Supabase-stack of in de browser (zie §3).
- Signalen worden alleen bij opslaan berekend. Een gewijzigde goedkeuringslimiet of een later ingevoerde duplicaatfactuur werkt bestaande facturen niet bij (de nieuwe factuur krijgt het duplicaatsignaal wel).
- Duplicaatcontrole werkt per gekoppelde leverancier. "Bol.com" en "Bol.com B.V." gelden als verschillende leveranciers.
- Leden toevoegen kan alleen voor bestaande accounts; er is geen uitnodigingsmail.
- Er is geen scherm voor leveranciersbeheer. Het bekende IBAN verandert alleen via "Oplossen".
- Er is geen historie van vóór de migratie. Het auditscherm toont maximaal 1000 regels per filter.
- De reden bij afkeuren gaat via `window.prompt`, dat is functioneel maar sober.
- Als een collega een factuur verwijdert die nog een bestand onder het oude pad (`{user_id}/…`) van iemand anders heeft, kan dat bestand achterblijven.
- De JS-bundle is iets groter dan 500 kB (waarschuwing van Vite).

**Ideeën voor een volgende stap**
- **Dashboard:** openstaande bedragen per status, vervaldatums deze week, doorlooptijd van controle tot betaling, en signalen per leverancier.
- **SEPA-betaalbestand (pain.001)** vanuit de tab *Te betalen*, waarna de facturen automatisch op *Betaald* gaan.
- **E-mailinbox:** facturen doorsturen naar een eigen adres (inbound e-mail → Edge Function → scan).
- **Leveranciersbeheer met IBAN-verificatie** (Verification of Payee / SurePay) en een tweede paar ogen bij het wijzigen van een IBAN.
- **Vier-ogenprincipe boven een drempel:** twee goedkeurders nodig boven bijvoorbeeld € 10.000.
- **Notificaties:** e-mail of Slack bij "te keuren" of een kritiek signaal.
- **E-facturen (UBL/Peppol) importeren** zonder AI, en een koppeling met de boekhouding (Exact Online, Twinfield, Moneybird).
- Code-splitting van de frontend en paginering in het auditscherm.
