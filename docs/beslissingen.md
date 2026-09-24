# Beslissingen

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

## Fase 4.1: basis voor de koppelingen

Afspraken met de opdrachtgever vóór de bouw: Mailgun (gratis plan: 1 inbound route) voor inkomende mail; voorlopig één
organisatie met één set sleutels in de Supabase secrets; goedkeuringslimiet in euro bij vreemde valuta; facturen in een
betaalbatch of na export inhoudelijk vergrendeld; de knop goedgekeurd → betaald blijft voor handmatige betalingen.

### B51. Service role telt niet meer als "bevoegd"
- **Wat:** `bewaak_factuur` en `bewaak_btw_regel` behandelen `service_role` nu als gewone gebruiker: status en
  workflowkolommen zijn niet rechtstreeks te wijzigen. Alleen security-definerfuncties (eigenaar `postgres`) en de SQL Editor mogen dat.
- **Waarom:** de koppelingen draaien in Edge Functions met de service-rolsleutel. Zonder deze wijziging kan een fout in zo'n
  functie (of een gelekte sleutel) `wijzig_status` en dus functiescheiding, limiet en blokkades omzeilen.
- **Alternatief:** alleen afspreken dat functies geen directe updates doen. Dat is niet afdwingbaar.

### B52. `wijzig_status` als wrapper om `intern.wijzig_status_als(gebruiker, …)`
- **Wat:** de controles staan in één functie die de gebruiker als parameter krijgt. `public.wijzig_status` geeft
  `auth.uid()` en bron `app` mee; goedkeuren via een mail-link (fase 4.4) straks de gebruiker uit het token en bron `email`.
- **Waarom:** één plek voor de regels; de mailroute kan niet "net iets anders" controleren. De bestaande tests bewaken dat
  het gedrag gelijk is gebleven.
- **Detail:** lidmaatschap wordt nu opgezocht voor de opgegeven gebruiker (i.p.v. `is_lid()`, dat `auth.uid()` gebruikt). De
  melding voor een buitenstaander blijft "Factuur niet gevonden.".

### B53. Audit log: kolom `bron` en gebeurtenissen
- **Wat:**
  - `bron`: app, systeem, mailbox, vies, ecb, kvk, boekhouding, betaling of email. Bestaande regels krijgen `app`.
  - Gebruiker en bron komen uit transactie-instellingen (`factuurscanner.audit_user`/`audit_bron`, via
    `intern.zet_audit_context`), met `auth.uid()` als terugval. Geen gebruiker en geen bron = `systeem`.
  - Nieuwe acties `import`, `verrijking`, `export`, `betaling`, `notificatie` voor gebeurtenissen zonder rijwijziging
    (`intern.log_gebeurtenis`). Hoort een gebeurtenis bij een factuur, dan is de regel `tabel = 'facturen'` met het
    factuur-id, zodat hij in de historie van de factuur staat.
- **Waarom:** de opdracht vraagt per actie de bron en "gebruiker of systeem". Een kolom toevoegen is geen UPDATE; de
  onveranderlijkheid (B45) blijft intact.
- **Alternatief:** een aparte logtabel voor koppelingen. Dan is er geen volledige historie meer op één plek.

### B54. Takenwachtrij in Postgres, worker als Edge Function, cron via pg_cron + pg_net
- **Wat:** `koppeling_taken` met status wachtrij → bezig → gelukt/opgegeven. `claim_taken` gebruikt `for update skip
  locked` (meerdere workers tegelijk is veilig). Retries na 1 min, 5 min, 30 min, 2 uur, 12 uur; standaard maximaal 6
  pogingen. Een taak die > 10 minuten "bezig" blijft (crash, time-out), komt terug in de wachtrij.
- **Idempotent:** `sleutel` is uniek zolang een taak actief is (partiële unieke index). Dezelfde VIES-controle twee keer
  aanvragen levert één taak op.
- **Definitief vs. tijdelijk:** een handler gooit `DefinitieveFout` als een nieuwe poging niets oplost (bijv. ontbrekende
  mapping); dan wordt de taak direct opgegeven.
