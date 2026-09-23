-- Fase 2.2: signalen (mogelijke duplicaten en fraude-indicatoren).
--
-- - facturen krijgt eigen kolommen iban/btw_nummer/kvk_nummer: de waarden zoals ze op DEZE factuur
--   staan. De leverancier houdt het "bekende" IBAN; dat wordt nooit meer automatisch overschreven.
-- - factuur_signalen: per factuur de gevonden signalen. Alleen te schrijven via functies
--   (intern.bepaal_signalen bij opslaan, public.los_signaal_op), zodat niemand een kritiek signaal
--   ongemerkt kan verwijderen of zonder toelichting kan oplossen.

-- ---------------------------------------------------------------------------
-- Schema voor interne hulpfuncties (niet bereikbaar via de API)
-- ---------------------------------------------------------------------------

create schema if not exists intern;
revoke all on schema intern from public;
grant usage on schema intern to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Leveranciersgegevens zoals op de factuur zelf
-- ---------------------------------------------------------------------------

alter table public.facturen
  add column iban       text,
  add column btw_nummer text,
  add column kvk_nummer text;

-- Backfill: tot nu toe werden deze velden alleen bij de leverancier bewaard.
update public.facturen f
set iban = l.iban, btw_nummer = l.btw_nummer, kvk_nummer = l.kvk_nummer
from public.leveranciers l
where l.id = f.leverancier_id;

-- ---------------------------------------------------------------------------
-- Validatie (zelfde regels en meldingen als src/lib/veldvalidatie.ts)
-- ---------------------------------------------------------------------------

create function intern.controleer_iban(p_iban text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_iban      text := upper(regexp_replace(coalesce(p_iban, ''), '\s', '', 'g'));
  v_lengtes   constant jsonb := '{
    "AD":24,"AE":23,"AL":28,"AT":20,"AZ":28,"BA":20,"BE":16,"BG":22,"BH":22,"BI":27,"BR":29,"BY":28,
    "CH":21,"CR":22,"CY":28,"CZ":24,"DE":22,"DJ":27,"DK":18,"DO":28,"EE":20,"EG":29,"ES":24,"FI":18,
    "FK":18,"FO":18,"FR":27,"GB":22,"GE":22,"GI":23,"GL":18,"GR":27,"GT":28,"HN":28,"HR":21,"HU":28,
    "IE":22,"IL":23,"IQ":23,"IS":26,"IT":27,"JO":30,"KW":30,"KZ":20,"LB":28,"LC":32,"LI":21,"LT":20,
    "LU":20,"LV":21,"LY":25,"MC":27,"MD":24,"ME":22,"MK":19,"MN":20,"MR":27,"MT":31,"MU":30,"NI":28,
    "NL":18,"NO":15,"OM":23,"PK":24,"PL":28,"PS":29,"PT":25,"QA":29,"RO":24,"RS":22,"RU":33,"SA":24,
    "SC":31,"SD":18,"SE":24,"SI":19,"SK":24,"SM":27,"SO":23,"ST":25,"SV":28,"TL":23,"TN":24,"TR":26,
    "UA":29,"VA":22,"VG":24,"XK":20,"YE":30}';
  v_land      text;
  v_lengte    int;
  v_herschikt text;
  v_teken     text;
  v_cijfers   text;
  v_rest      int := 0;
begin
  if v_iban = '' then
    return null;
  end if;
  if v_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]+$' then
    return 'Ongeldig IBAN: begin met een landcode en 2 cijfers, gevolgd door letters en cijfers.';
  end if;

  v_land := left(v_iban, 2);
  v_lengte := (v_lengtes ->> v_land)::int;
  if v_lengte is null then
    return format('Ongeldig IBAN: onbekende landcode %s.', v_land);
  end if;
  if length(v_iban) <> v_lengte then
    return format('Ongeldig IBAN: een IBAN uit %s heeft %s tekens (nu %s).', v_land, v_lengte, length(v_iban));
  end if;

  v_herschikt := substr(v_iban, 5) || left(v_iban, 4);
  for i in 1 .. length(v_herschikt) loop
    v_teken := substr(v_herschikt, i, 1);
    v_cijfers := case when v_teken ~ '[0-9]' then v_teken else (ascii(v_teken) - 55)::text end;
    for j in 1 .. length(v_cijfers) loop
      v_rest := (v_rest * 10 + substr(v_cijfers, j, 1)::int) % 97;
    end loop;
  end loop;

  if v_rest <> 1 then
    return 'Ongeldig IBAN: het controlegetal klopt niet.';
  end if;
  return null;
