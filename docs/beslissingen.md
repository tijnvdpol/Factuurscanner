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

## Fase 2.2: signalen

### B8. Signalen bepalen in een Postgres-functie, niet in een Edge Function
- **Wat:** `intern.bepaal_signalen(factuur_id)` wordt aan het eind van `sla_factuur_op` aangeroepen, in dezelfde transactie.
- **Waarom:** opslaan loopt al via deze RPC, dus een factuur kan niet zonder signaalbepaling worden opgeslagen. Er is geen extra netwerkstap en geen extra deploy nodig. De functie leest de actuele data direct, dus er is geen race tussen twee gelijktijdige saves via een losse functie. Blokkades (kritiek signaal → niet goedkeuren) moeten toch al in de database zitten.
- **Alternatief:** een Edge Function na het opslaan. Die kan worden overgeslagen, wordt niet atomisch uitgevoerd en vraagt om een service-role-sleutel.

### B9. De regels staan dubbel: SQL is leidend, TypeScript geeft een voorproef
- **Wat:** `src/lib/signalen.ts` bevat dezelfde regels als pure functies. Het formulier toont daarmee "Bij opslaan verwacht: …" vóór het opslaan. De databasetests vergelijken de SQL- en TS-uitkomst van IBAN-, btw-, KvK- en factuurnummercontroles op dezelfde invoer.
- **Waarom:** de opdracht vraagt om pure, unit-testbare functies, en de gebruiker ziet een duplicaat of afwijkend IBAN al vóór het opslaan.

### B10. Het IBAN staat op de factuur én bij de leverancier
- **Wat:** nieuwe kolommen `facturen.iban`, `btw_nummer` en `kvk_nummer` (backfill vanuit de leverancier). `leveranciers.iban` is het "bekende" IBAN. `sla_factuur_op` vult dat alleen als het leeg is (eerste factuur) en overschrijft het nooit, ook niet bij bewerken. Wijzigen kan alleen via `los_signaal_op(..., p_iban_overnemen => true)`.
- **Waarom:** zonder IBAN per factuur is een afwijking niet vast te stellen. Automatisch overschrijven is precies de fraudeaanval (CEO-fraude/"nieuw rekeningnummer") die we willen tegenhouden.
- **Gevolg:** test 7b in `handtests/fase1_rls.sql` is aangepast, want bewerken overschrijft het IBAN niet meer.

### B11. Levenscyclus van signalen: sleutel per situatie
- **Wat:** extra kolommen `sleutel` en `details` (uniek op factuur + type + sleutel). Bij elke save worden de signalen opnieuw berekend:
  - nieuwe signalen worden toegevoegd
  - open signalen die niet meer gelden verdwijnen
  - opgeloste signalen blijven staan met hun toelichting
  - verandert de situatie (bijv. een ander afwijkend IBAN, sleutel = factuur-IBAN|bekend IBAN), dan ontstaat een nieuw signaal
- **Waarom:** een opgelost signaal mag niet bij elke save terugkomen, maar een nieuwe afwijking moet wel opnieuw gemeld worden.

### B12. Signalen zijn alleen via functies te schrijven
- **Wat:** `authenticated` heeft alleen SELECT op `factuur_signalen`. Aanmaken gebeurt via `intern.bepaal_signalen`, oplossen via `public.los_signaal_op` (security definer, toelichting verplicht, ook als CHECK-constraint).
- **Waarom:** anders kan iemand een kritiek signaal verwijderen en zo de goedkeuringsblokkade uit fase 3.2 omzeilen.
- **Schema `intern`:** hulpfuncties staan in een apart schema dat PostgREST niet publiceert. Ze zijn dus niet via de API aan te roepen.

### B13. Normalisatie van factuurnummers
- **Wat:** hoofdletters, spaties weg, voorloopnullen weg **per cijferreeks**, streepjes weg. `F-001`, `f 1` en `F1` worden allemaal `F1`, en `2024-0012` ≡ `2024-12`.
- **Waarom:** "voorloopnullen" alleen aan het begin van de hele string vangt `F-001` vs `F-1` niet.
- **Alternatief:** alleen voorloopnullen aan het begin. Dat was te beperkt.
- **Uniciteit:** de bestaande unieke index (exact zelfde nummer bij zelfde leverancier) blijft bestaan als harde blokkade. Het signaal vangt de varianten.

### B14. Duplicaat-op-bedrag gebruikt de factuurdatum, met de aanmaakdatum als terugval
- **Wat:** "binnen 30 dagen" wordt gemeten op `factuurdatum`. Ontbreekt die, dan telt `created_at`.