- **Audit:** alleen het eindresultaat (gelukt/opgegeven) en "handmatig opnieuw geprobeerd" komen in de audit log, niet
  elke tussenpoging. De tussenpogingen staan in de taak zelf (pogingen, laatste fout).
- **Waarom:** geen extra dienst nodig (alles zit al in Supabase); de status per factuur is een simpele view; retries overleven
  een herstart.
- **Alternatief:** retries binnen één functieaanroep. Die gaan verloren bij een time-out, en er is dan geen zichtbare status.

### B55. De worker claimt alleen soorten waarvoor hij een verwerking heeft
- **Wat:** `verwerk-taken` geeft de lijst met eigen handlers mee aan `claim_taken`.
- **Waarom:** staat de migratie van een fase er al maar de nieuwe functie nog niet, dan blijven die taken gewoon wachten
  in plaats van als "onbekend" te worden opgegeven.

### B56. Cron roept de worker aan met een gedeeld geheim uit Vault
- **Wat:** de cronjob (elke minuut) en `plan_taak` (direct na aanmaken) doen een `net.http_post` naar `verwerk-taken` met
  header `x-worker-geheim`. De URL en het geheim staan in Supabase Vault; de functie vergelijkt met het secret
  `WORKER_GEHEIM` (in constante tijd). `verify_jwt` staat uit voor deze functie.
- **Waarom:** de service-rolsleutel hoeft zo niet in de database of in cron te staan. Zonder Vault-secrets doet de job niets
  (geen foutmeldingen elke minuut). In PGlite (tests) ontbreken pg_cron/pg_net/Vault; daar is `start_worker` een no-op.

### B57. Modus: env gaat voor de instelling
- **Wat:** `KOPPELING_<NAAM>_MODUS` (Supabase secret) wint en maakt de instelling alleen-lezen ("vastgezet door server");
  anders geldt `koppeling_instellingen`; anders mock. De regels staan in `_shared/koppelingen/modus.ts`, dat zowel de Edge
  Functions als de frontend gebruiken.
- **Waarom:** de opdracht vraagt "via env óf instellingenpagina". Env als harde override maakt het mogelijk een testomgeving
  gegarandeerd op mock te houden.
- **Secrets:** de functie `koppeling-actie` meldt alleen welke secrets ontbreken, nooit waarden. `config` in de tabel is
  alleen voor niet-geheime instellingen.

### B58. Badges alleen bij problemen
- **Wat:** de factuurlijst toont een badge bij een mislukte poging ("VIES: nieuwe poging om 14:05") of een opgegeven taak
  ("Export mislukt", klik = opnieuw proberen). Gelukte, wachtende of lopende taken geven geen badge.
- **Waarom:** anders staat bij elke factuur een rij badges. Het volledige overzicht staat op de pagina Koppelingen en in de
  historie van de factuur.
- **Opnieuw proberen:** elk lid mag dat; de taak zelf controleert opnieuw of de actie is toegestaan.

## Fase 4.2: verrijken en controleren

### B59. Resultaten in een tabel, signalen via bepaal_signalen
- **Wat:** VIES- en KvK-resultaten staan in `verificaties` (per organisatie, soort en nummer; het laatste resultaat, met tijdstip
  en bron live/mock). `bepaal_signalen` leest die tabel en maakt de signalen `btw_vies_ongeldig` en `kvk_afwijking`
  (waarschuwing). Een nieuw resultaat bepaalt de signalen opnieuw voor alle niet-betaalde facturen met dat nummer.
- **Waarom:** `bepaal_signalen` verwijdert bij elke save open signalen die niet in de nieuwe set zitten (B11). Een los
  weggeschreven VIES-signaal zou dus bij de volgende save verdwijnen. Opgeloste signalen blijven staan (zelfde sleutel).
- **Historie:** wijzigingen in `verificaties` staan in de audit log (bron vies/kvk, systeem); de uitkomst van de taak staat in
  de historie van de factuur waarvoor de controle werd aangevraagd.

