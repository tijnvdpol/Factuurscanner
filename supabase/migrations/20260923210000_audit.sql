-- Fase 3.3: audit trail.
--
-- audit_log wordt alleen door triggers gevuld (security definer) en is voor niemand te wijzigen of te
-- verwijderen. Leden van de organisatie mogen lezen.

create table public.audit_log (
  id                bigint generated always as identity primary key,
  -- Bewust geen foreign keys: de historie moet blijven bestaan, ook als de factuur, het account of
  -- de organisatie verdwijnt.
  organisatie_id    uuid not null,
  tabel             text not null,
  record_id         uuid,
  actie             text not null check (actie in ('insert', 'update', 'delete', 'statuswijziging')),
  gewijzigde_velden text[],
  oud               jsonb,
  nieuw             jsonb,
  user_id           uuid,
  toelichting       text,
  created_at        timestamptz not null default now()
);

create index audit_log_organisatie_idx on public.audit_log (organisatie_id, created_at desc);
create index audit_log_record_idx on public.audit_log (tabel, record_id);

alter table public.audit_log enable row level security;

create policy "Leden lezen de audit log"
  on public.audit_log for select to authenticated
  using (public.is_lid(organisatie_id));

revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;

-- Alleen toevoegen: UPDATE, DELETE en TRUNCATE worden altijd geweigerd, ook voor de service role en
-- de SQL Editor.
create function intern.audit_log_onveranderlijk()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'De audit log kan niet worden gewijzigd of verwijderd.' using errcode = '42501';
end;
$$;

revoke execute on function intern.audit_log_onveranderlijk() from public;

create trigger audit_log_geen_update_delete
  before update or delete on public.audit_log
  for each row execute function intern.audit_log_onveranderlijk();

create trigger audit_log_geen_truncate
  before truncate on public.audit_log
  for each statement execute function intern.audit_log_onveranderlijk();

-- ---------------------------------------------------------------------------
-- Generieke logtrigger
-- ---------------------------------------------------------------------------
-- Bij updates worden alleen de gewijzigde velden bewaard (zonder updated_at). Een statuswijziging via
-- wijzig_status krijgt actie 'statuswijziging'; de toelichting (reden, of melding over
-- functiescheiding / automatische terugval) komt uit de transactie-instelling
-- factuurscanner.audit_toelichting.

create function intern.log_wijziging()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_oud         jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_nieuw       jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_rij         jsonb := coalesce(to_jsonb(new), to_jsonb(old));
  v_actie       text := lower(tg_op);
  v_org         uuid;
  v_record      uuid;
  v_velden      text[];
  v_toelichting text;
begin
  -- Kinderen die meeverwijderd worden met hun factuur: het verwijderen van de factuur zelf staat al in de log.
  if tg_op = 'DELETE' and tg_table_name in ('btw_regels', 'factuur_signalen')
     and not exists (select 1 from public.facturen where id = (v_oud ->> 'factuur_id')::uuid) then
    return null;
  end if;

  if tg_table_name = 'btw_regels' then
    select organisatie_id into v_org from public.facturen where id = (v_rij ->> 'factuur_id')::uuid;
  else
    v_org := (v_rij ->> 'organisatie_id')::uuid;
  end if;
  if v_org is null then
    return null;
  end if;

  v_record := case when tg_table_name = 'organisatie_leden' then (v_rij ->> 'user_id')::uuid
                   else (v_rij ->> 'id')::uuid end;

  if tg_op = 'UPDATE' then
    select array_agg(k order by k) into v_velden
    from jsonb_object_keys(v_nieuw) as k
    where k <> 'updated_at' and (v_nieuw -> k) is distinct from (v_oud -> k);
    if v_velden is null then
      return null;
    end if;
    select jsonb_object_agg(k, v_oud -> k), jsonb_object_agg(k, v_nieuw -> k)
      into v_oud, v_nieuw
    from unnest(v_velden) as k;

    if tg_table_name = 'facturen' and 'status' = any (v_velden)
       and current_setting('factuurscanner.audit_actie', true) = 'statuswijziging' then
      v_actie := 'statuswijziging';
    end if;
  end if;

  if tg_table_name = 'facturen' then
    v_toelichting := nullif(current_setting('factuurscanner.audit_toelichting', true), '');
    -- eenmalig gebruiken
    perform set_config('factuurscanner.audit_toelichting', '', true);
  end if;

  insert into public.audit_log (organisatie_id, tabel, record_id, actie, gewijzigde_velden, oud, nieuw, user_id, toelichting)
  values (v_org, tg_table_name, v_record, v_actie, v_velden, v_oud, v_nieuw, auth.uid(), v_toelichting);

  return null;
end;
$$;

revoke execute on function intern.log_wijziging() from public;

create trigger audit_facturen
  after insert or update or delete on public.facturen
  for each row execute function intern.log_wijziging();
create trigger audit_btw_regels
  after insert or update or delete on public.btw_regels
  for each row execute function intern.log_wijziging();
create trigger audit_leveranciers
  after insert or update or delete on public.leveranciers
  for each row execute function intern.log_wijziging();
create trigger audit_factuur_signalen
  after insert or update or delete on public.factuur_signalen
  for each row execute function intern.log_wijziging();
create trigger audit_organisatie_leden
  after insert or update or delete on public.organisatie_leden
  for each row execute function intern.log_wijziging();

-- De toelichting van een terugval alleen gebruiken als er echt iets teruggezet is.
create or replace function intern.status_terug_naar_gescand(p_factuur_id uuid, p_reden text)
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
  perform set_config('factuurscanner.audit_toelichting', '', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Historie van één factuur (factuur, btw-regels en signalen)
-- ---------------------------------------------------------------------------
-- Security invoker: RLS op audit_log bepaalt wat zichtbaar is.

create function public.factuur_historie(p_factuur_id uuid)
returns setof public.audit_log
language sql
stable
security invoker
set search_path = ''
as $$
  select a.*
  from public.audit_log a
  where (a.tabel = 'facturen' and a.record_id = p_factuur_id)
     or (a.tabel in ('btw_regels', 'factuur_signalen')
         and (coalesce(a.nieuw, a.oud) ->> 'factuur_id' = p_factuur_id::text
              or a.record_id in (select s.id from public.factuur_signalen s where s.factuur_id = p_factuur_id)))
  order by a.id;
$$;

revoke execute on function public.factuur_historie(uuid) from public, anon;
grant execute on function public.factuur_historie(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- org_gebruikers: ook gebruikers die (alleen) in de audit log voorkomen
-- ---------------------------------------------------------------------------

create or replace function public.org_gebruikers(p_organisatie_id uuid)
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
    union
    select a.user_id from public.audit_log a where a.organisatie_id = p_organisatie_id
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