### B15. Validatiefouten als signaal
- **Wat:** type `validatiefout` (waarschuwing), één per veld: IBAN, btw-nummer, KvK-nummer, vervaldatum vóór factuurdatum, en de totaalcontrole (grondslag + btw ≠ totaal).
- **Waarom:** zo zijn validatiefouten ook zichtbaar voor een goedkeurder die het formulier niet opent. Ze blokkeren goedkeuring niet; alleen "kritiek" blokkeert.

### B16. Backfill van signalen
- **Wat:** de migratie berekent signalen voor alle bestaande facturen (oudste eerst). Zonder ingelogde gebruiker (migratie/service role) slaat `bepaal_signalen` de toegangscontrole over.

## Fase 2.3: coderingsvoorstel

### B17. Standaardset van 16 rekeningen, gezaaid via een trigger op `auth.users`
- **Wat:** `intern.seed_grootboekrekeningen(user_id)` maakt 16 gangbare kostenrekeningen aan (4000 Huisvestingskosten … 7100 Uitbesteed werk). Een trigger op `auth.users` roept die aan bij registratie, en de migratie doet een backfill voor bestaande gebruikers. In fase 3.1 verhuist dit naar organisaties.
- **Waarom:** een trigger werkt ook voor accounts die via het dashboard worden aangemaakt. Bij "eerste login" kan dat worden overgeslagen.

### B18. Rekeningen niet verwijderen, alleen deactiveren
- **Wat:** er is geen DELETE-recht. Inactieve rekeningen worden niet voorgesteld en niet in de keuzelijst getoond, behalve als de factuur er al aan gekoppeld is.
- **Waarom:** oude facturen, de CSV-export en de audit trail houden zo een geldige codering.

### B19. Historievoorstel via RPC vanuit de frontend, AI-voorstel in dezelfde Gemini-aanroep
- **Wat:** `scan-factuur` haalt de actieve rekeningen op met de JWT van de gebruiker (RLS), zet ze in de prompt en laat Gemini een `grootboek_code` + `grootboek_zekerheid` kiezen in dezelfde aanroep als de extractie. Onbekende codes worden genegeerd. Na de scan vraagt de frontend `stel_codering_voor(leverancier)` op. Historie gaat vóór AI (`kiesCoderingsvoorstel`, pure functie).
- **Waarom:** de leverancier is pas na de scan bekend. Een aparte AI-aanroep kost extra tijd en quota. De keuze tussen historie en AI in een pure functie is eenvoudig te testen.
- **Alternatief:** de historie in de Edge Function opzoeken. Dat kan, maar dan staat dezelfde logica op twee plekken (ook bij het openen van een ongecodeerde factuur is een historievoorstel nodig).
- **Veiligheid:** omschrijvingen van rekeningen (gebruikersinvoer) gaan zonder regeleinden en backticks, en maximaal 100 tekens, de prompt in.

### B20. Historie telt alleen handmatig bevestigde coderingen
- **Wat:** `stel_codering_voor` kijkt alleen naar facturen met `codering_bron = 'handmatig'` en een actieve rekening. De zekerheid is het aandeel van de meest gebruikte rekening (bij gelijke stand wint de recentste). Een onbevestigd AI-voorstel dat zo wordt opgeslagen, blijft `ai` en telt niet mee.
- **Waarom:** anders versterkt een fout AI-voorstel zichzelf.

### B21. Bevestigen maakt de codering "handmatig"
- **Wat:** het formulier toont "Voorgesteld (historie/AI, xx%)" met een knop **Bevestigen**. Bevestigen of een andere rekening kiezen zet de bron op `handmatig` (zekerheid leeg).

### B22. CSV: twee nieuwe kolommen achteraan
- **Wat:** "Grootboekrekening" (code) en "Omschrijving grootboekrekening", achteraan, zodat bestaande imports die op kolomvolgorde werken blijven werken. Dezelfde aanpak als in stap 1.

## Fase 3.1: organisaties en rollen

### B23. `is_lid` en `heeft_rol` in `public`, security definer
- **Wat:** `public.is_lid(org)` en `public.heeft_rol(org, rollen[])` lezen `organisatie_leden` als eigenaar. Daardoor is er geen recursie via de RLS van die tabel. Ze staan in `public` (namen uit de opdracht) en geven alleen informatie over de eigen lidmaatschappen.
- **Alternatief:** in `intern`. Dat kan ook, maar de frontend zou ze dan niet kunnen gebruiken.

