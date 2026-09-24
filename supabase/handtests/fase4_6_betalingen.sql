-- Handmatige test voor fase 4.6 (betaalopdrachten): plak dit in de Supabase SQL Editor en klik Run.
--
-- Test de betalende rekening, het maken van een betaalbatch (goedgekeurd → in betaalbatch), de controles (IBAN,
-- euro, SEPA-land), dat een factuur niet in twee batches kan, de vergrendeling, de bevestiging van de bank en
-- annuleren. De bank wordt niet aangeroepen: het script doet wat de worker (mock-bank) doet. Het script eindigt
-- ALTIJD met een foutmelding, zodat alle testdata automatisch wordt teruggedraaid:
--   "GESLAAGD: ..."  -> alles werkt
--   "FOUT n: ..."    -> test n faalt (of een andere onverwachte fout)

do $$
declare
  v_beheerder   uuid := gen_random_uuid();
  v_invoerder   uuid := gen_random_uuid();
  v_goedkeurder uuid := gen_random_uuid();
  v_org         uuid;
  v_rekening    uuid;
  v_a           uuid;
  v_b           uuid;
  v_usd         uuid;
  v_batch       uuid;
  v_batch2      uuid;
  v_e2e         text;
  v_tekst       text;
  v_ok          boolean;
  v_id          uuid;
