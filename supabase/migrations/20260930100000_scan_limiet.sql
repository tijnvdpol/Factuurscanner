-- Dagelijkse limiet op AI-scans (OpenAI kost geld per aanroep).
--
-- - scan_gebruik: aantal scans per sleutel (organisatie; zonder lidmaatschap de gebruiker) per dag
--   (Nederlandse tijd). Alleen de Edge Functions (service_role) komen erbij; de app zelf niet.
-- - claim_scan: verhoogt de teller atomair als de limiet nog niet bereikt is en geeft dan true, anders false.
-- - geef_scan_terug: maakt een claim ongedaan als de scan zelf mislukte, zodat een storing niet meetelt.
-- De limiet zelf (standaard 5) staat in de Edge Functions (secret SCAN_LIMIET_PER_DAG).

create table public.scan_gebruik (
  sleutel uuid not null,
  dag     date not null,
  aantal  integer not null default 0 check (aantal >= 0),
  primary key (sleutel, dag)
);

alter table public.scan_gebruik enable row level security;
revoke all on public.scan_gebruik from public, anon, authenticated;

create function public.claim_scan(p_sleutel uuid, p_limiet integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_aantal integer;
begin
  if p_limiet < 1 then
    return false;
  end if;

  insert into public.scan_gebruik as g (sleutel, dag, aantal)
  values (p_sleutel, (now() at time zone 'Europe/Amsterdam')::date, 1)
  on conflict (sleutel, dag) do update set aantal = g.aantal + 1
    where g.aantal < p_limiet
  returning g.aantal into v_aantal;

  return v_aantal is not null;
end;
$$;

create function public.geef_scan_terug(p_sleutel uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.scan_gebruik
  set aantal = greatest(aantal - 1, 0)
  where sleutel = p_sleutel and dag = (now() at time zone 'Europe/Amsterdam')::date;
$$;

revoke execute on function public.claim_scan(uuid, integer), public.geef_scan_terug(uuid) from public, anon, authenticated;
grant execute on function public.claim_scan(uuid, integer), public.geef_scan_terug(uuid) to service_role;
