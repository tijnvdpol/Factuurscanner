-- Fase 4.2: verrijken en controleren (VIES, ECB-wisselkoersen, KvK).
--
-- - verificaties: resultaat van VIES (btw-nummer) en KvK (bedrijfsgegevens) per nummer, met tijdstip en bron.
-- - wisselkoersen: cache van ECB-koersen. facturen krijgt bedrag_eur, koers, koers_datum en koers_bron.
-- - Bij opslaan plant een trigger de taken in (vies, kvk, ecb); de worker haalt de gegevens op en roept
--   de functies hieronder aan. bepaal_signalen maakt uit de opgeslagen resultaten de signalen
--   btw_vies_ongeldig en kvk_afwijking (zo verdwijnen ze niet bij de volgende save).
-- - Goedkeuringslimiet en "net onder limiet" in euro: bij vreemde valuta telt bedrag_eur. Ontbreekt de
--   koers nog, dan is goedkeuren met een limiet geblokkeerd.

-- ---------------------------------------------------------------------------
-- Omrekening naar euro op de factuur
-- ---------------------------------------------------------------------------

alter table public.facturen
  add column bedrag_eur numeric(12, 2),
  add column koers      numeric(18, 6) check (koers > 0),
  add column koers_datum date,
  add column koers_bron text check (koers_bron in ('ecb', 'mock'));

comment on column public.facturen.bedrag_eur is 'Totaal incl. btw in euro (bij EUR gelijk aan totaal_incl; anders omgerekend met koers)';
comment on column public.facturen.koers is 'Eenheden vreemde valuta per 1 euro (ECB-referentiekoers)';
comment on column public.facturen.koers_datum is 'Datum van de gebruikte koers (laatste ECB-publicatie op of vóór de factuurdatum)';

-- Backfill: euro-facturen direct; facturen in vreemde valuta krijgen hieronder een ecb-taak.
update public.facturen set bedrag_eur = totaal_incl where coalesce(valuta, 'EUR') = 'EUR';

-- Bedrag in euro dat telt voor limieten; null = koers (nog) onbekend.
create function intern.bedrag_in_euro(f public.facturen)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case when coalesce(f.valuta, 'EUR') = 'EUR' then f.totaal_incl else f.bedrag_eur end;
$$;

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------

create table public.verificaties (
  id             uuid primary key default gen_random_uuid(),
  organisatie_id uuid not null references public.organisaties (id) on delete cascade,
  soort          text not null check (soort in ('vies', 'kvk')),
  -- het gecontroleerde nummer (btw-nummer of KvK-nummer), genormaliseerd zoals op de factuur
  sleutel        text not null check (btrim(sleutel) <> ''),
  -- vies: geldig | ongeldig;  kvk: gevonden | niet_gevonden | uitgeschreven
  uitkomst       text not null check (uitkomst in ('geldig', 'ongeldig', 'gevonden', 'niet_gevonden', 'uitgeschreven')),
  -- vies: { naam, adres };  kvk: { naam, statutaire_naam, handelsnamen[], datum_einde, adres }
  details        jsonb not null default '{}'::jsonb,
  bron           text not null check (bron in ('live', 'mock')),
  opgevraagd_op  timestamptz not null default now(),
  unique (organisatie_id, soort, sleutel)
);

alter table public.verificaties enable row level security;

create policy "Leden lezen de verificaties"
  on public.verificaties for select to authenticated
  using (public.is_lid(organisatie_id));

revoke all on public.verificaties from anon, authenticated;
grant select on public.verificaties to authenticated;

-- Wijzigingen in de audit log (wie/wat: bron vies/kvk, systeem)
create trigger audit_verificaties
  after insert or update or delete on public.verificaties
  for each row execute function intern.log_wijziging();

create table public.wisselkoersen (
  valuta       char(3) not null check (valuta ~ '^[A-Z]{3}$' and valuta <> 'EUR'),
  datum        date not null,
  koers        numeric(18, 6) not null check (koers > 0),
  bron         text not null check (bron in ('ecb', 'mock')),
  opgehaald_op timestamptz not null default now(),
  primary key (valuta, datum, bron)
);

alter table public.wisselkoersen enable row level security;

-- Openbare referentiekoersen: elke ingelogde gebruiker mag ze lezen; schrijven alleen via functies.
create policy "Ingelogde gebruikers lezen wisselkoersen"
  on public.wisselkoersen for select to authenticated
  using (true);

revoke all on public.wisselkoersen from anon, authenticated;
grant select on public.wisselkoersen to authenticated;

-- ---------------------------------------------------------------------------
-- Signaaltypen
-- ---------------------------------------------------------------------------

