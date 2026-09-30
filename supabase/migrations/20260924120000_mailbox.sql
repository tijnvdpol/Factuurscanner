-- Fase 4.3: mailbox-import.
--
-- Facturen die naar het ontvangstadres worden gemaild, komen via Mailgun (inbound route → Edge Function
-- inbound-mail) binnen. De Edge Function controleert de handtekening, slaat mail en bijlagen op en roept
-- registreer_inbox_bericht aan. Bekende afzender (in inbox_afzenders én SPF of DKIM geslaagd): elke
-- bijlage wordt een mailbox-taak; de worker scant hem en maakt via maak_factuur_uit_inbox een factuur
-- (status gescand, bron mailbox, geen "ingevoerd door"). Onbekende afzender: het bericht wacht op een
-- beoordeling door een controller of beheerder (beoordeel_inbox_bericht).
--
-- Voor facturen uit de mail gelden dezelfde controles als bij uploaden: signalen, verrijking,
-- functiescheiding (een mens controleert, een ander keurt goed) en de goedkeuringslimiet.

-- ---------------------------------------------------------------------------
-- Herkomst op de factuur
-- ---------------------------------------------------------------------------

alter table public.facturen
  add column bron             text not null default 'upload' check (bron in ('upload', 'mailbox')),
  add column inbox_bijlage_id uuid;

comment on column public.facturen.bron is 'upload = via de app gescand; mailbox = uit een gemailde bijlage';

-- Gebruikers (en de service role) kunnen de herkomst niet zelf zetten of wijzigen.
create function intern.bewaak_herkomst()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon', 'service_role') then
    if tg_op = 'INSERT' then
      new.bron := 'upload';
      new.inbox_bijlage_id := null;
    else
      new.bron := old.bron;
      new.inbox_bijlage_id := old.inbox_bijlage_id;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function intern.bewaak_herkomst() from public;

create trigger facturen_herkomst
  before insert or update on public.facturen
  for each row execute function intern.bewaak_herkomst();

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------

