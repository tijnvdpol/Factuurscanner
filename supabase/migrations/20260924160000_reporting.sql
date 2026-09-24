-- Fase 4.7: rapportages voor Power BI.
--
-- - Schema "reporting" met alleen-lezen views: openstaande posten, crediteurenouderdom, cashflowprognose op
--   vervaldatum en doorlooptijd van goedkeuring. Bedragen in euro (bij vreemde valuta de ECB-omrekening; zonder koers
--   leeg en apart geteld). "Vandaag" = de datum in Nederland.
-- - Rol reporting_lezer (geen login): mag alleen deze views lezen. De login voor Power BI maak je zelf, met een eigen
--   wachtwoord, als lid van deze rol (zie README, "Power BI").
-- - De views draaien met de rechten van hun eigenaar (postgres), dus RLS geldt niet: de rol ziet alle organisaties.
--   Elke view heeft organisatie_id en de naam van de organisatie om op te filteren.
-- - Geen functies uit het schema intern in de views: functies in een view worden met de rechten van de lezer
--   uitgevoerd, en reporting_lezer heeft geen toegang tot intern.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'reporting_lezer') then
    create role reporting_lezer nologin;
  end if;
end;
$$;


create schema reporting;
comment on schema reporting is 'Alleen-lezen views voor rapportages (Power BI). Lezen via de rol reporting_lezer.';
revoke all on schema reporting from public;

-- ---------------------------------------------------------------------------
-- Openstaande posten: ontvangen, niet afgekeurde en nog niet betaalde facturen
-- ---------------------------------------------------------------------------

create view reporting.openstaande_posten as
select
  f.id                                             as factuur_id,
  f.organisatie_id,
  o.naam                                           as organisatie,
  f.leverancier_id,
  coalesce(f.leverancier_naam, '(onbekend)')      as leverancier,
  f.factuurnummer,
  f.factuurdatum,
  f.vervaldatum,
  coalesce(f.valuta, 'EUR')                        as valuta,
  f.totaal_incl                                    as bedrag,
  case when coalesce(f.valuta, 'EUR') = 'EUR' then f.totaal_incl else f.bedrag_eur end as bedrag_eur,
  f.status,
  case f.status
    when 'gescand' then 'Te controleren'
    when 'gecontroleerd' then 'Te keuren'
    when 'goedgekeurd' then 'Te betalen'
    when 'in_betaalbatch' then 'In betaalbatch'
  end                                              as status_omschrijving,
  f.status in ('goedgekeurd', 'in_betaalbatch')    as goedgekeurd,
  f.bron,
  f.geexporteerd_op is not null                    as geexporteerd,
  g.code                                           as grootboekrekening,
  g.omschrijving                                   as grootboekrekening_omschrijving,
  d.vandaag                                        as peildatum,
  f.vervaldatum - d.vandaag                        as dagen_tot_vervaldatum,
  greatest(d.vandaag - f.vervaldatum, 0)           as dagen_over_vervaldatum,
  case
    when f.vervaldatum is null then 'Geen vervaldatum'
    when f.vervaldatum >= d.vandaag then 'Niet vervallen'
    when d.vandaag - f.vervaldatum <= 30 then '1-30 dagen'
    when d.vandaag - f.vervaldatum <= 60 then '31-60 dagen'
    when d.vandaag - f.vervaldatum <= 90 then '61-90 dagen'
    else 'Meer dan 90 dagen'
  end                                              as ouderdom,
  case
    when f.vervaldatum is null then 5
    when f.vervaldatum >= d.vandaag then 0
    when d.vandaag - f.vervaldatum <= 30 then 1
    when d.vandaag - f.vervaldatum <= 60 then 2
    when d.vandaag - f.vervaldatum <= 90 then 3
    else 4
  end                                              as ouderdom_volgorde,
  f.created_at                                     as ingevoerd_op
from public.facturen f
join public.organisaties o on o.id = f.organisatie_id
left join public.grootboekrekeningen g on g.id = f.grootboekrekening_id
cross join (select (now() at time zone 'Europe/Amsterdam')::date as vandaag) d
where f.status in ('gescand', 'gecontroleerd', 'goedgekeurd', 'in_betaalbatch');

comment on view reporting.openstaande_posten is
  'Ontvangen facturen die nog niet betaald of afgekeurd zijn, met bedrag in euro en ouderdom t.o.v. de vervaldatum.';

-- ---------------------------------------------------------------------------
-- Crediteurenouderdom per leverancier (bedragen in euro per ouderdomsklasse)
-- ---------------------------------------------------------------------------

create view reporting.crediteurenouderdom as
select
  organisatie_id,
  organisatie,
  leverancier_id,
  leverancier,
  peildatum,
  count(*)                                                                      as aantal,
  coalesce(sum(bedrag_eur) filter (where ouderdom_volgorde = 0), 0)             as niet_vervallen,
  coalesce(sum(bedrag_eur) filter (where ouderdom_volgorde = 1), 0)             as dagen_1_30,
  coalesce(sum(bedrag_eur) filter (where ouderdom_volgorde = 2), 0)             as dagen_31_60,
  coalesce(sum(bedrag_eur) filter (where ouderdom_volgorde = 3), 0)             as dagen_61_90,
  coalesce(sum(bedrag_eur) filter (where ouderdom_volgorde = 4), 0)             as meer_dan_90,
  coalesce(sum(bedrag_eur) filter (where ouderdom_volgorde = 5), 0)             as geen_vervaldatum,
  coalesce(sum(bedrag_eur), 0)                                                  as totaal_eur,
  count(*) filter (where bedrag_eur is null)                                    as aantal_zonder_bedrag_eur,
  max(dagen_over_vervaldatum)                                                   as max_dagen_over_vervaldatum