### B60. Controles per nummer, met een geldigheid
- **Wat:** VIES per btw-nummer (30 dagen geldig), KvK per KvK-nummer (90 dagen). Alleen bij een geldig formaat, en VIES alleen
  voor EU-landen (`EL` voor Griekenland, `XI` voor Noord-Ierland). Een nieuwe factuur met een recent gecontroleerd nummer
  krijgt direct de signalen, zonder nieuwe aanvraag.
- **Waarom:** de opdracht noemt "bij een nieuwe leverancier" voor KvK; een nieuw of lang niet gecontroleerd nummer dekt dat,
  ook als een bekende leverancier een ander KvK-nummer gaat gebruiken. VIES is gratis maar vaak druk; dus niet bij elke save.

### B61. Bedrag in euro op de factuur, de koers alleen via de worker
- **Wat:** kolommen `bedrag_eur`, `koers`, `koers_datum` en `koers_bron`. Trigger `facturen_euro`: bij EUR is `bedrag_eur` het
  totaal; bij vreemde valuta wordt alles leeggemaakt zodra valuta, totaal of factuurdatum wijzigt, en plant een AFTER-trigger
  een ecb-taak. Alleen `verwerk_wisselkoers` (security definer, service role) vult de koers in, en alleen als valuta en datum
  nog kloppen (anders is de factuur intussen gewijzigd).
- **Waarom:** anders kan iemand via de API (of met de service role) een lager bedrag in euro zetten en zo de limiet omzeilen.
- **Koers:** ECB-referentiekoers van de laatste publicatie op of vóór de factuurdatum (maximaal 10 dagen terug); zonder
  factuurdatum de aanmaakdatum. Een factuurdatum in de toekomst krijgt de laatst beschikbare koers. De cache `wisselkoersen`
  wordt alleen gebruikt voor een koers van precies dezelfde datum.
- **Terugval:** `bedrag_eur` hoort niet bij de velden die een gecontroleerde factuur terugzetten naar gescand (het is afgeleid).
- **Backfill:** bestaande euro-facturen krijgen `bedrag_eur` = totaal (dat staat als systeemwijziging in de audit log); voor
  bestaande facturen in vreemde valuta wordt een ecb-taak gepland.

### B62. Goedkeuringslimiet en "net onder limiet" in euro (strenger dan voorheen)
- **Wat:** bij vreemde valuta telt `bedrag_eur`. Ontbreekt de koers nog en heeft de goedkeurder een limiet, dan is goedkeuren
  geblokkeerd ("De wisselkoers voor USD is nog niet bekend…"). Zonder limiet kan goedkeuren wel.
- **Waarom:** afgesproken met de opdrachtgever. Voorheen werd "USD 6.000" als 6.000 vergeleken met een limiet in euro, en was
  "JPY 700.000" altijd boven elke limiet.
- **UI:** `workflow.ts` (`bedragInEuro`) toont dezelfde blokkade als reden bij de knop; de lijst toont "≈ € …" of "koers volgt".
  De voorproef "net onder limiet" in het formulier geldt alleen voor euro; bij vreemde valuta bepaalt de database dat na de koers.

### B63. Bedrijfsnamen vergelijken in SQL
- **Wat:** `intern.normaliseer_bedrijfsnaam`: kleine letters, zonder accenten, leestekens en rechtsvormen (B.V., N.V., V.O.F.,
  C.V., GmbH, Ltd, …). Overeenkomst = gelijk, of de ene naam bevat de andere (minimaal 4 tekens). Naam, statutaire naam en
  alle handelsnamen tellen mee.
- **Waarom:** de naam op een factuur is vaak een handelsnaam of staat er zonder rechtsvorm; een strikte vergelijking geeft te
  veel waarschuwingen. De vergelijking staat in `bepaal_signalen` (SQL is leidend, B9), zodat een gewijzigde naam op de
  factuur meteen een ander resultaat geeft zonder nieuwe KvK-aanvraag.