alter table public.factuur_signalen drop constraint factuur_signalen_type_check;
alter table public.factuur_signalen add constraint factuur_signalen_type_check
  check (type in ('mogelijk_duplicaat', 'iban_afwijkend', 'nieuwe_leverancier', 'rond_bedrag',
                  'net_onder_limiet', 'validatiefout', 'btw_vies_ongeldig', 'kvk_afwijking'));

-- ---------------------------------------------------------------------------
-- Hulpfuncties
-- ---------------------------------------------------------------------------

-- Lidstaten in VIES (EL = Griekenland, XI = Noord-Ierland).
create function intern.is_vies_land(p_btw_nummer text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select left(coalesce(p_btw_nummer, ''), 2) = any (array[
    'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT',
    'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI']);
$$;

-- Bedrijfsnaam vergelijkbaar maken: kleine letters, zonder accenten, leestekens en rechtsvorm.
-- "Test B.V." en "test bv" worden beide "test".
create function intern.normaliseer_bedrijfsnaam(p_naam text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        lower(translate(coalesce(p_naam, ''),
          'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖòóôõöÙÚÛÜùúûüÇçÑñ',
          'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn')),
        -- rechtsvormen, ook met puntjes of spaties ("b.v.", "b v", "v.o.f.")
        '(^|[^a-z0-9])(b\.?\s?v|n\.?\s?v|v\.?\s?o\.?\s?f|c\.?\s?v|besloten vennootschap|naamloze vennootschap|vennootschap onder firma|eenmanszaak|gmbh|ltd|limited|s\.?a\.?r\.?l|sarl|s\.?a|inc)\.?(?=$|[^a-z0-9])',
        ' ', 'g'),
      '[^a-z0-9]+', ' ', 'g'),
    '\s+', ' ', 'g')), '');
$$;

