-- Fase 4.6: betaalopdrachten (SEPA pain.001.001.03) en een mock-bank.
--
-- - Nieuwe status "in_betaalbatch": goedgekeurd → in_betaalbatch → betaald. Alleen de functies hieronder zetten die
--   status (security definer); in de app blijft de knop goedgekeurd → betaald voor handmatige betalingen.
-- - betaalbatches + betaalbatch_posten: een selectie goedgekeurde, onbetaalde facturen. maak_betaalbatch controleert
--   per factuur de status, euro, het bedrag, het IBAN (zelfde controle als overal: intern.controleer_iban), of het IBAN
--   in het SEPA-gebied ligt, de naam en open kritieke signalen (bijv. afwijkend IBAN). Een factuur kan maar in één
--   actieve batch zitten (status + unieke index).
-- - Live: het SEPA-bestand downloaden (gemaakt in de app, _shared/koppelingen/sepa.ts), uploaden bij de bank, en de
--   batch als uitgevoerd bevestigen. Mock: een betaling-taak dient de batch in bij een gesimuleerde bank en verwerkt de
--   bevestiging (per betaling betaald of geweigerd), zoals een echte bank-API dat later kan doen.
-- - Een factuur in een betaalbatch is inhoudelijk vergrendeld en niet te verwijderen (afspraak); annuleren van de batch
--   zet de facturen terug op goedgekeurd.

-- ---------------------------------------------------------------------------
-- Status
-- ---------------------------------------------------------------------------

alter table public.facturen drop constraint facturen_status_check;
alter table public.facturen add constraint facturen_status_check
  check (status in ('gescand', 'gecontroleerd', 'goedgekeurd', 'in_betaalbatch', 'betaald', 'afgekeurd'));

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------

create table public.betaalbatches (
  id              uuid primary key default gen_random_uuid(),
  organisatie_id  uuid not null references public.organisaties (id) on delete cascade,
  -- FS<JJJJMMDD>-<nr>: ook MsgId in het SEPA-bestand
  nummer          text not null,
  -- aangemaakt → ingediend (bij de bank) → verwerkt | geannuleerd
  status          text not null default 'aangemaakt' check (status in ('aangemaakt', 'ingediend', 'verwerkt', 'geannuleerd')),
  uitvoerdatum    date not null,
  debiteur_naam   text not null,
  debiteur_iban   text not null,
  debiteur_bic    text,
  aantal          int not null default 0,
  totaal          numeric(14, 2) not null default 0,
  -- live = bestand zelf bij de bank aangeboden; mock = gesimuleerde bank (gezet bij indienen)
  modus           text check (modus in ('live', 'mock')),
  bank_referentie text,
  aangemaakt_door uuid references auth.users (id) on delete set null,
  aangemaakt_op   timestamptz not null default now(),
  ingediend_op    timestamptz,
  verwerkt_op     timestamptz,
  geannuleerd_op  timestamptz,
  toelichting     text,
  unique (organisatie_id, nummer)
);

create index betaalbatches_organisatie_idx on public.betaalbatches (organisatie_id, aangemaakt_op desc);

create table public.betaalbatch_posten (
  id             uuid primary key default gen_random_uuid(),
  batch_id       uuid not null references public.betaalbatches (id) on delete cascade,
  organisatie_id uuid not null references public.organisaties (id) on delete cascade,
  -- set null: de betaalhistorie blijft staan als een (betaalde) factuur later wordt verwijderd
  factuur_id     uuid references public.facturen (id) on delete set null,
  volgnummer     int not null,
  end_to_end_id  text not null,
  bedrag         numeric(12, 2) not null check (bedrag > 0),
  naam           text not null,
  iban           text not null,
  omschrijving   text not null,
  -- open → betaald | geweigerd (door de bank) | geannuleerd (batch geannuleerd)
  status         text not null default 'open' check (status in ('open', 'betaald', 'geweigerd', 'geannuleerd')),
  reden          text,
  verwerkt_op    timestamptz,
  unique (batch_id, end_to_end_id),
  unique (batch_id, volgnummer)
);