### B64. KvK live via de testomgeving of productie
- **Wat:** `KVK_OMGEVING=test` gebruikt `https://api.kvk.nl/test/api` met de openbare testsleutel die de KvK zelf publiceert
  (dus geen secret nodig); anders productie met `KVK_API_KEY`. De pagina Koppelingen houdt daar rekening mee.
- **Let op:** de testomgeving kent alleen fictieve bedrijven; een echte leverancier geeft daar "niet gevonden" (en dus een
  waarschuwing). Gebruik de testomgeving om de koppeling te testen, niet voor echte facturen.

### B65. Tijdelijke vs. definitieve fouten per dienst
- VIES: `MS_UNAVAILABLE`, `TIMEOUT`, `*_MAX_CONCURRENT_REQ`, HTTP 5xx en netwerkfouten → nieuwe poging. Tijdens de bouw gaf de
  Nederlandse VIES-dienst live `MS_MAX_CONCURRENT_REQ`; zo'n melding komt dus echt voor.
- ECB: 404 voor een datum van vandaag of gisteren → nieuwe poging (koers nog niet gepubliceerd); voor een oudere datum of een
  onbekende valuta → definitief.
- KvK: 404 = "niet gevonden" (een resultaat, geen fout); 401/403 → definitief (sleutel of abonnement); 5xx → nieuwe poging.
- Rooktest tegen de echte diensten (24-09-2026): VIES (geldig en ongeldig NL-nummer), ECB (USD op een zaterdag → koers van
  vrijdag; onbekende valuta → definitief) en de KvK-testomgeving (68750110 gevonden, onbekend nummer → niet gevonden).

## Fase 4.3: mailbox-import

### B66. Mailgun, met één route voor één organisatie
- **Wat:** inkomende mail via een Mailgun inbound route (`forward()` naar de Edge Function `inbound-mail`). Het ontvangstadres
  staat in `inbox_adressen` en bepaalt de organisatie.
- **Waarom:** Mailgun ondertekent webhooks (HMAC-SHA256); Postmark Inbound doet dat niet (alleen Basic Auth). Het gratis plan
  (1 inbound route, 100 mails/dag) is genoeg voor één organisatie (afspraak). Meer organisaties = meer adressen in dezelfde
  route (bijv. `match_recipient(".*@inbox.domein.nl")`); de tabel is daar al op ingericht.

### B67. De webhook slaat alleen op; scannen gebeurt in de worker
- **Wat:** `inbound-mail` controleert de handtekening, registreert de mail, zet bruikbare bijlagen in Storage
  (`{organisatie_id}/inbox/{bericht_id}/…`) en antwoordt meteen. Per bijlage volgt een `mailbox`-taak die scant en de
  factuur maakt.
- **Waarom:** scannen met Gemini duurt tot een minuut per bijlage; een webhook die lang duurt, laat Mailgun opnieuw
  proberen. Via de wachtrij krijgt het scannen ook retries en een zichtbare status.
- **Antwoordcodes:** 200 (verwerkt of al ontvangen), 406 (onbekend adres, mock-modus, onleesbaar: niet opnieuw proberen),
  401 (handtekening), 500 (tijdelijk: Mailgun probeert het tot 8 uur opnieuw).

### B68. Idempotent: Message-Id en "afgerond"
- **Wat:** uniek per organisatie op Message-Id (zonder Message-Id: een hash van afzender, ontvanger, onderwerp, datum en
  Mailgun-timestamp). Een registratie die halverwege faalde (`afgerond = false`), wordt bij de volgende poging afgemaakt in
  plaats van als duplicaat genegeerd. De factuur krijgt het id van de bijlage, dus een nieuwe poging van de worker maakt nooit
  een tweede factuur.
- **Handtekening:** maximaal 12 uur oud (Mailgun probeert tot 8 uur opnieuw). Geen aparte token-administratie tegen replay:
  een herhaald verzoek levert door de Message-Id niets nieuws op.

