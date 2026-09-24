-- Fase 4.5: export naar het boekhoudpakket (Moneybird live; Exact Online en SnelStart als mock).
--
-- - boekhoud_mappings: per pakket de koppeling van onze grootboekrekeningen, btw-tarieven en leveranciers aan
--   de id's in het pakket. Grootboek en btw stelt een controller/beheerder in; leveranciers legt de export zelf
--   vast (gevonden of aangemaakt contact) en zijn daarna aan te passen.
-- - boekhoud_exports: één export per factuur, met het externe id. Dubbele export is zo onmogelijk (uniek per
--   factuur); de worker zoekt bovendien vóór het aanmaken in het pakket of de factuur er al staat.
-- - Alleen goedgekeurde (of daarna betaalde) facturen worden geëxporteerd. Na goedkeuren plant een trigger de
--   export (instelbaar: config.automatisch, standaard aan); de knop "Exporteren" plant de rest.
-- - Na export is de factuur inhoudelijk vergrendeld (zoals bij betaald) en niet meer te verwijderen:
--   correcties lopen via de boekhouding. Status "betaald" zetten blijft mogelijk.

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------

alter table public.facturen add column geexporteerd_op timestamptz;

comment on column public.facturen.geexporteerd_op is 'Tijdstip van de export naar het boekhoudpakket (zie boekhoud_exports); daarna inhoudelijk vergrendeld';

create table public.boekhoud_mappings (
  id              uuid primary key default gen_random_uuid(),
  organisatie_id  uuid not null references public.organisaties (id) on delete cascade,
  provider        text not null check (provider in ('moneybird', 'exact', 'snelstart')),
  soort           text not null check (soort in ('grootboek', 'btw', 'leverancier')),
  -- grootboek: grootboekrekening_id;  btw: percentage ("21", "9", "0");  leverancier: leverancier_id
  intern          text not null check (btrim(intern) <> ''),
  extern_id       text not null check (btrim(extern_id) <> ''),
  extern_naam     text,
  -- true = door de export gevonden of aangemaakt (leverancier), false = door een gebruiker ingesteld
  automatisch     boolean not null default false,
  bijgewerkt_door uuid references auth.users (id) on delete set null,
  bijgewerkt_op   timestamptz not null default now(),
  unique (organisatie_id, provider, soort, intern)
);

create table public.boekhoud_exports (
  id              uuid primary key default gen_random_uuid(),
  organisatie_id  uuid not null references public.organisaties (id) on delete cascade,
  factuur_id      uuid not null unique references public.facturen (id) on delete cascade,
  provider        text not null check (provider in ('moneybird', 'exact', 'snelstart')),
  modus           text not null check (modus in ('live', 'mock')),
  extern_id       text not null,
  extern_url      text,
  -- { leverancier_extern_id, al_aanwezig, bijlage, regels }
  details         jsonb not null default '{}'::jsonb,
  geexporteerd_op timestamptz not null default now()
);

create index boekhoud_exports_organisatie_idx on public.boekhoud_exports (organisatie_id, geexporteerd_op desc);

alter table public.boekhoud_mappings enable row level security;
alter table public.boekhoud_exports enable row level security;

create policy "Leden lezen de mappings" on public.boekhoud_mappings for select to authenticated
  using (public.is_lid(organisatie_id));
create policy "Leden lezen de exports" on public.boekhoud_exports for select to authenticated
  using (public.is_lid(organisatie_id));

revoke all on public.boekhoud_mappings, public.boekhoud_exports from anon, authenticated;
grant select on public.boekhoud_mappings, public.boekhoud_exports to authenticated;

-- Mappings bepalen waar een boeking terechtkomt: elke wijziging in de audit log.
create trigger audit_boekhoud_mappings
  after insert or update or delete on public.boekhoud_mappings
  for each row execute function intern.log_wijziging();

-- ---------------------------------------------------------------------------
-- Vergrendeling na export
-- ---------------------------------------------------------------------------
-- geexporteerd_op zet alleen registreer_export (security definer). Daarna: geen inhoudelijke wijzigingen,
-- geen btw-regels wijzigen en niet verwijderen (behalve als de hele organisatie wordt verwijderd).

