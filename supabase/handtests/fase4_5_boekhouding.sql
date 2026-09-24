-- Handmatige test voor fase 4.5 (export naar het boekhoudpakket): plak dit in de Supabase SQL Editor en klik Run.
--
-- Test het inplannen van de export na goedkeuren, dat alleen goedgekeurde facturen worden geëxporteerd, de
-- mappings, dubbele export (één export per factuur) en de vergrendeling na export. Moneybird wordt niet
-- aangeroepen: het script doet wat de worker doet. Het script eindigt ALTIJD met een foutmelding, zodat alle
-- testdata automatisch wordt teruggedraaid:
--   "GESLAAGD: ..."  -> alles werkt
--   "FOUT n: ..."    -> test n faalt (of een andere onverwachte fout)

do $$
declare
  v_beheerder   uuid := gen_random_uuid();
  v_invoerder   uuid := gen_random_uuid();
  v_goedkeurder uuid := gen_random_uuid();
  v_org         uuid;
  v_rekening    uuid;
  v_factuur     uuid;
  v_open        uuid;
  v_r           jsonb;
  v_n           int;
  v_ok          boolean;
begin
  insert into auth.users (id, email) values
    (v_beheerder, 'fase45-beheerder@example.invalid'),
    (v_invoerder, 'fase45-invoerder@example.invalid'),
    (v_goedkeurder, 'fase45-goedkeurder@example.invalid');
  select organisatie_id into v_org from public.organisatie_leden where user_id = v_beheerder;
  select id into v_rekening from public.grootboekrekeningen where organisatie_id = v_org and code = '4300';

  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.voeg_lid_toe(v_org, 'fase45-invoerder@example.invalid', 'invoerder', null);
  perform public.voeg_lid_toe(v_org, 'fase45-goedkeurder@example.invalid', 'goedkeurder', null);

  -- Invoerder voert in, beheerder controleert, goedkeurder keurt goed
  perform set_config('request.jwt.claims', json_build_object('sub', v_invoerder, 'role', 'authenticated')::text, true);
  v_factuur := public.sla_factuur_op(jsonb_build_object(
    'organisatie_id', v_org, 'leverancier', 'Fase45 BV', 'factuurnummer', 'F45-1', 'totaal_incl', 121, 'bedrag_excl', 100,
    'iban', 'NL91ABNA0417164300', 'grootboekrekening_id', v_rekening,
    'btw_regels', jsonb_build_array(jsonb_build_object('tarief', 21, 'grondslag', 100, 'btw_bedrag', 21))));
  v_open := public.sla_factuur_op(jsonb_build_object(
    'organisatie_id', v_org, 'leverancier', 'Fase45 BV', 'factuurnummer', 'F45-2', 'totaal_incl', 50, 'grootboekrekening_id', v_rekening));

  -- 1. Nog niet goedgekeurd: geen export gepland
  select count(*) into v_n from public.koppeling_taken where soort = 'boekhouding' and factuur_id = v_factuur;
  if v_n <> 0 then raise exception 'FOUT 1: export gepland vóór goedkeuren'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
  perform public.wijzig_status(v_factuur, 'gecontroleerd');
  perform set_config('request.jwt.claims', json_build_object('sub', v_goedkeurder, 'role', 'authenticated')::text, true);
  perform public.wijzig_status(v_factuur, 'goedgekeurd');

  -- 2. Na goedkeuren: export in de wachtrij
  select count(*) into v_n from public.koppeling_taken where soort = 'boekhouding' and factuur_id = v_factuur and status = 'wachtrij';
  if v_n <> 1 then raise exception 'FOUT 2: verwacht 1 export-taak na goedkeuren, kreeg %', v_n; end if;

  -- 3. Mapping instellen (beheerder) en ophalen zoals de worker
  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
  perform public.stel_boekhoud_mapping_in(v_org, 'moneybird', 'grootboek', v_rekening::text, 'MB-4300', 'Kantoorkosten');
  perform public.stel_boekhoud_mapping_in(v_org, 'moneybird', 'btw', '21', 'MB-21', '21% btw');

  -- ===================== Als eigenaar (zoals de worker) =====================
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'postgres', true);

  v_r := public.export_gegevens(v_factuur);
  if v_r ->> 'status' <> 'exporteren' or v_r #>> '{mappings,grootboek,extern_id}' <> 'MB-4300'
     or v_r #>> '{mappings,btw,21,extern_id}' <> 'MB-21' then
    raise exception 'FOUT 3: export_gegevens klopt niet: %', v_r;
  end if;

  -- 4. Niet goedgekeurd = niet toegestaan
  if public.export_gegevens(v_open) ->> 'status' <> 'niet_toegestaan' then
    raise exception 'FOUT 4: een niet-goedgekeurde factuur mocht worden geëxporteerd';
  end if;

  -- 5. Registreren; een tweede, andere export van dezelfde factuur wordt geweigerd
  perform public.registreer_export(v_factuur, 'moneybird', 'mock', 'MB-FACTUUR-1', null, '{}'::jsonb);
  v_ok := false;
  begin
    perform public.registreer_export(v_factuur, 'moneybird', 'mock', 'MB-FACTUUR-2', null, '{}'::jsonb);
  exception when unique_violation then v_ok := true;
  end;
  if not v_ok or public.export_gegevens(v_factuur) ->> 'status' <> 'al_geexporteerd' then
    raise exception 'FOUT 5: dubbele export niet tegengehouden';
  end if;

  -- ===================== In de app =====================
  perform set_config('role', 'authenticated', true);

  -- 6. Geëxporteerde factuur: inhoud niet te wijzigen
  perform set_config('request.jwt.claims', json_build_object('sub', v_invoerder, 'role', 'authenticated')::text, true);
  v_ok := false;
  begin
    update public.facturen set totaal_incl = 1 where id = v_factuur;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 6: geëxporteerde factuur kon worden gewijzigd'; end if;

  -- 7. Btw-regels niet te wijzigen
  v_ok := false;
  begin
    delete from public.btw_regels where factuur_id = v_factuur;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 7: btw-regels van een geëxporteerde factuur konden worden gewijzigd'; end if;

  -- 8. Ook de beheerder kan hem niet verwijderen
  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
  v_ok := false;
  begin
    delete from public.facturen where id = v_factuur;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 8: geëxporteerde factuur kon worden verwijderd'; end if;

  -- 9. Als betaald markeren kan wel
  perform public.wijzig_status(v_factuur, 'betaald');
  if (select status from public.facturen where id = v_factuur) <> 'betaald' then
    raise exception 'FOUT 9: geëxporteerde factuur kon niet als betaald worden gemarkeerd';
  end if;

  raise exception 'GESLAAGD: alle 9 tests ok (testdata is teruggedraaid)';
end;
$$;