### B69. "Bekende afzender" = in de lijst én echt
- **Wat:** bekend als het From-adres (of het domein, patroon `@domein.nl`) in `inbox_afzenders` staat én Mailgun SPF of DKIM
  als geslaagd meldt én het geen spam is. Anders: ter beoordeling.
- **Waarom:** het From-adres is eenvoudig te vervalsen; juist mail "van een bekende leverancier" is het klassieke middel voor
  factuurfraude. Ook een verwerkte mail van een bekende afzender doorloopt alle controles (o.a. het kritieke signaal bij een
  afwijkend IBAN).
- **Vertrouwen bij beoordeling:** de knop vertrouwt alleen het exacte adres, niet het domein (anders zou bij `@gmail.com`
  iedereen binnenkomen). Een domein voeg je bewust toe bij *Vertrouwde afzenders*.
- **Rollen:** beoordelen en vertrouwde afzenders beheren kan een controller of beheerder; het ontvangstadres alleen een
  beheerder. Alle leden zien de inbox (zoals de facturen). Wijzigingen aan adres en afzenders staan in de audit log.

### B70. Facturen uit de mail: geen "ingevoerd door", bron mailbox
- **Wat:** `maak_factuur_uit_inbox` (security definer, alleen service role) doet wat `sla_factuur_op` doet (leverancier op
  naam, bekend IBAN alleen vullen als het leeg is, btw-regels, codering historie → AI, signalen), maar met `user_id` leeg,
  `bron = 'mailbox'` en een verwijzing naar de bijlage. Een bestaande factuur (zelfde leverancier en nummer) geeft
  "duplicaat" in plaats van een fout.
- **Functiescheiding:** met een lege invoerder moet nog steeds iemand controleren en een ander goedkeuren (de controleur kan
  niet goedkeuren). Verwijderen van een mailfactuur kan alleen een beheerder (de regel "eigen factuur" geldt niet).
- **Herkomst:** `bron` en `inbox_bijlage_id` zijn niet door gebruikers of de service role te zetten (trigger).
- **Bestand:** de worker kopieert de bijlage naar `{organisatie_id}/{factuur_id}/…`, zodat bewerken via `sla_factuur_op` (die
  dat pad eist) gewoon werkt; het origineel blijft bij de mail staan.

### B71. Mock: gesimuleerde mail door dezelfde pipeline
- **Wat:** in mock-modus weigert `inbound-mail` echte mail (406) en maakt `koppeling-actie` (`simuleer_mail`) een mail met een
  echt PDF (gegenereerd, elke keer een ander factuurnummer). Die gaat door `verwerkMail`, dezelfde functie als de webhook.
  Bij "bekende afzender" wordt het testdomein aan de vertrouwde afzenders toegevoegd (zichtbaar en gelogd).
- **Scan:** met `GEMINI_API_KEY` scant Gemini het test-PDF echt; zonder sleutel of met `SCAN_MODUS=mock` gebruikt de mock-scan
  de gegevens die in het PDF staan. Zo werkt de mock zonder enig extern account.

### B72. Gemini-scan gedeeld door upload en mailbox
- **Wat:** de modelkeuze, fallback en foutvertaling van `scan-factuur` staan nu in `_shared/geminiScan.ts`; `scan-factuur` en
  de worker gebruiken dezelfde functie. Meldingen en gedrag van `scan-factuur` zijn ongewijzigd.
- **Waarom:** de opdracht eist dat bijlagen "door dezelfde scan- en controlepipeline" gaan; twee kopieën zouden uit elkaar
  gaan lopen. De worker gebruikt een kleiner tijdbudget (55 s) om binnen de looptijd van de functie te blijven.

### B73. Status van een taak terug naar het onderwerp
- **Wat:** `intern.taak_status_gewijzigd` wordt door `rond_taak_af` en `probeer_taak_opnieuw` aangeroepen. Voor mailbox-taken
  zet die de bijlage op *Mislukt* (met de fout) of terug op *Wordt verwerkt*. Latere fasen gebruiken dezelfde haak.