-- Een factuur zit hooguit in één actieve (of betaalde) batch.
create unique index betaalbatch_posten_factuur_actief
  on public.betaalbatch_posten (factuur_id) where status in ('open', 'betaald');
create index betaalbatch_posten_batch_idx on public.betaalbatch_posten (batch_id, volgnummer);

alter table public.betaalbatches enable row level security;
alter table public.betaalbatch_posten enable row level security;

create policy "Leden lezen de betaalbatches" on public.betaalbatches for select to authenticated
  using (public.is_lid(organisatie_id));
create policy "Leden lezen de betaalposten" on public.betaalbatch_posten for select to authenticated
  using (public.is_lid(organisatie_id));

revoke all on public.betaalbatches, public.betaalbatch_posten from anon, authenticated;
grant select on public.betaalbatches, public.betaalbatch_posten to authenticated;

-- ---------------------------------------------------------------------------
-- Vergrendeling: na export (fase 4.5) én in een betaalbatch
-- ---------------------------------------------------------------------------

create or replace function intern.bewaak_export()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_bevoegd boolean := current_user not in ('authenticated', 'anon', 'service_role');
  v_melding text;
begin
  if tg_op = 'INSERT' then
    if not v_bevoegd then
      new.geexporteerd_op := null;
    end if;
    return new;
  end if;

  v_melding := case
    when old.status = 'in_betaalbatch' then 'Deze factuur zit in een betaalbatch en kan niet worden gewijzigd of verwijderd. Annuleer eerst de batch.'
    when old.geexporteerd_op is not null then 'Deze factuur is geëxporteerd naar het boekhoudpakket en kan niet meer worden gewijzigd. Corrigeer hem daar.'
  end;

  if tg_op = 'DELETE' then
    if v_melding is not null and not v_bevoegd
       and exists (select 1 from public.organisaties where id = old.organisatie_id) then
      raise exception '%', case when old.status = 'in_betaalbatch' then v_melding
                                else 'Deze factuur is geëxporteerd naar het boekhoudpakket en kan niet worden verwijderd.' end
        using errcode = '42501';
    end if;
    return old;
  end if;

  if not v_bevoegd then
    new.geexporteerd_op := old.geexporteerd_op;
  end if;
  if v_melding is not null and not v_bevoegd
     and (new.leverancier_id, new.leverancier_naam, new.factuurnummer, new.factuurdatum, new.vervaldatum,
          new.valuta, new.bedrag_excl, new.totaal_incl, new.iban, new.btw_nummer, new.kvk_nummer,
          new.grootboekrekening_id)
     is distinct from (old.leverancier_id, old.leverancier_naam, old.factuurnummer, old.factuurdatum,
                       old.vervaldatum, old.valuta, old.bedrag_excl, old.totaal_incl, old.iban, old.btw_nummer,
                       old.kvk_nummer, old.grootboekrekening_id) then
    raise exception '%', v_melding using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function intern.bewaak_btw_export()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_factuur uuid := case when tg_op = 'DELETE' then old.factuur_id else new.factuur_id end;
  f         public.facturen%rowtype;
begin
  if current_user in ('authenticated', 'anon', 'service_role') then
    select * into f from public.facturen where id = v_factuur;
    if f.status = 'in_betaalbatch' then
      raise exception 'Deze factuur zit in een betaalbatch en kan niet worden gewijzigd of verwijderd. Annuleer eerst de batch.'
        using errcode = '42501';
    end if;
    if f.geexporteerd_op is not null then
      raise exception 'Deze factuur is geëxporteerd naar het boekhoudpakket en kan niet meer worden gewijzigd. Corrigeer hem daar.'
        using errcode = '42501';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Hulpfuncties
