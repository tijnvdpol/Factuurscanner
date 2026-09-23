-- Fase 3.1: organisaties en rollen.
--
-- Eigendom verhuist van gebruiker naar organisatie. Elke bestaande gebruiker krijgt een persoonlijke
-- organisatie (als beheerder); alle bestaande data verhuist mee. user_id blijft bestaan als
-- "aangemaakt/ingevoerd door".

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------

create table public.organisaties (
  id         uuid primary key default gen_random_uuid(),
  naam       text not null check (btrim(naam) <> ''),
  created_at timestamptz not null default now()
);

create table public.organisatie_leden (
  organisatie_id     uuid not null references public.organisaties (id) on delete cascade,
  user_id            uuid not null references auth.users (id) on delete cascade,
  rol                text not null check (rol in ('invoerder', 'goedkeurder', 'controller', 'beheerder')),
  -- null = onbeperkt
  goedkeuringslimiet numeric(12, 2) check (goedkeuringslimiet >= 0),
  created_at         timestamptz not null default now(),
  unique (organisatie_id, user_id)
);

create index organisatie_leden_user_idx on public.organisatie_leden (user_id);

-- ---------------------------------------------------------------------------
-- Hulpfuncties voor policies (security definer: geen recursie via RLS op organisatie_leden)
-- ---------------------------------------------------------------------------

create function public.is_lid(p_organisatie_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organisatie_leden
    where organisatie_id = p_organisatie_id and user_id = (select auth.uid())
  );
$$;

create function public.heeft_rol(p_organisatie_id uuid, p_rollen text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organisatie_leden
    where organisatie_id = p_organisatie_id and user_id = (select auth.uid()) and rol = any (p_rollen)
  );
$$;