end;
$$;

create function intern.controleer_btw_nummer(p_nummer text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_nummer text := upper(regexp_replace(coalesce(p_nummer, ''), '[\s.]', '', 'g'));
begin
  if v_nummer = '' then
    return null;
  end if;
  if v_nummer like 'NL%' then
    if v_nummer ~ '^NL[0-9]{9}B[0-9]{2}$' then
      return null;
    end if;
    return 'Ongeldig btw-nummer: een Nederlands btw-nummer is NL + 9 cijfers + B + 2 cijfers (bijv. NL123456789B01).';
  end if;
  if v_nummer ~ '^[A-Z]{2}[A-Z0-9+*]{2,13}$' then
    return null;
  end if;
  return 'Ongeldig btw-nummer: begin met een landcode van 2 letters, gevolgd door letters en cijfers.';
end;
$$;

create function intern.controleer_kvk_nummer(p_nummer text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(btrim(p_nummer), '') = '' then null
    when regexp_replace(p_nummer, '\s', '', 'g') ~ '^[0-9]{8}$' then null
    else 'Ongeldig KvK-nummer: dit moet uit 8 cijfers bestaan.'
  end;
$$;

-- Zelfde normalisatie als normaliseerFactuurnummer() in src/lib/signalen.ts: hoofdletters, zonder
-- spaties, zonder voorloopnullen (per cijferreeks) en zonder streepjes. "F-001" en "f 1" worden "F1".
create function intern.normaliseer_factuurnummer(p_nummer text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(
    replace(
      regexp_replace(upper(regexp_replace(p_nummer, '\s', '', 'g')), '(^|[^0-9])0+(?=[0-9])', '\1', 'g'),
      '-', ''),
    '');
$$;

-- ---------------------------------------------------------------------------
-- Tabel factuur_signalen
-- ---------------------------------------------------------------------------

create table public.factuur_signalen (
  id            uuid primary key default gen_random_uuid(),
  factuur_id    uuid not null references public.facturen (id) on delete cascade,
  type          text not null check (type in (
                  'mogelijk_duplicaat', 'iban_afwijkend', 'nieuwe_leverancier',
                  'rond_bedrag', 'net_onder_limiet', 'validatiefout')),
  ernst         text not null check (ernst in ('info', 'waarschuwing', 'kritiek')),
  bericht       text not null,
  -- Onderscheidt signalen van hetzelfde type (bijv. welk veld of welke IBAN's). Een opgelost signaal
  -- komt niet terug zolang de sleutel gelijk blijft; verandert de situatie, dan volgt een nieuw signaal.
  sleutel       text not null default '',
  details       jsonb not null default '{}'::jsonb,
  opgelost      boolean not null default false,
  opgelost_door uuid references auth.users (id) on delete set null,
  opgelost_op   timestamptz,
  toelichting   text,
  created_at    timestamptz not null default now(),
  unique (factuur_id, type, sleutel),
  check (opgelost = (opgelost_op is not null)),
  check (not opgelost or coalesce(btrim(toelichting), '') <> '')
);

create index factuur_signalen_open_idx on public.factuur_signalen (factuur_id) where not opgelost;

alter table public.factuur_signalen enable row level security;

create policy "Signalen van eigen facturen"
  on public.factuur_signalen for select to authenticated
  using (exists (
    select 1 from public.facturen f
    where f.id = factuur_signalen.factuur_id and f.user_id = (select auth.uid())
  ));

-- Alleen lezen; schrijven gaat via de functies hieronder.
revoke all on public.factuur_signalen from anon, authenticated;
grant select on public.factuur_signalen to authenticated;

-- ---------------------------------------------------------------------------
-- intern.bepaal_signalen: (her)berekent de signalen van één factuur
-- ---------------------------------------------------------------------------
-- - Nieuwe signalen worden toegevoegd.
-- - Open signalen die niet meer gelden (bijv. IBAN gecorrigeerd) worden verwijderd.
-- - Opgeloste signalen blijven altijd staan (met hun toelichting).

create function intern.bepaal_signalen(p_factuur_id uuid)
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
begin
  select * into f from public.facturen where id = p_factuur_id;
  if not found then
    return;
  end if;
  -- Zonder ingelogde gebruiker (migratie, service role) geen toegangscontrole.
  if v_uid is not null and f.user_id <> v_uid then
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
      and o.user_id = f.user_id
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
  insert into public.factuur_signalen as s (factuur_id, type, ernst, bericht, sleutel, details)
  select f.id, n.type, n.ernst, n.bericht, n.sleutel, n.details
  from jsonb_to_recordset(v_nieuw) as n (type text, ernst text, bericht text, sleutel text, details jsonb)
  on conflict (factuur_id, type, sleutel) do update
    set ernst = excluded.ernst, bericht = excluded.bericht, details = excluded.details
    where not s.opgelost
      and (s.ernst, s.bericht, s.details) is distinct from (excluded.ernst, excluded.bericht, excluded.details);
end;
$$;

revoke execute on function intern.bepaal_signalen(uuid) from public;
grant execute on function intern.bepaal_signalen(uuid) to authenticated, service_role;
grant execute on function intern.normaliseer_factuurnummer(text), intern.controleer_iban(text),
  intern.controleer_btw_nummer(text), intern.controleer_kvk_nummer(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- public.los_signaal_op: signaal oplossen met verplichte toelichting
-- ---------------------------------------------------------------------------
-- p_iban_overnemen (alleen bij iban_afwijkend): het IBAN van de factuur wordt het nieuwe bekende
-- IBAN van de leverancier. Dit is de enige manier waarop een bekend IBAN nog kan veranderen.

create function public.los_signaal_op(p_signaal_id uuid, p_toelichting text, p_iban_overnemen boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  s          public.factuur_signalen%rowtype;
  f          public.facturen%rowtype;
begin
  if v_uid is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_toelichting), '') = '' then
    raise exception 'Een toelichting is verplicht bij het oplossen van een signaal.' using errcode = '22023';
  end if;

  select * into s from public.factuur_signalen where id = p_signaal_id for update;
  if found then
    select * into f from public.facturen where id = s.factuur_id;
  end if;
  if not found or f.user_id <> v_uid then
    raise exception 'Signaal niet gevonden.' using errcode = 'P0002';
  end if;
  if s.opgelost then
    raise exception 'Dit signaal is al opgelost.' using errcode = '22023';
  end if;

  if p_iban_overnemen then
    if s.type <> 'iban_afwijkend' then
      raise exception 'Alleen bij een afwijkend IBAN kan het IBAN worden overgenomen.' using errcode = '22023';
    end if;
    if intern.controleer_iban(f.iban) is not null then
      raise exception 'Het IBAN op de factuur is ongeldig en kan niet worden overgenomen.' using errcode = '22023';
    end if;
    update public.leveranciers set iban = f.iban where id = f.leverancier_id;
  end if;

  update public.factuur_signalen
  set opgelost = true, opgelost_door = v_uid, opgelost_op = now(), toelichting = btrim(p_toelichting)
  where id = s.id;
end;
$$;

revoke execute on function public.los_signaal_op(uuid, text, boolean) from public, anon;
grant execute on function public.los_signaal_op(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- sla_factuur_op (vervangt de versie uit de init-migratie)
-- ---------------------------------------------------------------------------
-- Wijzigingen:
-- - iban/btw_nummer/kvk_nummer worden op de factuur zelf bewaard.
-- - Het bekende IBAN van een leverancier wordt alleen gevuld als het nog leeg is, nooit overschreven
--   (ook niet bij bewerken). Wijzigen kan alleen via los_signaal_op.
-- - btw-regels worden alleen vervangen als ze echt veranderd zijn.
-- - Na opslaan worden de signalen bepaald.

create or replace function public.sla_factuur_op(p_factuur jsonb, p_leverancier_bijwerken boolean default false)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid            uuid := auth.uid();
  v_id             uuid := coalesce(nullif(p_factuur ->> 'id', '')::uuid, gen_random_uuid());
  v_naam           text := nullif(btrim(p_factuur ->> 'leverancier'), '');
  v_btw_nummer     text := upper(nullif(regexp_replace(p_factuur ->> 'btw_nummer', '[\s.]', '', 'g'), ''));
  v_kvk_nummer     text := nullif(regexp_replace(p_factuur ->> 'kvk_nummer', '\s', '', 'g'), '');
  v_iban           text := upper(nullif(regexp_replace(p_factuur ->> 'iban', '\s', '', 'g'), ''));
  v_valuta         text := upper(nullif(btrim(p_factuur ->> 'valuta'), ''));
  v_status         text := nullif(p_factuur ->> 'status', '');
  v_pad            text := nullif(p_factuur ->> 'bestand_pad', '');
  v_leverancier_id uuid;
  v_resultaat      uuid;
  v_regels         jsonb;
begin
  if v_uid is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;

  if v_pad is not null and v_pad not like v_uid::text || '/' || v_id::text || '/%' then
    raise exception 'Ongeldig bestandspad.' using errcode = '22023';
  end if;

  if v_naam is not null then
    insert into public.leveranciers as l (user_id, naam, btw_nummer, kvk_nummer, iban)
    values (v_uid, v_naam, v_btw_nummer, v_kvk_nummer, v_iban)
    on conflict (user_id, lower(naam)) do update set
      btw_nummer = case when p_leverancier_bijwerken
                        then coalesce(excluded.btw_nummer, l.btw_nummer)
                        else coalesce(l.btw_nummer, excluded.btw_nummer) end,
      kvk_nummer = case when p_leverancier_bijwerken
                        then coalesce(excluded.kvk_nummer, l.kvk_nummer)
                        else coalesce(l.kvk_nummer, excluded.kvk_nummer) end,
      iban       = coalesce(l.iban, excluded.iban)
    returning l.id into v_leverancier_id;
  end if;

  insert into public.facturen as f (
    id, user_id, leverancier_id, leverancier_naam, factuurnummer, factuurdatum, vervaldatum,
    valuta, bedrag_excl, totaal_incl, status, bestand_pad, bestandsnaam, ai_model,
    iban, btw_nummer, kvk_nummer
  )
  values (
    v_id,
    v_uid,
    v_leverancier_id,
    v_naam,
    nullif(btrim(p_factuur ->> 'factuurnummer'), ''),
    nullif(p_factuur ->> 'factuurdatum', '')::date,
    nullif(p_factuur ->> 'vervaldatum', '')::date,
    v_valuta,
    (p_factuur ->> 'bedrag_excl')::numeric,
    (p_factuur ->> 'totaal_incl')::numeric,
    coalesce(v_status, 'gescand'),
    v_pad,
    nullif(p_factuur ->> 'bestandsnaam', ''),
    nullif(p_factuur ->> 'ai_model', ''),
    v_iban,
    v_btw_nummer,
    v_kvk_nummer
  )
  on conflict (id) do update set
    leverancier_id   = excluded.leverancier_id,
    leverancier_naam = excluded.leverancier_naam,
    factuurnummer    = excluded.factuurnummer,
    factuurdatum     = excluded.factuurdatum,
    vervaldatum      = excluded.vervaldatum,
    valuta           = excluded.valuta,
    bedrag_excl      = excluded.bedrag_excl,
    totaal_incl      = excluded.totaal_incl,
    status           = coalesce(v_status, f.status),
    bestand_pad      = coalesce(excluded.bestand_pad, f.bestand_pad),
    bestandsnaam     = coalesce(excluded.bestandsnaam, f.bestandsnaam),
    ai_model         = coalesce(excluded.ai_model, f.ai_model),
    iban             = excluded.iban,
    btw_nummer       = excluded.btw_nummer,
    kvk_nummer       = excluded.kvk_nummer
  where f.user_id = v_uid
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

-- ---------------------------------------------------------------------------
-- Backfill: signalen voor bestaande facturen (oudste eerst)
-- ---------------------------------------------------------------------------

do $$
declare
  v_id uuid;
begin
  for v_id in select id from public.facturen order by created_at, id loop
    perform intern.bepaal_signalen(v_id);
  end loop;
end;
$$;
