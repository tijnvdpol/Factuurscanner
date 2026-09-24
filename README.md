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
| `supabase/functions/koppeling-actie/` | Acties op koppelingen vanuit de app (overzicht, wachtrij testen, testmail, …) |
| `supabase/functions/inbound-mail/` | Webhook voor inkomende mail (Mailgun) |
| `supabase/functions/mail-actie/` | Knoppen Goedkeuren/Afkeuren uit een goedkeuringsmail (ondertekend, eenmalig token) |
| `supabase/functions/_shared/geminiScan.ts` | Gemini-scan met modelkeuze en fallback (gedeeld door scan-factuur en de mailbox) |
| `supabase/functions/_shared/koppelingen/` | Gedeelde, testbare logica van de koppelingen (modus, taken, adapters) |
| `supabase/handtests/` | Testscripts voor de SQL Editor (`fase1_rls.sql`, `fase2_3_workflow.sql`, `fase4_1_koppelingen.sql` t/m `fase4_5_boekhouding.sql`) |
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
| Mailbox-import | `MAILBOX` | Mailgun-account (gratis plan) + eigen (sub)domein + `MAILGUN_SIGNING_KEY` | fase 4.3 ✅ |
| E-mailnotificaties | `EMAIL` | Resend-account (gratis plan) + eigen domein + `RESEND_API_KEY`, `MAIL_AFZENDER`, `APP_URL` | fase 4.4 ✅ |
| Boekhoudpakket | `BOEKHOUDING` | Moneybird (testadministratie) + `MONEYBIRD_TOKEN`, `MONEYBIRD_ADMINISTRATIE_ID` | fase 4.5 ✅ |
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

### Mailbox-import (fase 4.3)

Facturen die naar het ontvangstadres worden gemaild, komen automatisch binnen (pagina **Inbox**):

- **Bekende afzender** (staat bij *Vertrouwde afzenders* én SPF of DKIM geslaagd volgens Mailgun): elke pdf of foto wordt
  gescand (Gemini, dezelfde scan als bij uploaden) en wordt een factuur met status *Gescand*, gemarkeerd met "mail".
  "Ingevoerd door" blijft leeg; een mens controleert, een ander keurt goed (functiescheiding en limiet gelden gewoon).
- **Onbekende afzender** (of SPF/DKIM mislukt, of spam): de mail wacht in de inbox op een controller of beheerder:
  *Verwerken* (eventueel het adres vertrouwen) of *Weigeren* (met reden).