- **Waarom:** de inbox toont de status per bijlage zonder dat de worker aparte administratie hoeft te doen.


## Fase 4.4: e-mailnotificaties

### B74. De database bepaalt wie een mail krijgt; de worker stelt hem op en verstuurt hem
- **Wat:** triggers (gecontroleerd, koers bekend, afgekeurd), `intern.taak_status_gewijzigd` (export opgegeven) en een
  dagelijkse cronjob (bijna vervallen) leggen per ontvanger een rij vast in `notificaties` en plannen een `email`-taak. De
  worker haalt via `notificatie_voor_verzending` de gegevens op, stelt de mail op (`_shared/koppelingen/mailteksten.ts`) en
  verstuurt hem via Resend of mock.
- **Waarom:** de ontvangers hangen af van rollen, limieten en functiescheiding; die regels staan al in SQL (B9). Via de
  wachtrij krijgt versturen retries en een zichtbare status per factuur ("Mail niet verzonden").
- **Idempotent:** `notificaties` is uniek op (organisatie, soort, sleutel); de sleutel bevat de factuur, het moment (bijv. de
  controle) en de ontvanger. Resend krijgt de notificatie-id als `Idempotency-Key` (24 uur geldig, langer dan de hele
  retry-reeks van ongeveer 15 uur), dus een nieuwe poging na een time-out mailt niet dubbel.
- **Relevantie bij verzenden:** is de factuur intussen goedgekeurd, opnieuw gecontroleerd of verwijderd, of is de ontvanger
  geen lid meer, dan wordt de mail overgeslagen (status *Niet nodig*, met reden).

### B75. Ontvangers
- **Goedkeuren:** rol goedkeurder/controller/beheerder, bedrag in euro binnen de limiet (of geen limiet), niet de invoerder en
  niet de controleur. Bij vreemde valuta zonder koers krijgen alleen leden zonder limiet direct een mail; de rest zodra
  `verwerk_wisselkoers` het bedrag in euro zet (dezelfde trigger, zelfde sleutel per controleronde, dus geen dubbele mail).
- **Afgekeurd:** invoerder en controleur, behalve wie afkeurde. Een factuur uit de mail heeft geen invoerder; zonder
  invoerder en controleur gaat de mail naar controllers en beheerders.
- **Export mislukt / bijna vervallen:** controllers en beheerders, de rollen die dit kunnen oplossen. Bijna vervallen is één
  mail per persoon per dag met de facturen die die persoon nog niet eerder gemeld kreeg (standaard 3 dagen vooruit,
  instelbaar 1–30), zodat een factuur niet dagelijks terugkomt.
- **Alternatief:** een mail per factuur voor "bijna vervallen". Dat geeft op drukke dagen een reeks losse mails.

### B76. Knoppen openen een bevestigingspagina in de app, niet direct de actie
- **Wat:** de knoppen linken naar `APP_URL/#mail-actie=<token>&keuze=…`. De pagina toont de factuur (incl. open signalen) en
  voert pas na *Bevestig* de actie uit via de Edge Function `mail-actie`. Inloggen is niet nodig.
- **Waarom:** mailprogramma's (bijv. Outlook Safe Links) openen links om ze te scannen; een GET mag dus nooit iets goedkeuren.
  Een Edge Function kan op Supabase geen HTML-pagina serveren, en de app draait al op Vercel. Het token staat in de
  `#`-fragment, zodat het niet in serverlogs of in een Referer terechtkomt, en er is geen rewrite-regel op Vercel nodig.
- **Afkeuren** vraagt op die pagina de verplichte reden (zelfde regel als in de app).

### B77. Token: ondertekend (HMAC) met verlooptijd; eenmalig en gebonden via de database
- **Wat:** `v1.<payload>.<handtekening>`, met payload `{ id van mail_acties, verlooptijd }` en HMAC-SHA256 met
  `MAIL_TOKEN_GEHEIM` (of een sleutel afgeleid van de service-rolsleutel). `mail_acties` koppelt het id aan goedkeurder,
  factuur en het tijdstip van de controle, en legt het gebruik vast. Eén token voor beide knoppen: gebruikt = gebruikt.
