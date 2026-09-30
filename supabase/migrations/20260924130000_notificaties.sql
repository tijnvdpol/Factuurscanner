-- Fase 4.4: e-mailnotificaties (Resend), met goedkeuren en afkeuren vanuit de mail.
--
-- - notificaties: één rij per mail (outbox). De database bepaalt wie een mail krijgt (triggers en een
--   dagelijkse cronjob) en plant per notificatie een email-taak; de worker stelt de mail op en verstuurt
--   hem via Resend (live) of legt hem alleen vast (mock).
-- - notificatie_inhoud: de volledige mail, alleen in mock-modus en alleen leesbaar voor de ontvanger
--   ("Mijn mails"). Zo zijn de knoppen in een mock-mail niet bruikbaar voor andere leden.
-- - mail_acties: de eenmalige goedkeur/afkeur-actie achter de knoppen in een goedkeuringsmail. De link
--   bevat een door de server ondertekend token (HMAC, zie _shared/koppelingen/mailtoken.ts) met het id en
--   de verlooptijd; de database bewaakt eenmalig gebruik. voer_mail_actie_uit doet dezelfde controles als
--   de app (intern.wijzig_status_als: rol, limiet in euro, signalen, grootboekrekening) plus een strikte
--   functiescheiding: nooit goedkeuren wat je zelf hebt ingevoerd of gecontroleerd, ook niet in een
--   organisatie met één lid.
--
-- Wanneer er een mail uitgaat:
--   goedkeuren       factuur wordt gecontroleerd → elk lid dat hem mag goedkeuren (rol, limiet in euro,
--                    niet de invoerder of controleur). Bij vreemde valuta krijgen leden met een limiet de
--                    mail pas als de koers bekend is.
--   afgekeurd        factuur wordt afgekeurd → invoerder en controleur (niet wie afkeurde); zijn die er
--                    niet, dan de controllers en beheerders.
--   export_mislukt   een boekhoudexport is opgegeven → controllers en beheerders.
--   bijna_vervallen  dagelijks (08:00): openstaande facturen met een vervaldatum binnen N dagen (standaard 3)
--                    → controllers en beheerders, één mail per persoon, elke factuur één keer.
--   test             knop "Stuur een testmail" op de pagina Koppelingen.

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------

create table public.notificaties (
  id             uuid primary key default gen_random_uuid(),
  organisatie_id uuid not null references public.organisaties (id) on delete cascade,
  soort          text not null check (soort in ('goedkeuren', 'afgekeurd', 'export_mislukt', 'bijna_vervallen', 'test')),
  -- Idempotentie: dezelfde gebeurtenis voor dezelfde ontvanger levert nooit twee mails op.
  sleutel        text not null check (btrim(sleutel) <> ''),
  ontvanger_id   uuid references auth.users (id) on delete set null,
  factuur_id     uuid references public.facturen (id) on delete set null,
  -- goedkeuren: { gecontroleerd_op };  afgekeurd: { reden, afgekeurd_door };
  -- export_mislukt: { taak_id, fout };  bijna_vervallen: { factuur_ids[], datum, dagen }
  details        jsonb not null default '{}'::jsonb,
  -- wachtrij → verzonden | overgeslagen (niet meer relevant) | mislukt (na alle pogingen)
  status         text not null default 'wachtrij' check (status in ('wachtrij', 'verzonden', 'overgeslagen', 'mislukt')),
  modus          text check (modus in ('live', 'mock')),
  ontvanger_email text,
  onderwerp      text,
  provider_id    text,
  reden          text,
  created_at     timestamptz not null default now(),
  verzonden_op   timestamptz,
  unique (organisatie_id, soort, sleutel)
);

create index notificaties_organisatie_idx on public.notificaties (organisatie_id, created_at desc);
create index notificaties_ontvanger_idx on public.notificaties (ontvanger_id, created_at desc);
create index notificaties_factuur_idx on public.notificaties (factuur_id);

create table public.notificatie_inhoud (
  notificatie_id uuid primary key references public.notificaties (id) on delete cascade,
  organisatie_id uuid not null references public.organisaties (id) on delete cascade,
  ontvanger_id   uuid references auth.users (id) on delete cascade,
  onderwerp      text not null,
  html           text not null,
  tekst          text not null,
  created_at     timestamptz not null default now()
);