-- Ontvangstadres per organisatie (bijv. facturen@inbox.jouwbedrijf.nl).
create table public.inbox_adressen (
  id             uuid primary key default gen_random_uuid(),
  organisatie_id uuid not null references public.organisaties (id) on delete cascade,
  adres          text not null check (adres ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at     timestamptz not null default now()
);

create unique index inbox_adressen_adres_uniek on public.inbox_adressen (lower(adres));
create unique index inbox_adressen_organisatie_uniek on public.inbox_adressen (organisatie_id);

-- Vertrouwde afzenders: een e-mailadres ("facturen@leverancier.nl") of een heel domein ("@leverancier.nl").
create table public.inbox_afzenders (
  id              uuid primary key default gen_random_uuid(),
  organisatie_id  uuid not null references public.organisaties (id) on delete cascade,
  patroon         text not null check (patroon ~ '^([^@\s]+@|@)[^@\s]+\.[^@\s]+$'),
  omschrijving    text,
  toegevoegd_door uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now()
);

create unique index inbox_afzenders_uniek on public.inbox_afzenders (organisatie_id, lower(patroon));

create table public.inbox_berichten (
  id               uuid primary key default gen_random_uuid(),
  organisatie_id   uuid not null references public.organisaties (id) on delete cascade,
  message_id       text not null,
  van              text not null,
  van_naam         text,
  envelop_afzender text,
  aan              text not null,
  onderwerp        text,
  tekst            text,
  -- Echtheidscontrole door Mailgun (X-Mailgun-Spf / X-Mailgun-Dkim-Check-Result); mock: 'Pass'
  spf              text,
  dkim             text,
  spam             boolean not null default false,
  bekende_afzender boolean not null,
  -- te_beoordelen → geaccepteerd (bijlagen worden verwerkt) of geweigerd
  status           text not null check (status in ('te_beoordelen', 'geaccepteerd', 'geweigerd')),
  bron             text not null check (bron in ('mailgun', 'mock')),
  -- true zodra de bijlagen zijn vastgelegd; een onderbroken registratie (webhook faalde halverwege) wordt
  -- bij de volgende poging van Mailgun afgemaakt in plaats van als duplicaat genegeerd
  afgerond         boolean not null default false,
  ontvangen_op     timestamptz not null default now(),
  beoordeeld_door  uuid references auth.users (id) on delete set null,
  beoordeeld_op    timestamptz,
  toelichting      text,
  unique (organisatie_id, message_id)
);

create index inbox_berichten_organisatie_idx on public.inbox_berichten (organisatie_id, ontvangen_op desc);

create table public.inbox_bijlagen (
  id             uuid primary key default gen_random_uuid(),
  bericht_id     uuid not null references public.inbox_berichten (id) on delete cascade,
  organisatie_id uuid not null references public.organisaties (id) on delete cascade,
  volgnummer     int not null,
  bestandsnaam   text not null,
  mime_type      text,
  grootte        bigint,
  -- pad in de bucket facturen ({organisatie_id}/inbox/{bericht_id}/…); leeg als de bijlage is genegeerd
  pad            text,
  -- wacht (op beoordeling) → wachtrij → verwerkt | duplicaat | mislukt;  genegeerd = geen factuurbestand
  status         text not null check (status in ('wacht', 'wachtrij', 'verwerkt', 'duplicaat', 'mislukt', 'genegeerd')),
  reden          text,
  factuur_id     uuid references public.facturen (id) on delete set null,
  -- Alleen bij een gesimuleerde mail (mock): de gegevens die in het voorbeeld-PDF staan, voor de mock-scan
  testdata       jsonb,
  unique (bericht_id, volgnummer)
);

create index inbox_bijlagen_factuur_idx on public.inbox_bijlagen (factuur_id);

alter table public.facturen add constraint facturen_inbox_bijlage_fk
  foreign key (inbox_bijlage_id) references public.inbox_bijlagen (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Row Level Security: leden lezen; schrijven alleen via functies
-- ---------------------------------------------------------------------------

alter table public.inbox_adressen enable row level security;
alter table public.inbox_afzenders enable row level security;
alter table public.inbox_berichten enable row level security;
alter table public.inbox_bijlagen enable row level security;

create policy "Leden lezen het ontvangstadres" on public.inbox_adressen for select to authenticated
  using (public.is_lid(organisatie_id));
create policy "Leden lezen de vertrouwde afzenders" on public.inbox_afzenders for select to authenticated
  using (public.is_lid(organisatie_id));
create policy "Leden lezen de inbox" on public.inbox_berichten for select to authenticated
  using (public.is_lid(organisatie_id));
create policy "Leden lezen de bijlagen" on public.inbox_bijlagen for select to authenticated
  using (public.is_lid(organisatie_id));

revoke all on public.inbox_adressen, public.inbox_afzenders, public.inbox_berichten, public.inbox_bijlagen
  from anon, authenticated;
grant select on public.inbox_adressen, public.inbox_afzenders, public.inbox_berichten, public.inbox_bijlagen
  to authenticated;

-- Wie welk adres of welke afzender heeft ingesteld, staat in de audit log (dit bepaalt wat er automatisch
-- binnenkomt). Berichten zelf worden via gebeurtenissen gelogd (hieronder).
create trigger audit_inbox_adressen
  after insert or update or delete on public.inbox_adressen
  for each row execute function intern.log_wijziging();
create trigger audit_inbox_afzenders
  after insert or update or delete on public.inbox_afzenders
  for each row execute function intern.log_wijziging();

-- ---------------------------------------------------------------------------
-- Instellingen (beheerder / controller)
-- ---------------------------------------------------------------------------

create function public.stel_inbox_adres_in(p_organisatie_id uuid, p_adres text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_adres text := lower(btrim(p_adres));
begin
  if not public.heeft_rol(p_organisatie_id, array['beheerder']) then
    raise exception 'Alleen een beheerder kan het ontvangstadres instellen.' using errcode = '42501';
  end if;
  if coalesce(v_adres, '') = '' then
    delete from public.inbox_adressen where organisatie_id = p_organisatie_id;
    return;
  end if;
  if v_adres !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Ongeldig e-mailadres.' using errcode = '22023';
  end if;
  if exists (select 1 from public.inbox_adressen where lower(adres) = v_adres and organisatie_id <> p_organisatie_id) then
    raise exception 'Dit adres is al in gebruik.' using errcode = '23505';
  end if;
  insert into public.inbox_adressen (organisatie_id, adres) values (p_organisatie_id, v_adres)
  on conflict (organisatie_id) do update set adres = excluded.adres;
end;
$$;

create function public.voeg_inbox_afzender_toe(p_organisatie_id uuid, p_patroon text, p_omschrijving text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_patroon text := lower(btrim(p_patroon));
  v_id      uuid;
begin
  if not public.heeft_rol(p_organisatie_id, array['controller', 'beheerder']) then
    raise exception 'Alleen een controller of beheerder kan vertrouwde afzenders beheren.' using errcode = '42501';
  end if;
  if v_patroon is null or v_patroon !~ '^([^@\s]+@|@)[^@\s]+\.[^@\s]+$' then
    raise exception 'Geef een e-mailadres (naam@domein.nl) of een domein (@domein.nl).' using errcode = '22023';
  end if;
  insert into public.inbox_afzenders (organisatie_id, patroon, omschrijving, toegevoegd_door)
  values (p_organisatie_id, v_patroon, nullif(btrim(p_omschrijving), ''), auth.uid())
  on conflict (organisatie_id, lower(patroon)) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

create function public.verwijder_inbox_afzender(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organisatie_id into v_org from public.inbox_afzenders where id = p_id;
  if v_org is null or not public.heeft_rol(v_org, array['controller', 'beheerder']) then
    raise exception 'Afzender niet gevonden.' using errcode = 'P0002';
  end if;
  delete from public.inbox_afzenders where id = p_id;
end;
$$;

revoke execute on function public.stel_inbox_adres_in(uuid, text), public.voeg_inbox_afzender_toe(uuid, text, text),
  public.verwijder_inbox_afzender(uuid) from public, anon;
grant execute on function public.stel_inbox_adres_in(uuid, text), public.voeg_inbox_afzender_toe(uuid, text, text),
  public.verwijder_inbox_afzender(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Afzender herkennen
-- ---------------------------------------------------------------------------

-- Staat het adres (of het domein) in de lijst met vertrouwde afzenders?
create function intern.is_vertrouwde_afzender(p_organisatie_id uuid, p_adres text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.inbox_afzenders a
    where a.organisatie_id = p_organisatie_id
      and (lower(a.patroon) = lower(btrim(p_adres))
           or (left(a.patroon, 1) = '@' and lower(btrim(p_adres)) like '%' || lower(a.patroon)))
  );
$$;

revoke execute on function intern.is_vertrouwde_afzender(uuid, text) from public;

-- ---------------------------------------------------------------------------
-- Binnenkomende mail registreren (service role: Edge Function inbound-mail of de simulatie)
-- ---------------------------------------------------------------------------
-- p_bericht: { aan, van, van_naam, envelop_afzender, onderwerp, tekst, message_id, spf, dkim, spam, bron }
-- Geeft { status: 'onbekend_adres' | 'duplicaat' | 'nieuw', bericht_id, organisatie_id, bekend }.
-- Een eerder onderbroken registratie (niet afgerond) geeft 'nieuw' met hetzelfde bericht_id.
-- Bekende afzender = in de lijst én SPF of DKIM geslaagd én geen spam. Anders: te beoordelen.

create function public.registreer_inbox_bericht(p_bericht jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org       uuid;
  v_id        uuid;
  v_van       text := lower(btrim(p_bericht ->> 'van'));
  v_spf       text := nullif(btrim(p_bericht ->> 'spf'), '');
  v_dkim      text := nullif(btrim(p_bericht ->> 'dkim'), '');
  v_spam      boolean := coalesce((p_bericht ->> 'spam')::boolean, false);
  v_echt      boolean;
  v_bekend    boolean;
begin
  select organisatie_id into v_org from public.inbox_adressen where lower(adres) = lower(btrim(p_bericht ->> 'aan'));
  if v_org is null then
    return jsonb_build_object('status', 'onbekend_adres');
  end if;

  select id, bekende_afzender into v_id, v_bekend from public.inbox_berichten
  where organisatie_id = v_org and message_id = p_bericht ->> 'message_id';
  if v_id is not null then
    if exists (select 1 from public.inbox_berichten where id = v_id and afgerond) then
      return jsonb_build_object('status', 'duplicaat', 'bericht_id', v_id, 'organisatie_id', v_org);
    end if;
    return jsonb_build_object('status', 'nieuw', 'bericht_id', v_id, 'organisatie_id', v_org, 'bekend', v_bekend);
  end if;

  v_echt := lower(coalesce(v_spf, '')) = 'pass' or lower(coalesce(v_dkim, '')) = 'pass';
  v_bekend := v_echt and not v_spam and intern.is_vertrouwde_afzender(v_org, v_van);

  insert into public.inbox_berichten (organisatie_id, message_id, van, van_naam, envelop_afzender, aan, onderwerp,
                                      tekst, spf, dkim, spam, bekende_afzender, status, bron)
  values (v_org, p_bericht ->> 'message_id', v_van, nullif(btrim(p_bericht ->> 'van_naam'), ''),
          nullif(lower(btrim(p_bericht ->> 'envelop_afzender')), ''), lower(btrim(p_bericht ->> 'aan')),
          left(p_bericht ->> 'onderwerp', 500), left(p_bericht ->> 'tekst', 5000), v_spf, v_dkim, v_spam, v_bekend,
          case when v_bekend then 'geaccepteerd' else 'te_beoordelen' end,
          coalesce(p_bericht ->> 'bron', 'mailgun'))
  returning id into v_id;

  return jsonb_build_object('status', 'nieuw', 'bericht_id', v_id, 'organisatie_id', v_org, 'bekend', v_bekend);
end;
$$;

-- Legt de (al in Storage opgeslagen) bijlagen vast. Bij een geaccepteerd bericht gaat elke bijlage met een
-- bestand direct de wachtrij in; anders wacht hij op de beoordeling. Logt de ontvangst in de audit log.
-- p_bijlagen: [{ volgnummer, bestandsnaam, mime_type, grootte, pad (null = genegeerd), reden, testdata }]
create function public.rond_inbox_bericht_af(p_bericht_id uuid, p_bijlagen jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  b          public.inbox_berichten%rowtype;
  v_aantal   int;
  v_bruikbaar int;
begin
  select * into b from public.inbox_berichten where id = p_bericht_id for update;
  if not found then
    raise exception 'Bericht niet gevonden.' using errcode = 'P0002';
  end if;
  if b.afgerond then
    return (select count(*) from public.inbox_bijlagen where bericht_id = b.id and status <> 'genegeerd');
  end if;

  insert into public.inbox_bijlagen (bericht_id, organisatie_id, volgnummer, bestandsnaam, mime_type, grootte, pad,
                                     status, reden, testdata)
  select b.id, b.organisatie_id, (x ->> 'volgnummer')::int, coalesce(nullif(x ->> 'bestandsnaam', ''), 'bijlage'),
         x ->> 'mime_type', (x ->> 'grootte')::bigint, nullif(x ->> 'pad', ''),
         case when nullif(x ->> 'pad', '') is null then 'genegeerd' else 'wacht' end,
         nullif(x ->> 'reden', ''), x -> 'testdata'
  from jsonb_array_elements(coalesce(p_bijlagen, '[]'::jsonb)) as x
  on conflict (bericht_id, volgnummer) do nothing;

  select count(*), count(*) filter (where status <> 'genegeerd') into v_aantal, v_bruikbaar
  from public.inbox_bijlagen where bericht_id = b.id;
  update public.inbox_berichten set afgerond = true where id = b.id;

  perform intern.log_gebeurtenis(b.organisatie_id, 'import', 'mailbox', 'inbox_berichten', b.id,
    jsonb_build_object(
      'omschrijving', format('Mail van %s ontvangen (%s bijlage%s, %s bruikbaar)%s', b.van, v_aantal,
                             case when v_aantal = 1 then '' else 'n' end, v_bruikbaar,
                             case when b.status = 'te_beoordelen' then ' — onbekende afzender, ter beoordeling' else '' end),
      'van', b.van, 'onderwerp', b.onderwerp, 'spf', b.spf, 'dkim', b.dkim, 'bekende_afzender', b.bekende_afzender),
    null, null);

  if b.status = 'geaccepteerd' then
    perform intern.plan_inbox_bijlagen(b.id);
  end if;
  return v_bruikbaar;
end;
$$;

-- Zet de wachtende bijlagen van een geaccepteerd bericht in de wachtrij (één mailbox-taak per bijlage).
create function intern.plan_inbox_bijlagen(p_bericht_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  x   public.inbox_bijlagen%rowtype;
  v_n int := 0;
begin
  for x in select * from public.inbox_bijlagen where bericht_id = p_bericht_id and status = 'wacht' order by volgnummer loop
    update public.inbox_bijlagen set status = 'wachtrij' where id = x.id;
    perform intern.plan_taak(x.organisatie_id, 'mailbox', x.id::text, null,
                             jsonb_build_object('bijlage_id', x.id, 'bericht_id', x.bericht_id, 'bestandsnaam', x.bestandsnaam));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke execute on function intern.plan_inbox_bijlagen(uuid) from public;

-- ---------------------------------------------------------------------------
-- Beoordelen (controller / beheerder)
-- ---------------------------------------------------------------------------

create function public.beoordeel_inbox_bericht(
  p_bericht_id        uuid,
  p_actie             text,
  p_vertrouw_afzender boolean default false,
  p_toelichting       text default null
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  b     public.inbox_berichten%rowtype;
  v_n   int := 0;
  v_dom text;
begin
  select * into b from public.inbox_berichten where id = p_bericht_id for update;
  if not found or not public.is_lid(b.organisatie_id) then
    raise exception 'Bericht niet gevonden.' using errcode = 'P0002';
  end if;
  if not public.heeft_rol(b.organisatie_id, array['controller', 'beheerder']) then
    raise exception 'Alleen een controller of beheerder kan mail van onbekende afzenders beoordelen.' using errcode = '42501';
  end if;
  if b.status <> 'te_beoordelen' then
    raise exception 'Dit bericht is al beoordeeld.' using errcode = '22023';
  end if;
  if not b.afgerond then
    raise exception 'Dit bericht wordt nog ontvangen. Probeer het zo opnieuw.' using errcode = '22023';
  end if;
  if p_actie not in ('verwerken', 'weigeren') then
    raise exception 'Actie moet "verwerken" of "weigeren" zijn.' using errcode = '22023';
  end if;
  if p_actie = 'weigeren' and coalesce(btrim(p_toelichting), '') = '' then
    raise exception 'Een reden is verplicht bij weigeren.' using errcode = '22023';
  end if;

  update public.inbox_berichten
  set status = case when p_actie = 'verwerken' then 'geaccepteerd' else 'geweigerd' end,
      beoordeeld_door = auth.uid(), beoordeeld_op = now(), toelichting = nullif(btrim(p_toelichting), '')
  where id = b.id;

  if p_actie = 'verwerken' then
    if p_vertrouw_afzender then
      perform public.voeg_inbox_afzender_toe(b.organisatie_id, b.van, 'Toegevoegd bij beoordeling van een mail');
    end if;
    v_n := intern.plan_inbox_bijlagen(b.id);
  else
    update public.inbox_bijlagen set status = 'genegeerd', reden = 'Mail geweigerd' where bericht_id = b.id and status = 'wacht';
  end if;

  perform intern.log_gebeurtenis(b.organisatie_id, 'import', 'app', 'inbox_berichten', b.id,
    jsonb_build_object(
      'omschrijving', case when p_actie = 'verwerken'
                           then format('Mail van %s goedgekeurd voor verwerking (%s bijlage%s)%s', b.van, v_n,
                                       case when v_n = 1 then '' else 'n' end,
                                       case when p_vertrouw_afzender then '; afzender toegevoegd aan vertrouwde afzenders' else '' end)
                           else format('Mail van %s geweigerd', b.van) end,
      'van', b.van, 'onderwerp', b.onderwerp),
    nullif(btrim(p_toelichting), ''), auth.uid());
  return v_n;
end;
$$;

revoke execute on function public.beoordeel_inbox_bericht(uuid, text, boolean, text) from public, anon;
grant execute on function public.beoordeel_inbox_bericht(uuid, text, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Factuur maken uit een bijlage (service role: de worker, na het scannen)
-- ---------------------------------------------------------------------------
-- Zelfde velden en regels als sla_factuur_op (leverancier op naam, bekend IBAN alleen vullen als het leeg
-- is, btw-regels, codering, signalen), maar zonder ingelogde gebruiker: "ingevoerd door" blijft leeg en
-- bron = mailbox. Het bestand is al verplaatst naar {organisatie_id}/{factuur_id}/…
-- Geeft { status: 'verwerkt' | 'duplicaat', factuur_id }.

create function public.maak_factuur_uit_inbox(
  p_bijlage_id uuid,
  p_factuur_id uuid,
  p_factuur    jsonb,
  p_pad        text,
  p_ai_model   text,
  p_codering   jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x                public.inbox_bijlagen%rowtype;
  b                public.inbox_berichten%rowtype;
  v_org            uuid;
  v_naam           text := nullif(btrim(p_factuur ->> 'leverancier'), '');
  v_btw_nummer     text := upper(nullif(regexp_replace(p_factuur ->> 'btw_nummer', '[\s.]', '', 'g'), ''));
  v_kvk_nummer     text := nullif(regexp_replace(p_factuur ->> 'kvk_nummer', '\s', '', 'g'), '');
  v_iban           text := upper(nullif(regexp_replace(p_factuur ->> 'iban', '\s', '', 'g'), ''));
  v_nummer         text := nullif(btrim(p_factuur ->> 'factuurnummer'), '');
  v_leverancier_id uuid;
  v_rekening       uuid;
  v_bron           text;
  v_zekerheid      numeric;
  v_bestaand       uuid;
begin
  select * into x from public.inbox_bijlagen where id = p_bijlage_id for update;
  if not found then
    raise exception 'Bijlage niet gevonden.' using errcode = 'P0002';
  end if;
  if x.factuur_id is not null then
    return jsonb_build_object('status', 'verwerkt', 'factuur_id', x.factuur_id);
  end if;
  select * into b from public.inbox_berichten where id = x.bericht_id;
  if b.status <> 'geaccepteerd' then
    raise exception 'Deze mail is niet (meer) goedgekeurd voor verwerking.' using errcode = '22023';
  end if;
  v_org := x.organisatie_id;
  if p_pad is null or p_pad not like v_org::text || '/' || p_factuur_id::text || '/%' then
    raise exception 'Ongeldig bestandspad.' using errcode = '22023';
  end if;

  perform intern.zet_audit_context(null, 'mailbox');

  -- Leverancier op naam (zoals sla_factuur_op); het bekende IBAN wordt alleen gevuld als het nog leeg is.
  if v_naam is not null then
    insert into public.leveranciers as l (organisatie_id, user_id, naam, btw_nummer, kvk_nummer, iban)
    values (v_org, null, v_naam, v_btw_nummer, v_kvk_nummer, v_iban)
    on conflict (organisatie_id, lower(naam)) do update set
      btw_nummer = coalesce(l.btw_nummer, excluded.btw_nummer),
      kvk_nummer = coalesce(l.kvk_nummer, excluded.kvk_nummer)
    returning l.id into v_leverancier_id;
    update public.leveranciers set iban = v_iban where id = v_leverancier_id and iban is null and v_iban is not null;
  end if;

  -- Dezelfde factuur (leverancier + nummer) staat er al: niet nog eens aanmaken.
  if v_nummer is not null then
    select id into v_bestaand from public.facturen
    where organisatie_id = v_org and leverancier_id is not distinct from v_leverancier_id and factuurnummer = v_nummer;
    if v_bestaand is not null then
      update public.inbox_bijlagen
      set status = 'duplicaat', factuur_id = null,
          reden = format('Factuur %s van %s staat al in het overzicht.', v_nummer, coalesce(v_naam, 'deze leverancier'))
      where id = x.id;
      perform intern.zet_audit_context(null, null);
      return jsonb_build_object('status', 'duplicaat', 'factuur_id', v_bestaand);
    end if;
  end if;

  -- Codering: historie gaat vóór het AI-voorstel (zoals in de app); alleen actieve rekeningen van de organisatie.
  select h.grootboekrekening_id, h.zekerheid into v_rekening, v_zekerheid
  from public.stel_codering_voor(v_org, v_naam) h;
  if v_rekening is not null then
    v_bron := 'historie';
  else
    select g.id into v_rekening from public.grootboekrekeningen g
    where g.id = nullif(p_codering ->> 'grootboekrekening_id', '')::uuid and g.organisatie_id = v_org and g.actief;
    if v_rekening is not null then
      v_bron := 'ai';
      v_zekerheid := (p_codering ->> 'zekerheid')::numeric;
    end if;
  end if;

  insert into public.facturen (
    id, organisatie_id, user_id, leverancier_id, leverancier_naam, factuurnummer, factuurdatum, vervaldatum,
    valuta, bedrag_excl, totaal_incl, bestand_pad, bestandsnaam, ai_model, iban, btw_nummer, kvk_nummer,
    grootboekrekening_id, codering_bron, codering_zekerheid, bron, inbox_bijlage_id
  )
  values (
    p_factuur_id, v_org, null, v_leverancier_id, v_naam, v_nummer,
    nullif(p_factuur ->> 'factuurdatum', '')::date, nullif(p_factuur ->> 'vervaldatum', '')::date,
    upper(nullif(btrim(p_factuur ->> 'valuta'), '')), (p_factuur ->> 'bedrag_excl')::numeric,
    (p_factuur ->> 'totaal_incl')::numeric, p_pad, x.bestandsnaam, nullif(p_ai_model, ''),
    v_iban, v_btw_nummer, v_kvk_nummer, v_rekening, v_bron,
    case when v_bron in ('historie', 'ai') then least(greatest(v_zekerheid, 0), 1) end,
    'mailbox', x.id
  );

  insert into public.btw_regels (factuur_id, volgorde, tarief, grondslag, btw_bedrag)
  select p_factuur_id, (r.nr - 1)::smallint, (r.regel ->> 'tarief')::numeric, (r.regel ->> 'grondslag')::numeric,
         (r.regel ->> 'btw_bedrag')::numeric
  from jsonb_array_elements(coalesce(p_factuur -> 'btw_regels', '[]'::jsonb)) with ordinality as r (regel, nr);

  perform intern.bepaal_signalen(p_factuur_id);

  update public.inbox_bijlagen set status = 'verwerkt', factuur_id = p_factuur_id, reden = null where id = x.id;

  perform intern.log_gebeurtenis(v_org, 'import', 'mailbox', 'facturen', p_factuur_id,
    jsonb_build_object('omschrijving', format('Geïmporteerd uit de mail van %s (%s)', b.van, x.bestandsnaam),
                       'bericht_id', b.id, 'bijlage_id', x.id, 'van', b.van, 'onderwerp', b.onderwerp),
    null, null);
  perform intern.zet_audit_context(null, null);

  return jsonb_build_object('status', 'verwerkt', 'factuur_id', p_factuur_id);
end;
$$;

revoke execute on function public.registreer_inbox_bericht(jsonb), public.rond_inbox_bericht_af(uuid, jsonb),
  public.maak_factuur_uit_inbox(uuid, uuid, jsonb, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.registreer_inbox_bericht(jsonb), public.rond_inbox_bericht_af(uuid, jsonb),
  public.maak_factuur_uit_inbox(uuid, uuid, jsonb, text, text, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Status van een taak doorgeven aan het onderwerp (hier: de inbox-bijlage)
-- ---------------------------------------------------------------------------
-- Wordt aangeroepen door rond_taak_af en probeer_taak_opnieuw. Latere fasen breiden deze functie uit.

create function intern.taak_status_gewijzigd(p_taak public.koppeling_taken, p_status text, p_fout text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_taak.soort = 'mailbox' then
    if p_status = 'opgegeven' then
      update public.inbox_bijlagen set status = 'mislukt', reden = left(coalesce(p_fout, 'Onbekende fout.'), 500)
      where id = (p_taak.payload ->> 'bijlage_id')::uuid and factuur_id is null and status = 'wachtrij';
    elsif p_status = 'wachtrij' then
      update public.inbox_bijlagen set status = 'wachtrij', reden = null
      where id = (p_taak.payload ->> 'bijlage_id')::uuid and factuur_id is null and status = 'mislukt';
    end if;
  end if;
end;
$$;

revoke execute on function intern.taak_status_gewijzigd(public.koppeling_taken, text, text) from public;

-- rond_taak_af en probeer_taak_opnieuw uit fase 4.1, nu met intern.taak_status_gewijzigd.

create or replace function public.rond_taak_af(
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

  perform intern.taak_status_gewijzigd(t, v_status, v_fout);
  return v_status;
end;
$$;

create or replace function public.probeer_taak_opnieuw(p_taak_id uuid)
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

  perform intern.taak_status_gewijzigd(t, 'wachtrij', null);
  perform intern.start_worker();
end;
$$;

-- Taak van een inbox-bijlage (om vanuit de inbox opnieuw te kunnen proberen).
create function public.taak_van_inbox_bijlage(p_bijlage_id uuid)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select t.id from public.koppeling_taken t
  where t.soort = 'mailbox' and t.sleutel = p_bijlage_id::text
  order by t.created_at desc
  limit 1;
$$;

revoke execute on function public.taak_van_inbox_bijlage(uuid) from public, anon;
grant execute on function public.taak_van_inbox_bijlage(uuid) to authenticated;
