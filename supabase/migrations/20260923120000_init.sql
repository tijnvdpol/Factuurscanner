-- Factuurscanner: basisschema (leveranciers, facturen, btw_regels) met Row Level Security.

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------

create table public.leveranciers (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  naam        text not null check (btrim(naam) <> ''),
  btw_nummer  text,
  kvk_nummer  text,
  iban        text,
  created_at  timestamptz not null default now(),
  -- nodig voor de samengestelde foreign key vanuit facturen (voorkomt koppelen aan andermans leverancier)
  unique (id, user_id)
);

create unique index leveranciers_user_naam_uniek on public.leveranciers (user_id, lower(naam));

create table public.facturen (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  leverancier_id    uuid,
  leverancier_naam  text,
  factuurnummer     text,
  factuurdatum      date,
  vervaldatum       date,
  valuta            char(3) default 'EUR' check (valuta is null or valuta ~ '^[A-Z]{3}$'),
  bedrag_excl       numeric(12, 2),
  totaal_incl       numeric(12, 2),
  status            text not null default 'gescand'
                    check (status in ('gescand', 'gecontroleerd', 'goedgekeurd', 'betaald')),
  bestand_pad       text,
  bestandsnaam      text,
  ai_model          text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (leverancier_id, user_id)
    references public.leveranciers (id, user_id)
    on delete set null (leverancier_id)
);

-- Duplicaatcontrole. NULLS NOT DISTINCT zorgt dat twee facturen zonder leverancier met hetzelfde
-- nummer ook als duplicaat gelden; facturen zonder factuurnummer blokkeren elkaar niet.
create unique index facturen_duplicaat_uniek
  on public.facturen (user_id, leverancier_id, factuurnummer)
  nulls not distinct
  where factuurnummer is not null;

create index facturen_user_created_idx on public.facturen (user_id, created_at desc);
create index facturen_leverancier_idx on public.facturen (leverancier_id);

create table public.btw_regels (
  id          uuid primary key default gen_random_uuid(),
  factuur_id  uuid not null references public.facturen (id) on delete cascade,
  -- volgorde van de regels zoals in het formulier (validatiefouten verwijzen naar de index)
  volgorde    smallint not null default 0,
  tarief      numeric(5, 2),
  grondslag   numeric(12, 2),
  btw_bedrag  numeric(12, 2)
);

create index btw_regels_factuur_idx on public.btw_regels (factuur_id, volgorde);

-- ---------------------------------------------------------------------------
-- updated_at-trigger
-- ---------------------------------------------------------------------------

create function public.zet_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger facturen_updated_at
  before update on public.facturen
  for each row execute function public.zet_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.leveranciers enable row level security;
alter table public.facturen enable row level security;
alter table public.btw_regels enable row level security;

create policy "Eigen leveranciers"
  on public.leveranciers for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Eigen facturen"
  on public.facturen for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "BTW-regels van eigen facturen"
  on public.btw_regels for all to authenticated
  using (exists (
    select 1 from public.facturen f
    where f.id = btw_regels.factuur_id and f.user_id = (select auth.uid())
  ))
  with check (exists (
    select 1 from public.facturen f
    where f.id = btw_regels.factuur_id and f.user_id = (select auth.uid())
  ));

revoke all on public.leveranciers, public.facturen, public.btw_regels from anon;
grant select, insert, update, delete on public.leveranciers, public.facturen, public.btw_regels to authenticated;

-- ---------------------------------------------------------------------------
-- sla_factuur_op: factuur + leverancier + btw-regels in één transactie opslaan
-- ---------------------------------------------------------------------------
-- p_factuur: { id?, leverancier, factuurnummer, factuurdatum, vervaldatum, valuta, bedrag_excl,
--              totaal_incl, status?, bestand_pad?, bestandsnaam?, ai_model?, btw_nummer, kvk_nummer,
--              iban, btw_regels: [{ tarief, grondslag, btw_bedrag }] }
-- p_leverancier_bijwerken: false = alleen lege leveranciersgegevens aanvullen (nieuwe scan),
--                          true  = ingevulde waarden overschrijven (expliciete bewerking).
-- Draait als security invoker: alle RLS-policies blijven gelden.

create function public.sla_factuur_op(p_factuur jsonb, p_leverancier_bijwerken boolean default false)
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
      iban       = case when p_leverancier_bijwerken
                        then coalesce(excluded.iban, l.iban)
                        else coalesce(l.iban, excluded.iban) end
    returning l.id into v_leverancier_id;
  end if;

  insert into public.facturen as f (
    id, user_id, leverancier_id, leverancier_naam, factuurnummer, factuurdatum, vervaldatum,
    valuta, bedrag_excl, totaal_incl, status, bestand_pad, bestandsnaam, ai_model
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
    nullif(p_factuur ->> 'ai_model', '')
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
    ai_model         = coalesce(excluded.ai_model, f.ai_model)
  where f.user_id = v_uid
  returning f.id into v_resultaat;

  if v_resultaat is null then
    raise exception 'Factuur niet gevonden.' using errcode = 'P0002';
  end if;

  delete from public.btw_regels where factuur_id = v_id;

  insert into public.btw_regels (factuur_id, volgorde, tarief, grondslag, btw_bedrag)
  select
    v_id,
    (r.nr - 1)::smallint,
    (r.regel ->> 'tarief')::numeric,
    (r.regel ->> 'grondslag')::numeric,
    (r.regel ->> 'btw_bedrag')::numeric
  from jsonb_array_elements(coalesce(p_factuur -> 'btw_regels', '[]'::jsonb)) with ordinality as r (regel, nr);

  return v_id;
end;
$$;

revoke execute on function public.sla_factuur_op(jsonb, boolean) from public, anon;
grant execute on function public.sla_factuur_op(jsonb, boolean) to authenticated;
