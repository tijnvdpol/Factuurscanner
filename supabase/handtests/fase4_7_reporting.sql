-- Handmatige test voor fase 4.7 (rapportages voor Power BI): plak dit in de Supabase SQL Editor en klik Run.
--
-- Test dat de views bestaan en kloppen voor een voorbeeldfactuur, en dat de rol reporting_lezer alleen de views mag
-- lezen (geen tabellen, geen functies die met rechten van de eigenaar draaien). Draai hem opnieuw nadat je de
-- login-rol voor Power BI hebt gemaakt: dan wordt die ook gecontroleerd. Het script eindigt ALTIJD met een
-- foutmelding, zodat alle testdata automatisch wordt teruggedraaid:
--   "GESLAAGD: ..."  -> alles werkt
--   "FOUT n: ..."    -> test n faalt (of een andere onverwachte fout)

do $$
declare
  v_gebruiker uuid := gen_random_uuid();
  v_org       uuid;
  v_factuur   uuid;
  v_tekst     text;
  v_n         int;
  v_login     text;
begin
  insert into auth.users (id, email) values (v_gebruiker, 'fase47@example.invalid');
  select organisatie_id into v_org from public.organisatie_leden where user_id = v_gebruiker;

  perform set_config('request.jwt.claims', json_build_object('sub', v_gebruiker, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  v_factuur := public.sla_factuur_op(jsonb_build_object('organisatie_id', v_org, 'leverancier', 'Fase47 BV',
    'factuurnummer', 'F47-1', 'totaal_incl', 242, 'vervaldatum', ((now() at time zone 'Europe/Amsterdam')::date - 40)::text));
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'postgres', true);

  -- 1. Openstaande post met ouderdom 31-60 dagen
  select ouderdom || '|' || bedrag_eur into v_tekst from reporting.openstaande_posten where factuur_id = v_factuur;
  if v_tekst is distinct from '31-60 dagen|242.00' then raise exception 'FOUT 1: openstaande_posten gaf %', v_tekst; end if;

  -- 2. Crediteurenouderdom telt hem in de juiste kolom
  select dagen_31_60::text into v_tekst from reporting.crediteurenouderdom where organisatie_id = v_org;
  if v_tekst is distinct from '242.00' then raise exception 'FOUT 2: crediteurenouderdom gaf %', v_tekst; end if;

  -- 3. Cashflowprognose: vervallen = vandaag
  select count(*) into v_n from reporting.cashflowprognose
  where organisatie_id = v_org and verwachte_datum = (now() at time zone 'Europe/Amsterdam')::date and bedrag_eur = 242;
  if v_n <> 1 then raise exception 'FOUT 3: cashflowprognose niet op vandaag'; end if;

  -- 4. Doorlooptijd-view is leesbaar (nog niet goedgekeurd, dus niet in de lijst)
  select count(*) into v_n from reporting.doorlooptijd_goedkeuring where factuur_id = v_factuur;
  if v_n <> 0 then raise exception 'FOUT 4: niet-goedgekeurde factuur in doorlooptijd_goedkeuring'; end if;

  -- 5. reporting_lezer mag alle vier de views lezen
  select count(*) filter (where has_table_privilege('reporting_lezer', c.oid, 'select')) into v_n
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'reporting' and c.relkind = 'v';
  if v_n <> 4 then raise exception 'FOUT 5: reporting_lezer kan % van de 4 views lezen', v_n; end if;

  -- 6. ... maar geen enkele tabel in public of auth
  select count(*) filter (where has_table_privilege('reporting_lezer', c.oid, 'select')) into v_n
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'auth', 'storage') and c.relkind in ('r', 'v', 'm', 'p');
  if v_n <> 0 then raise exception 'FOUT 6: reporting_lezer kan % tabellen lezen', v_n; end if;

  -- 7. ... en geen functie die met rechten van de eigenaar draait (anders: met een zelfgezette JWT een gebruiker nadoen)
  select string_agg(n.nspname || '.' || p.proname, ', ') into v_tekst
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prosecdef and n.nspname in ('public', 'intern', 'reporting')
    and has_function_privilege('reporting_lezer', p.oid, 'execute');
  if v_tekst is not null then raise exception 'FOUT 7: reporting_lezer kan uitvoeren: %', v_tekst; end if;

  -- 8. App-gebruikers zien het schema niet
  if has_schema_privilege('authenticated', 'reporting', 'usage') or has_schema_privilege('anon', 'reporting', 'usage') then
    raise exception 'FOUT 8: app-gebruikers hebben toegang tot het schema reporting';
  end if;

  -- 9. Login-rollen die lid zijn van reporting_lezer: alleen lezen en geen andere rechten (als ze er al zijn)
  for v_login in
    select r.rolname from pg_roles r join pg_auth_members m on m.member = r.oid
    where m.roleid = (select oid from pg_roles where rolname = 'reporting_lezer') and r.rolcanlogin
  loop
    if (select rolsuper or rolcreaterole or rolcreatedb or rolbypassrls from pg_roles where rolname = v_login) then
      raise exception 'FOUT 9: login-rol % heeft te veel rechten', v_login;
    end if;
    if (select count(*) filter (where has_table_privilege(v_login, c.oid, 'select'))
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'auth') and c.relkind in ('r', 'v', 'm', 'p')) > 0 then
      raise exception 'FOUT 9: login-rol % kan tabellen buiten reporting lezen', v_login;
    end if;
  end loop;

  raise exception 'GESLAAGD: alle 9 tests ok (testdata is teruggedraaid)';
end;
$$;
