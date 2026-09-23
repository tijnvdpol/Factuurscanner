-- Fase 3.2: statusworkflow en functiescheiding, afgedwongen in de database.
--
--   gescand → gecontroleerd → goedgekeurd → betaald
--   gescand/gecontroleerd → afgekeurd (reden verplicht) → gescand (na correctie)
--
-- De status is alleen via public.wijzig_status() te wijzigen. Een inhoudelijke wijziging van een
-- gecontroleerde of goedgekeurde factuur zet de status automatisch terug naar gescand.

-- ---------------------------------------------------------------------------
-- Kolommen en statussen
-- ---------------------------------------------------------------------------

alter table public.facturen drop constraint facturen_status_check;
alter table public.facturen add constraint facturen_status_check
  check (status in ('gescand', 'gecontroleerd', 'goedgekeurd', 'betaald', 'afgekeurd'));

alter table public.facturen
  add column gecontroleerd_door uuid references auth.users (id) on delete set null,
  add column gecontroleerd_op   timestamptz,
  add column goedgekeurd_door   uuid references auth.users (id) on delete set null,
  add column goedgekeurd_op     timestamptz,
  add column betaald_op         timestamptz,
  add column afkeur_reden       text,
  add constraint facturen_afkeur_reden_verplicht
    check (status <> 'afgekeurd' or coalesce(btrim(afkeur_reden), '') <> '');

create index facturen_organisatie_status_idx on public.facturen (organisatie_id, status);

-- Gebruikers mogen status en workflowkolommen niet rechtstreeks wijzigen (UPDATE-recht opnieuw
-- toekennen zonder status).
revoke update on public.facturen from authenticated;
grant update (
  leverancier_id, leverancier_naam, factuurnummer, factuurdatum, vervaldatum, valuta, bedrag_excl,
  totaal_incl, bestand_pad, bestandsnaam, ai_model, iban, btw_nummer, kvk_nummer,
  grootboekrekening_id, codering_bron, codering_zekerheid
) on public.facturen to authenticated;

-- Verwijderen: de beheerder altijd; anderen alleen hun eigen factuur zolang die gescand of afgekeurd is.
drop policy "Facturen van de organisatie: verwijderen" on public.facturen;
create policy "Facturen van de organisatie: verwijderen"
  on public.facturen for delete to authenticated
  using (
    public.heeft_rol(organisatie_id, array['beheerder'])
    or (public.is_lid(organisatie_id) and user_id = (select auth.uid()) and status in ('gescand', 'afgekeurd'))
  );

-- ---------------------------------------------------------------------------
-- Bewaking van facturen (trigger)
-- ---------------------------------------------------------------------------
-- "Bevoegd" = niet de rol authenticated/anon, dus: security-definerfuncties (wijzig_status e.d.),
-- de service role en de SQL Editor.

create function intern.bewaak_factuur()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_bevoegd boolean := current_user not in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    if not v_bevoegd then
      new.status := 'gescand';
      new.gecontroleerd_door := null;
      new.gecontroleerd_op := null;
      new.goedgekeurd_door := null;
      new.goedgekeurd_op := null;
      new.betaald_op := null;
      new.afkeur_reden := null;
    end if;
    return new;
  end if;

  if not v_bevoegd and (new.status, new.gecontroleerd_door, new.gecontroleerd_op, new.goedgekeurd_door,
                        new.goedgekeurd_op, new.betaald_op, new.afkeur_reden)
     is distinct from (old.status, old.gecontroleerd_door, old.gecontroleerd_op, old.goedgekeurd_door,
                       old.goedgekeurd_op, old.betaald_op, old.afkeur_reden) then
    raise exception 'De status kan alleen via de workflowknoppen worden gewijzigd.' using errcode = '42501';
  end if;

  -- Betaald = afgesloten
  if old.status = 'betaald' and not v_bevoegd
     and (new.leverancier_id, new.leverancier_naam, new.factuurnummer, new.factuurdatum, new.vervaldatum,
          new.valuta, new.bedrag_excl, new.totaal_incl, new.iban, new.btw_nummer, new.kvk_nummer,
          new.grootboekrekening_id)
     is distinct from (old.leverancier_id, old.leverancier_naam, old.factuurnummer, old.factuurdatum,
                       old.vervaldatum, old.valuta, old.bedrag_excl, old.totaal_incl, old.iban, old.btw_nummer,
                       old.kvk_nummer, old.grootboekrekening_id) then
    raise exception 'Een betaalde factuur kan niet meer worden gewijzigd.' using errcode = '42501';
  end if;

  -- Inhoudelijke wijziging (bedragen, leverancier, IBAN) → terug naar gescand
  if old.status in ('gecontroleerd', 'goedgekeurd')
     and (new.leverancier_id, new.leverancier_naam, new.valuta, new.bedrag_excl, new.totaal_incl, new.iban)
     is distinct from (old.leverancier_id, old.leverancier_naam, old.valuta, old.bedrag_excl, old.totaal_incl, old.iban) then
    new.status := 'gescand';
    new.gecontroleerd_door := null;
    new.gecontroleerd_op := null;
    new.goedgekeurd_door := null;
    new.goedgekeurd_op := null;
    perform set_config('factuurscanner.audit_toelichting',
      'Status automatisch teruggezet naar gescand na een inhoudelijke wijziging.', true);
  end if;

  return new;
