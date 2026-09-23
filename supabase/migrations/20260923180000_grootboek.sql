-- Fase 2.3: grootboekrekeningen en coderingsvoorstel.
--
-- Eigendom voorlopig per gebruiker (user_id); in fase 3.1 komt daar de organisatie bij.

-- ---------------------------------------------------------------------------
-- Tabel grootboekrekeningen
-- ---------------------------------------------------------------------------

create table public.grootboekrekeningen (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  code         text not null check (code ~ '^[0-9A-Za-z.-]{1,12}$'),
  omschrijving text not null check (btrim(omschrijving) <> ''),
  actief       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (user_id, code),
  -- voor de samengestelde foreign key vanuit facturen (geen koppeling aan andermans rekening)
  unique (id, user_id)
);

alter table public.grootboekrekeningen enable row level security;

create policy "Eigen grootboekrekeningen"
  on public.grootboekrekeningen for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Geen DELETE: een rekening die niet meer gebruikt wordt, wordt gedeactiveerd (historie blijft kloppen).
revoke all on public.grootboekrekeningen from anon, authenticated;
grant select, insert, update on public.grootboekrekeningen to authenticated;

-- ---------------------------------------------------------------------------
-- Standaardset voor een Nederlands mkb-bedrijf
-- ---------------------------------------------------------------------------

create function intern.seed_grootboekrekeningen(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.grootboekrekeningen (user_id, code, omschrijving)
  select p_user_id, r.code, r.omschrijving
  from (values
    ('4000', 'Huisvestingskosten'),
    ('4100', 'Autokosten'),
    ('4150', 'Reis- en verblijfkosten'),
    ('4200', 'Verkoopkosten'),
    ('4250', 'Reclame en marketing'),
    ('4300', 'Kantoorkosten'),
    ('4350', 'Telefoon en internet'),
    ('4400', 'ICT en software'),
    ('4500', 'Advieskosten'),
    ('4550', 'Accountants- en administratiekosten'),
    ('4600', 'Verzekeringen'),
    ('4700', 'Opleidingskosten'),
    ('4800', 'Algemene kosten'),
    ('4900', 'Bankkosten'),
    ('7000', 'Inkoopwaarde van de omzet'),
    ('7100', 'Uitbesteed werk')
  ) as r (code, omschrijving)
  on conflict (user_id, code) do nothing;
$$;

revoke execute on function intern.seed_grootboekrekeningen(uuid) from public;

-- Nieuwe gebruikers krijgen de standaardset bij registratie.
create function intern.bij_nieuwe_gebruiker_grootboek()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform intern.seed_grootboekrekeningen(new.id);
  return new;
end;
$$;

revoke execute on function intern.bij_nieuwe_gebruiker_grootboek() from public;

create trigger grootboek_voor_nieuwe_gebruiker
  after insert on auth.users
  for each row execute function intern.bij_nieuwe_gebruiker_grootboek();

-- Backfill voor bestaande gebruikers
select intern.seed_grootboekrekeningen(id) from auth.users;

-- ---------------------------------------------------------------------------
-- Codering op facturen
-- ---------------------------------------------------------------------------

alter table public.facturen
  add column grootboekrekening_id uuid,
  add column codering_bron        text check (codering_bron in ('handmatig', 'historie', 'ai')),
  add column codering_zekerheid   numeric(3, 2) check (codering_zekerheid between 0 and 1),
  add constraint facturen_codering_volledig
    check (grootboekrekening_id is not null or (codering_bron is null and codering_zekerheid is null)),
  add constraint facturen_grootboekrekening_fk
    foreign key (grootboekrekening_id, user_id)
    references public.grootboekrekeningen (id, user_id)
    on delete set null (grootboekrekening_id);

create index facturen_grootboekrekening_idx on public.facturen (grootboekrekening_id);

-- ---------------------------------------------------------------------------
-- stel_codering_voor: voorstel op basis van eerder handmatig gecodeerde facturen
-- ---------------------------------------------------------------------------
-- Geeft de meest gebruikte (actieve) rekening voor deze leverancier terug, met als zekerheid het
-- aandeel van die rekening in de handmatig gecodeerde facturen. Geen rij = geen historie.
-- Security invoker: RLS bepaalt welke facturen meetellen.

create function public.stel_codering_voor(p_leverancier text)
returns table (grootboekrekening_id uuid, zekerheid numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with historie as (
    select f.grootboekrekening_id, count(*) as aantal, max(f.created_at) as laatst
    from public.facturen f
    join public.grootboekrekeningen g on g.id = f.grootboekrekening_id and g.actief
    where f.codering_bron = 'handmatig'
      and lower(btrim(f.leverancier_naam)) = lower(btrim(p_leverancier))
    group by f.grootboekrekening_id
  )
  select h.grootboekrekening_id, round(h.aantal::numeric / sum(h.aantal) over (), 2) as zekerheid
  from historie h
  order by h.aantal desc, h.laatst desc
  limit 1;
$$;

revoke execute on function public.stel_codering_voor(text) from public, anon;
grant execute on function public.stel_codering_voor(text) to authenticated;

-- ---------------------------------------------------------------------------
-- sla_factuur_op: nu ook met codering
-- ---------------------------------------------------------------------------
-- Extra velden in p_factuur: grootboekrekening_id, codering_bron, codering_zekerheid.
-- Zonder rekening worden bron en zekerheid leeggemaakt; bij handmatig is er geen zekerheid.

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
    iban, btw_nummer, kvk_nummer, grootboekrekening_id, codering_bron, codering_zekerheid
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
    status               = coalesce(v_status, f.status),
    bestand_pad          = coalesce(excluded.bestand_pad, f.bestand_pad),
    bestandsnaam         = coalesce(excluded.bestandsnaam, f.bestandsnaam),
    ai_model             = coalesce(excluded.ai_model, f.ai_model),
    iban                 = excluded.iban,
    btw_nummer           = excluded.btw_nummer,
    kvk_nummer           = excluded.kvk_nummer,
    grootboekrekening_id = excluded.grootboekrekening_id,
    codering_bron        = excluded.codering_bron,
    codering_zekerheid   = excluded.codering_zekerheid
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
