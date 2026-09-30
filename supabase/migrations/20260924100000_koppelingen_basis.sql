-- Fase 4.1: basis voor de koppelingen.
--
-- - audit_log krijgt een bron (app, mailbox, vies, …) en kan gebeurtenissen vastleggen die geen rij
--   wijzigen (export gelukt, VIES opgevraagd). Geen gebruiker = systeem.
-- - wijzig_status wordt een wrapper om intern.wijzig_status_als(gebruiker, …), zodat goedkeuren via een
--   mail-link (fase 4.4) precies dezelfde controles doorloopt.
-- - De service role mag status en workflowkolommen niet meer rechtstreeks wijzigen. Ook server-functies
--   (Edge Functions met de service-rolsleutel) gaan via de RPC's.
-- - koppeling_instellingen: modus live/mock per koppeling.
-- - koppeling_taken: wachtrij met retries; verwerkt door de Edge Function verwerk-taken.

-- ---------------------------------------------------------------------------
-- Audit log: bron en gebeurtenissen
-- ---------------------------------------------------------------------------

-- Bestaande regels krijgen 'app' (alles tot nu toe kwam uit de app). Een kolom toevoegen is geen UPDATE,
-- dus de onveranderlijkheidstrigger blijft intact.
alter table public.audit_log
  add column bron text not null default 'app'
    check (bron in ('app', 'systeem', 'mailbox', 'vies', 'ecb', 'kvk', 'boekhouding', 'betaling', 'email'));

alter table public.audit_log drop constraint audit_log_actie_check;
alter table public.audit_log add constraint audit_log_actie_check
  check (actie in ('insert', 'update', 'delete', 'statuswijziging',
                   'import', 'verrijking', 'export', 'betaling', 'notificatie'));

-- Wie/waar vandaan, als een server-functie namens iemand (of als systeem) iets doet. Transactie-lokaal.
create function intern.zet_audit_context(p_user uuid, p_bron text)
returns void
language sql
set search_path = ''
as $$
  select set_config('factuurscanner.audit_user', coalesce(p_user::text, ''), true),
         set_config('factuurscanner.audit_bron', coalesce(p_bron, ''), true);
$$;

revoke execute on function intern.zet_audit_context(uuid, text) from public;

create function intern.audit_user()
returns uuid
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('factuurscanner.audit_user', true), '')::uuid, auth.uid());
$$;

create function intern.audit_bron(p_user uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('factuurscanner.audit_bron', true), ''),
                  case when p_user is null then 'systeem' else 'app' end);
$$;

revoke execute on function intern.audit_user(), intern.audit_bron(uuid) from public;

-- Zelfde logtrigger als in fase 3.3, nu met gebruiker en bron uit de audit-context.
create or replace function intern.log_wijziging()
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
  v_user        uuid := intern.audit_user();
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
    where k not in ('updated_at', 'bijgewerkt_op') and (v_nieuw -> k) is distinct from (v_oud -> k);
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

  insert into public.audit_log (organisatie_id, tabel, record_id, actie, gewijzigde_velden, oud, nieuw, user_id, toelichting, bron)
  values (v_org, tg_table_name, v_record, v_actie, v_velden, v_oud, v_nieuw, v_user, v_toelichting, intern.audit_bron(v_user));

  return null;
end;
$$;