- Andere bijlagen (Word, kleine logo's, afbeeldingen in de mailtekst, > 15 MB) worden genegeerd. Een factuur die al bestaat
  (zelfde leverancier en nummer) wordt niet dubbel aangemaakt. Mislukt het scannen, dan volgen automatisch nieuwe pogingen;
  daarna staat de bijlage op *Mislukt* met een knop *Opnieuw proberen*.
- Alles staat in de audit log: ontvangst (bron mailbox), beoordeling (gebruiker), aangemaakte factuur (bron mailbox).

**Mock-modus** (standaard): echte mail wordt geweigerd; op de pagina Inbox staan knoppen *Testmail van bekende afzender*
en *Testmail van onbekende afzender*. Die maken een mail met een echte PDF-factuur (elke keer een ander nummer) en sturen
die door dezelfde verwerking. Zonder `GEMINI_API_KEY` (of met `SCAN_MODUS=mock`) gebruikt de scan de gegevens uit het PDF.
Stel eerst een ontvangstadres in (in mock-modus mag dat elk adres zijn).

**Live instellen (Mailgun, gratis plan: 1 domein, 1 inbound route, 100 mails/dag):**

1. Account maken op mailgun.com, regio **EU**.
2. **Domein toevoegen** voor ontvangst, bij voorkeur een subdomein, bijv. `inbox.jouwbedrijf.nl`. Zet bij je DNS-provider
   de **MX-records** die Mailgun toont (`mxa.eu.mailgun.org` en `mxb.eu.mailgun.org`, prioriteit 10) en wacht tot Mailgun
   het domein als geverifieerd toont. Een subdomein laat je gewone mail ongemoeid.
3. **Route maken** (Send → Receiving → Create route):
   - Expression type *Match recipient*: `facturen@inbox.jouwbedrijf.nl`
   - Actie *Forward*: `https://<project-ref>.supabase.co/functions/v1/inbound-mail`
   - *Stop* aanvinken.
4. **Signing key** kopiëren (Mailgun → Sending → Webhooks → *HTTP webhook signing key*) en als Supabase secret zetten:
   `MAILGUN_SIGNING_KEY`.
5. **Deployen:**
   ```powershell
   npx.cmd supabase functions deploy inbound-mail --use-api --project-ref <project-ref>
   npx.cmd supabase functions deploy verwerk-taken --use-api --project-ref <project-ref>
   npx.cmd supabase functions deploy koppeling-actie --use-api --project-ref <project-ref>
   npx.cmd supabase functions deploy scan-factuur --use-api --project-ref <project-ref>
   ```
   (`scan-factuur` is intern omgebouwd naar de gedeelde scanmodule; het gedrag is gelijk.)
6. In de app (beheerder): **Inbox → Ontvangstadres** = `facturen@inbox.jouwbedrijf.nl`; voeg de adressen of domeinen van je
   leveranciers toe bij *Vertrouwde afzenders*; zet **Koppelingen → Mailbox-import** op *Live* (of secret
   `KOPPELING_MAILBOX_MODUS=live`).
7. **Controleren:** draai `supabase/handtests/fase4_3_mailbox.sql` (verwacht: `GESLAAGD: alle 9 tests ok`) en mail een
   pdf-factuur naar het adres. Binnen een minuut staat de mail in de inbox (Supabase → Edge Functions → inbound-mail → Logs
   bij problemen; Mailgun → Logs toont of de route is aangeroepen).

Webhook-beveiliging: elke aanroep moet een geldige Mailgun-handtekening hebben (HMAC-SHA256 met de signing key, maximaal
12 uur oud: Mailgun probeert tot 8 uur opnieuw). Dezelfde mail (Message-Id) wordt nooit twee keer verwerkt.

### E-mailnotificaties (fase 4.4)

Wie wanneer een mail krijgt:

| Mail | Wanneer | Aan |
|---|---|---|
| **Goedkeuringsverzoek** met knoppen *Goedkeuren* en *Afkeuren* | een factuur wordt gecontroleerd | elk lid dat hem mag goedkeuren: rol goedkeurder, controller of beheerder, bedrag in euro binnen de limiet, niet de invoerder of controleur. Bij vreemde valuta krijgen leden met een limiet de mail zodra de koers bekend is. |
| **Afgekeurd** | een factuur wordt afgekeurd | invoerder en controleur (niet wie afkeurde); zijn die er niet, dan de controllers en beheerders |
| **Export mislukt** | een export naar het boekhoudpakket is na alle pogingen opgegeven (fase 4.5) | controllers en beheerders |
| **Bijna vervallen** | dagelijks om 08:00: openstaande facturen die binnen 3 dagen vervallen (instelbaar) | controllers en beheerders; één mail per persoon, elke factuur één keer |

**Goedkeuren vanuit de mail:** de knop opent de app (`APP_URL/#mail-actie=…`) met de factuurgegevens en een knop
*Bevestig goedkeuren* (bij afkeuren met een verplichte reden). Inloggen is niet nodig. De link:

- bevat een door de server **ondertekend token** (HMAC-SHA256) met een **verlooptijd** (standaard 72 uur, instelbaar);
- werkt **één keer**, voor goedkeuren óf afkeuren, en vervalt als de factuur intussen is gewijzigd en opnieuw gecontroleerd;
- doorloopt op de server **dezelfde controles als de app**: rol, goedkeuringslimiet in euro, open kritieke signalen en
  grootboekrekening. Daarnaast geldt een **strikte functiescheiding**: nooit goedkeuren wat je zelf hebt ingevoerd of
  gecontroleerd, ook niet in een organisatie met één lid (daar gaan dus geen goedkeuringsmails uit).

In de audit log staat de statuswijziging met de goedkeurder als gebruiker en bron *E-mail*. Een geweigerde poging (bijv.
"boven je limiet") staat er ook, en verbruikt de link niet. Elke verstuurde mail staat in de historie van de factuur. Een
mail die niet meer nodig is (factuur al goedgekeurd), wordt niet verstuurd (status *Niet nodig*).

**Mock-modus** (standaard): er gaat niets de deur uit. Elke gebruiker leest zijn eigen mails onder **Meldingen → Mijn mails**,
met werkende knoppen (ze openen de bevestigingspagina in een nieuw tabblad). Controllers en beheerders zien onder *Alle mails*
wie wat heeft gekregen, maar niet de inhoud: anders zou een invoerder met de knoppen van een goedkeurder kunnen goedkeuren.
Fouten testen: een ontvanger met `+tijdelijk` in het adres geeft een tijdelijke fout (nieuwe pogingen), met `+ongeldig` een
definitieve fout ("Mail niet verzonden" bij de factuur).

**Live instellen (Resend, gratis plan: 3.000 mails per maand, 100 per dag, 1 domein):**

1. Account maken op resend.com.
2. **Domein toevoegen** (Domains → Add domain), bij voorkeur een subdomein, bijv. `mail.jouwbedrijf.nl`, regio *eu-west-1*.
   Zet de DNS-records die Resend toont (SPF/MX en DKIM) en wacht tot het domein *Verified* is. Zonder geverifieerd domein
   kun je alleen mailen naar het adres van je eigen Resend-account.
3. **API-sleutel** maken (API Keys → Create, permission *Sending access*, alleen dit domein).
4. **Supabase secrets** (Edge Functions → Secrets):
   - `RESEND_API_KEY` = de sleutel uit stap 3
   - `MAIL_AFZENDER` = bijv. `Factuurscanner <facturen@mail.jouwbedrijf.nl>` (het domein uit stap 2)
   - `APP_URL` = de URL van de app op Vercel, bijv. `https://factuurscanner.vercel.app` (voor de links in de mail)
   - optioneel `MAIL_TOKEN_GEHEIM` = een eigen geheim voor de links (maak het zoals `WORKER_GEHEIM`). Zonder dit secret
     wordt een sleutel afgeleid van de service-rolsleutel; open links vervallen dan als die sleutel ooit wordt vervangen.
5. **Migratie** `20260924130000_notificaties.sql` uitvoeren. Die plant ook de dagelijkse cronjob
   `factuurscanner-vervalherinneringen`.
6. **Deployen** (commando's één voor één):
   ```powershell
   npx.cmd supabase functions deploy mail-actie --use-api --project-ref <project-ref>
   npx.cmd supabase functions deploy verwerk-taken --use-api --project-ref <project-ref>
   npx.cmd supabase functions deploy koppeling-actie --use-api --project-ref <project-ref>
   ```
   De frontend (nieuwe pagina *Meldingen* en de bevestigingspagina) komt mee met een nieuwe deploy op Vercel; er zijn geen
   nieuwe Vercel-variabelen nodig.
7. Zet **Koppelingen → E-mailnotificaties** op *Live* (of secret `KOPPELING_EMAIL_MODUS=live`) en klik op
   **Stuur een testmail naar mezelf**. Op dezelfde pagina stel je in hoeveel dagen vóór de vervaldatum de herinnering komt
   en hoe lang de knoppen geldig zijn.
8. **Controleren:** draai `supabase/handtests/fase4_4_notificaties.sql` (verwacht: `GESLAAGD: alle 9 tests ok`). Blijft een
   mail op *In wachtrij* staan of mislukt hij, kijk dan bij Koppelingen → Wachtrij (de foutmelding van Resend staat erbij)
   en in Resend → Logs.

### Boekhoudpakket (fase 4.5)

Goedgekeurde facturen worden als **inkoopfactuur** geboekt in het boekhoudpakket, met het PDF als bijlage:

- **Wanneer:** automatisch direct na goedkeuren (uit te zetten), of met **Koppelingen → Boekhoudpakket → Nu exporteren**
  voor alle goedgekeurde of betaalde facturen die nog niet zijn geëxporteerd. Andere facturen worden nooit geëxporteerd.
- **Mapping:** per pakket koppel je je grootboekrekeningen en de btw-tarieven (21%, 9%, 0%) aan die van het pakket.
  *Automatisch koppelen* doet dat op code, naam en percentage; controleer het resultaat. Leveranciers worden bij de eerste
  export in het pakket gezocht (KvK-nummer, btw-nummer, naam) of aangemaakt, en daarna onthouden. Een leverancier kun je
  ontkoppelen, dan wordt hij bij de volgende export opnieuw gezocht.
- **Geen dubbele boekingen:** per factuur wordt één export met het externe id opgeslagen. Staat de factuur (zelfde
  leverancier en factuurnummer) al in het pakket, bijvoorbeeld omdat een eerdere poging halverwege is afgebroken, dan wordt
  die gekoppeld in plaats van opnieuw aangemaakt.
- **Na export** is de factuur vergrendeld ("geboekt" in de lijst): inhoud, btw-regels en verwijderen zijn geblokkeerd,
  correcties doe je in het pakket. Als betaald markeren kan wel.
- **Fouten:** een ontbrekende mapping of een weigering door het pakket geeft direct "Export mislukt" bij de factuur (plus een
  mail aan controllers en beheerders, fase 4.4). Los het op en klik op de badge om het opnieuw te proberen. Tijdelijke
  fouten (Moneybird druk of onbereikbaar) worden automatisch opnieuw geprobeerd.

**Pakketten:** Moneybird werkt live. Exact Online en SnelStart zijn alleen als mock beschikbaar (eigen rekeningschema en
btw-codes); de adapter-interface (`AccountingProvider` in `_shared/koppelingen/boekhouding.ts`) maakt een echte koppeling
later een kwestie van één klasse toevoegen.

**Mock-modus** (standaard): werkt voor alle drie de pakketten zonder account. Fouten testen via het factuurnummer: met
`TIJDELIJK` erin volgt een tijdelijke fout (nieuwe pogingen), met `WEIGER` erin weigert het pakket de factuur.

**Live instellen (Moneybird):**

1. Account maken op moneybird.nl en een **testadministratie** aanmaken (gratis, bedoeld voor ontwikkelaars; kies bij het
   aanmaken van een administratie voor een testadministratie). Gebruik die tot alles werkt, en pas daarna je echte
   administratie.
2. **API-token:** in Moneybird → Instellingen → Ontwikkelaars → *Nieuwe API-token* (persoonlijk token) met de scopes
   **documents**, **settings** en **sales_invoices** (voor contacten).
3. **Administratie-id:** het getal in de adresbalk als je de administratie opent: `moneybird.com/<administratie-id>/…`.
4. **Supabase secrets:** `MONEYBIRD_TOKEN` en `MONEYBIRD_ADMINISTRATIE_ID`.
5. **Migratie** `20260924140000_boekhouding.sql` uitvoeren.
6. **Deployen** (commando's één voor één):
   ```powershell
   npx.cmd supabase functions deploy verwerk-taken --use-api --project-ref <project-ref>
   npx.cmd supabase functions deploy koppeling-actie --use-api --project-ref <project-ref>
   ```
7. In de app: **Koppelingen → Boekhoudpakket**: pakket *Moneybird*, dan zet je de koppeling op *Live* (of secret
   `KOPPELING_BOEKHOUDING_MODUS=live`), klik *Rekeningen ophalen uit Moneybird* (dit test ook de verbinding), dan
   *Automatisch koppelen*, en controleer de koppelingen.
8. **Controleren:** draai `supabase/handtests/fase4_5_boekhouding.sql` (verwacht: `GESLAAGD: alle 9 tests ok`) en keur een
   factuur goed. Binnen een minuut staat hij in Moneybird onder *Inkoopfacturen* (met het PDF) en staat "geboekt" in de
   lijst. Moneybird staat 150 verzoeken per 5 minuten toe; bij een grote achterstand gaat de rest vanzelf later.

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
- Na export naar het boekhoudpakket is een factuur vergrendeld en niet te verwijderen (trigger + kolomrechten); het
  exportmoment zet alleen de server.
- Mail-links: ondertekend token met verlooptijd, eenmalig; de server controleert rol, limiet en functiescheiding opnieuw.
  Bevestigen gebeurt altijd op een pagina, dus een link-scanner van een mailprogramma voert niets uit. De inhoud van
  mock-mails is alleen leesbaar voor de ontvanger; van echte mails wordt de inhoud niet bewaard.