create function intern.bewaak_export()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_bevoegd boolean := current_user not in ('authenticated', 'anon', 'service_role');
begin
  if tg_op = 'INSERT' then
    if not v_bevoegd then
      new.geexporteerd_op := null;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.geexporteerd_op is not null and not v_bevoegd
       and exists (select 1 from public.organisaties where id = old.organisatie_id) then
      raise exception 'Deze factuur is geëxporteerd naar het boekhoudpakket en kan niet worden verwijderd.' using errcode = '42501';
    end if;
    return old;
  end if;

  if not v_bevoegd then
    new.geexporteerd_op := old.geexporteerd_op;
  end if;
  if old.geexporteerd_op is not null and not v_bevoegd
     and (new.leverancier_id, new.leverancier_naam, new.factuurnummer, new.factuurdatum, new.vervaldatum,
          new.valuta, new.bedrag_excl, new.totaal_incl, new.iban, new.btw_nummer, new.kvk_nummer,
          new.grootboekrekening_id)
     is distinct from (old.leverancier_id, old.leverancier_naam, old.factuurnummer, old.factuurdatum,
                       old.vervaldatum, old.valuta, old.bedrag_excl, old.totaal_incl, old.iban, old.btw_nummer,
                       old.kvk_nummer, old.grootboekrekening_id) then
    raise exception 'Deze factuur is geëxporteerd naar het boekhoudpakket en kan niet meer worden gewijzigd. Corrigeer hem daar.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke execute on function intern.bewaak_export() from public;

create trigger facturen_export_slot
  before insert or update or delete on public.facturen
  for each row execute function intern.bewaak_export();

create function intern.bewaak_btw_export()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_factuur uuid := case when tg_op = 'DELETE' then old.factuur_id else new.factuur_id end;
begin
  if current_user in ('authenticated', 'anon', 'service_role')
     and exists (select 1 from public.facturen where id = v_factuur and geexporteerd_op is not null) then
    raise exception 'Deze factuur is geëxporteerd naar het boekhoudpakket en kan niet meer worden gewijzigd. Corrigeer hem daar.'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke execute on function intern.bewaak_btw_export() from public;

create trigger btw_regels_export_slot
  before insert or update or delete on public.btw_regels
  for each row execute function intern.bewaak_btw_export();

-- ---------------------------------------------------------------------------
-- Export inplannen
-- ---------------------------------------------------------------------------

-- Instellingen van de koppeling: { provider: moneybird|exact|snelstart (standaard moneybird), automatisch: bool }
create function intern.boekhoud_provider(p_organisatie_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select case when config ->> 'provider' in ('moneybird', 'exact', 'snelstart') then config ->> 'provider' end
     from public.koppeling_instellingen where organisatie_id = p_organisatie_id and koppeling = 'boekhouding'),
    'moneybird');
$$;

revoke execute on function intern.boekhoud_provider(uuid) from public;

create function intern.plan_export_na_goedkeuren()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'goedgekeurd' and old.status is distinct from 'goedgekeurd' and new.geexporteerd_op is null
     and coalesce((select (config ->> 'automatisch')::boolean from public.koppeling_instellingen
                   where organisatie_id = new.organisatie_id and koppeling = 'boekhouding'
                     and config ->> 'automatisch' in ('true', 'false')), true) then
    perform intern.plan_taak(new.organisatie_id, 'boekhouding', new.id::text, new.id, '{}'::jsonb);
  end if;
  return null;
end;
$$;

revoke execute on function intern.plan_export_na_goedkeuren() from public;

create trigger facturen_export_plannen
  after update of status on public.facturen
  for each row execute function intern.plan_export_na_goedkeuren();