-- Gebeurtenis zonder rijwijziging (bijv. "export naar Moneybird gelukt"). Hoort de gebeurtenis bij een
-- factuur, geef dan tabel 'facturen' en het factuur-id mee: dan staat hij ook in de historie van de factuur.
-- details.omschrijving is de korte tekst in de tijdlijn.
create function intern.log_gebeurtenis(
  p_organisatie_id uuid,
  p_actie          text,
  p_bron           text,
  p_tabel          text,
  p_record_id      uuid,
  p_details        jsonb default null,
  p_toelichting    text default null,
  p_user           uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := coalesce(p_user, intern.audit_user());
begin
  insert into public.audit_log (organisatie_id, tabel, record_id, actie, nieuw, user_id, toelichting, bron)
  values (p_organisatie_id, p_tabel, p_record_id, p_actie, p_details, v_user, nullif(btrim(p_toelichting), ''),
          coalesce(p_bron, intern.audit_bron(v_user)));
end;
$$;

revoke execute on function intern.log_gebeurtenis(uuid, text, text, text, uuid, jsonb, text, uuid) from public;

-- ---------------------------------------------------------------------------
-- Service role mag de status niet meer rechtstreeks wijzigen
-- ---------------------------------------------------------------------------
-- "Bevoegd" = security-definerfuncties (eigenaar postgres) en de SQL Editor. De service role (Edge
-- Functions met de geheime sleutel) valt er nu buiten: ook die moet via wijzig_status en de andere RPC's.

create or replace function intern.bewaak_factuur()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_bevoegd boolean := current_user not in ('authenticated', 'anon', 'service_role');
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

create or replace function intern.bewaak_btw_regel()
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
  if v_status = 'betaald' and current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'Een betaalde factuur kan niet meer worden gewijzigd.' using errcode = '42501';
  end if;
  if v_status in ('gecontroleerd', 'goedgekeurd') then
    perform intern.status_terug_naar_gescand(v_factuur,
      'Status automatisch teruggezet naar gescand na een wijziging van de btw-regels.');
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- wijzig_status namens een gebruiker
-- ---------------------------------------------------------------------------
-- Zelfde controles als de versie uit fase 3.2, maar voor een opgegeven gebruiker in plaats van
-- auth.uid(). public.wijzig_status roept deze aan met de ingelogde gebruiker en bron 'app'; goedkeuren
-- via een mail-link (fase 4.4) met de gebruiker uit het token en bron 'email'.

create function intern.wijzig_status_als(
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

revoke execute on function intern.wijzig_status_als(uuid, uuid, text, text, text) from public;

create or replace function public.wijzig_status(p_factuur_id uuid, p_nieuwe_status text, p_toelichting text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;
  return intern.wijzig_status_als(auth.uid(), p_factuur_id, p_nieuwe_status, p_toelichting, 'app');
end;
$$;

-- ---------------------------------------------------------------------------
-- Instellingen per koppeling (modus live/mock)
-- ---------------------------------------------------------------------------
-- Geen rij = mock. Een env-variabele KOPPELING_<NAAM>_MODUS in de Supabase secrets gaat altijd voor
-- (dat bepalen de Edge Functions). config bevat alleen niet-geheime instellingen; sleutels staan in de
-- Supabase secrets.

create table public.koppeling_instellingen (
  id              uuid primary key default gen_random_uuid(),
  organisatie_id  uuid not null references public.organisaties (id) on delete cascade,
  koppeling       text not null
                  check (koppeling in ('mailbox', 'vies', 'ecb', 'kvk', 'boekhouding', 'betaling', 'email')),
  modus           text not null default 'mock' check (modus in ('live', 'mock')),
  config          jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  bijgewerkt_door uuid references auth.users (id) on delete set null,
  bijgewerkt_op   timestamptz not null default now(),
  unique (organisatie_id, koppeling)
);

alter table public.koppeling_instellingen enable row level security;

create policy "Leden lezen de koppelingsinstellingen"
  on public.koppeling_instellingen for select to authenticated
  using (public.is_lid(organisatie_id));

revoke all on public.koppeling_instellingen from anon, authenticated;
grant select on public.koppeling_instellingen to authenticated;

create trigger audit_koppeling_instellingen
  after insert or update or delete on public.koppeling_instellingen
  for each row execute function intern.log_wijziging();

create function public.stel_koppeling_in(p_organisatie_id uuid, p_koppeling text, p_modus text, p_config jsonb default null)
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
    raise exception 'Alleen een beheerder kan koppelingen instellen.' using errcode = '42501';
  end if;
  if p_modus is null or p_modus not in ('live', 'mock') then
    raise exception 'Modus moet "live" of "mock" zijn.' using errcode = '22023';
  end if;
  if p_config is not null and jsonb_typeof(p_config) <> 'object' then
    raise exception 'Ongeldige configuratie.' using errcode = '22023';
  end if;

  insert into public.koppeling_instellingen as k (organisatie_id, koppeling, modus, config, bijgewerkt_door)
  values (p_organisatie_id, p_koppeling, p_modus, coalesce(p_config, '{}'::jsonb), auth.uid())
  on conflict (organisatie_id, koppeling) do update set
    modus           = excluded.modus,
    config          = coalesce(p_config, k.config),
    bijgewerkt_door = excluded.bijgewerkt_door,
    bijgewerkt_op   = now();
end;
$$;

revoke execute on function public.stel_koppeling_in(uuid, text, text, jsonb) from public, anon;
grant execute on function public.stel_koppeling_in(uuid, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Takenwachtrij met retries
-- ---------------------------------------------------------------------------
-- Status: wachtrij (ook: wacht op een nieuwe poging) → bezig → gelukt | opgegeven.
-- sleutel = idempotentie: zolang er een actieve taak (wachtrij/bezig) met dezelfde soort en sleutel is,
-- wordt er geen tweede aangemaakt.

create table public.koppeling_taken (
  id                 uuid primary key default gen_random_uuid(),
  organisatie_id     uuid not null references public.organisaties (id) on delete cascade,
  soort              text not null
                     check (soort in ('test', 'mailbox', 'vies', 'ecb', 'kvk', 'boekhouding', 'betaling', 'email')),
  factuur_id         uuid references public.facturen (id) on delete cascade,
  sleutel            text not null check (btrim(sleutel) <> ''),
  payload            jsonb not null default '{}'::jsonb,
  status             text not null default 'wachtrij' check (status in ('wachtrij', 'bezig', 'gelukt', 'opgegeven')),
  pogingen           int not null default 0 check (pogingen >= 0),
  max_pogingen       int not null default 6 check (max_pogingen between 1 and 20),
  volgende_poging_op timestamptz not null default now(),
  geclaimd_op        timestamptz,
  laatste_fout       text,
  resultaat          jsonb,
  created_at         timestamptz not null default now(),
  bijgewerkt_op      timestamptz not null default now()
);

create unique index koppeling_taken_actief_uniek
  on public.koppeling_taken (organisatie_id, soort, sleutel)
  where status in ('wachtrij', 'bezig');
create index koppeling_taken_klaar_idx on public.koppeling_taken (volgende_poging_op) where status = 'wachtrij';
create index koppeling_taken_factuur_idx on public.koppeling_taken (factuur_id, soort, created_at desc);
create index koppeling_taken_organisatie_idx on public.koppeling_taken (organisatie_id, created_at desc);

alter table public.koppeling_taken enable row level security;

create policy "Leden zien de taken van hun organisatie"
  on public.koppeling_taken for select to authenticated
  using (public.is_lid(organisatie_id));

revoke all on public.koppeling_taken from anon, authenticated;
grant select on public.koppeling_taken to authenticated;

-- Laatste taak per factuur en soort, voor de statusbadges in de factuurlijst.
create view public.factuur_koppelingstatus
with (security_invoker = true)
as
  select distinct on (t.factuur_id, t.soort)
    t.organisatie_id, t.factuur_id, t.soort, t.id as taak_id, t.status, t.pogingen, t.max_pogingen,
    t.volgende_poging_op, t.laatste_fout, t.bijgewerkt_op
  from public.koppeling_taken t
  where t.factuur_id is not null
  order by t.factuur_id, t.soort, t.created_at desc, t.id;

revoke all on public.factuur_koppelingstatus from anon, authenticated;
grant select on public.factuur_koppelingstatus to authenticated;

-- Wachttijd vóór poging n+1: 1 min, 5 min, 30 min, 2 uur, daarna 12 uur.
create function intern.wachttijd(p_pogingen int)
returns interval
language sql
immutable
set search_path = ''
as $$
  select case
    when p_pogingen <= 1 then interval '1 minute'
    when p_pogingen = 2 then interval '5 minutes'
    when p_pogingen = 3 then interval '30 minutes'
    when p_pogingen = 4 then interval '2 hours'
    else interval '12 hours'
  end;
$$;

-- Actie en bron in de audit log per soort taak (test wordt niet gelogd).
create function intern.taak_audit(p_soort text, out actie text, out bron text)
language sql
immutable
set search_path = ''
as $$
  select
    case p_soort
      when 'mailbox' then 'import'
      when 'vies' then 'verrijking'
      when 'ecb' then 'verrijking'
      when 'kvk' then 'verrijking'
      when 'boekhouding' then 'export'
      when 'betaling' then 'betaling'
      when 'email' then 'notificatie'
    end,
    case when p_soort = 'test' then null else p_soort end;
$$;

-- Maakt de Edge Function verwerk-taken wakker (fire-and-forget). Standaard doet deze niets; op Supabase
-- (met pg_net en Vault) wordt hij onderaan deze migratie vervangen.
create function intern.start_worker()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  null;
end;
$$;

revoke execute on function intern.start_worker() from public;

-- Zet een taak in de wachtrij (of geeft de al actieve taak met dezelfde sleutel terug).
create function intern.plan_taak(
  p_organisatie_id uuid,
  p_soort          text,
  p_sleutel        text,
  p_factuur_id     uuid default null,
  p_payload        jsonb default '{}'::jsonb,
  p_vertraging     interval default interval '0'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.koppeling_taken (organisatie_id, soort, sleutel, factuur_id, payload, volgende_poging_op)
  values (p_organisatie_id, p_soort, p_sleutel, p_factuur_id, coalesce(p_payload, '{}'::jsonb), now() + p_vertraging)
  on conflict (organisatie_id, soort, sleutel) where status in ('wachtrij', 'bezig') do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.koppeling_taken
    where organisatie_id = p_organisatie_id and soort = p_soort and sleutel = p_sleutel
      and status in ('wachtrij', 'bezig');
  elsif p_vertraging <= interval '0' then
    perform intern.start_worker();
  end if;
  return v_id;
end;
$$;

revoke execute on function intern.plan_taak(uuid, text, text, uuid, jsonb, interval) from public;

-- Claimt taken die klaar zijn om te draaien (alleen de service role: de Edge Function verwerk-taken).
-- Taken die langer dan 10 minuten "bezig" zijn (worker gecrasht of time-out) komen eerst terug in de wachtrij.
create function public.claim_taken(p_max int default 10, p_soorten text[] default null)
returns setof public.koppeling_taken
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.koppeling_taken
  set status        = case when pogingen >= max_pogingen then 'opgegeven' else 'wachtrij' end,
      laatste_fout  = 'Verwerking onderbroken (geen antwoord binnen 10 minuten).',
      geclaimd_op   = null,
      bijgewerkt_op = now()
  where status = 'bezig' and geclaimd_op < now() - interval '10 minutes';

  return query
  update public.koppeling_taken t
  set status = 'bezig', geclaimd_op = now(), pogingen = t.pogingen + 1, bijgewerkt_op = now()
  where t.id in (
    select k.id from public.koppeling_taken k
    where k.status = 'wachtrij'
      and k.volgende_poging_op <= now()
      and (p_soorten is null or k.soort = any (p_soorten))
    order by k.volgende_poging_op, k.created_at
    limit greatest(1, least(coalesce(p_max, 10), 50))
    for update skip locked
  )
  returning t.*;
end;
$$;

-- Rondt een geclaimde taak af. Mislukt: opnieuw proberen met oplopende wachttijd, tenzij de maximale
-- pogingen bereikt zijn of p_opnieuw false is (fout die een nieuwe poging niet oplost). Het eindresultaat
-- (gelukt of opgegeven) komt in de audit log. Geeft de nieuwe status terug.
create function public.rond_taak_af(
  p_taak_id   uuid,
  p_gelukt    boolean,
  p_resultaat jsonb default null,
  p_fout      text default null,
  p_opnieuw   boolean default true
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t        public.koppeling_taken%rowtype;
  v_status text;
  v_fout   text := left(nullif(btrim(p_fout), ''), 1000);
  v_audit  record;
begin
  select * into t from public.koppeling_taken where id = p_taak_id for update;
  if not found then
    raise exception 'Taak niet gevonden.' using errcode = 'P0002';
  end if;
  if t.status <> 'bezig' then
    raise exception 'Taak is niet in behandeling (status %).', t.status using errcode = '22023';
  end if;

  v_status := case
    when p_gelukt then 'gelukt'
    when not p_opnieuw or t.pogingen >= t.max_pogingen then 'opgegeven'
    else 'wachtrij'
  end;

  update public.koppeling_taken
  set status             = v_status,
      resultaat          = case when p_gelukt then p_resultaat else resultaat end,
      laatste_fout       = case when p_gelukt then null else coalesce(v_fout, 'Onbekende fout.') end,
      volgende_poging_op = case when v_status = 'wachtrij' then now() + intern.wachttijd(t.pogingen)
                                else volgende_poging_op end,
      geclaimd_op        = null,
      bijgewerkt_op      = now()
  where id = t.id;

  select * into v_audit from intern.taak_audit(t.soort);
  if v_status in ('gelukt', 'opgegeven') and v_audit.actie is not null then
    perform intern.log_gebeurtenis(
      t.organisatie_id, v_audit.actie, v_audit.bron,
      case when t.factuur_id is not null then 'facturen' else 'koppeling_taken' end,
      coalesce(t.factuur_id, t.id),
      jsonb_build_object('taak_id', t.id, 'soort', t.soort, 'status', v_status, 'pogingen', t.pogingen)
        || coalesce(case when p_gelukt then p_resultaat end, '{}'::jsonb),
      case when v_status = 'opgegeven' then coalesce(v_fout, 'Onbekende fout.') end,
      null);
  end if;

  return v_status;
end;
$$;

revoke execute on function public.claim_taken(int, text[]), public.rond_taak_af(uuid, boolean, jsonb, text, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_taken(int, text[]), public.rond_taak_af(uuid, boolean, jsonb, text, boolean)
  to service_role;

-- Een opgegeven (of wachtende) taak meteen opnieuw laten proberen. Elk lid mag dit: de taak zelf
-- controleert opnieuw of de actie is toegestaan (bijv. alleen goedgekeurde facturen exporteren).
create function public.probeer_taak_opnieuw(p_taak_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t       public.koppeling_taken%rowtype;
  v_audit record;
begin
  if auth.uid() is null then
    raise exception 'Niet ingelogd.' using errcode = '42501';
  end if;
  select * into t from public.koppeling_taken where id = p_taak_id for update;
  if not found or not public.is_lid(t.organisatie_id) then
    raise exception 'Taak niet gevonden.' using errcode = 'P0002';
  end if;
  if t.status in ('bezig', 'gelukt') then
    raise exception 'Deze taak is al in behandeling of gelukt.' using errcode = '22023';
  end if;
  if t.status = 'opgegeven' and exists (
    select 1 from public.koppeling_taken
    where organisatie_id = t.organisatie_id and soort = t.soort and sleutel = t.sleutel
      and status in ('wachtrij', 'bezig')
  ) then
    raise exception 'Er staat al een nieuwe poging voor deze taak in de wachtrij.' using errcode = '22023';
  end if;

  update public.koppeling_taken
  set status = 'wachtrij', pogingen = 0, volgende_poging_op = now(), bijgewerkt_op = now()
  where id = t.id;

  select * into v_audit from intern.taak_audit(t.soort);
  if v_audit.actie is not null then
    perform intern.log_gebeurtenis(
      t.organisatie_id, v_audit.actie, 'app',
      case when t.factuur_id is not null then 'facturen' else 'koppeling_taken' end,
      coalesce(t.factuur_id, t.id),
      jsonb_build_object('taak_id', t.id, 'soort', t.soort, 'status', 'wachtrij',
                         'omschrijving', 'Handmatig opnieuw geprobeerd'),
      null, auth.uid());
  end if;

  perform intern.start_worker();
end;
$$;

-- Testtaak om te controleren of de wachtrij en de worker werken (controller of beheerder).
create function public.plan_testtaak(p_organisatie_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.heeft_rol(p_organisatie_id, array['controller', 'beheerder']) then
    raise exception 'Alleen een controller of beheerder kan de wachtrij testen.' using errcode = '42501';
  end if;
  return intern.plan_taak(p_organisatie_id, 'test', 'test-' || gen_random_uuid()::text, null,
                          jsonb_build_object('aangevraagd_door', auth.uid()));
end;
$$;

revoke execute on function public.probeer_taak_opnieuw(uuid), public.plan_testtaak(uuid) from public, anon;
grant execute on function public.probeer_taak_opnieuw(uuid), public.plan_testtaak(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Worker elke minuut aanroepen (alleen op Supabase: pg_cron, pg_net en Vault)
-- ---------------------------------------------------------------------------
-- De URL en het gedeelde geheim staan in Supabase Vault (zie README, "Koppelingen: basis"). Zolang ze
-- ontbreken, doet de cronjob niets.

do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net')
     and exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_namespace where nspname = 'vault') then
    create extension if not exists pg_net;
    create extension if not exists pg_cron;

    execute $f$
      create or replace function intern.start_worker()
      returns void
      language plpgsql
      security definer
      set search_path = ''
      as $b$
      declare
        v_url    text;
        v_geheim text;
      begin
        select decrypted_secret into v_url from vault.decrypted_secrets where name = 'factuurscanner_project_url';
        select decrypted_secret into v_geheim from vault.decrypted_secrets where name = 'factuurscanner_worker_geheim';
        if v_url is null or v_geheim is null then
          return;
        end if;
        perform net.http_post(
          url := rtrim(v_url, '/') || '/functions/v1/verwerk-taken',
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-geheim', v_geheim),
          body := '{}'::jsonb,
          timeout_milliseconds := 5000);
      end;
      $b$;
    $f$;

    perform cron.schedule('factuurscanner-verwerk-taken', '* * * * *', 'select intern.start_worker()');
  end if;
end;
$do$;