### B24. Leden alleen via RPC's
- **Wat:** `authenticated` heeft alleen SELECT op `organisatie_leden`. Toevoegen, wijzigen en verwijderen gaan via `voeg_lid_toe`, `wijzig_lid` en `verwijder_lid` (security definer, alleen beheerder).
- **Laatste beheerder:** die kan niet worden verwijderd of gedegradeerd. De controle zit in de RPC's, en de rij van de organisatie wordt eerst gelockt (`for update`). Zo kunnen twee beheerders elkaar niet tegelijk degraderen.
- **Alternatief:** een trigger. Die blokkeert dan ook het cascade-verwijderen van een account.
- **E-mailadres zoeken:** `voeg_lid_toe` zoekt in `auth.users`, zonder onderscheid in hoofdletters. Bestaat het account niet, dan volgt een duidelijke melding ("laat de persoon eerst registreren"). Uitnodigen per e-mail valt buiten deze stap.

### B25. Nieuwe gebruiker → organisatie via een trigger op `auth.users`, met een vangnet bij de eerste login
- **Wat:** trigger `organisatie_voor_nieuwe_gebruiker` maakt "Organisatie van {e-mail}" met de gebruiker als beheerder. Een trigger op `organisaties` zaait de 16 standaardrekeningen. De frontend roept `zorg_voor_organisatie()` aan als iemand toch geen organisatie heeft.
- De grootboek-trigger per gebruiker uit fase 2.3 is vervangen.

### B26. Uniciteit en koppelingen per organisatie
- Leverancier uniek op (organisatie, naam) en rekening uniek op (organisatie, code). Samengestelde foreign keys (`leverancier_id`, `organisatie_id`) en (`grootboekrekening_id`, `organisatie_id`), zodat een factuur niet aan een leverancier of rekening van een andere organisatie kan hangen. De duplicaatindex is nu per organisatie.

### B27. Data blijft bij de organisatie als een account verdwijnt
- **Wat:** `user_id` op facturen, leveranciers en rekeningen: `on delete cascade` wordt `on delete set null` (kolom nullable).
- **Waarom:** in een organisatie zou het verwijderen van een invoerder anders al "zijn" facturen van de organisatie wissen.

### B28. Kolomrechten in plaats van alleen RLS
- **Wat:**
  - `facturen`: UPDATE alleen op inhoudelijke kolommen, dus niet op `user_id` (ingevoerd door), `organisatie_id` of `created_at`
  - `leveranciers`: UPDATE alleen op naam, btw- en KvK-nummer, en geen DELETE
  - `grootboekrekeningen`: UPDATE op code, omschrijving en actief
- **Waarom:** anders kan een invoerder via de API zichzelf onzichtbaar maken voor de functiescheiding (`user_id` wijzigen). Hij zou ook het bekende IBAN kunnen overschrijven, of een leverancier verwijderen en opnieuw aanmaken met een ander IBAN zonder signaal.
- **Gevolg:** `sla_factuur_op` vult een leeg IBAN via `intern.vul_leveranciers_iban` (security definer).

### B29. Wie mag wat (buiten de statusworkflow)
- Grootboekrekeningen beheren: **controller en beheerder**.
- Een **kritiek** signaal oplossen, of een IBAN overnemen: **goedkeurder, controller of beheerder**, of het enige lid van een organisatie. Anders zou de invoerder zijn eigen kritieke signaal kunnen wegklikken.
- De naam van de organisatie wijzigen: beheerder (kolomrecht op `naam`).

### B30. Storage: nieuwe paden `{organisatie_id}/…`, oude paden blijven leesbaar
- **Lezen:** in een organisatiemap waarvan je lid bent, in je eigen oude `{user_id}`-map, of in een bestand waarnaar een factuur van jouw organisatie verwijst. Zo kunnen collega's ook oude bestanden openen.
- **Uploaden:** in een organisatiemap, of (tijdelijk, voor een oudere frontend tijdens de uitrol) in de eigen `{user_id}`-map.
- `sla_factuur_op` accepteert beide padvormen. `scan-factuur` controleert het pad niet meer op `user_id`; de Storage-policies bepalen de toegang, want het bestand wordt met de JWT van de gebruiker gedownload.

### B31. Achterwaartse compatibiliteit van `sla_factuur_op`
- Zonder `organisatie_id` gebruikt de functie de enige organisatie van de gebruiker. Heeft de gebruiker er meer, dan volgt de fout "Kies een organisatie.". Zo blijft de frontend van stap 1 werken tot de nieuwe is gedeployed.

### B32. Actieve organisatie in localStorage
- Alleen als gemak per browser (in try/catch). De database bepaalt de toegang. Bij meerdere organisaties staat er een keuzelijst in de header. De hele app wordt opnieuw opgebouwd (`key`) bij een wissel.