from reporting.openstaande_posten
group by organisatie_id, organisatie, leverancier_id, leverancier, peildatum;

comment on view reporting.crediteurenouderdom is
  'Openstaand bedrag in euro per leverancier en ouderdomsklasse (dagen over de vervaldatum).';

-- ---------------------------------------------------------------------------
-- Cashflowprognose: verwachte uitgaven per dag op basis van de vervaldatum
-- ---------------------------------------------------------------------------
-- Verwachte betaaldatum = de vervaldatum; al vervallen = vandaag; geen vervaldatum = factuurdatum + 30 dagen.

create view reporting.cashflowprognose as
with posten as (
  select p.*,
         greatest(coalesce(p.vervaldatum, p.factuurdatum + 30, p.peildatum), p.peildatum) as verwachte_datum
  from reporting.openstaande_posten p
)
select
  organisatie_id,
  organisatie,
  verwachte_datum,
  date_trunc('week', verwachte_datum)::date                                     as week,
  to_char(verwachte_datum, 'YYYY-MM')                                           as maand,
  count(*)                                                                      as aantal,
  coalesce(sum(bedrag_eur), 0)                                                  as bedrag_eur,
  coalesce(sum(bedrag_eur) filter (where goedgekeurd), 0)                       as bedrag_goedgekeurd,
  coalesce(sum(bedrag_eur) filter (where not goedgekeurd), 0)                   as bedrag_nog_te_keuren,
  coalesce(sum(bedrag_eur) filter (where status = 'in_betaalbatch'), 0)        as bedrag_in_betaalbatch,
  count(*) filter (where bedrag_eur is null)                                    as aantal_zonder_bedrag_eur,
  sum(coalesce(sum(bedrag_eur), 0)) over (partition by organisatie_id order by verwachte_datum) as cumulatief_eur
from posten
group by organisatie_id, organisatie, verwachte_datum;

comment on view reporting.cashflowprognose is
  'Verwachte uitgaven per dag (vervaldatum; vervallen = vandaag), met onderscheid goedgekeurd / nog te keuren en een cumulatief totaal.';

-- ---------------------------------------------------------------------------
-- Doorlooptijd van goedkeuring (alle goedgekeurde facturen, ook al betaald)
-- ---------------------------------------------------------------------------

create view reporting.doorlooptijd_goedkeuring as
select
  f.id                                                                          as factuur_id,
  f.organisatie_id,
  o.naam                                                                        as organisatie,
  coalesce(f.leverancier_naam, '(onbekend)')                                   as leverancier,
  f.factuurnummer,
  case when coalesce(f.valuta, 'EUR') = 'EUR' then f.totaal_incl else f.bedrag_eur end as bedrag_eur,
  f.status,
  f.bron,
  f.created_at                                                                  as ingevoerd_op,
  f.gecontroleerd_op,
  f.goedgekeurd_op,
  f.betaald_op,
  (f.goedgekeurd_op at time zone 'Europe/Amsterdam')::date                      as goedkeurdatum,
  round((extract(epoch from f.gecontroleerd_op - f.created_at) / 3600)::numeric, 1)      as uren_invoer_tot_controle,
  round((extract(epoch from f.goedgekeurd_op - f.gecontroleerd_op) / 3600)::numeric, 1)  as uren_controle_tot_goedkeuring,
  round((extract(epoch from f.goedgekeurd_op - f.created_at) / 3600)::numeric, 1)        as uren_invoer_tot_goedkeuring,
  round((extract(epoch from f.goedgekeurd_op - f.created_at) / 86400)::numeric, 2)       as dagen_invoer_tot_goedkeuring,
  round((extract(epoch from f.betaald_op - f.goedgekeurd_op) / 86400)::numeric, 2)       as dagen_goedkeuring_tot_betaling,
  uc.email                                                                      as gecontroleerd_door,
  ug.email                                                                      as goedgekeurd_door,
  -- app of e-mail (knop in de goedkeuringsmail, fase 4.4)
  (select a.bron from public.audit_log a
   where a.tabel = 'facturen' and a.record_id = f.id and a.actie = 'statuswijziging' and a.nieuw ->> 'status' = 'goedgekeurd'
   order by a.id desc limit 1)                                                  as goedgekeurd_via,
  (select count(*) from public.audit_log a
   where a.tabel = 'facturen' and a.record_id = f.id and a.actie = 'statuswijziging' and a.nieuw ->> 'status' = 'afgekeurd')::int
                                                                                as keren_afgekeurd
from public.facturen f
join public.organisaties o on o.id = f.organisatie_id
left join auth.users uc on uc.id = f.gecontroleerd_door
left join auth.users ug on ug.id = f.goedgekeurd_door
where f.goedgekeurd_op is not null;

comment on view reporting.doorlooptijd_goedkeuring is
  'Per goedgekeurde factuur de tijd van invoer tot controle en goedkeuring (en tot betaling), wie en via welke weg.';

-- ---------------------------------------------------------------------------
-- Rechten: alleen reporting_lezer, alleen lezen
-- ---------------------------------------------------------------------------

revoke all on all tables in schema reporting from public, anon, authenticated;
grant usage on schema reporting to reporting_lezer;
grant select on all tables in schema reporting to reporting_lezer;

-- Voor snelle doorlooptijd-berekening (statuswijzigingen per factuur uit de audit log)
create index if not exists audit_log_statuswijziging_idx on public.audit_log (record_id) where actie = 'statuswijziging';