- **Waarom deze vorm:** de opdracht vraagt om een ondertekend, eenmalig token met een verlooptijd. Het token is
  deterministisch per notificatie (verlooptijd staat in de database), zodat een nieuwe poging van de worker exact dezelfde mail
  verstuurt en de idempotentie van Resend werkt. Er staan geen persoonsgegevens of bedragen in het token.
- **Vervalt ook** als de factuur na de mail opnieuw is gecontroleerd (andere `gecontroleerd_op`).
- **Geweigerde poging** (limiet, signaal, verlopen, al gebruikt): staat in de audit log (bron email, gebruiker = goedkeurder van
  de link) en verbruikt de link niet; een tijdelijk probleem (bijv. koers volgt) kan dus later alsnog.
- **Alternatief:** alleen een willekeurig token met een hash in de database. Dat is ook veilig, maar niet "ondertekend" en
  lastiger idempotent te versturen.

### B78. Via de mail geldt een strikte functiescheiding
- **Wat:** `voer_mail_actie_uit` weigert goedkeuren door de invoerder of controleur, ook in een organisatie met één lid, en
  voert daarna `intern.wijzig_status_als(goedkeurder, …, 'email')` uit: dezelfde controles als de app (rol, limiet in euro,
  open kritieke signalen, grootboekrekening).
- **Waarom:** de opdracht eist dat de server dit bij een mail-goedkeuring opnieuw controleert. De uitzondering voor één lid
  (B36) is bedoeld voor wie in de app werkt; een link in een mailbox is makkelijker door te sturen. Een organisatie met één lid
  krijgt daardoor geen goedkeuringsmails (het enige lid is altijd de controleur).
- **Vooraf tonen:** `bekijk_mail_actie` voert de statuswijziging als proef uit en draait hem terug (`intern.proef_statuswijziging`),
  zodat de pagina en de mail de reden al tonen ("Kies eerst een grootboekrekening.") en geen goedkeurknop geven die toch faalt.
  Zo is er één bron van regels.

### B79. Mock: mails lezen in de app, alleen de eigen mails met inhoud
- **Wat:** in mock-modus wordt niets verstuurd; de volledige mail staat in `notificatie_inhoud` en is alleen leesbaar voor de
  ontvanger (pagina *Meldingen → Mijn mails*, in een iframe met sandbox; links openen in een nieuw tabblad). Controllers en
  beheerders zien bij *Alle mails* wie wat kreeg en de status, maar niet de inhoud. Van live mails wordt de inhoud niet bewaard.
- **Waarom:** mock staat standaard aan, ook in productie. Als iedereen de mock-mails kon lezen, zou een invoerder met de
  knoppen van een goedkeurder zijn eigen factuur kunnen goedkeuren.
- **APP_URL in mock:** mag ontbreken; de mail krijgt dan een placeholder die de app vervangt door zijn eigen adres.
- **Fouten simuleren:** `+tijdelijk` of `+ongeldig` in het ontvangstadres (zelfde idee als de mock-regels van VIES en KvK).

### B80. Resend: welke fouten opnieuw
- 429 (limiet per seconde, dag- of maandquotum), 409 `concurrent_idempotent_requests`, 5xx en netwerkfouten → nieuwe poging.
  409 `invalid_idempotent_request` (zelfde sleutel, iets andere inhoud: de eerdere poging is dus aangekomen) → geldt als
  verzonden. Andere 4xx (sleutel ongeldig, domein niet geverifieerd, ongeldig adres) → direct opgegeven, met de melding van
  Resend bij de taak en de notificatie.
- **Waarom Resend:** gratis plan (3.000/maand, 100/dag) is genoeg voor één organisatie; eenvoudige REST-API met idempotentie.
  Inkomende mail blijft Mailgun (B66).