-- Komt de naam op de factuur overeen met een van de KvK-namen? Gelijk na normaliseren, of de een bevat de
-- ander (minimaal 4 tekens), bijv. "Donald" in "Test BV Donald".
create function intern.naam_komt_overeen(p_factuurnaam text, p_namen text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select exists (
    select 1
    from unnest(p_namen) as n (naam)
    cross join lateral (select intern.normaliseer_bedrijfsnaam(p_factuurnaam) as a, intern.normaliseer_bedrijfsnaam(n.naam) as b) x
    where x.a is not null and x.b is not null
      and (x.a = x.b
           or (length(x.a) >= 4 and position(x.a in x.b) > 0)
           or (length(x.b) >= 4 and position(x.b in x.a) > 0))
  );
$$;

revoke execute on function intern.bedrag_in_euro(public.facturen), intern.is_vies_land(text),
  intern.normaliseer_bedrijfsnaam(text), intern.naam_komt_overeen(text, text[]) from public;
grant execute on function intern.bedrag_in_euro(public.facturen), intern.is_vies_land(text),
  intern.normaliseer_bedrijfsnaam(text), intern.naam_komt_overeen(text, text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Euro-kolommen bewaken (BEFORE-trigger, na facturen_bewaking)
-- ---------------------------------------------------------------------------
-- Gebruikers en de service role kunnen bedrag_eur/koers niet zelf zetten: bij INSERT worden ze berekend,
-- bij UPDATE blijven ze staan tenzij valuta, totaal of factuurdatum verandert. Dan:
--   EUR: bedrag_eur = totaal_incl;  vreemde valuta: leeg, en de AFTER-trigger plant een ecb-taak.
-- Alleen intern.verwerk_wisselkoers (security definer) vult de koers in.

create function intern.bewaak_euro()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_bevoegd boolean := current_user not in ('authenticated', 'anon', 'service_role');
begin
  if tg_op = 'UPDATE' and v_bevoegd
     and (new.bedrag_eur, new.koers, new.koers_datum, new.koers_bron)
         is distinct from (old.bedrag_eur, old.koers, old.koers_datum, old.koers_bron) then
    -- verwerk_wisselkoers zet de koers zelf
    return new;
  end if;

  if tg_op = 'UPDATE' then
    new.bedrag_eur := old.bedrag_eur;
    new.koers := old.koers;
    new.koers_datum := old.koers_datum;
    new.koers_bron := old.koers_bron;
  end if;

  if tg_op = 'INSERT'
     or (new.valuta, new.totaal_incl, new.factuurdatum) is distinct from (old.valuta, old.totaal_incl, old.factuurdatum) then
    if coalesce(new.valuta, 'EUR') = 'EUR' then
      new.bedrag_eur := new.totaal_incl;
    else
      new.bedrag_eur := null;
    end if;
    new.koers := null;
    new.koers_datum := null;
    new.koers_bron := null;
  end if;
  return new;
end;
$$;

revoke execute on function intern.bewaak_euro() from public;

create trigger facturen_euro
  before insert or update on public.facturen
  for each row execute function intern.bewaak_euro();

-- ---------------------------------------------------------------------------
-- Verrijking inplannen (AFTER-trigger)
-- ---------------------------------------------------------------------------
-- - ecb:  vreemde valuta met totaal, zodra valuta/totaal/factuurdatum verandert.
-- - vies: geldig btw-nummer uit een VIES-land, als er geen resultaat is van de laatste 30 dagen.
-- - kvk:  geldig KvK-nummer, als er geen resultaat is van de laatste 90 dagen (nieuwe leverancier of nieuw nummer).

create function intern.plan_verrijking()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_datum date := coalesce(new.factuurdatum, new.created_at::date);
begin
  if coalesce(new.valuta, 'EUR') <> 'EUR' and new.totaal_incl is not null and new.bedrag_eur is null
     and (tg_op = 'INSERT'
          or (new.valuta, new.totaal_incl, new.factuurdatum) is distinct from (old.valuta, old.totaal_incl, old.factuurdatum)) then
    perform intern.plan_taak(new.organisatie_id, 'ecb', new.id::text || ':' || new.valuta || ':' || v_datum::text, new.id,
                             jsonb_build_object('valuta', new.valuta, 'datum', v_datum));
  end if;

  if new.btw_nummer is not null
     and (tg_op = 'INSERT' or new.btw_nummer is distinct from old.btw_nummer)
     and intern.controleer_btw_nummer(new.btw_nummer) is null
     and intern.is_vies_land(new.btw_nummer)
     and not exists (
       select 1 from public.verificaties v
       where v.organisatie_id = new.organisatie_id and v.soort = 'vies' and v.sleutel = new.btw_nummer
         and v.opgevraagd_op > now() - interval '30 days'
     ) then
    perform intern.plan_taak(new.organisatie_id, 'vies', new.btw_nummer, new.id,
                             jsonb_build_object('btw_nummer', new.btw_nummer));
  end if;

  if new.kvk_nummer is not null
     and (tg_op = 'INSERT' or new.kvk_nummer is distinct from old.kvk_nummer)
     and intern.controleer_kvk_nummer(new.kvk_nummer) is null
     and not exists (
       select 1 from public.verificaties v
       where v.organisatie_id = new.organisatie_id and v.soort = 'kvk' and v.sleutel = new.kvk_nummer
         and v.opgevraagd_op > now() - interval '90 days'
     ) then
    perform intern.plan_taak(new.organisatie_id, 'kvk', new.kvk_nummer, new.id,
                             jsonb_build_object('kvk_nummer', new.kvk_nummer, 'naam', new.leverancier_naam));
  end if;

  return null;
end;
$$;

revoke execute on function intern.plan_verrijking() from public;

create trigger facturen_verrijking
  after insert or update of valuta, totaal_incl, factuurdatum, btw_nummer, kvk_nummer on public.facturen
  for each row execute function intern.plan_verrijking();

-- ---------------------------------------------------------------------------
-- Resultaten verwerken (alleen de service role: de worker)
-- ---------------------------------------------------------------------------

-- Slaat een VIES- of KvK-resultaat op en bepaalt de signalen opnieuw voor alle (niet betaalde) facturen
-- met dit nummer. Geeft het aantal bijgewerkte facturen terug.
create function public.sla_verificatie_op(
  p_organisatie_id uuid,
  p_soort          text,
  p_sleutel        text,
  p_uitkomst       text,
  p_details        jsonb,
  p_bron           text
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n  int := 0;
begin
  perform intern.zet_audit_context(null, p_soort);

  insert into public.verificaties as v (organisatie_id, soort, sleutel, uitkomst, details, bron, opgevraagd_op)
  values (p_organisatie_id, p_soort, p_sleutel, p_uitkomst, coalesce(p_details, '{}'::jsonb), p_bron, now())
  on conflict (organisatie_id, soort, sleutel) do update set
    uitkomst = excluded.uitkomst, details = excluded.details, bron = excluded.bron, opgevraagd_op = excluded.opgevraagd_op;

  for v_id in
    select f.id from public.facturen f
    where f.organisatie_id = p_organisatie_id
      and f.status <> 'betaald'
      and ((p_soort = 'vies' and f.btw_nummer = p_sleutel) or (p_soort = 'kvk' and f.kvk_nummer = p_sleutel))
  loop
    perform intern.bepaal_signalen(v_id);
    v_n := v_n + 1;
  end loop;

  perform intern.zet_audit_context(null, null);
  return v_n;
end;
$$;

-- Slaat een koers op (cache) en rekent de factuur om, als valuta en datum nog kloppen (de factuur kan
-- intussen zijn gewijzigd). Geeft het bedrag in euro terug, of null als de factuur niet (meer) past.
create function public.verwerk_wisselkoers(
  p_factuur_id  uuid,
  p_valuta      text,
  p_datum       date,
  p_koers_datum date,
  p_koers       numeric,
  p_bron        text
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  f      public.facturen%rowtype;
  v_euro numeric;
begin
  if p_koers is null or p_koers <= 0 then
    raise exception 'Ongeldige koers.' using errcode = '22023';
  end if;

  insert into public.wisselkoersen (valuta, datum, koers, bron)
  values (p_valuta, p_koers_datum, p_koers, p_bron)
  on conflict (valuta, datum, bron) do update set koers = excluded.koers, opgehaald_op = now();

  select * into f from public.facturen where id = p_factuur_id for update;
  if f.id is null or f.valuta is distinct from p_valuta
     or coalesce(f.factuurdatum, f.created_at::date) <> p_datum or f.totaal_incl is null then
    return null;
  end if;

  v_euro := round(f.totaal_incl / p_koers, 2);
  perform intern.zet_audit_context(null, 'ecb');
  update public.facturen
  set bedrag_eur = v_euro, koers = p_koers, koers_datum = p_koers_datum, koers_bron = p_bron
  where id = f.id;
  perform intern.bepaal_signalen(f.id);
  perform intern.zet_audit_context(null, null);
  return v_euro;
end;
$$;

-- Gecachte koers (laatste op of vóór de datum, maximaal 10 dagen terug), zodat de worker niet voor elke
-- factuur de ECB hoeft aan te roepen.
create function public.zoek_wisselkoers(p_valuta text, p_datum date, p_bron text)
returns table (datum date, koers numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select w.datum, w.koers
  from public.wisselkoersen w
  where w.valuta = p_valuta and w.bron = p_bron and w.datum <= p_datum and w.datum > p_datum - 10
  order by w.datum desc
  limit 1;
$$;

revoke execute on function
  public.sla_verificatie_op(uuid, text, text, text, jsonb, text),
  public.verwerk_wisselkoers(uuid, text, date, date, numeric, text),
  public.zoek_wisselkoers(text, date, text)
from public, anon, authenticated;
grant execute on function
  public.sla_verificatie_op(uuid, text, text, text, jsonb, text),
  public.verwerk_wisselkoers(uuid, text, date, date, numeric, text),
  public.zoek_wisselkoers(text, date, text)
to service_role;

-- ---------------------------------------------------------------------------
-- bepaal_signalen: + VIES, + KvK, net onder limiet in euro
-- ---------------------------------------------------------------------------

create or replace function intern.bepaal_signalen(p_factuur_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  f           public.facturen%rowtype;
  v_lev_naam  text;
  v_lev_iban  text;
  v_nieuw     jsonb := '[]'::jsonb;
  v_ids       uuid[];
  v_nummers   text;
  v_fout      text;
  v_som       numeric;
  v_aantal    int;
  v_leeg      int;
  v_limiet    numeric;
  v_euro      numeric;
  v_ver       public.verificaties%rowtype;
  v_namen     text[];
begin
  select * into f from public.facturen where id = p_factuur_id;
  if not found then
    return;
  end if;
  -- Zonder ingelogde gebruiker (migratie, service role) geen toegangscontrole.
  if v_uid is not null and not public.is_lid(f.organisatie_id) then
    raise exception 'Geen toegang tot deze factuur.' using errcode = '42501';
  end if;
  v_euro := intern.bedrag_in_euro(f);

  if f.leverancier_id is not null then
    select naam, iban into v_lev_naam, v_lev_iban from public.leveranciers where id = f.leverancier_id;

    -- Mogelijk duplicaat: zelfde leverancier en (genormaliseerd) factuurnummer, of zelfde totaalbedrag
    -- binnen 30 dagen.
    select array_agg(o.id order by o.id),
           string_agg(coalesce(o.factuurnummer, 'zonder nummer') || coalesce(' van ' || to_char(o.factuurdatum, 'DD-MM-YYYY'), ''),
                      ', ' order by o.factuurdatum nulls last, o.id)
      into v_ids, v_nummers
    from public.facturen o
    where o.id <> f.id
      and o.organisatie_id = f.organisatie_id
      and o.leverancier_id = f.leverancier_id
      and (
        intern.normaliseer_factuurnummer(o.factuurnummer) = intern.normaliseer_factuurnummer(f.factuurnummer)
        or (
          f.totaal_incl is not null
          and o.totaal_incl = f.totaal_incl
          and abs(coalesce(o.factuurdatum, o.created_at::date) - coalesce(f.factuurdatum, f.created_at::date)) <= 30
        )
      );
    if v_ids is not null then
      v_nieuw := v_nieuw || jsonb_build_object(
        'type', 'mogelijk_duplicaat', 'ernst', 'waarschuwing',
        'sleutel', array_to_string(v_ids, ','),
        'details', jsonb_build_object('facturen', to_jsonb(v_ids)),
        'bericht', format('Mogelijk duplicaat: %s heeft al een factuur met hetzelfde nummer of bedrag (%s).',
                          v_lev_naam, v_nummers));
    end if;

    -- IBAN afwijkend van het bekende IBAN van de leverancier
    if f.iban is not null and v_lev_iban is not null and f.iban <> v_lev_iban then
      v_nieuw := v_nieuw || jsonb_build_object(
        'type', 'iban_afwijkend', 'ernst', 'kritiek',
        'sleutel', f.iban || '|' || v_lev_iban,
        'details', jsonb_build_object('factuur_iban', f.iban, 'bekend_iban', v_lev_iban),
        'bericht', format('Het IBAN op de factuur (%s) wijkt af van het bekende IBAN van %s (%s). '
                          'Controleer dit bij de leverancier via een bekend telefoonnummer voordat je betaalt.',
                          f.iban, v_lev_naam, v_lev_iban));
    end if;

    -- Nieuwe leverancier: dit is de eerste factuur van deze leverancier
    if not exists (
      select 1 from public.facturen o
      where o.leverancier_id = f.leverancier_id
        and o.id <> f.id
        and (o.created_at, o.id) < (f.created_at, f.id)
    ) then
      v_nieuw := v_nieuw || jsonb_build_object(
        'type', 'nieuwe_leverancier', 'ernst', 'info',
        'sleutel', f.leverancier_id::text,
        'details', '{}'::jsonb,
        'bericht', format('Eerste factuur van %s. Controleer of deze leverancier bekend en betrouwbaar is.', v_lev_naam));
    end if;
  end if;

  -- Rond bedrag: veelvoud van 100 en minimaal 1.000
  if f.totaal_incl >= 1000 and mod(f.totaal_incl, 100) = 0 then
    v_nieuw := v_nieuw || jsonb_build_object(
      'type', 'rond_bedrag', 'ernst', 'info',
      'sleutel', f.totaal_incl::text,
      'details', '{}'::jsonb,
      'bericht', 'Het totaalbedrag is een rond bedrag. Controleer of er een onderbouwing (specificatie) bij de factuur zit.');
  end if;

  -- Net onder limiet (in euro): binnen 5% onder de laagste geraakte goedkeuringslimiet van een lid dat mag goedkeuren
  select min(m.goedkeuringslimiet) into v_limiet
  from public.organisatie_leden m
  where m.organisatie_id = f.organisatie_id
    and m.rol in ('goedkeurder', 'controller', 'beheerder')
    and m.goedkeuringslimiet > 0
    and v_euro <= m.goedkeuringslimiet
    and v_euro >= m.goedkeuringslimiet * 0.95;
  if v_limiet is not null then
    v_nieuw := v_nieuw || jsonb_build_object(
      'type', 'net_onder_limiet', 'ernst', 'waarschuwing',
      'sleutel', v_limiet::text,
      'details', jsonb_build_object('limiet', v_limiet),
      'bericht', format('Het bedrag ligt net onder een goedkeuringslimiet van %s. Controleer of de factuur niet is opgeknipt.',
                        intern.euro(v_limiet)));
  end if;

  -- Validatiefouten (zelfde regels als het formulier)
  foreach v_fout in array array[
    'iban:'        || coalesce(intern.controleer_iban(f.iban), ''),
    'btw_nummer:'  || coalesce(intern.controleer_btw_nummer(f.btw_nummer), ''),
    'kvk_nummer:'  || coalesce(intern.controleer_kvk_nummer(f.kvk_nummer), ''),
    'vervaldatum:' || case when f.vervaldatum < f.factuurdatum then 'Vervaldatum ligt vóór de factuurdatum.' else '' end
  ] loop
    if split_part(v_fout, ':', 2) <> '' then
      v_nieuw := v_nieuw || jsonb_build_object(
        'type', 'validatiefout', 'ernst', 'waarschuwing',
        'sleutel', split_part(v_fout, ':', 1),
        'details', jsonb_build_object('veld', split_part(v_fout, ':', 1)),
        'bericht', substr(v_fout, strpos(v_fout, ':') + 1));
    end if;
  end loop;

  -- Totaalcontrole: som van grondslag + btw moet gelijk zijn aan het totaal (marge € 0,02)
  select sum(coalesce(grondslag, 0) + coalesce(btw_bedrag, 0)), count(*),
         count(*) filter (where grondslag is null or btw_bedrag is null)
    into v_som, v_aantal, v_leeg
  from public.btw_regels where factuur_id = f.id;
  if f.totaal_incl is not null and v_aantal > 0 and v_leeg = 0 and abs(v_som - f.totaal_incl) > 0.02 then
    v_nieuw := v_nieuw || jsonb_build_object(
      'type', 'validatiefout', 'ernst', 'waarschuwing',
      'sleutel', 'totaal_incl',
      'details', jsonb_build_object('veld', 'totaal_incl'),
      'bericht', format('Som van grondslag + BTW (€ %s) komt niet overeen met totaal incl. BTW (€ %s).',
                        replace(to_char(v_som, 'FM999999990.00'), '.', ','),
                        replace(to_char(f.totaal_incl, 'FM999999990.00'), '.', ',')));
  end if;

  -- VIES: btw-nummer ongeldig volgens de Europese Commissie
  if f.btw_nummer is not null then
    select * into v_ver from public.verificaties
    where organisatie_id = f.organisatie_id and soort = 'vies' and sleutel = f.btw_nummer;
    if v_ver.uitkomst = 'ongeldig' then
      v_nieuw := v_nieuw || jsonb_build_object(
        'type', 'btw_vies_ongeldig', 'ernst', 'waarschuwing',
        'sleutel', f.btw_nummer,
        'details', jsonb_build_object('verificatie_id', v_ver.id, 'opgevraagd_op', v_ver.opgevraagd_op, 'bron', v_ver.bron),
        'bericht', format('Het btw-nummer %s is volgens VIES (Europese Commissie) niet geldig (gecontroleerd op %s). '
                          'Vraag de leverancier om een correct btw-nummer.',
                          f.btw_nummer, to_char(v_ver.opgevraagd_op at time zone 'Europe/Amsterdam', 'DD-MM-YYYY')));
    end if;
  end if;

  -- KvK: niet gevonden, uitgeschreven, of de naam op de factuur past niet bij de KvK-gegevens
  if f.kvk_nummer is not null then
    select * into v_ver from public.verificaties
    where organisatie_id = f.organisatie_id and soort = 'kvk' and sleutel = f.kvk_nummer;
    if v_ver.uitkomst = 'niet_gevonden' then
      v_nieuw := v_nieuw || jsonb_build_object(
        'type', 'kvk_afwijking', 'ernst', 'waarschuwing',
        'sleutel', 'niet_gevonden|' || f.kvk_nummer,
        'details', jsonb_build_object('verificatie_id', v_ver.id, 'bron', v_ver.bron),
        'bericht', format('KvK-nummer %s komt niet voor in het Handelsregister.', f.kvk_nummer));
    elsif v_ver.uitkomst = 'uitgeschreven' then
      v_nieuw := v_nieuw || jsonb_build_object(
        'type', 'kvk_afwijking', 'ernst', 'waarschuwing',
        'sleutel', 'uitgeschreven|' || f.kvk_nummer,
        'details', jsonb_build_object('verificatie_id', v_ver.id, 'bron', v_ver.bron),
        'bericht', format('%s (KvK %s) staat volgens de KvK uitgeschreven%s.',
                          coalesce(v_ver.details ->> 'naam', 'Het bedrijf'), f.kvk_nummer,
                          coalesce(' sinds ' || to_char((v_ver.details ->> 'datum_einde')::date, 'DD-MM-YYYY'), '')));
    end if;
    if v_ver.uitkomst in ('gevonden', 'uitgeschreven') and f.leverancier_naam is not null then
      select array_remove(array[v_ver.details ->> 'naam', v_ver.details ->> 'statutaire_naam']
                          || coalesce(array(select jsonb_array_elements_text(v_ver.details -> 'handelsnamen')), '{}'), null)
        into v_namen;
      if not intern.naam_komt_overeen(f.leverancier_naam, v_namen) then
        v_nieuw := v_nieuw || jsonb_build_object(
          'type', 'kvk_afwijking', 'ernst', 'waarschuwing',
          'sleutel', 'naam|' || f.kvk_nummer || '|' || coalesce(intern.normaliseer_bedrijfsnaam(f.leverancier_naam), ''),
          'details', jsonb_build_object('verificatie_id', v_ver.id, 'bron', v_ver.bron, 'kvk_namen', to_jsonb(v_namen)),
          'bericht', format('De naam op de factuur (%s) komt niet overeen met de KvK-gegevens van %s (%s). '
                            'Controleer of het KvK-nummer bij deze leverancier hoort.',
                            f.leverancier_naam, f.kvk_nummer, coalesce(v_ver.details ->> 'naam', array_to_string(v_namen, ', '))));
      end if;
    end if;
  end if;

  -- Open signalen die niet meer gelden verwijderen
  delete from public.factuur_signalen s
  where s.factuur_id = f.id
    and not s.opgelost
    and not exists (
      select 1 from jsonb_to_recordset(v_nieuw) as n (type text, sleutel text)
      where n.type = s.type and n.sleutel = s.sleutel
    );

  -- Nieuwe signalen toevoegen; open signalen bijwerken als de tekst veranderd is
  insert into public.factuur_signalen as s (factuur_id, organisatie_id, type, ernst, bericht, sleutel, details)
  select f.id, f.organisatie_id, n.type, n.ernst, n.bericht, n.sleutel, n.details
  from jsonb_to_recordset(v_nieuw) as n (type text, ernst text, bericht text, sleutel text, details jsonb)
  on conflict (factuur_id, type, sleutel) do update
    set ernst = excluded.ernst, bericht = excluded.bericht, details = excluded.details
    where not s.opgelost
      and (s.ernst, s.bericht, s.details) is distinct from (excluded.ernst, excluded.bericht, excluded.details);
end;
$$;

-- ---------------------------------------------------------------------------
-- Goedkeuringslimiet in euro
-- ---------------------------------------------------------------------------

create or replace function intern.wijzig_status_als(
  p_user          uuid,
  p_factuur_id    uuid,
  p_nieuwe_status text,
  p_toelichting   text,
  p_bron          text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  f          public.facturen%rowtype;
  v_rol      text;
  v_limiet   numeric;
  v_enig     boolean;
  v_rollen   text[];
  v_reden    text := nullif(btrim(p_toelichting), '');
  v_melding  text;
  v_euro     numeric;
begin
  if p_user is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  select * into f from public.facturen where id = p_factuur_id for update;
  if f.id is not null then
    select rol, goedkeuringslimiet into v_rol, v_limiet
    from public.organisatie_leden where organisatie_id = f.organisatie_id and user_id = p_user;
  end if;
  if f.id is null or v_rol is null then
    raise exception 'Factuur niet gevonden.' using errcode = 'P0002';
  end if;

  v_enig := intern.aantal_leden(f.organisatie_id) = 1;

  -- Toegestane overgangen en de rollen die ze mogen uitvoeren
  v_rollen := case
    when f.status = 'gescand' and p_nieuwe_status = 'gecontroleerd' then array['invoerder', 'controller', 'beheerder']
    when f.status = 'gecontroleerd' and p_nieuwe_status = 'goedgekeurd' then array['goedkeurder', 'controller', 'beheerder']
    when f.status = 'goedgekeurd' and p_nieuwe_status = 'betaald' then array['controller', 'beheerder']
    when f.status in ('gescand', 'gecontroleerd') and p_nieuwe_status = 'afgekeurd' then array['goedkeurder', 'controller', 'beheerder']
    when f.status = 'afgekeurd' and p_nieuwe_status = 'gescand' then array['invoerder', 'controller', 'beheerder']
  end;
  if v_rollen is null then
    raise exception 'Van "%" naar "%" is geen toegestane statuswijziging.', f.status, p_nieuwe_status
      using errcode = '22023';
  end if;
  if not v_enig and not (v_rol = any (v_rollen)) then
    raise exception 'Je rol (%) mag deze statuswijziging niet uitvoeren.', v_rol using errcode = '42501';
  end if;

  if p_nieuwe_status = 'goedgekeurd' then
    if not v_enig and f.user_id = p_user then
      raise exception 'Functiescheiding: je kunt een factuur die je zelf hebt ingevoerd niet goedkeuren.'
        using errcode = '42501';
    end if;
    if not v_enig and f.gecontroleerd_door = p_user then
      raise exception 'Functiescheiding: je kunt een factuur die je zelf hebt gecontroleerd niet goedkeuren.'
        using errcode = '42501';
    end if;
    if v_limiet is not null then
      if f.totaal_incl is null then
        raise exception 'Het totaalbedrag ontbreekt, dus de goedkeuringslimiet kan niet worden gecontroleerd.'
          using errcode = '22023';
      end if;
      v_euro := intern.bedrag_in_euro(f);
      if v_euro is null then
        raise exception 'De wisselkoers voor % is nog niet bekend, dus de goedkeuringslimiet kan niet worden gecontroleerd. Probeer het zo opnieuw.',
          f.valuta using errcode = '22023';
      end if;
      if v_euro > v_limiet then
        raise exception 'Boven je goedkeuringslimiet van %.', intern.euro(v_limiet) using errcode = '42501';
      end if;
    end if;
    if exists (
      select 1 from public.factuur_signalen
      where factuur_id = f.id and ernst = 'kritiek' and not opgelost
    ) then
      raise exception 'Er is nog een open kritiek signaal. Los dat eerst op.' using errcode = '22023';
    end if;
    if f.grootboekrekening_id is null then
      raise exception 'Kies eerst een grootboekrekening.' using errcode = '22023';
    end if;
  end if;

  if p_nieuwe_status = 'afgekeurd' and v_reden is null then
    raise exception 'Een reden is verplicht bij afkeuren.' using errcode = '22023';
  end if;

  if v_enig and p_nieuwe_status in ('gecontroleerd', 'goedgekeurd', 'betaald') then
    v_melding := 'Functiescheiding niet mogelijk: organisatie heeft één lid';
  end if;

  -- Toelichting, gebruiker en bron voor de audit trail
  perform set_config('factuurscanner.audit_toelichting', concat_ws(' — ', v_reden, v_melding), true);
  perform set_config('factuurscanner.audit_actie', 'statuswijziging', true);
  perform intern.zet_audit_context(p_user, p_bron);

  update public.facturen
  set status             = p_nieuwe_status,
      gecontroleerd_door = case when p_nieuwe_status = 'gecontroleerd' then p_user
                                when p_nieuwe_status = 'gescand' then null else gecontroleerd_door end,
      gecontroleerd_op   = case when p_nieuwe_status = 'gecontroleerd' then now()
                                when p_nieuwe_status = 'gescand' then null else gecontroleerd_op end,
      goedgekeurd_door   = case when p_nieuwe_status = 'goedgekeurd' then p_user
                                when p_nieuwe_status = 'gescand' then null else goedgekeurd_door end,
      goedgekeurd_op     = case when p_nieuwe_status = 'goedgekeurd' then now()
                                when p_nieuwe_status = 'gescand' then null else goedgekeurd_op end,
      betaald_op         = case when p_nieuwe_status = 'betaald' then now() else betaald_op end,
      afkeur_reden       = case when p_nieuwe_status = 'afgekeurd' then v_reden
                                when p_nieuwe_status = 'gescand' then null else afkeur_reden end
  where id = f.id;

  perform set_config('factuurscanner.audit_actie', '', true);
  perform set_config('factuurscanner.audit_toelichting', '', true);
  perform intern.zet_audit_context(null, null);

  return v_melding;
end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill: verrijking inplannen voor bestaande, niet betaalde facturen
-- ---------------------------------------------------------------------------
-- (bij facturen in vreemde valuta ook de betaalde: de rapportages in fase 4.7 rekenen in euro)

do $$
declare
  f record;
begin
  for f in
    select * from public.facturen where coalesce(valuta, 'EUR') <> 'EUR' and totaal_incl is not null
  loop
    perform intern.plan_taak(f.organisatie_id, 'ecb',
      f.id::text || ':' || f.valuta || ':' || coalesce(f.factuurdatum, f.created_at::date)::text, f.id,
      jsonb_build_object('valuta', f.valuta, 'datum', coalesce(f.factuurdatum, f.created_at::date)));
  end loop;

  for f in
    select distinct on (organisatie_id, btw_nummer) organisatie_id, btw_nummer, id
    from public.facturen
    where status <> 'betaald' and btw_nummer is not null
      and intern.controleer_btw_nummer(btw_nummer) is null and intern.is_vies_land(btw_nummer)
  loop
    perform intern.plan_taak(f.organisatie_id, 'vies', f.btw_nummer, f.id, jsonb_build_object('btw_nummer', f.btw_nummer));
  end loop;

  for f in
    select distinct on (organisatie_id, kvk_nummer) organisatie_id, kvk_nummer, id, leverancier_naam
    from public.facturen
    where status <> 'betaald' and kvk_nummer is not null and intern.controleer_kvk_nummer(kvk_nummer) is null
  loop
    perform intern.plan_taak(f.organisatie_id, 'kvk', f.kvk_nummer, f.id,
      jsonb_build_object('kvk_nummer', f.kvk_nummer, 'naam', f.leverancier_naam));
  end loop;
end;
$$;