begin
  insert into auth.users (id, email) values
    (v_beheerder, 'fase46-beheerder@example.invalid'),
    (v_invoerder, 'fase46-invoerder@example.invalid'),
    (v_goedkeurder, 'fase46-goedkeurder@example.invalid');
  select organisatie_id into v_org from public.organisatie_leden where user_id = v_beheerder;
  select id into v_rekening from public.grootboekrekeningen where organisatie_id = v_org and code = '4300';

  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.voeg_lid_toe(v_org, 'fase46-invoerder@example.invalid', 'invoerder', null);
  perform public.voeg_lid_toe(v_org, 'fase46-goedkeurder@example.invalid', 'goedkeurder', null);
  perform public.stel_koppeling_in(v_org, 'betaling', 'mock',
    jsonb_build_object('naam', 'Fase46 Eigen B.V.', 'iban', 'NL44RABO0123456789', 'bic', 'RABONL2U'));

  -- Drie facturen: twee in euro, één in dollars; alle drie goedgekeurd
  perform set_config('request.jwt.claims', json_build_object('sub', v_invoerder, 'role', 'authenticated')::text, true);
  v_a := public.sla_factuur_op(jsonb_build_object('organisatie_id', v_org, 'leverancier', 'Fase46 A BV', 'factuurnummer', 'F46-1',
    'totaal_incl', 121, 'iban', 'NL91ABNA0417164300', 'grootboekrekening_id', v_rekening));
  v_b := public.sla_factuur_op(jsonb_build_object('organisatie_id', v_org, 'leverancier', 'Fase46 B BV', 'factuurnummer', 'F46-2',
    'totaal_incl', 50.13, 'iban', 'NL91ABNA0417164300', 'grootboekrekening_id', v_rekening));
  v_usd := public.sla_factuur_op(jsonb_build_object('organisatie_id', v_org, 'leverancier', 'Fase46 Inc', 'factuurnummer', 'F46-3',
    'totaal_incl', 80, 'valuta', 'USD', 'iban', 'NL91ABNA0417164300', 'grootboekrekening_id', v_rekening));
  foreach v_id in array array[v_a, v_b, v_usd] loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
    perform public.wijzig_status(v_id, 'gecontroleerd');
    perform set_config('request.jwt.claims', json_build_object('sub', v_goedkeurder, 'role', 'authenticated')::text, true);
    perform public.wijzig_status(v_id, 'goedgekeurd');
  end loop;

  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);

  -- 1. Een factuur in dollars kan niet in een SEPA-batch (en er wordt dan niets aangemaakt)
  v_ok := false;
  begin
    perform public.maak_betaalbatch(v_org, array[v_a, v_usd], null);
  exception when invalid_parameter_value then v_ok := sqlerrm like '%alleen in euro%';
  end;
  if not v_ok or (select status from public.facturen where id = v_a) <> 'goedgekeurd' then
    raise exception 'FOUT 1: factuur in vreemde valuta niet geweigerd (of batch toch deels gemaakt)';
  end if;

  -- 2. Batch maken: facturen gaan naar "in betaalbatch"
  v_batch := public.maak_betaalbatch(v_org, array[v_a, v_b], null);
  if (select count(*) from public.facturen where id in (v_a, v_b) and status = 'in_betaalbatch') <> 2 then
    raise exception 'FOUT 2: facturen niet in betaalbatch';
  end if;

  -- 3. Totaal en aantal kloppen
  select aantal || '|' || totaal into v_tekst from public.betaalbatches where id = v_batch;
  if v_tekst <> '2|171.13' then raise exception 'FOUT 3: batch heeft %', v_tekst; end if;

  -- 4. Dezelfde factuur kan niet in een tweede batch
  v_ok := false;
  begin
    perform public.maak_betaalbatch(v_org, array[v_a], null);
  exception when invalid_parameter_value then v_ok := sqlerrm like '%zit al in een betaalbatch%';
  end;
  if not v_ok then raise exception 'FOUT 4: factuur kon in twee batches'; end if;

  -- 5. Vergrendeld: het IBAN wijzigen kan niet
  v_ok := false;
  begin
    update public.facturen set iban = 'NL44RABO0123456789' where id = v_a;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 5: factuur in een betaalbatch kon worden gewijzigd'; end if;

  -- ===================== Als eigenaar (zoals de worker met de mock-bank) =====================
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'postgres', true);

  -- 6. Ingediend en bevestigd: A betaald, B geweigerd (AC04) → B terug naar goedgekeurd
  perform public.registreer_batch_ingediend(v_batch, 'MOCKBANK-TEST', 'mock');
  select end_to_end_id into v_e2e from public.betaalbatch_posten where batch_id = v_batch and factuur_id = v_a;
  perform public.verwerk_bankbevestiging(v_batch, jsonb_build_array(
    jsonb_build_object('end_to_end_id', v_e2e, 'status', 'betaald'),
    jsonb_build_object('end_to_end_id', (select end_to_end_id from public.betaalbatch_posten where batch_id = v_batch and factuur_id = v_b),
                       'status', 'geweigerd', 'reden', 'AC04 Rekening opgeheven')));
  select (select status from public.facturen where id = v_a) || '|' || (select status from public.facturen where id = v_b)
         || '|' || (select status from public.betaalbatches where id = v_batch) into v_tekst;
  if v_tekst <> 'betaald|goedgekeurd|verwerkt' then raise exception 'FOUT 6: na bevestiging: %', v_tekst; end if;

  -- 7. In de audit log: statuswijziging met bron betaling
  if not exists (select 1 from public.audit_log where record_id = v_a and actie = 'statuswijziging' and bron = 'betaling'
                 and nieuw ->> 'status' = 'betaald') then
    raise exception 'FOUT 7: betaling niet (met bron betaling) in de audit log';
  end if;

  -- ===================== Beheerder: opnieuw en annuleren =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- 8. De geweigerde factuur kan in een nieuwe batch, en annuleren zet hem terug
  v_batch2 := public.maak_betaalbatch(v_org, array[v_b], null);
  perform public.annuleer_betaalbatch(v_batch2, 'Test annuleren');
  if (select status from public.facturen where id = v_b) <> 'goedgekeurd'
     or (select status from public.betaalbatches where id = v_batch2) <> 'geannuleerd' then
    raise exception 'FOUT 8: annuleren zette de factuur niet terug';
  end if;

  -- 9. Een invoerder kan geen batch maken
  perform set_config('request.jwt.claims', json_build_object('sub', v_invoerder, 'role', 'authenticated')::text, true);
  v_ok := false;
  begin
    perform public.maak_betaalbatch(v_org, array[v_b], null);
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 9: invoerder kon een betaalbatch maken'; end if;

  raise exception 'GESLAAGD: alle 9 tests ok (testdata is teruggedraaid)';
end;
$$;