create function intern.aantal_leden(p_organisatie_id uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.organisatie_leden where organisatie_id = p_organisatie_id;
$$;

revoke execute on function public.is_lid(uuid), public.heeft_rol(uuid, text[]) from public, anon;
grant execute on function public.is_lid(uuid), public.heeft_rol(uuid, text[]) to authenticated, service_role;
revoke execute on function intern.aantal_leden(uuid) from public;
grant execute on function intern.aantal_leden(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Grootboek-seed per organisatie (vervangt de seed per gebruiker uit fase 2.3)
-- ---------------------------------------------------------------------------

drop trigger grootboek_voor_nieuwe_gebruiker on auth.users;
drop function intern.bij_nieuwe_gebruiker_grootboek();
drop function intern.seed_grootboekrekeningen(uuid);

-- ---------------------------------------------------------------------------
-- Backfill: persoonlijke organisatie per bestaande gebruiker
-- ---------------------------------------------------------------------------

do $$
declare
  u     record;
  v_org uuid;
begin
  for u in select id, email from auth.users order by created_at, id loop
    insert into public.organisaties (naam)
    values ('Organisatie van ' || coalesce(nullif(u.email, ''), 'onbekend'))
    returning id into v_org;
    insert into public.organisatie_leden (organisatie_id, user_id, rol) values (v_org, u.id, 'beheerder');
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- organisatie_id op de bestaande tabellen
-- ---------------------------------------------------------------------------

alter table public.leveranciers        add column organisatie_id uuid references public.organisaties (id) on delete cascade;
alter table public.facturen            add column organisatie_id uuid references public.organisaties (id) on delete cascade;
alter table public.grootboekrekeningen add column organisatie_id uuid references public.organisaties (id) on delete cascade;
alter table public.factuur_signalen    add column organisatie_id uuid references public.organisaties (id) on delete cascade;

-- Op dit moment heeft elke gebruiker precies één lidmaatschap: zijn persoonlijke organisatie.
update public.leveranciers t set organisatie_id = m.organisatie_id
from public.organisatie_leden m where m.user_id = t.user_id;
update public.facturen t set organisatie_id = m.organisatie_id
from public.organisatie_leden m where m.user_id = t.user_id;
update public.grootboekrekeningen t set organisatie_id = m.organisatie_id
from public.organisatie_leden m where m.user_id = t.user_id;
update public.factuur_signalen s set organisatie_id = f.organisatie_id
from public.facturen f where f.id = s.factuur_id;

alter table public.leveranciers        alter column organisatie_id set not null;
alter table public.facturen            alter column organisatie_id set not null;
alter table public.grootboekrekeningen alter column organisatie_id set not null;
alter table public.factuur_signalen    alter column organisatie_id set not null;

create index leveranciers_organisatie_idx        on public.leveranciers (organisatie_id);
create index facturen_organisatie_created_idx    on public.facturen (organisatie_id, created_at desc);
create index grootboekrekeningen_organisatie_idx on public.grootboekrekeningen (organisatie_id);
create index factuur_signalen_organisatie_idx    on public.factuur_signalen (organisatie_id);

-- ---------------------------------------------------------------------------
-- Uniciteit en koppelingen per organisatie i.p.v. per gebruiker
-- ---------------------------------------------------------------------------

drop index public.leveranciers_user_naam_uniek;
create unique index leveranciers_organisatie_naam_uniek on public.leveranciers (organisatie_id, lower(naam));
alter table public.leveranciers add constraint leveranciers_id_organisatie_key unique (id, organisatie_id);

alter table public.grootboekrekeningen drop constraint grootboekrekeningen_user_id_code_key;
alter table public.grootboekrekeningen add constraint grootboekrekeningen_organisatie_code_key unique (organisatie_id, code);
alter table public.grootboekrekeningen add constraint grootboekrekeningen_id_organisatie_key unique (id, organisatie_id);

alter table public.facturen drop constraint facturen_leverancier_id_user_id_fkey;
alter table public.facturen add constraint facturen_leverancier_fk
  foreign key (leverancier_id, organisatie_id)
  references public.leveranciers (id, organisatie_id)
  on delete set null (leverancier_id);

alter table public.facturen drop constraint facturen_grootboekrekening_fk;
alter table public.facturen add constraint facturen_grootboekrekening_fk
  foreign key (grootboekrekening_id, organisatie_id)
  references public.grootboekrekeningen (id, organisatie_id)
  on delete set null (grootboekrekening_id);

drop index public.facturen_duplicaat_uniek;
create unique index facturen_duplicaat_uniek
  on public.facturen (organisatie_id, leverancier_id, factuurnummer)
  nulls not distinct
  where factuurnummer is not null;

-- Data is van de organisatie: als een account verdwijnt, blijft de data staan (user_id wordt leeg).
alter table public.leveranciers drop constraint leveranciers_user_id_fkey;
alter table public.leveranciers alter column user_id drop not null;
alter table public.leveranciers add constraint leveranciers_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete set null;

alter table public.facturen drop constraint facturen_user_id_fkey;
alter table public.facturen alter column user_id drop not null;
alter table public.facturen add constraint facturen_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete set null;

alter table public.grootboekrekeningen drop constraint grootboekrekeningen_user_id_fkey;
alter table public.grootboekrekeningen alter column user_id drop not null;
alter table public.grootboekrekeningen add constraint grootboekrekeningen_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete set null;

comment on column public.facturen.user_id is 'Ingevoerd door';

-- ---------------------------------------------------------------------------
-- Nieuwe organisaties en gebruikers
-- ---------------------------------------------------------------------------

create function intern.seed_grootboekrekeningen(p_organisatie_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.grootboekrekeningen (organisatie_id, user_id, code, omschrijving)
  select p_organisatie_id, null, r.code, r.omschrijving
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
  on conflict (organisatie_id, code) do nothing;
$$;

revoke execute on function intern.seed_grootboekrekeningen(uuid) from public;

create function intern.bij_nieuwe_organisatie()
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

revoke execute on function intern.bij_nieuwe_organisatie() from public;

create trigger grootboek_voor_nieuwe_organisatie
  after insert on public.organisaties
  for each row execute function intern.bij_nieuwe_organisatie();

-- Persoonlijke organisatie (gebruiker = beheerder); geeft het id terug.
create function intern.maak_persoonlijke_organisatie(p_user_id uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  insert into public.organisaties (naam)
  values ('Organisatie van ' || coalesce(nullif(p_email, ''), 'onbekend'))
  returning id into v_org;
  insert into public.organisatie_leden (organisatie_id, user_id, rol) values (v_org, p_user_id, 'beheerder');
  return v_org;
end;
$$;

revoke execute on function intern.maak_persoonlijke_organisatie(uuid, text) from public;

create function intern.bij_nieuwe_gebruiker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform intern.maak_persoonlijke_organisatie(new.id, new.email);
  return new;
end;
$$;

revoke execute on function intern.bij_nieuwe_gebruiker() from public;

create trigger organisatie_voor_nieuwe_gebruiker
  after insert on auth.users
  for each row execute function intern.bij_nieuwe_gebruiker();

-- Vangnet bij de eerste login (bijv. als de trigger ooit niet heeft gedraaid): zorgt dat de gebruiker
-- minstens één organisatie heeft en geeft die terug.
create function public.zorg_voor_organisatie()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;
  select organisatie_id into v_org from public.organisatie_leden where user_id = v_uid order by created_at limit 1;
  if v_org is null then
    v_org := intern.maak_persoonlijke_organisatie(v_uid, (select email from auth.users where id = v_uid));
  end if;
  return v_org;
end;
$$;

revoke execute on function public.zorg_voor_organisatie() from public, anon;
grant execute on function public.zorg_voor_organisatie() to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security: lidmaatschap van de organisatie
-- ---------------------------------------------------------------------------

alter table public.organisaties enable row level security;
alter table public.organisatie_leden enable row level security;

create policy "Leden zien hun organisatie"
  on public.organisaties for select to authenticated
  using (public.is_lid(id));

create policy "Beheerder wijzigt organisatie"
  on public.organisaties for update to authenticated
  using (public.heeft_rol(id, array['beheerder']))
  with check (public.heeft_rol(id, array['beheerder']));

create policy "Leden zien de leden"
  on public.organisatie_leden for select to authenticated
  using (public.is_lid(organisatie_id));

revoke all on public.organisaties, public.organisatie_leden from anon, authenticated;
grant select on public.organisaties, public.organisatie_leden to authenticated;
grant update (naam) on public.organisaties to authenticated;
-- Leden toevoegen/wijzigen/verwijderen gaat alleen via de RPC's hieronder.

drop policy "Eigen leveranciers" on public.leveranciers;
drop policy "Eigen facturen" on public.facturen;
drop policy "BTW-regels van eigen facturen" on public.btw_regels;
drop policy "Signalen van eigen facturen" on public.factuur_signalen;
drop policy "Eigen grootboekrekeningen" on public.grootboekrekeningen;

-- Leveranciers: het bekende IBAN is alleen via los_signaal_op te wijzigen, en verwijderen kan niet
-- (anders kun je een leverancier opnieuw aanmaken met een ander IBAN zonder signaal).
create policy "Leveranciers van de organisatie: lezen"
  on public.leveranciers for select to authenticated
  using (public.is_lid(organisatie_id));
create policy "Leveranciers van de organisatie: toevoegen"
  on public.leveranciers for insert to authenticated
  with check (public.is_lid(organisatie_id));
create policy "Leveranciers van de organisatie: wijzigen"
  on public.leveranciers for update to authenticated
  using (public.is_lid(organisatie_id))
  with check (public.is_lid(organisatie_id));

revoke all on public.leveranciers from anon, authenticated;
grant select, insert on public.leveranciers to authenticated;
grant update (naam, btw_nummer, kvk_nummer) on public.leveranciers to authenticated;

-- Facturen: user_id ("ingevoerd door") is altijd de gebruiker zelf en daarna niet meer te wijzigen.
create policy "Facturen van de organisatie: lezen"
  on public.facturen for select to authenticated
  using (public.is_lid(organisatie_id));
create policy "Facturen van de organisatie: toevoegen"
  on public.facturen for insert to authenticated
  with check (public.is_lid(organisatie_id) and user_id = (select auth.uid()));
create policy "Facturen van de organisatie: wijzigen"
  on public.facturen for update to authenticated
  using (public.is_lid(organisatie_id))
  with check (public.is_lid(organisatie_id));
create policy "Facturen van de organisatie: verwijderen"
  on public.facturen for delete to authenticated
  using (public.is_lid(organisatie_id));

revoke all on public.facturen from anon, authenticated;
grant select, insert, delete on public.facturen to authenticated;
grant update (
  leverancier_id, leverancier_naam, factuurnummer, factuurdatum, vervaldatum, valuta, bedrag_excl,
  totaal_incl, status, bestand_pad, bestandsnaam, ai_model, iban, btw_nummer, kvk_nummer,
  grootboekrekening_id, codering_bron, codering_zekerheid
) on public.facturen to authenticated;

create policy "BTW-regels van facturen van de organisatie"
  on public.btw_regels for all to authenticated
  using (exists (
    select 1 from public.facturen f
    where f.id = btw_regels.factuur_id and public.is_lid(f.organisatie_id)
  ))
  with check (exists (
    select 1 from public.facturen f
    where f.id = btw_regels.factuur_id and public.is_lid(f.organisatie_id)
  ));

create policy "Signalen van de organisatie"
  on public.factuur_signalen for select to authenticated
  using (public.is_lid(organisatie_id));

-- Grootboekrekeningen: iedereen leest, controller en beheerder beheren.
create policy "Grootboekrekeningen van de organisatie: lezen"
  on public.grootboekrekeningen for select to authenticated
  using (public.is_lid(organisatie_id));
create policy "Grootboekrekeningen van de organisatie: toevoegen"
  on public.grootboekrekeningen for insert to authenticated
  with check (public.heeft_rol(organisatie_id, array['controller', 'beheerder']));
create policy "Grootboekrekeningen van de organisatie: wijzigen"
  on public.grootboekrekeningen for update to authenticated
  using (public.heeft_rol(organisatie_id, array['controller', 'beheerder']))
  with check (public.heeft_rol(organisatie_id, array['controller', 'beheerder']));

revoke all on public.grootboekrekeningen from anon, authenticated;
grant select, insert on public.grootboekrekeningen to authenticated;
grant update (code, omschrijving, actief) on public.grootboekrekeningen to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: nieuwe uploads onder {organisatie_id}/{factuur_id}/…; oude paden blijven werken
-- ---------------------------------------------------------------------------

-- Is het eerste padsegment een organisatie waarvan de gebruiker lid is?
create function intern.is_organisatiemap(p_map text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_map ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and public.is_lid(p_map::uuid);
$$;

-- Hoort het bestand bij een factuur van een organisatie waarvan de gebruiker lid is? (oude paden)
create function intern.is_bestand_van_organisatie(p_pad text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.facturen f
    where f.bestand_pad = p_pad and public.is_lid(f.organisatie_id)
  );
$$;

revoke execute on function intern.is_organisatiemap(text), intern.is_bestand_van_organisatie(text) from public;
grant execute on function intern.is_organisatiemap(text), intern.is_bestand_van_organisatie(text) to authenticated;

drop policy "Facturen: eigen bestanden lezen" on storage.objects;
drop policy "Facturen: eigen bestanden uploaden" on storage.objects;
drop policy "Facturen: eigen bestanden wijzigen" on storage.objects;
drop policy "Facturen: eigen bestanden verwijderen" on storage.objects;

create policy "Facturen: bestanden van de organisatie lezen"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'facturen' and (
      intern.is_organisatiemap((storage.foldername(name))[1])
      or (storage.foldername(name))[1] = (select auth.uid()::text)
      or intern.is_bestand_van_organisatie(name)
    )
  );

create policy "Facturen: bestanden van de organisatie uploaden"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'facturen' and (
      intern.is_organisatiemap((storage.foldername(name))[1])
      -- oude frontend (vóór deze migratie) uploadt nog in de eigen map
      or (storage.foldername(name))[1] = (select auth.uid()::text)
    )
  );

create policy "Facturen: bestanden van de organisatie wijzigen"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'facturen' and (
      intern.is_organisatiemap((storage.foldername(name))[1])
      or (storage.foldername(name))[1] = (select auth.uid()::text)
    )
  )
  with check (
    bucket_id = 'facturen' and (
      intern.is_organisatiemap((storage.foldername(name))[1])
      or (storage.foldername(name))[1] = (select auth.uid()::text)
    )
  );

create policy "Facturen: bestanden van de organisatie verwijderen"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'facturen' and (
      intern.is_organisatiemap((storage.foldername(name))[1])
      or (storage.foldername(name))[1] = (select auth.uid()::text)
      or intern.is_bestand_van_organisatie(name)
    )
  );

-- ---------------------------------------------------------------------------
-- Ledenbeheer (alleen beheerders)
-- ---------------------------------------------------------------------------

create function intern.controleer_beheerder(p_organisatie_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;
  if not public.heeft_rol(p_organisatie_id, array['beheerder']) then
    raise exception 'Alleen een beheerder kan leden beheren.' using errcode = '42501';
  end if;
  -- Serialiseert gelijktijdige wijzigingen (bijv. twee beheerders die elkaar degraderen).
  perform 1 from public.organisaties where id = p_organisatie_id for update;
end;
$$;

revoke execute on function intern.controleer_beheerder(uuid) from public;

create function intern.controleer_rol_en_limiet(p_rol text, p_limiet numeric)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_rol is null or p_rol not in ('invoerder', 'goedkeurder', 'controller', 'beheerder') then
    raise exception 'Ongeldige rol.' using errcode = '22023';
  end if;
  if p_limiet < 0 then
    raise exception 'De goedkeuringslimiet kan niet negatief zijn.' using errcode = '22023';
  end if;
end;
$$;

revoke execute on function intern.controleer_rol_en_limiet(text, numeric) from public;

-- Voegt een bestaand account toe op e-mailadres.
create function public.voeg_lid_toe(p_organisatie_id uuid, p_email text, p_rol text, p_goedkeuringslimiet numeric default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  perform intern.controleer_beheerder(p_organisatie_id);
  perform intern.controleer_rol_en_limiet(p_rol, p_goedkeuringslimiet);

  select id into v_user from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then
    raise exception 'Er is geen account met dit e-mailadres. Vraag de persoon om eerst te registreren.'
      using errcode = 'P0002';
  end if;
  if exists (select 1 from public.organisatie_leden where organisatie_id = p_organisatie_id and user_id = v_user) then
    raise exception 'Deze persoon is al lid van de organisatie.' using errcode = '23505';
  end if;

  insert into public.organisatie_leden (organisatie_id, user_id, rol, goedkeuringslimiet)
  values (p_organisatie_id, v_user, p_rol, p_goedkeuringslimiet);
  return v_user;
end;
$$;

create function public.wijzig_lid(p_organisatie_id uuid, p_user_id uuid, p_rol text, p_goedkeuringslimiet numeric default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_huidige_rol text;
begin
  perform intern.controleer_beheerder(p_organisatie_id);
  perform intern.controleer_rol_en_limiet(p_rol, p_goedkeuringslimiet);

  select rol into v_huidige_rol from public.organisatie_leden
  where organisatie_id = p_organisatie_id and user_id = p_user_id;
  if v_huidige_rol is null then
    raise exception 'Lid niet gevonden.' using errcode = 'P0002';
  end if;
  if v_huidige_rol = 'beheerder' and p_rol <> 'beheerder' and (
    select count(*) from public.organisatie_leden where organisatie_id = p_organisatie_id and rol = 'beheerder'
  ) = 1 then
    raise exception 'Dit is de laatste beheerder. Maak eerst iemand anders beheerder.' using errcode = '22023';
  end if;

  update public.organisatie_leden
  set rol = p_rol, goedkeuringslimiet = p_goedkeuringslimiet
  where organisatie_id = p_organisatie_id and user_id = p_user_id;
end;
$$;

create function public.verwijder_lid(p_organisatie_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol text;
begin
  perform intern.controleer_beheerder(p_organisatie_id);

  select rol into v_rol from public.organisatie_leden
  where organisatie_id = p_organisatie_id and user_id = p_user_id;
  if v_rol is null then
    raise exception 'Lid niet gevonden.' using errcode = 'P0002';
  end if;
  if v_rol = 'beheerder' and (
    select count(*) from public.organisatie_leden where organisatie_id = p_organisatie_id and rol = 'beheerder'
  ) = 1 then
    raise exception 'Je kunt de laatste beheerder niet verwijderen. Maak eerst iemand anders beheerder.'
      using errcode = '22023';
  end if;

  delete from public.organisatie_leden where organisatie_id = p_organisatie_id and user_id = p_user_id;
end;
$$;

-- Namen (e-mailadressen) van leden en van oud-leden die nog in de data voorkomen. Alleen voor leden.
create function public.org_gebruikers(p_organisatie_id uuid)
returns table (user_id uuid, email text, rol text, goedkeuringslimiet numeric, is_lid boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_lid(p_organisatie_id) then
    raise exception 'Geen toegang tot deze organisatie.' using errcode = '42501';
  end if;

  return query
  with betrokken as (
    select f.user_id as id from public.facturen f where f.organisatie_id = p_organisatie_id
    union
    select s.opgelost_door from public.factuur_signalen s where s.organisatie_id = p_organisatie_id
  )
  select m.user_id, u.email::text, m.rol, m.goedkeuringslimiet, true
  from public.organisatie_leden m
  join auth.users u on u.id = m.user_id
  where m.organisatie_id = p_organisatie_id
  union all
  select u.id, u.email::text, null, null, false
  from betrokken b
  join auth.users u on u.id = b.id
  where not exists (
    select 1 from public.organisatie_leden m where m.organisatie_id = p_organisatie_id and m.user_id = b.id
  );
end;
$$;

revoke execute on function
  public.voeg_lid_toe(uuid, text, text, numeric),
  public.wijzig_lid(uuid, uuid, text, numeric),
  public.verwijder_lid(uuid, uuid),
  public.org_gebruikers(uuid)
from public, anon;
grant execute on function
  public.voeg_lid_toe(uuid, text, text, numeric),
  public.wijzig_lid(uuid, uuid, text, numeric),
  public.verwijder_lid(uuid, uuid),
  public.org_gebruikers(uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- Signalen per organisatie
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

-- Kritieke signalen (en het overnemen van een IBAN) alleen door goedkeurder/controller/beheerder,
-- of door het enige lid van een organisatie. Andere signalen door elk lid.
create or replace function public.los_signaal_op(p_signaal_id uuid, p_toelichting text, p_iban_overnemen boolean default false)
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
  if not found or not public.is_lid(f.organisatie_id) then
    raise exception 'Signaal niet gevonden.' using errcode = 'P0002';
  end if;
  if s.opgelost then
    raise exception 'Dit signaal is al opgelost.' using errcode = '22023';
  end if;
  if (s.ernst = 'kritiek' or p_iban_overnemen)
     and not public.heeft_rol(f.organisatie_id, array['goedkeurder', 'controller', 'beheerder'])
     and intern.aantal_leden(f.organisatie_id) > 1 then
    raise exception 'Een kritiek signaal kan alleen worden opgelost door een goedkeurder, controller of beheerder.'
      using errcode = '42501';
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

-- ---------------------------------------------------------------------------
-- Coderingsvoorstel per organisatie (vervangt stel_codering_voor(text))
-- ---------------------------------------------------------------------------

drop function public.stel_codering_voor(text);

create function public.stel_codering_voor(p_organisatie_id uuid, p_leverancier text)
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
    where f.organisatie_id = p_organisatie_id
      and f.codering_bron = 'handmatig'
      and lower(btrim(f.leverancier_naam)) = lower(btrim(p_leverancier))
    group by f.grootboekrekening_id
  )
  select h.grootboekrekening_id, round(h.aantal::numeric / sum(h.aantal) over (), 2) as zekerheid
  from historie h
  order by h.aantal desc, h.laatst desc
  limit 1;
$$;

revoke execute on function public.stel_codering_voor(uuid, text) from public, anon;
grant execute on function public.stel_codering_voor(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- sla_factuur_op per organisatie
-- ---------------------------------------------------------------------------
-- Extra veld in p_factuur: organisatie_id. Ontbreekt dat en is de gebruiker lid van precies één
-- organisatie, dan wordt die gebruikt (zodat een oudere frontend tijdens de overgang blijft werken).

-- Vult het bekende IBAN van een leverancier alleen als dat nog leeg is (security definer, want
-- gebruikers hebben geen UPDATE-recht op leveranciers.iban).
create function intern.vul_leveranciers_iban(p_leverancier_id uuid, p_iban text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.leveranciers
  set iban = p_iban
  where id = p_leverancier_id and iban is null and p_iban is not null and public.is_lid(organisatie_id);
$$;

revoke execute on function intern.vul_leveranciers_iban(uuid, text) from public;
grant execute on function intern.vul_leveranciers_iban(uuid, text) to authenticated;

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
    valuta, bedrag_excl, totaal_incl, status, bestand_pad, bestandsnaam, ai_model,
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