-- Knop "Exporteren" (controller/beheerder): de opgegeven facturen, of alle goedgekeurde/betaalde facturen die
-- nog niet zijn geëxporteerd. Een factuur met een lopende export krijgt geen tweede taak. Geeft het aantal.
create function public.plan_exports(p_organisatie_id uuid, p_factuur_ids uuid[] default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n  int := 0;
begin
  if not public.heeft_rol(p_organisatie_id, array['controller', 'beheerder']) then
    raise exception 'Alleen een controller of beheerder kan exporteren.' using errcode = '42501';
  end if;
  for v_id in
    select f.id from public.facturen f
    where f.organisatie_id = p_organisatie_id
      and f.status in ('goedgekeurd', 'betaald')
      and f.geexporteerd_op is null
      and (p_factuur_ids is null or f.id = any (p_factuur_ids))
      and not exists (select 1 from public.koppeling_taken t
                      where t.soort = 'boekhouding' and t.sleutel = f.id::text and t.status in ('wachtrij', 'bezig'))
    order by f.goedgekeurd_op nulls last, f.id
  loop
    perform intern.plan_taak(p_organisatie_id, 'boekhouding', v_id::text, v_id, jsonb_build_object('aangevraagd_door', auth.uid()));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke execute on function public.plan_exports(uuid, uuid[]) from public, anon;
grant execute on function public.plan_exports(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Mappings instellen (controller/beheerder)
-- ---------------------------------------------------------------------------
-- p_extern_id leeg = mapping verwijderen.

create function public.stel_boekhoud_mapping_in(
  p_organisatie_id uuid,
  p_provider       text,
  p_soort          text,
  p_intern         text,
  p_extern_id      text,
  p_extern_naam    text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.heeft_rol(p_organisatie_id, array['controller', 'beheerder']) then
    raise exception 'Alleen een controller of beheerder kan de koppeling met het boekhoudpakket instellen.' using errcode = '42501';
  end if;
  if p_provider not in ('moneybird', 'exact', 'snelstart') or p_soort not in ('grootboek', 'btw', 'leverancier') then
    raise exception 'Onbekend pakket of soort mapping.' using errcode = '22023';
  end if;
  if p_soort = 'grootboek' and not exists (
    select 1 from public.grootboekrekeningen where id::text = p_intern and organisatie_id = p_organisatie_id) then
    raise exception 'Grootboekrekening niet gevonden.' using errcode = 'P0002';
  end if;
  if p_soort = 'leverancier' and not exists (
    select 1 from public.leveranciers where id::text = p_intern and organisatie_id = p_organisatie_id) then
    raise exception 'Leverancier niet gevonden.' using errcode = 'P0002';
  end if;
  if p_soort = 'btw' and p_intern !~ '^\d{1,2}(\.\d{1,2})?$' then
    raise exception 'Btw-tarief moet een percentage zijn (bijv. 21).' using errcode = '22023';
  end if;

  if coalesce(btrim(p_extern_id), '') = '' then
    delete from public.boekhoud_mappings
    where organisatie_id = p_organisatie_id and provider = p_provider and soort = p_soort and intern = p_intern;
    return;
  end if;

  insert into public.boekhoud_mappings as m (organisatie_id, provider, soort, intern, extern_id, extern_naam, automatisch, bijgewerkt_door)
  values (p_organisatie_id, p_provider, p_soort, p_intern, btrim(p_extern_id), nullif(btrim(p_extern_naam), ''), false, auth.uid())
  on conflict (organisatie_id, provider, soort, intern) do update set
    extern_id = excluded.extern_id, extern_naam = excluded.extern_naam, automatisch = false,
    bijgewerkt_door = excluded.bijgewerkt_door, bijgewerkt_op = now();
end;
$$;

revoke execute on function public.stel_boekhoud_mapping_in(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.stel_boekhoud_mapping_in(uuid, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Export uitvoeren (service role: de worker)
-- ---------------------------------------------------------------------------

-- Alles wat de worker nodig heeft, en of de factuur (nog) geëxporteerd mag worden.
-- { status: 'exporteren' | 'al_geexporteerd' | 'niet_toegestaan', reden, provider, factuur, btw_regels[],
--   leverancier, grootboekrekening, mappings: { grootboek, btw: { "21": {...} }, leverancier }, export }
create function public.export_gegevens(p_factuur_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f          public.facturen%rowtype;
  v_provider text;
  v_export   public.boekhoud_exports%rowtype;
begin
  select * into f from public.facturen where id = p_factuur_id;
  if not found then
    return jsonb_build_object('status', 'niet_toegestaan', 'reden', 'De factuur bestaat niet meer.');
  end if;

  select * into v_export from public.boekhoud_exports where factuur_id = f.id;
  if found then
    return jsonb_build_object('status', 'al_geexporteerd', 'reden',
      format('Al geëxporteerd naar %s (%s).', v_export.provider, v_export.extern_id),
      'export', to_jsonb(v_export));
  end if;
  if f.status not in ('goedgekeurd', 'betaald') or f.goedgekeurd_op is null then
    return jsonb_build_object('status', 'niet_toegestaan', 'reden',
      format('Alleen goedgekeurde facturen worden geëxporteerd (status: %s).', f.status));
  end if;

  v_provider := intern.boekhoud_provider(f.organisatie_id);

  return jsonb_build_object(
    'status', 'exporteren',
    'provider', v_provider,
    'organisatie_id', f.organisatie_id,
    'factuur', jsonb_build_object(
      'id', f.id, 'factuurnummer', f.factuurnummer, 'factuurdatum', coalesce(f.factuurdatum, f.created_at::date),
      'vervaldatum', f.vervaldatum, 'valuta', coalesce(f.valuta, 'EUR'), 'bedrag_excl', f.bedrag_excl,
      'totaal_incl', f.totaal_incl, 'iban', f.iban, 'bestand_pad', f.bestand_pad, 'bestandsnaam', f.bestandsnaam),
    'btw_regels', coalesce((
      select jsonb_agg(jsonb_build_object('tarief', r.tarief, 'grondslag', r.grondslag, 'btw_bedrag', r.btw_bedrag) order by r.volgorde)
      from public.btw_regels r where r.factuur_id = f.id), '[]'::jsonb),
    'leverancier', (
      select jsonb_build_object('id', l.id, 'naam', l.naam, 'btw_nummer', l.btw_nummer, 'kvk_nummer', l.kvk_nummer, 'iban', l.iban)
      from public.leveranciers l where l.id = f.leverancier_id),
    'grootboekrekening', (
      select jsonb_build_object('id', g.id, 'code', g.code, 'omschrijving', g.omschrijving)
      from public.grootboekrekeningen g where g.id = f.grootboekrekening_id),
    'mappings', jsonb_build_object(
      'grootboek', (select jsonb_build_object('extern_id', m.extern_id, 'extern_naam', m.extern_naam)
                    from public.boekhoud_mappings m
                    where m.organisatie_id = f.organisatie_id and m.provider = v_provider and m.soort = 'grootboek'
                      and m.intern = f.grootboekrekening_id::text),
      'btw', coalesce((select jsonb_object_agg(m.intern, jsonb_build_object('extern_id', m.extern_id, 'extern_naam', m.extern_naam))
                       from public.boekhoud_mappings m
                       where m.organisatie_id = f.organisatie_id and m.provider = v_provider and m.soort = 'btw'), '{}'::jsonb),
      'leverancier', (select jsonb_build_object('extern_id', m.extern_id, 'extern_naam', m.extern_naam)
                      from public.boekhoud_mappings m
                      where m.organisatie_id = f.organisatie_id and m.provider = v_provider and m.soort = 'leverancier'
                        and m.intern = f.leverancier_id::text))
  );
end;
$$;

-- Leverancier gevonden of aangemaakt in het pakket: mapping vastleggen (overschrijft geen handmatige mapping).
create function public.sla_leverancier_mapping_op(
  p_organisatie_id uuid,
  p_provider       text,
  p_leverancier_id uuid,
  p_extern_id      text,
  p_extern_naam    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform intern.zet_audit_context(null, 'boekhouding');
  insert into public.boekhoud_mappings (organisatie_id, provider, soort, intern, extern_id, extern_naam, automatisch)
  values (p_organisatie_id, p_provider, 'leverancier', p_leverancier_id::text, p_extern_id, p_extern_naam, true)
  on conflict (organisatie_id, provider, soort, intern) do nothing;
  perform intern.zet_audit_context(null, null);
end;
$$;

-- Export vastleggen en de factuur vergrendelen. Nog een keer registreren met hetzelfde externe id = niets;
-- een ander extern id voor dezelfde factuur = fout (zou een dubbele boeking betekenen).
create function public.registreer_export(
  p_factuur_id uuid,
  p_provider   text,
  p_modus      text,
  p_extern_id  text,
  p_extern_url text default null,
  p_details    jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  f         public.facturen%rowtype;
  v_bestaand public.boekhoud_exports%rowtype;
begin
  select * into f from public.facturen where id = p_factuur_id for update;
  if not found then
    raise exception 'Factuur niet gevonden.' using errcode = 'P0002';
  end if;
  select * into v_bestaand from public.boekhoud_exports where factuur_id = f.id;
  if found then
    if v_bestaand.extern_id = p_extern_id then
      return;
    end if;
    raise exception 'Factuur is al geëxporteerd als % (nu %).', v_bestaand.extern_id, p_extern_id using errcode = '23505';
  end if;

  perform intern.zet_audit_context(null, 'boekhouding');
  insert into public.boekhoud_exports (organisatie_id, factuur_id, provider, modus, extern_id, extern_url, details)
  values (f.organisatie_id, f.id, p_provider, p_modus, p_extern_id, p_extern_url, coalesce(p_details, '{}'::jsonb));
  update public.facturen set geexporteerd_op = now() where id = f.id;
  perform intern.zet_audit_context(null, null);
end;
$$;

revoke execute on function
  public.export_gegevens(uuid),
  public.sla_leverancier_mapping_op(uuid, text, uuid, text, text),
  public.registreer_export(uuid, text, text, text, text, jsonb)
from public, anon, authenticated;
grant execute on function
  public.export_gegevens(uuid),
  public.sla_leverancier_mapping_op(uuid, text, uuid, text, text),
  public.registreer_export(uuid, text, text, text, text, jsonb)
to service_role;