end;
$$;

revoke execute on function intern.bewaak_factuur() from public;

create trigger facturen_bewaking
  before insert or update on public.facturen
  for each row execute function intern.bewaak_factuur();

-- Terug naar gescand (voor wijzigingen in btw-regels; security definer omdat gebruikers de status niet
-- mogen schrijven).
create function intern.status_terug_naar_gescand(p_factuur_id uuid, p_reden text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('factuurscanner.audit_toelichting', p_reden, true);
  update public.facturen
  set status = 'gescand',
      gecontroleerd_door = null, gecontroleerd_op = null,
      goedgekeurd_door = null, goedgekeurd_op = null
  where id = p_factuur_id
    and status in ('gecontroleerd', 'goedgekeurd')
    and (auth.uid() is null or public.is_lid(organisatie_id));
end;
$$;

revoke execute on function intern.status_terug_naar_gescand(uuid, text) from public;
grant execute on function intern.status_terug_naar_gescand(uuid, text) to authenticated;

-- btw-regels: een wijziging telt als inhoudelijke wijziging van de factuur. Invoker-functie, zodat
-- current_user nog de aanroeper is.
create function intern.bewaak_btw_regel()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_factuur uuid := case when tg_op = 'DELETE' then old.factuur_id else new.factuur_id end;
  v_status  text;
begin
  -- Cascade vanuit het verwijderen van de factuur: niets te bewaken.
  if pg_trigger_depth() > 1 then
    return null;
  end if;

  select status into v_status from public.facturen where id = v_factuur;
  if v_status = 'betaald' and current_user in ('authenticated', 'anon') then
    raise exception 'Een betaalde factuur kan niet meer worden gewijzigd.' using errcode = '42501';
  end if;
  if v_status in ('gecontroleerd', 'goedgekeurd') then
    perform intern.status_terug_naar_gescand(v_factuur,
      'Status automatisch teruggezet naar gescand na een wijziging van de btw-regels.');
  end if;
  return null;
end;
$$;

revoke execute on function intern.bewaak_btw_regel() from public;

create trigger btw_regels_bewaking
  after insert or update or delete on public.btw_regels
  for each row execute function intern.bewaak_btw_regel();

-- ---------------------------------------------------------------------------
-- wijzig_status
-- ---------------------------------------------------------------------------

create function intern.euro(p_bedrag numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  -- 5000 → "€ 5.000", 1234.5 → "€ 1.234,50"
  select '€ ' || regexp_replace(translate(to_char(p_bedrag, 'FM999,999,999,990.00'), ',.', '.,'), ',00$', '');
$$;

-- Geeft een melding terug (bijv. over functiescheiding bij één lid), of null.
create function public.wijzig_status(p_factuur_id uuid, p_nieuwe_status text, p_toelichting text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  f          public.facturen%rowtype;
  v_rol      text;
  v_limiet   numeric;
  v_enig     boolean;
  v_rollen   text[];
  v_reden    text := nullif(btrim(p_toelichting), '');
  v_melding  text;
begin
  if v_uid is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  select * into f from public.facturen where id = p_factuur_id for update;
  if not found or not public.is_lid(f.organisatie_id) then
    raise exception 'Factuur niet gevonden.' using errcode = 'P0002';
  end if;

  select rol, goedkeuringslimiet into v_rol, v_limiet
  from public.organisatie_leden where organisatie_id = f.organisatie_id and user_id = v_uid;
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
    if not v_enig and f.user_id = v_uid then
      raise exception 'Functiescheiding: je kunt een factuur die je zelf hebt ingevoerd niet goedkeuren.'
        using errcode = '42501';
    end if;
    if not v_enig and f.gecontroleerd_door = v_uid then
      raise exception 'Functiescheiding: je kunt een factuur die je zelf hebt gecontroleerd niet goedkeuren.'
        using errcode = '42501';
    end if;
    if v_limiet is not null and f.totaal_incl is null then
      raise exception 'Het totaalbedrag ontbreekt, dus de goedkeuringslimiet kan niet worden gecontroleerd.'
        using errcode = '22023';
    end if;
    if v_limiet is not null and f.totaal_incl > v_limiet then
      raise exception 'Boven je goedkeuringslimiet van %.', intern.euro(v_limiet) using errcode = '42501';
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

  -- Toelichting voor de audit trail (fase 3.3)
  perform set_config('factuurscanner.audit_toelichting',
    concat_ws(' — ', v_reden, v_melding), true);
  perform set_config('factuurscanner.audit_actie', 'statuswijziging', true);

  update public.facturen
  set status             = p_nieuwe_status,
      gecontroleerd_door = case when p_nieuwe_status = 'gecontroleerd' then v_uid
                                when p_nieuwe_status = 'gescand' then null else gecontroleerd_door end,
      gecontroleerd_op   = case when p_nieuwe_status = 'gecontroleerd' then now()
                                when p_nieuwe_status = 'gescand' then null else gecontroleerd_op end,
      goedgekeurd_door   = case when p_nieuwe_status = 'goedgekeurd' then v_uid
                                when p_nieuwe_status = 'gescand' then null else goedgekeurd_door end,
      goedgekeurd_op     = case when p_nieuwe_status = 'goedgekeurd' then now()
                                when p_nieuwe_status = 'gescand' then null else goedgekeurd_op end,
      betaald_op         = case when p_nieuwe_status = 'betaald' then now() else betaald_op end,
      afkeur_reden       = case when p_nieuwe_status = 'afgekeurd' then v_reden
                                when p_nieuwe_status = 'gescand' then null else afkeur_reden end
  where id = f.id;

  perform set_config('factuurscanner.audit_actie', '', true);
  perform set_config('factuurscanner.audit_toelichting', '', true);

  return v_melding;
end;
$$;

revoke execute on function public.wijzig_status(uuid, text, text) from public, anon;
grant execute on function public.wijzig_status(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Signaal "net onder limiet" (fase 2.2): binnen 5% onder een goedkeuringslimiet
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
begin
  select * into f from public.facturen where id = p_factuur_id;
  if not found then
    return;
  end if;
  -- Zonder ingelogde gebruiker (migratie, service role) geen toegangscontrole.
  if v_uid is not null and not public.is_lid(f.organisatie_id) then
    raise exception 'Geen toegang tot deze factuur.' using errcode = '42501';
  end if;

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

  -- Net onder limiet: binnen 5% onder de laagste geraakte goedkeuringslimiet van een lid dat mag goedkeuren
  select min(m.goedkeuringslimiet) into v_limiet
  from public.organisatie_leden m
  where m.organisatie_id = f.organisatie_id
    and m.rol in ('goedkeurder', 'controller', 'beheerder')
    and m.goedkeuringslimiet > 0
    and f.totaal_incl <= m.goedkeuringslimiet
    and f.totaal_incl >= m.goedkeuringslimiet * 0.95;
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
-- sla_factuur_op zonder status (status alleen via wijzig_status)
-- ---------------------------------------------------------------------------

create or replace function public.sla_factuur_op(p_factuur jsonb, p_leverancier_bijwerken boolean default false)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid            uuid := auth.uid();
  v_id             uuid := coalesce(nullif(p_factuur ->> 'id', '')::uuid, gen_random_uuid());
  v_org            uuid := nullif(p_factuur ->> 'organisatie_id', '')::uuid;
  v_naam           text := nullif(btrim(p_factuur ->> 'leverancier'), '');
  v_btw_nummer     text := upper(nullif(regexp_replace(p_factuur ->> 'btw_nummer', '[\s.]', '', 'g'), ''));
  v_kvk_nummer     text := nullif(regexp_replace(p_factuur ->> 'kvk_nummer', '\s', '', 'g'), '');
  v_iban           text := upper(nullif(regexp_replace(p_factuur ->> 'iban', '\s', '', 'g'), ''));
  v_valuta         text := upper(nullif(btrim(p_factuur ->> 'valuta'), ''));
  v_pad            text := nullif(p_factuur ->> 'bestand_pad', '');
  v_rekening       uuid := nullif(p_factuur ->> 'grootboekrekening_id', '')::uuid;
  v_bron           text := case when v_rekening is null then null
                                else coalesce(nullif(p_factuur ->> 'codering_bron', ''), 'handmatig') end;
  v_zekerheid      numeric := case when v_bron in ('historie', 'ai')
                                   then (p_factuur ->> 'codering_zekerheid')::numeric end;
  v_leverancier_id uuid;
  v_resultaat      uuid;
  v_regels         jsonb;
begin
  if v_uid is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if v_org is null then
    select case when count(*) = 1 then min(organisatie_id::text)::uuid end into v_org
    from public.organisatie_leden where user_id = v_uid;
    if v_org is null then
      raise exception 'Kies een organisatie.' using errcode = '22023';
    end if;
  end if;
  if not public.is_lid(v_org) then
    raise exception 'Je bent geen lid van deze organisatie.' using errcode = '42501';
  end if;

  if v_pad is not null
     and v_pad not like v_org::text || '/' || v_id::text || '/%'
     and v_pad not like v_uid::text || '/' || v_id::text || '/%' then
    raise exception 'Ongeldig bestandspad.' using errcode = '22023';
  end if;

  if v_naam is not null then
    insert into public.leveranciers as l (organisatie_id, user_id, naam, btw_nummer, kvk_nummer, iban)
    values (v_org, v_uid, v_naam, v_btw_nummer, v_kvk_nummer, v_iban)
    on conflict (organisatie_id, lower(naam)) do update set
      btw_nummer = case when p_leverancier_bijwerken
                        then coalesce(excluded.btw_nummer, l.btw_nummer)
                        else coalesce(l.btw_nummer, excluded.btw_nummer) end,
      kvk_nummer = case when p_leverancier_bijwerken
                        then coalesce(excluded.kvk_nummer, l.kvk_nummer)
                        else coalesce(l.kvk_nummer, excluded.kvk_nummer) end
    returning l.id into v_leverancier_id;

    perform intern.vul_leveranciers_iban(v_leverancier_id, v_iban);
  end if;

  insert into public.facturen as f (
    id, organisatie_id, user_id, leverancier_id, leverancier_naam, factuurnummer, factuurdatum, vervaldatum,
    valuta, bedrag_excl, totaal_incl, bestand_pad, bestandsnaam, ai_model,
    iban, btw_nummer, kvk_nummer, grootboekrekening_id, codering_bron, codering_zekerheid
  )
  values (
    v_id,
    v_org,
    v_uid,
    v_leverancier_id,
    v_naam,
    nullif(btrim(p_factuur ->> 'factuurnummer'), ''),
    nullif(p_factuur ->> 'factuurdatum', '')::date,
    nullif(p_factuur ->> 'vervaldatum', '')::date,
    v_valuta,
    (p_factuur ->> 'bedrag_excl')::numeric,
    (p_factuur ->> 'totaal_incl')::numeric,
    v_pad,
    nullif(p_factuur ->> 'bestandsnaam', ''),
    nullif(p_factuur ->> 'ai_model', ''),
    v_iban,
    v_btw_nummer,
    v_kvk_nummer,
    v_rekening,
    v_bron,
    v_zekerheid
  )
  on conflict (id) do update set
    leverancier_id       = excluded.leverancier_id,
    leverancier_naam     = excluded.leverancier_naam,
    factuurnummer        = excluded.factuurnummer,
    factuurdatum         = excluded.factuurdatum,
    vervaldatum          = excluded.vervaldatum,
    valuta               = excluded.valuta,
    bedrag_excl          = excluded.bedrag_excl,
    totaal_incl          = excluded.totaal_incl,
    bestand_pad          = coalesce(excluded.bestand_pad, f.bestand_pad),
    bestandsnaam         = coalesce(excluded.bestandsnaam, f.bestandsnaam),
    ai_model             = coalesce(excluded.ai_model, f.ai_model),
    iban                 = excluded.iban,
    btw_nummer           = excluded.btw_nummer,
    kvk_nummer           = excluded.kvk_nummer,
    grootboekrekening_id = excluded.grootboekrekening_id,
    codering_bron        = excluded.codering_bron,
    codering_zekerheid   = excluded.codering_zekerheid
  where f.organisatie_id = v_org
  returning f.id into v_resultaat;

  if v_resultaat is null then
    raise exception 'Factuur niet gevonden.' using errcode = 'P0002';
  end if;

  -- btw-regels alleen vervangen als ze veranderd zijn (scheelt ruis in de historie)
  select coalesce(jsonb_agg(jsonb_build_array(
           (r.regel ->> 'tarief')::numeric(5, 2),
           (r.regel ->> 'grondslag')::numeric(12, 2),
           (r.regel ->> 'btw_bedrag')::numeric(12, 2)) order by r.nr), '[]'::jsonb)
    into v_regels
  from jsonb_array_elements(coalesce(p_factuur -> 'btw_regels', '[]'::jsonb)) with ordinality as r (regel, nr);

  if v_regels is distinct from (
    select coalesce(jsonb_agg(jsonb_build_array(b.tarief, b.grondslag, b.btw_bedrag) order by b.volgorde), '[]'::jsonb)
    from public.btw_regels b where b.factuur_id = v_id
  ) then
    delete from public.btw_regels where factuur_id = v_id;

    insert into public.btw_regels (factuur_id, volgorde, tarief, grondslag, btw_bedrag)
    select v_id, (r.nr - 1)::smallint, (r.regel ->> 0)::numeric, (r.regel ->> 1)::numeric, (r.regel ->> 2)::numeric
    from jsonb_array_elements(v_regels) with ordinality as r (regel, nr);
  end if;

  perform intern.bepaal_signalen(v_id);

  return v_id;
end;
$$;