### B33. `org_gebruikers(org)` voor namen
- Geeft e-mailadressen van leden en van oud-leden die nog in de data voorkomen, alleen aan leden. Gebruikt voor "opgelost door", ledenbeheer en (fase 3.3) de historie.

## Fase 3.2: statusworkflow en functiescheiding

### B34. Status blokkeren via kolomrechten + trigger, wijzigen alleen via `wijzig_status`
- **Wat:**
  - `authenticated` heeft geen UPDATE-recht meer op `status` en de workflowkolommen.
  - Trigger `facturen_bewaking`: bij INSERT door een gebruiker wordt de status altijd `gescand`; bij UPDATE volgt een fout als status/workflowkolommen toch wijzigen.
  - `public.wijzig_status` (security definer) controleert de overgang, de rol, de functiescheiding, de limiet, open kritieke signalen en of er een grootboekrekening is.
- **"Bevoegd"** = `current_user` is niet `authenticated`/`anon`: security-definerfuncties, service role en SQL Editor.
- **Waarom beide:** kolomrechten zijn de harde grens. De trigger vangt ook INSERT af (bij INSERT zijn kolomrechten op status lastig zonder de RPC te breken) en regelt de automatische terugval.

### B35. Wie mag welke overgang
| Overgang | Rollen |
|---|---|
| gescand → gecontroleerd | invoerder, controller, beheerder |
| gecontroleerd → goedgekeurd | goedkeurder, controller, beheerder (+ voorwaarden) |
| goedgekeurd → betaald | controller, beheerder |
| gescand/gecontroleerd → afgekeurd | goedkeurder, controller, beheerder (reden verplicht) |
| afgekeurd → gescand | invoerder, controller, beheerder |

- **Waarom:** de opdracht noemt de rollen voor controleren, goedkeuren en betalen. Afkeuren is een beoordeling, dus die ligt bij wie mag goedkeuren. Terugzetten na correctie ligt bij wie mag invoeren en controleren.

### B36. Eén lid: alles mag, maar limiet en inhoudelijke blokkades blijven
- **Wat:** in een organisatie met één lid vervallen de rolcontrole en de functiescheiding. `wijzig_status` geeft de melding "Functiescheiding niet mogelijk: organisatie heeft één lid" terug, die in de audit-toelichting komt. De UI toont een blauwe balk.
- **Blijft wel gelden:** de eigen goedkeuringslimiet (die de beheerder zelf kan leegmaken), open kritieke signalen en de verplichte grootboekrekening.
- **Waarom:** die laatste zijn geen functiescheiding maar inhoudelijke controles.

### B37. Terugval naar "gescand"
- **Wat:** wijzigt bij status gecontroleerd/goedgekeurd een van leverancier, valuta, bedrag excl., totaal incl. of IBAN, of een btw-regel, dan gaat de status naar `gescand` en worden de gecontroleerd/goedgekeurd-velden gewist.
  - Voor btw-regels gebeurt dat via een trigger op `btw_regels`, dus ook bij rechtstreekse inserts. Cascade-deletes worden overgeslagen via `pg_trigger_depth() > 1`.
- **Valuta:** hoort er ook bij, want die verandert de betekenis van het bedrag.
- **Andere velden** (factuurnummer, datums, codering) laten de status staan.
- De UI waarschuwt vóór het opslaan ("na opslaan gaat de status terug…").

### B38. Betaald = afgesloten
- **Wat:** inhoudelijke wijzigingen en wijzigingen aan btw-regels van een betaalde factuur worden geweigerd. In de UI wordt het formulier alleen-lezen ("Bekijken").
- **Waarom:** anders klopt de administratie niet meer met de betaling. De opdracht noemt het niet expliciet.

### B39. Verwijderen
- De beheerder mag altijd verwijderen. Anderen alleen hun eigen factuur zolang die `gescand` of `afgekeurd` is. De audit trail (3.3) legt het verwijderen vast.

### B40. Goedkeuren boven de limiet bij een ontbrekend totaal
- Heeft de goedkeurder een limiet en ontbreekt het totaal, dan is goedkeuren geblokkeerd ("Totaalbedrag ontbreekt").

### B41. `net_onder_limiet`
- Waarschuwing als `totaal_incl` tussen 95% en 100% van een limiet ligt. Het gaat om limieten van leden met een goedkeurrol, en de laagste geraakte limiet telt. Het signaal wordt bij opslaan bepaald en niet opnieuw berekend als een limiet later verandert (bekende beperking).