create table public.mail_acties (
  id               uuid primary key default gen_random_uuid(),
  organisatie_id   uuid not null references public.organisaties (id) on delete cascade,
  notificatie_id   uuid not null unique references public.notificaties (id) on delete cascade,
  factuur_id       uuid not null references public.facturen (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  -- De controle waarvoor de mail is verstuurd; is de factuur daarna opnieuw gecontroleerd, dan vervalt de link.
  gecontroleerd_op timestamptz not null,
  verloopt_op      timestamptz not null,
  gebruikt_op      timestamptz,
  gebruikt_actie   text check (gebruikt_actie in ('goedkeuren', 'afkeuren')),
  created_at       timestamptz not null default now()
);

create index mail_acties_factuur_idx on public.mail_acties (factuur_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- notificaties: je eigen mails, en controllers/beheerders zien alle mails van de organisatie (zonder inhoud).
-- notificatie_inhoud: alleen de ontvanger. mail_acties: niemand (alleen via de functies hieronder).

alter table public.notificaties enable row level security;
alter table public.notificatie_inhoud enable row level security;
alter table public.mail_acties enable row level security;

create policy "Eigen notificaties, of alle als controller/beheerder"
  on public.notificaties for select to authenticated
  using (ontvanger_id = auth.uid() and public.is_lid(organisatie_id)
         or public.heeft_rol(organisatie_id, array['controller', 'beheerder']));

create policy "Alleen de ontvanger leest de inhoud"
  on public.notificatie_inhoud for select to authenticated
  using (ontvanger_id = auth.uid() and public.is_lid(organisatie_id));

revoke all on public.notificaties, public.notificatie_inhoud, public.mail_acties from anon, authenticated;
grant select on public.notificaties, public.notificatie_inhoud to authenticated;

-- ---------------------------------------------------------------------------
-- Hulpfuncties
-- ---------------------------------------------------------------------------

-- Legt een notificatie vast en plant de email-taak. Bestaat dezelfde (soort, sleutel) al: niets (null).
create function intern.plan_notificatie(
  p_organisatie_id uuid,
  p_soort          text,
  p_sleutel        text,
  p_ontvanger      uuid,
  p_factuur_id     uuid default null,
  p_details        jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.notificaties (organisatie_id, soort, sleutel, ontvanger_id, factuur_id, details)
  values (p_organisatie_id, p_soort, p_sleutel, p_ontvanger, p_factuur_id, coalesce(p_details, '{}'::jsonb))
  on conflict (organisatie_id, soort, sleutel) do nothing
  returning id into v_id;

  if v_id is not null then
    perform intern.plan_taak(p_organisatie_id, 'email', v_id::text, p_factuur_id,
                             jsonb_build_object('notificatie_id', v_id, 'soort', p_soort));
  end if;
  return v_id;
end;
$$;

-- Leden die deze factuur mogen goedkeuren én er een mail over krijgen: rol goedkeurder/controller/beheerder,
-- niet de invoerder of de controleur (ook niet bij één lid), en het bedrag in euro binnen de limiet.
create function intern.goedkeurders_voor(p_factuur_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id
  from public.facturen f
  join public.organisatie_leden m on m.organisatie_id = f.organisatie_id
  where f.id = p_factuur_id
    and m.rol in ('goedkeurder', 'controller', 'beheerder')
    and m.user_id is distinct from f.user_id
    and m.user_id is distinct from f.gecontroleerd_door
    and (m.goedkeuringslimiet is null
         or (intern.bedrag_in_euro(f) is not null and intern.bedrag_in_euro(f) <= m.goedkeuringslimiet));
$$;

create function intern.leden_met_rol(p_organisatie_id uuid, p_rollen text[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select user_id from public.organisatie_leden where organisatie_id = p_organisatie_id and rol = any (p_rollen);
$$;

-- Zou deze statuswijziging nu lukken? Voert hem uit en draait hem direct terug. null = ja, anders de reden.
create function intern.proef_statuswijziging(p_user uuid, p_factuur_id uuid, p_status text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform intern.wijzig_status_als(p_user, p_factuur_id, p_status, 'proef', 'email');
    raise exception 'proef' using errcode = 'FSPRF';
  exception
    when sqlstate 'FSPRF' then return null;
    when others then return sqlerrm;
  end;
end;
$$;

-- Wat een mail-actie nu blokkeert (null = niets). Goedkeuren via de mail: strikte functiescheiding,
-- daarna precies de controles van de app.
create function intern.mail_actie_blokkade(p_user uuid, p_factuur_id uuid, p_actie text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.facturen%rowtype;
begin
  select * into f from public.facturen where id = p_factuur_id;
  if f.id is null then
    return 'De factuur bestaat niet meer.';
  end if;
  if p_actie = 'goedkeuren' and f.user_id = p_user then
    return 'Functiescheiding: je kunt een factuur die je zelf hebt ingevoerd niet goedkeuren.';
  end if;
  if p_actie = 'goedkeuren' and f.gecontroleerd_door = p_user then
    return 'Functiescheiding: je kunt een factuur die je zelf hebt gecontroleerd niet goedkeuren.';
  end if;
  return intern.proef_statuswijziging(p_user, p_factuur_id,
                                      case when p_actie = 'goedkeuren' then 'goedgekeurd' else 'afgekeurd' end);
end;
$$;

-- Korte samenvatting van een factuur voor een mail of de pagina achter de mail-link.
create function intern.factuur_samenvatting(p_factuur_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', f.id,
    'leverancier', f.leverancier_naam,
    'factuurnummer', f.factuurnummer,
    'factuurdatum', f.factuurdatum,
    'vervaldatum', f.vervaldatum,
    'valuta', coalesce(f.valuta, 'EUR'),
    'totaal_incl', f.totaal_incl,
    'bedrag_eur', intern.bedrag_in_euro(f),
    'status', f.status,
    'bron', f.bron,
    'grootboekrekening', (select g.code || ' ' || g.omschrijving from public.grootboekrekeningen g where g.id = f.grootboekrekening_id),
    'ingevoerd_door', (select u.email from auth.users u where u.id = f.user_id),
    'gecontroleerd_door', (select u.email from auth.users u where u.id = f.gecontroleerd_door),
    'afkeur_reden', f.afkeur_reden,
    'signalen', coalesce((
      select jsonb_agg(jsonb_build_object('ernst', s.ernst, 'bericht', s.bericht)
                       order by case s.ernst when 'kritiek' then 0 when 'waarschuwing' then 1 else 2 end, s.created_at)
      from public.factuur_signalen s where s.factuur_id = f.id and not s.opgelost), '[]'::jsonb)
  )
  from public.facturen f
  where f.id = p_factuur_id;
$$;

revoke execute on function
  intern.plan_notificatie(uuid, text, text, uuid, uuid, jsonb),
  intern.goedkeurders_voor(uuid),
  intern.leden_met_rol(uuid, text[]),
  intern.proef_statuswijziging(uuid, uuid, text),
  intern.mail_actie_blokkade(uuid, uuid, text),
  intern.factuur_samenvatting(uuid)
from public;

-- ---------------------------------------------------------------------------
-- Notificaties bij statuswijzigingen en de koers (AFTER-trigger op facturen)
-- ---------------------------------------------------------------------------

create function intern.plan_factuur_notificaties()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user      uuid;
  v_door      uuid := intern.audit_user();
  v_ontvanger uuid[];
begin
  -- Klaar om goed te keuren (of de koers is net bekend geworden): wie hem mag goedkeuren, krijgt een mail.
  -- De sleutel bevat het tijdstip van de controle, dus per controleronde krijgt iedereen hooguit één mail.
  if new.status = 'gecontroleerd'
     and (old.status is distinct from 'gecontroleerd' or old.bedrag_eur is distinct from new.bedrag_eur) then
    for v_user in select intern.goedkeurders_voor(new.id) loop
      perform intern.plan_notificatie(new.organisatie_id, 'goedkeuren',
        new.id::text || ':' || extract(epoch from new.gecontroleerd_op)::text || ':' || v_user::text,
        v_user, new.id, jsonb_build_object('gecontroleerd_op', new.gecontroleerd_op));
    end loop;
  end if;

  -- Afgekeurd: invoerder en controleur, niet degene die afkeurde. Anders controllers en beheerders.
  if new.status = 'afgekeurd' and old.status is distinct from 'afgekeurd' then
    select array_agg(distinct m.user_id) into v_ontvanger
    from public.organisatie_leden m
    where m.organisatie_id = new.organisatie_id
      and m.user_id in (new.user_id, new.gecontroleerd_door)
      and m.user_id is distinct from v_door;
    if v_ontvanger is null then
      select array_agg(u) into v_ontvanger
      from intern.leden_met_rol(new.organisatie_id, array['controller', 'beheerder']) as u
      where u is distinct from v_door;
    end if;
    foreach v_user in array coalesce(v_ontvanger, '{}') loop
      perform intern.plan_notificatie(new.organisatie_id, 'afgekeurd',
        new.id::text || ':' || extract(epoch from now())::text || ':' || v_user::text,
        v_user, new.id, jsonb_build_object('reden', new.afkeur_reden, 'afgekeurd_door', v_door));
    end loop;
  end if;

  return null;
end;
$$;

revoke execute on function intern.plan_factuur_notificaties() from public;

create trigger facturen_notificaties
  after update of status, bedrag_eur on public.facturen
  for each row execute function intern.plan_factuur_notificaties();

-- ---------------------------------------------------------------------------
-- Taakstatus doorgeven: email-taak → notificatie; opgegeven export → mail aan controllers/beheerders
-- ---------------------------------------------------------------------------

create or replace function intern.taak_status_gewijzigd(p_taak public.koppeling_taken, p_status text, p_fout text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if p_taak.soort = 'mailbox' then
    if p_status = 'opgegeven' then
      update public.inbox_bijlagen set status = 'mislukt', reden = left(coalesce(p_fout, 'Onbekende fout.'), 500)
      where id = (p_taak.payload ->> 'bijlage_id')::uuid and factuur_id is null and status = 'wachtrij';
    elsif p_status = 'wachtrij' then
      update public.inbox_bijlagen set status = 'wachtrij', reden = null
      where id = (p_taak.payload ->> 'bijlage_id')::uuid and factuur_id is null and status = 'mislukt';
    end if;

  elsif p_taak.soort = 'email' then
    if p_status = 'opgegeven' then
      update public.notificaties set status = 'mislukt', reden = left(coalesce(p_fout, 'Onbekende fout.'), 500)
      where id = (p_taak.payload ->> 'notificatie_id')::uuid and status = 'wachtrij';
    elsif p_status = 'wachtrij' then
      update public.notificaties set status = 'wachtrij', reden = null
      where id = (p_taak.payload ->> 'notificatie_id')::uuid and status = 'mislukt';
    end if;

  elsif p_taak.soort = 'boekhouding' and p_status = 'opgegeven' then
    for v_user in select intern.leden_met_rol(p_taak.organisatie_id, array['controller', 'beheerder']) loop
      perform intern.plan_notificatie(p_taak.organisatie_id, 'export_mislukt',
        p_taak.id::text || ':' || extract(epoch from now())::text || ':' || v_user::text,
        v_user, p_taak.factuur_id, jsonb_build_object('taak_id', p_taak.id, 'fout', left(p_fout, 500)));
    end loop;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Bijna vervallen (dagelijks via pg_cron)
-- ---------------------------------------------------------------------------
-- Eén mail per controller/beheerder met de openstaande facturen (gescand, gecontroleerd, goedgekeurd) die
-- binnen N dagen vervallen en die nog niet eerder aan die persoon zijn gemeld. N = config
-- dagen_voor_vervaldatum van de koppeling email (1–30, standaard 3). Geeft het aantal geplande mails.

create function intern.plan_vervalherinneringen(p_datum date default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_datum date := coalesce(p_datum, (now() at time zone 'Europe/Amsterdam')::date);
  r       record;
  v_ids   jsonb;
  v_n     int := 0;
begin
  for r in
    select m.organisatie_id, m.user_id,
           least(greatest(case when k.config ->> 'dagen_voor_vervaldatum' ~ '^\d{1,3}$'
                               then (k.config ->> 'dagen_voor_vervaldatum')::int else 3 end, 1), 30) as dagen
    from public.organisatie_leden m
    left join public.koppeling_instellingen k on k.organisatie_id = m.organisatie_id and k.koppeling = 'email'
    where m.rol in ('controller', 'beheerder')
  loop
    select jsonb_agg(f.id order by f.vervaldatum, f.id) into v_ids
    from public.facturen f
    where f.organisatie_id = r.organisatie_id
      and f.status in ('gescand', 'gecontroleerd', 'goedgekeurd')
      and f.vervaldatum between v_datum and v_datum + r.dagen
      and not exists (
        select 1 from public.notificaties n
        where n.organisatie_id = r.organisatie_id and n.soort = 'bijna_vervallen' and n.ontvanger_id = r.user_id
          and n.details -> 'factuur_ids' ? f.id::text
      );
    if v_ids is not null and intern.plan_notificatie(r.organisatie_id, 'bijna_vervallen',
         v_datum::text || ':' || r.user_id::text, r.user_id, null,
         jsonb_build_object('factuur_ids', v_ids, 'datum', v_datum, 'dagen', r.dagen)) is not null then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

revoke execute on function intern.plan_vervalherinneringen(date) from public;

-- ---------------------------------------------------------------------------
-- Testmail (controller/beheerder, aan zichzelf)
-- ---------------------------------------------------------------------------

create function public.plan_testmail(p_organisatie_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.heeft_rol(p_organisatie_id, array['controller', 'beheerder']) then
    raise exception 'Alleen een controller of beheerder kan een testmail sturen.' using errcode = '42501';
  end if;
  return intern.plan_notificatie(p_organisatie_id, 'test', gen_random_uuid()::text, auth.uid(), null, '{}'::jsonb);
end;
$$;

revoke execute on function public.plan_testmail(uuid) from public, anon;
grant execute on function public.plan_testmail(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Verzenden (service role: de worker)
-- ---------------------------------------------------------------------------

-- Alles wat de worker nodig heeft om de mail op te stellen, en of hij nog verstuurd moet worden.
-- { status: 'verzenden' | 'overslaan' | 'afgehandeld', reden, soort, organisatie_id, organisatie,
--   ontvanger_id, ontvanger_email, details, facturen: [samenvatting], blokkade (goedkeuren) }
create function public.notificatie_voor_verzending(p_notificatie_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n          public.notificaties%rowtype;
  f          public.facturen%rowtype;
  v_email    text;
  v_org      text;
  v_reden    text;
  v_facturen jsonb := '[]'::jsonb;
  v_blokkade text;
begin
  select * into n from public.notificaties where id = p_notificatie_id;
  if not found then
    raise exception 'Notificatie niet gevonden.' using errcode = 'P0002';
  end if;
  if n.status in ('verzonden', 'overgeslagen') then
    return jsonb_build_object('status', 'afgehandeld', 'reden', 'Al ' || n.status || '.');
  end if;

  select email into v_email from auth.users where id = n.ontvanger_id;
  select naam into v_org from public.organisaties where id = n.organisatie_id;

  if n.ontvanger_id is null or v_email is null then
    v_reden := 'De ontvanger bestaat niet meer.';
  elsif not exists (select 1 from public.organisatie_leden where organisatie_id = n.organisatie_id and user_id = n.ontvanger_id) then
    v_reden := 'De ontvanger is geen lid meer van de organisatie.';
  end if;

  if v_reden is null and n.soort = 'goedkeuren' then
    select * into f from public.facturen where id = n.factuur_id;
    if f.id is null then
      v_reden := 'De factuur is verwijderd.';
    elsif f.status <> 'gecontroleerd' then
      v_reden := format('De factuur heeft intussen status "%s".', f.status);
    elsif f.gecontroleerd_op is distinct from (n.details ->> 'gecontroleerd_op')::timestamptz then
      v_reden := 'De factuur is intussen opnieuw gecontroleerd.';
    elsif not exists (select 1 from intern.goedkeurders_voor(f.id) as u where u = n.ontvanger_id) then
      v_reden := 'De ontvanger mag deze factuur niet (meer) goedkeuren.';
    else
      v_blokkade := intern.mail_actie_blokkade(n.ontvanger_id, f.id, 'goedkeuren');
    end if;
  end if;

  if n.soort = 'bijna_vervallen' then
    select coalesce(jsonb_agg(intern.factuur_samenvatting(x.id) order by x.vervaldatum, x.id), '[]'::jsonb) into v_facturen
    from public.facturen x
    where x.id in (select (jsonb_array_elements_text(n.details -> 'factuur_ids'))::uuid)
      and x.status in ('gescand', 'gecontroleerd', 'goedgekeurd');
    if v_reden is null and jsonb_array_length(v_facturen) = 0 then
      v_reden := 'Alle facturen zijn intussen afgehandeld.';
    end if;
  elsif n.factuur_id is not null then
    select coalesce(jsonb_agg(s.samenvatting), '[]'::jsonb) into v_facturen
    from (select intern.factuur_samenvatting(n.factuur_id) as samenvatting) s
    where s.samenvatting is not null;
    if v_reden is null and n.soort = 'afgekeurd' and jsonb_array_length(v_facturen) = 0 then
      v_reden := 'De factuur is verwijderd.';
    end if;
  end if;

  return jsonb_build_object(
    'status', case when v_reden is null then 'verzenden' else 'overslaan' end,
    'reden', v_reden,
    'soort', n.soort,
    'organisatie_id', n.organisatie_id,
    'organisatie', v_org,
    'ontvanger_id', n.ontvanger_id,
    'ontvanger_email', v_email,
    'details', n.details
      || case when n.soort = 'afgekeurd'
              then jsonb_build_object('afgekeurd_door_email',
                     (select u.email from auth.users u where u.id = (n.details ->> 'afgekeurd_door')::uuid))
              else '{}'::jsonb end,
    'facturen', v_facturen,
    'blokkade', v_blokkade
  );
end;
$$;

-- De eenmalige actie achter de knoppen van een goedkeuringsmail. Idempotent per notificatie (een nieuwe
-- poging van de worker krijgt dezelfde actie en verlooptijd, dus exact dezelfde links).
-- Geldigheid: config link_geldig_uren van de koppeling email (1–336, standaard 72).
create function public.maak_mail_actie(p_notificatie_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n       public.notificaties%rowtype;
  f       public.facturen%rowtype;
  a       public.mail_acties%rowtype;
  v_uren  int;
begin
  select * into a from public.mail_acties where notificatie_id = p_notificatie_id;
  if found then
    return jsonb_build_object('id', a.id, 'verloopt_op', a.verloopt_op);
  end if;

  select * into n from public.notificaties where id = p_notificatie_id for update;
  if not found or n.soort <> 'goedkeuren' or n.ontvanger_id is null then
    raise exception 'Geen goedkeuringsmail.' using errcode = '22023';
  end if;
  select * into f from public.facturen where id = n.factuur_id;
  if f.id is null or f.gecontroleerd_op is null then
    raise exception 'Factuur niet gevonden of niet gecontroleerd.' using errcode = '22023';
  end if;

  select least(greatest(case when config ->> 'link_geldig_uren' ~ '^\d{1,4}$'
                             then (config ->> 'link_geldig_uren')::int else 72 end, 1), 336)
    into v_uren
  from public.koppeling_instellingen where organisatie_id = n.organisatie_id and koppeling = 'email';

  insert into public.mail_acties (organisatie_id, notificatie_id, factuur_id, user_id, gecontroleerd_op, verloopt_op)
  values (n.organisatie_id, n.id, f.id, n.ontvanger_id, f.gecontroleerd_op,
          date_trunc('second', now()) + make_interval(hours => coalesce(v_uren, 72)))
  returning * into a;
  return jsonb_build_object('id', a.id, 'verloopt_op', a.verloopt_op);
end;
$$;

-- Resultaat van de verzending vastleggen. p_inhoud ({ html, tekst }) alleen in mock-modus.
-- Bij een herinnering over meerdere facturen komt de verzending bij elke factuur in de historie.
create function public.markeer_notificatie(
  p_notificatie_id  uuid,
  p_status          text,
  p_modus           text default null,
  p_ontvanger_email text default null,
  p_onderwerp       text default null,
  p_provider_id     text default null,
  p_reden           text default null,
  p_inhoud          jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  n    public.notificaties%rowtype;
  v_id uuid;
begin
  if p_status not in ('verzonden', 'overgeslagen') then
    raise exception 'Status moet "verzonden" of "overgeslagen" zijn.' using errcode = '22023';
  end if;
  select * into n from public.notificaties where id = p_notificatie_id for update;
  if not found then
    raise exception 'Notificatie niet gevonden.' using errcode = 'P0002';
  end if;
  if n.status in ('verzonden', 'overgeslagen') then
    return;
  end if;

  update public.notificaties
  set status = p_status, modus = p_modus, ontvanger_email = p_ontvanger_email, onderwerp = left(p_onderwerp, 300),
      provider_id = left(p_provider_id, 200), reden = left(nullif(btrim(p_reden), ''), 500),
      verzonden_op = case when p_status = 'verzonden' then now() end
  where id = n.id;

  if p_status = 'verzonden' and p_modus = 'mock' and p_inhoud is not null then
    insert into public.notificatie_inhoud (notificatie_id, organisatie_id, ontvanger_id, onderwerp, html, tekst)
    values (n.id, n.organisatie_id, n.ontvanger_id, coalesce(p_onderwerp, ''), coalesce(p_inhoud ->> 'html', ''),
            coalesce(p_inhoud ->> 'tekst', ''))
    on conflict (notificatie_id) do nothing;
  end if;

  if p_status = 'verzonden' and n.soort = 'bijna_vervallen' then
    for v_id in select (jsonb_array_elements_text(n.details -> 'factuur_ids'))::uuid loop
      if exists (select 1 from public.facturen where id = v_id) then
        perform intern.log_gebeurtenis(n.organisatie_id, 'notificatie', 'email', 'facturen', v_id,
          jsonb_build_object('omschrijving', format('Herinnering vervaldatum gemaild aan %s%s', p_ontvanger_email,
                                                    case when p_modus = 'mock' then ' (mock)' else '' end),
                             'notificatie_id', n.id),
          null, null);
      end if;
    end loop;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Goedkeuren of afkeuren via de mail (service role: Edge Function mail-actie, na controle van het token)
-- ---------------------------------------------------------------------------

-- Wat er achter de link zit, zonder iets te wijzigen.
-- { geldig, melding, actie_mogelijk: { goedkeuren: null|reden, afkeuren: null|reden }, factuur, goedkeurder,
--   organisatie, verloopt_op, gebruikt_op, gebruikt_actie }
create function public.bekijk_mail_actie(p_mail_actie_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a       public.mail_acties%rowtype;
  f       public.facturen%rowtype;
  v_fout  text;
begin
  select * into a from public.mail_acties where id = p_mail_actie_id;
  if not found then
    return jsonb_build_object('geldig', false, 'melding', 'Deze link is ongeldig.');
  end if;
  select * into f from public.facturen where id = a.factuur_id;

  v_fout := case
    when a.gebruikt_op is not null then 'Deze link is al gebruikt.'
    when a.verloopt_op < now() then 'Deze link is verlopen. Open de factuur in de app.'
    when f.status <> 'gecontroleerd' then format('De factuur heeft intussen status "%s".', f.status)
    when f.gecontroleerd_op is distinct from a.gecontroleerd_op then 'De factuur is intussen gewijzigd en opnieuw gecontroleerd. Gebruik de nieuwste mail of de app.'
    when not exists (select 1 from public.organisatie_leden where organisatie_id = a.organisatie_id and user_id = a.user_id)
      then 'Je bent geen lid meer van deze organisatie.'
  end;

  return jsonb_build_object(
    'geldig', v_fout is null,
    'melding', v_fout,
    'mogelijk', case when v_fout is null then jsonb_build_object(
                  'goedkeuren', intern.mail_actie_blokkade(a.user_id, a.factuur_id, 'goedkeuren'),
                  'afkeuren', intern.mail_actie_blokkade(a.user_id, a.factuur_id, 'afkeuren')) end,
    'factuur', intern.factuur_samenvatting(a.factuur_id),
    'goedkeurder', (select email from auth.users where id = a.user_id),
    'organisatie', (select naam from public.organisaties where id = a.organisatie_id),
    'verloopt_op', a.verloopt_op,
    'gebruikt_op', a.gebruikt_op,
    'gebruikt_actie', a.gebruikt_actie
  );
end;
$$;

-- Voert de actie uit namens de goedkeurder van de link (bron email). Een geweigerde poging verbruikt de
-- link niet, maar staat wel in de audit log. { ok, melding }
create function public.voer_mail_actie_uit(p_mail_actie_id uuid, p_actie text, p_reden text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a       public.mail_acties%rowtype;
  f       public.facturen%rowtype;
  v_fout  text;
  v_reden text := nullif(btrim(p_reden), '');
begin
  if p_actie is null or p_actie not in ('goedkeuren', 'afkeuren') then
    raise exception 'Actie moet "goedkeuren" of "afkeuren" zijn.' using errcode = '22023';
  end if;
  select * into a from public.mail_acties where id = p_mail_actie_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'melding', 'Deze link is ongeldig.');
  end if;
  select * into f from public.facturen where id = a.factuur_id;

  v_fout := case
    when a.gebruikt_op is not null then 'Deze link is al gebruikt.'
    when a.verloopt_op < now() then 'Deze link is verlopen. Open de factuur in de app.'
    when f.status <> 'gecontroleerd' then format('De factuur heeft intussen status "%s".', f.status)
    when f.gecontroleerd_op is distinct from a.gecontroleerd_op then 'De factuur is intussen gewijzigd en opnieuw gecontroleerd. Gebruik de nieuwste mail of de app.'
    when p_actie = 'goedkeuren' and f.user_id = a.user_id then 'Functiescheiding: je kunt een factuur die je zelf hebt ingevoerd niet goedkeuren.'
    when p_actie = 'goedkeuren' and f.gecontroleerd_door = a.user_id then 'Functiescheiding: je kunt een factuur die je zelf hebt gecontroleerd niet goedkeuren.'
    when p_actie = 'afkeuren' and v_reden is null then 'Een reden is verplicht bij afkeuren.'
  end;

  if v_fout is null then
    begin
      -- Zelfde controles als in de app: rol, limiet in euro, open kritieke signalen, grootboekrekening.
      perform intern.wijzig_status_als(a.user_id, a.factuur_id,
        case when p_actie = 'goedkeuren' then 'goedgekeurd' else 'afgekeurd' end,
        case when p_actie = 'goedkeuren' then 'Goedgekeurd via de knop in de e-mail' else v_reden end,
        'email');
      update public.mail_acties set gebruikt_op = now(), gebruikt_actie = p_actie where id = a.id;
    exception when others then
      v_fout := sqlerrm;
    end;
  end if;

  if v_fout is not null then
    perform intern.log_gebeurtenis(a.organisatie_id, 'notificatie', 'email', 'facturen', a.factuur_id,
      jsonb_build_object('omschrijving', format('%s via de e-mail geweigerd',
                                                case when p_actie = 'goedkeuren' then 'Goedkeuren' else 'Afkeuren' end),
                         'mail_actie_id', a.id),
      v_fout, a.user_id);
    return jsonb_build_object('ok', false, 'melding', v_fout);
  end if;

  return jsonb_build_object('ok', true,
    'melding', case when p_actie = 'goedkeuren' then 'De factuur is goedgekeurd.' else 'De factuur is afgekeurd.' end);
end;
$$;

revoke execute on function
  public.notificatie_voor_verzending(uuid),
  public.maak_mail_actie(uuid),
  public.markeer_notificatie(uuid, text, text, text, text, text, text, jsonb),
  public.bekijk_mail_actie(uuid),
  public.voer_mail_actie_uit(uuid, text, text)
from public, anon, authenticated;
grant execute on function
  public.notificatie_voor_verzending(uuid),
  public.maak_mail_actie(uuid),
  public.markeer_notificatie(uuid, text, text, text, text, text, text, jsonb),
  public.bekijk_mail_actie(uuid),
  public.voer_mail_actie_uit(uuid, text, text)
to service_role;

-- ---------------------------------------------------------------------------
-- Dagelijkse herinnering (alleen op Supabase: pg_cron). 06:00 UTC = 07:00/08:00 in Nederland.
-- ---------------------------------------------------------------------------

do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('factuurscanner-vervalherinneringen', '0 6 * * *', 'select intern.plan_vervalherinneringen()');
  end if;
end;
$do$;