-- ---------------------------------------------------------------------------

-- Landen in het SEPA-gebied (EU/EER plus o.a. Zwitserland, VK, Monaco, San Marino, Andorra, Vaticaanstad en de
-- Kanaaleilanden/Man).
create function intern.is_sepa_land(p_iban text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select upper(left(coalesce(p_iban, ''), 2)) = any (array[
    'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV',
    'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'IS', 'LI', 'NO', 'CH', 'GB', 'MC', 'SM', 'AD', 'VA', 'GI', 'JE',
    'GG', 'IM']);
$$;

-- Waarom een factuur (nu) niet in een betaalbatch kan, of null. Zelfde regels in de app (betalingen.ts).
create function intern.betaal_blokkade(p_factuur_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  f public.facturen%rowtype;
begin
  select * into f from public.facturen where id = p_factuur_id;
  if not found then
    return 'factuur niet gevonden';
  end if;
  return case
    when f.status = 'in_betaalbatch' then 'zit al in een betaalbatch'
    when f.status <> 'goedgekeurd' then format('status is "%s" (alleen goedgekeurde facturen)', f.status)
    when coalesce(f.valuta, 'EUR') <> 'EUR' then format('SEPA-overboekingen kunnen alleen in euro (valuta %s)', f.valuta)
    when f.totaal_incl is null or f.totaal_incl <= 0 then 'het bedrag ontbreekt of is niet positief'
    when f.totaal_incl > 999999999.99 then 'het bedrag is te hoog'
    when f.iban is null then 'het IBAN ontbreekt'
    when intern.controleer_iban(f.iban) is not null then intern.controleer_iban(f.iban)
    when not intern.is_sepa_land(f.iban) then format('het IBAN (%s) ligt buiten het SEPA-gebied', left(f.iban, 2))
    when coalesce(btrim(f.leverancier_naam), '') = '' then 'de naam van de leverancier ontbreekt'
    when exists (select 1 from public.factuur_signalen s where s.factuur_id = f.id and s.ernst = 'kritiek' and not s.opgelost)
      then 'er is een open kritiek signaal (bijv. een afwijkend IBAN)'
  end;
end;
$$;

-- Status zetten namens een betaalactie, met statuswijziging in de audit log (bron betaling).
create function intern.zet_betaalstatus(p_factuur_id uuid, p_status text, p_user uuid, p_toelichting text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('factuurscanner.audit_toelichting', coalesce(p_toelichting, ''), true);
  perform set_config('factuurscanner.audit_actie', 'statuswijziging', true);
  perform intern.zet_audit_context(p_user, 'betaling');
  update public.facturen
  set status = p_status,
      betaald_op = case when p_status = 'betaald' then now() else betaald_op end
  where id = p_factuur_id;
  perform set_config('factuurscanner.audit_actie', '', true);
  perform set_config('factuurscanner.audit_toelichting', '', true);
  perform intern.zet_audit_context(null, null);
end;
$$;

create function intern.log_batch(p_batch public.betaalbatches, p_omschrijving text, p_user uuid, p_toelichting text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  select intern.log_gebeurtenis(p_batch.organisatie_id, 'betaling', 'betaling', 'betaalbatches', p_batch.id,
    jsonb_build_object('omschrijving', p_omschrijving, 'nummer', p_batch.nummer, 'aantal', p_batch.aantal, 'totaal', p_batch.totaal),
    p_toelichting, p_user);
$$;

revoke execute on function intern.is_sepa_land(text), intern.betaal_blokkade(uuid),
  intern.zet_betaalstatus(uuid, text, uuid, text), intern.log_batch(public.betaalbatches, text, uuid, text) from public;
grant execute on function intern.is_sepa_land(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Batch maken (controller/beheerder)
-- ---------------------------------------------------------------------------
-- De betalende rekening staat in de config van de koppeling betaling: { naam, iban, bic (optioneel) }.

create function public.maak_betaalbatch(p_organisatie_id uuid, p_factuur_ids uuid[], p_uitvoerdatum date default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vandaag date := (now() at time zone 'Europe/Amsterdam')::date;
  v_datum   date := coalesce(p_uitvoerdatum, (now() at time zone 'Europe/Amsterdam')::date);
  v_config  jsonb;
  v_naam    text;
  v_iban    text;
  v_bic     text;
  v_ids     uuid[];
  v_fouten  text[] := '{}';
  v_blok    text;
  f         public.facturen%rowtype;
  b         public.betaalbatches%rowtype;
  v_nummer  text;
begin
  if not public.heeft_rol(p_organisatie_id, array['controller', 'beheerder']) then
    raise exception 'Alleen een controller of beheerder kan betaalbatches maken.' using errcode = '42501';
  end if;
  select array_agg(distinct x) into v_ids from unnest(p_factuur_ids) as x where x is not null;
  if v_ids is null then
    raise exception 'Kies ten minste één factuur.' using errcode = '22023';
  end if;

  select config into v_config from public.koppeling_instellingen where organisatie_id = p_organisatie_id and koppeling = 'betaling';
  v_naam := nullif(btrim(v_config ->> 'naam'), '');
  v_iban := nullif(upper(regexp_replace(coalesce(v_config ->> 'iban', ''), '\s', '', 'g')), '');
  v_bic := nullif(upper(btrim(v_config ->> 'bic')), '');
  if v_naam is null or v_iban is null or intern.controleer_iban(v_iban) is not null then
    raise exception 'Stel eerst de betalende rekening in (naam en een geldig IBAN) op de pagina Betalingen.' using errcode = '22023';
  end if;
  if v_bic is not null and v_bic !~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$' then
    raise exception 'De BIC van de betalende rekening is ongeldig.' using errcode = '22023';
  end if;
  if v_datum < v_vandaag or v_datum > v_vandaag + 365 then
    raise exception 'De uitvoerdatum moet tussen vandaag en over een jaar liggen.' using errcode = '22023';
  end if;

  -- Eén batch tegelijk per organisatie (nummering) en de facturen vastzetten tegen gelijktijdige wijzigingen.
  perform pg_advisory_xact_lock(hashtext('betaalbatch:' || p_organisatie_id::text));
  perform 1 from public.facturen where id = any (v_ids) for update;

  if (select count(*) from public.facturen where id = any (v_ids) and organisatie_id = p_organisatie_id) <> cardinality(v_ids) then
    v_fouten := v_fouten || 'niet alle facturen zijn gevonden';
  end if;
  for f in select * from public.facturen where id = any (v_ids) and organisatie_id = p_organisatie_id order by vervaldatum nulls last, id loop
    v_blok := intern.betaal_blokkade(f.id);
    if v_blok is not null then
      v_fouten := v_fouten || format('%s %s: %s', coalesce(f.leverancier_naam, 'Onbekende leverancier'),
                                     coalesce(f.factuurnummer, 'zonder nummer'), v_blok);
    end if;
  end loop;
  if cardinality(v_fouten) > 0 then
    raise exception 'Betaalbatch niet gemaakt: %.', array_to_string(v_fouten, '; ') using errcode = '22023';
  end if;

  v_nummer := 'FS' || to_char(v_vandaag, 'YYYYMMDD') || '-' || lpad((
    select count(*) + 1 from public.betaalbatches
    where organisatie_id = p_organisatie_id and nummer like 'FS' || to_char(v_vandaag, 'YYYYMMDD') || '-%')::text, 3, '0');

  insert into public.betaalbatches (organisatie_id, nummer, uitvoerdatum, debiteur_naam, debiteur_iban, debiteur_bic, aangemaakt_door)
  values (p_organisatie_id, v_nummer, v_datum, v_naam, v_iban, v_bic, auth.uid())
  returning * into b;

  insert into public.betaalbatch_posten (batch_id, organisatie_id, factuur_id, volgnummer, end_to_end_id, bedrag, naam, iban, omschrijving)
  select b.id, p_organisatie_id, x.id, x.nr, v_nummer || '-' || lpad(x.nr::text, 3, '0'), x.totaal_incl,
         btrim(x.leverancier_naam), upper(regexp_replace(x.iban, '\s', '', 'g')),
         'Factuur ' || coalesce(x.factuurnummer, 'zonder nummer')
  from (
    select f2.*, row_number() over (order by f2.vervaldatum nulls last, f2.id)::int as nr
    from public.facturen f2 where f2.id = any (v_ids)
  ) x;

  update public.betaalbatches
  set aantal = (select count(*) from public.betaalbatch_posten where batch_id = b.id),
      totaal = (select sum(bedrag) from public.betaalbatch_posten where batch_id = b.id)
  where id = b.id
  returning * into b;

  for f in select * from public.facturen where id = any (v_ids) loop
    perform intern.zet_betaalstatus(f.id, 'in_betaalbatch', auth.uid(), 'Opgenomen in betaalbatch ' || v_nummer);
  end loop;

  perform intern.log_batch(b, format('Betaalbatch %s gemaakt: %s factu%s, %s, uitvoerdatum %s', v_nummer, b.aantal,
    case when b.aantal = 1 then 'ur' else 'ren' end, intern.euro(b.totaal), to_char(v_datum, 'DD-MM-YYYY')), auth.uid());

  -- Mock: de worker dient de batch in bij de gesimuleerde bank. Live: de worker doet niets (bestand downloaden).
  perform intern.plan_taak(p_organisatie_id, 'betaling', b.id::text || ':indienen', null,
                           jsonb_build_object('batch_id', b.id, 'stap', 'indienen'));
  return b.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Handmatige stappen (controller/beheerder): gedownload, ingediend, uitgevoerd, geannuleerd
-- ---------------------------------------------------------------------------

create function intern.batch_voor_actie(p_batch_id uuid, p_statussen text[])
returns public.betaalbatches
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.betaalbatches%rowtype;
begin
  select * into b from public.betaalbatches where id = p_batch_id for update;
  if not found or not public.is_lid(b.organisatie_id) then
    raise exception 'Betaalbatch niet gevonden.' using errcode = 'P0002';
  end if;
  if not public.heeft_rol(b.organisatie_id, array['controller', 'beheerder']) then
    raise exception 'Alleen een controller of beheerder kan betaalbatches beheren.' using errcode = '42501';
  end if;
  if not (b.status = any (p_statussen)) then
    raise exception 'Dit kan niet meer: de batch heeft status "%".', b.status using errcode = '22023';
  end if;
  return b;
end;
$$;

revoke execute on function intern.batch_voor_actie(uuid, text[]) from public;

-- Het SEPA-bestand is gedownload (alleen vastleggen; het bestand maakt de app).
create function public.log_betaalbestand_download(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.betaalbatches%rowtype;
begin
  b := intern.batch_voor_actie(p_batch_id, array['aangemaakt', 'ingediend', 'verwerkt', 'geannuleerd']);
  perform intern.log_batch(b, format('SEPA-bestand van betaalbatch %s gedownload', b.nummer), auth.uid());
end;
$$;

-- Live: het bestand is bij de bank aangeboden.
create function public.markeer_batch_ingediend(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.betaalbatches%rowtype;
begin
  b := intern.batch_voor_actie(p_batch_id, array['aangemaakt']);
  update public.betaalbatches set status = 'ingediend', ingediend_op = now(), modus = coalesce(modus, 'live')
  where id = b.id returning * into b;
  perform intern.log_batch(b, format('Betaalbatch %s bij de bank aangeboden', b.nummer), auth.uid());
end;
$$;

-- De bank heeft de batch uitgevoerd: alle openstaande betalingen → betaald.
create function public.bevestig_betaalbatch(p_batch_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  b   public.betaalbatches%rowtype;
  p   public.betaalbatch_posten%rowtype;
  v_n int := 0;
begin
  b := intern.batch_voor_actie(p_batch_id, array['aangemaakt', 'ingediend']);
  for p in select * from public.betaalbatch_posten where batch_id = b.id and status = 'open' loop
    update public.betaalbatch_posten set status = 'betaald', verwerkt_op = now() where id = p.id;
    if p.factuur_id is not null then
      perform intern.zet_betaalstatus(p.factuur_id, 'betaald', auth.uid(), format('Betaald via betaalbatch %s (bevestigd)', b.nummer));
    end if;
    v_n := v_n + 1;
  end loop;
  update public.betaalbatches set status = 'verwerkt', verwerkt_op = now(), modus = coalesce(modus, 'live')
  where id = b.id returning * into b;
  perform intern.log_batch(b, format('Betaalbatch %s als uitgevoerd bevestigd: %s betaald', b.nummer, v_n), auth.uid());
  return v_n;
end;
$$;

create function public.annuleer_betaalbatch(p_batch_id uuid, p_reden text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  b   public.betaalbatches%rowtype;
  p   public.betaalbatch_posten%rowtype;
  v_n int := 0;
begin
  if coalesce(btrim(p_reden), '') = '' then
    raise exception 'Een reden is verplicht bij annuleren.' using errcode = '22023';
  end if;
  b := intern.batch_voor_actie(p_batch_id, array['aangemaakt', 'ingediend']);
  for p in select * from public.betaalbatch_posten where batch_id = b.id and status = 'open' loop
    update public.betaalbatch_posten set status = 'geannuleerd', reden = btrim(p_reden), verwerkt_op = now() where id = p.id;
    if p.factuur_id is not null then
      perform intern.zet_betaalstatus(p.factuur_id, 'goedgekeurd', auth.uid(),
        format('Betaalbatch %s geannuleerd: %s', b.nummer, btrim(p_reden)));
    end if;
    v_n := v_n + 1;
  end loop;
  update public.betaalbatches set status = 'geannuleerd', geannuleerd_op = now(), toelichting = btrim(p_reden)
  where id = b.id returning * into b;
  perform intern.log_batch(b, format('Betaalbatch %s geannuleerd (%s factu%s terug naar goedgekeurd)', b.nummer, v_n,
    case when v_n = 1 then 'ur' else 'ren' end), auth.uid(), btrim(p_reden));
  return v_n;
end;
$$;

revoke execute on function public.maak_betaalbatch(uuid, uuid[], date), public.log_betaalbestand_download(uuid),
  public.markeer_batch_ingediend(uuid), public.bevestig_betaalbatch(uuid), public.annuleer_betaalbatch(uuid, text)
from public, anon;
grant execute on function public.maak_betaalbatch(uuid, uuid[], date), public.log_betaalbestand_download(uuid),
  public.markeer_batch_ingediend(uuid), public.bevestig_betaalbatch(uuid), public.annuleer_betaalbatch(uuid, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- Bank-API (service role: de worker met de mock-bank; later een echte bank)
-- ---------------------------------------------------------------------------

create function public.betaalbatch_gegevens(p_batch_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(b) || jsonb_build_object('posten', coalesce((
    select jsonb_agg(to_jsonb(p) order by p.volgnummer) from public.betaalbatch_posten p where p.batch_id = b.id), '[]'::jsonb))
  from public.betaalbatches b
  where b.id = p_batch_id;
$$;

-- De bank heeft de batch ontvangen; plant de statuscontrole (na een minuut).
create function public.registreer_batch_ingediend(p_batch_id uuid, p_referentie text, p_modus text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.betaalbatches%rowtype;
begin
  select * into b from public.betaalbatches where id = p_batch_id for update;
  if not found then
    raise exception 'Betaalbatch niet gevonden.' using errcode = 'P0002';
  end if;
  if b.status <> 'aangemaakt' then
    return;
  end if;
  update public.betaalbatches set status = 'ingediend', ingediend_op = now(), bank_referentie = p_referentie, modus = p_modus
  where id = b.id returning * into b;
  perform intern.log_batch(b, format('Betaalbatch %s ingediend bij de bank%s (referentie %s)', b.nummer,
    case when p_modus = 'mock' then ' (mock)' else '' end, p_referentie), null);
  perform intern.plan_taak(b.organisatie_id, 'betaling', b.id::text || ':status', null,
                           jsonb_build_object('batch_id', b.id, 'stap', 'status'), interval '1 minute');
end;
$$;

-- Bevestiging van de bank per betaling: [{ end_to_end_id, status: betaald|geweigerd, reden }].
-- Betaald → factuur betaald; geweigerd → factuur terug naar goedgekeurd (opnieuw in een batch te zetten).
-- Zijn alle betalingen verwerkt, dan is de batch verwerkt. Een geannuleerde of verwerkte batch: niets.
create function public.verwerk_bankbevestiging(p_batch_id uuid, p_posten jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b          public.betaalbatches%rowtype;
  p          public.betaalbatch_posten%rowtype;
  x          record;
  v_betaald  int := 0;
  v_geweigerd int := 0;
begin
  select * into b from public.betaalbatches where id = p_batch_id for update;
  if not found then
    raise exception 'Betaalbatch niet gevonden.' using errcode = 'P0002';
  end if;
  if b.status not in ('aangemaakt', 'ingediend') then
    return jsonb_build_object('betaald', 0, 'geweigerd', 0, 'batch_status', b.status);
  end if;

  for x in select * from jsonb_to_recordset(coalesce(p_posten, '[]'::jsonb)) as r (end_to_end_id text, status text, reden text) loop
    select * into p from public.betaalbatch_posten where batch_id = b.id and end_to_end_id = x.end_to_end_id for update;
    if not found or p.status <> 'open' or x.status not in ('betaald', 'geweigerd') then
      continue;
    end if;
    update public.betaalbatch_posten set status = x.status, reden = nullif(btrim(x.reden), ''), verwerkt_op = now() where id = p.id;
    if p.factuur_id is not null then
      if x.status = 'betaald' then
        perform intern.zet_betaalstatus(p.factuur_id, 'betaald', null,
          format('Betaald volgens de bank (batch %s%s)', b.nummer, case when b.modus = 'mock' then ', mock' else '' end));
        v_betaald := v_betaald + 1;
      else
        perform intern.zet_betaalstatus(p.factuur_id, 'goedgekeurd', null,
          format('Betaling geweigerd door de bank (batch %s): %s', b.nummer, coalesce(nullif(btrim(x.reden), ''), 'geen reden')));
        v_geweigerd := v_geweigerd + 1;
      end if;
    end if;
  end loop;

  if not exists (select 1 from public.betaalbatch_posten where batch_id = b.id and status = 'open') then
    update public.betaalbatches set status = 'verwerkt', verwerkt_op = now() where id = b.id returning * into b;
  end if;
  perform intern.log_batch(b, format('Bevestiging van de bank voor batch %s: %s betaald, %s geweigerd', b.nummer, v_betaald, v_geweigerd), null);
  return jsonb_build_object('betaald', v_betaald, 'geweigerd', v_geweigerd, 'batch_status', b.status);
end;
$$;

revoke execute on function public.betaalbatch_gegevens(uuid), public.registreer_batch_ingediend(uuid, text, text),
  public.verwerk_bankbevestiging(uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.betaalbatch_gegevens(uuid), public.registreer_batch_ingediend(uuid, text, text),
  public.verwerk_bankbevestiging(uuid, jsonb)
to service_role;