### B42. UI
- Tabs "Te controleren" (gescand), "Te keuren" (gecontroleerd), "Te betalen" (goedgekeurd), "Afgekeurd" en "Alles", met aantallen.
- Per factuur alleen de knoppen die bij de rol en status passen (`mogelijkeActies`, pure functie). Een geblokkeerde goedkeuring staat grijs met de reden eronder, bijv. "Boven je goedkeuringslimiet van € 5.000".
- Afkeuren vraagt de reden via `window.prompt`. Dat past bij het bestaande `window.confirm`-patroon.
- De kolommen "Excl. BTW" en "Valuta" zijn uit de tabel gehaald om ruimte te maken voor de acties. Een afwijkende valuta staat bij het totaal, en beide velden blijven in de CSV.

## Fase 3.3: audit trail

### B43. Eén generieke logtrigger (security definer)
- **Wat:** `intern.log_wijziging()` hangt aan `facturen`, `btw_regels`, `leveranciers`, `factuur_signalen` en `organisatie_leden`.
  - Bij INSERT/DELETE wordt de hele rij opgeslagen, bij UPDATE alleen de gewijzigde velden (`updated_at` telt niet mee). Een update zonder echte wijziging levert geen regel op.
  - `record_id` = `id` van de rij. Voor `organisatie_leden` (zonder eigen id) is dat de `user_id` van het lid.
- **Waarom één functie:** hetzelfde gedrag voor elke tabel, en minder code.

### B44. Statuswijziging en toelichting via transactie-instellingen
- **Wat:** `wijzig_status` zet `factuurscanner.audit_actie = 'statuswijziging'` en `factuurscanner.audit_toelichting` (reden van afkeuren en/of de melding "Functiescheiding niet mogelijk: organisatie heeft één lid"). De automatische terugval naar gescand zet een eigen toelichting. De logtrigger gebruikt de toelichting één keer (alleen voor `facturen`) en wist hem daarna, zodat hij niet "doorlekt" naar latere regels in dezelfde transactie.
- **Alternatief:** `wijzig_status` zelf laten loggen. Dat geeft dubbele regels naast de trigger.

### B45. Alleen toevoegen, ook voor beheerders van de database
- **Wat:** `authenticated` heeft alleen SELECT (RLS: leden van de organisatie). INSERT gebeurt uitsluitend via de triggerfunctie (security definer). Triggers weigeren UPDATE, DELETE en TRUNCATE, ook voor de service role en de SQL Editor.
- **Geen foreign keys** op `audit_log`: de historie blijft staan als een factuur, account of organisatie verdwijnt.
- **Id** = `bigint identity`: een betrouwbare volgorde binnen één transactie (`created_at` is daar gelijk).

### B46. Geen ruis bij cascade-verwijderen
- **Wat:** wordt een factuur verwijderd, dan worden de meeverwijderde btw-regels en signalen niet apart gelogd; het verwijderen van de factuur staat met de volledige oude rij in de log. De controle is "bestaat de factuur nog?". `pg_trigger_depth()` bleek niet betrouwbaar voor cascade-deletes, want AFTER-triggers van de cascade vuren op diepte 1.

### B47. Historie per factuur via `factuur_historie(factuur_id)`
- **Wat:** een RPC (security invoker, dus RLS geldt) die de regels van de factuur, de btw-regels en de signalen verzamelt. Signaalupdates bevatten alleen gewijzigde velden (geen `factuur_id`), dus die worden via `record_id` gekoppeld.

### B48. UI
- **Tab "Historie"** in het bewerkscherm: een tijdlijn (nieuwste boven) met wie, wanneer, een omschrijving ("Status: Gescand → Gecontroleerd") en per veld "van → naar" met Nederlandse veldnamen, bedragen in €, namen in plaats van user-id's en grootboekcode in plaats van id.
- **Scherm "Audit log"** (controller en beheerder): filters op periode (standaard de laatste 30 dagen), gebruiker (ook oud-leden), actie en onderdeel, plus export naar CSV (puntkomma, UTF-8 met BOM, zoals de factuurexport). Maximaal 1000 regels per keer, met een melding als dat maximum bereikt is.
- De RLS staat SELECT toe voor alle leden (zoals gevraagd). Het aparte scherm is alleen zichtbaar voor controller en beheerder. Andere leden zien alleen de historie per factuur.

### B49. Geen historie van vóór de audit trail
- Bestaande facturen hebben pas historie vanaf het moment dat de migratie draait. De tijdlijn meldt dat als er nog niets is.

### B50. Handtest voor productie
- `supabase/handtests/fase2_3_workflow.sql` (15 tests: signalen, RLS tussen organisaties, functiescheiding, limiet, kritiek signaal, terugval, audit log onveranderlijk) draait ook automatisch op PGlite.
