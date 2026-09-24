-- Handmatige test voor fase 4.1 (basis koppelingen): plak dit in de Supabase SQL Editor en klik Run.
--
-- Test de audit log (bron, systeem), dat de service role de status niet rechtstreeks kan wijzigen, de
-- instellingen per koppeling en de takenwachtrij (idempotent, claimen, retries, opgeven, audit log).
-- Het script eindigt ALTIJD met een foutmelding, zodat alle testdata automatisch wordt teruggedraaid:
--   "GESLAAGD: ..."  -> alles werkt
--   "FOUT n: ..."    -> test n faalt (of een andere onverwachte fout)

do $$
declare
  v_beheerder uuid := gen_random_uuid();
  v_invoerder uuid := gen_random_uuid();
  v_buiten    uuid := gen_random_uuid();
  v_org       uuid;
  v_rekening  uuid;
  v_factuur   uuid;
  v_taak      uuid;
  v_taak2     uuid;
  v_n         int;
  v_tekst     text;
  v_ok        boolean;
begin
  insert into auth.users (id, email) values
    (v_beheerder, 'fase41-beheerder@example.invalid'),
    (v_invoerder, 'fase41-invoerder@example.invalid'),
    (v_buiten, 'fase41-buiten@example.invalid');
  select organisatie_id into v_org from public.organisatie_leden where user_id = v_beheerder;
  select id into v_rekening from public.grootboekrekeningen where organisatie_id = v_org and code = '4300';

  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.voeg_lid_toe(v_org, 'fase41-invoerder@example.invalid', 'invoerder', null);

  -- 1. Instelling per koppeling: beheerder mag, en dat staat in de audit log met bron 'app'
  perform public.stel_koppeling_in(v_org, 'vies', 'live', null);
  select modus into v_tekst from public.koppeling_instellingen where organisatie_id = v_org and koppeling = 'vies';
  if v_tekst is distinct from 'live' then raise exception 'FOUT 1a: modus niet opgeslagen (%)', v_tekst; end if;
  select count(*) into v_n from public.audit_log
  where organisatie_id = v_org and tabel = 'koppeling_instellingen' and bron = 'app' and user_id = v_beheerder;
  if v_n <> 1 then raise exception 'FOUT 1b: verwacht 1 auditregel voor de instelling, kreeg %', v_n; end if;

  -- ===================== Invoerder =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_invoerder, 'role', 'authenticated')::text, true);

  -- 2. Invoerder mag de modus niet wijzigen
  v_ok := false;
  begin
    perform public.stel_koppeling_in(v_org, 'vies', 'mock', null);
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 2: invoerder kon een koppeling instellen'; end if;

  v_factuur := public.sla_factuur_op(jsonb_build_object(
    'organisatie_id', v_org, 'leverancier', 'Fase41 BV', 'factuurnummer', 'F41-1', 'totaal_incl', 121,
    'iban', 'NL91ABNA0417164300', 'grootboekrekening_id', v_rekening,
    'btw_regels', jsonb_build_array(jsonb_build_object('tarief', 21, 'grondslag', 100, 'btw_bedrag', 21))));

  -- 3. Gebruikers kunnen geen taken claimen
  v_ok := false;
  begin
    perform public.claim_taken(10, array['test']);
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 3: een gebruiker kon taken claimen'; end if;

  -- ===================== Service role (zoals een Edge Function) =====================
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'service_role', true);

  -- 4. De service role kan de status niet rechtstreeks wijzigen
  v_ok := false;
  begin
    update public.facturen set status = 'goedgekeurd' where id = v_factuur;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 4: service role kon de status rechtstreeks wijzigen'; end if;

  -- ===================== Wachtrij (als eigenaar, zoals de interne functies) =====================
  perform set_config('role', 'postgres', true);

  -- 5. Dezelfde sleutel geeft dezelfde actieve taak
  v_taak := intern.plan_taak(v_org, 'test', 'fase41-' || v_factuur::text, v_factuur);
  v_taak2 := intern.plan_taak(v_org, 'test', 'fase41-' || v_factuur::text, v_factuur);
  if v_taak <> v_taak2 then raise exception 'FOUT 5: tweede taak aangemaakt voor dezelfde sleutel'; end if;
  update public.koppeling_taken set soort = 'vies', max_pogingen = 2 where id = v_taak;

  -- 6. Claimen als service role; mislukt → nieuwe poging over 1 minuut
  perform set_config('role', 'service_role', true);
  select count(*) into v_n from public.claim_taken(50, array['vies']) c where c.id = v_taak;
  if v_n <> 1 then raise exception 'FOUT 6a: taak niet geclaimd'; end if;
  v_tekst := public.rond_taak_af(v_taak, false, null, 'VIES niet bereikbaar', true);
  if v_tekst <> 'wachtrij' then raise exception 'FOUT 6b: verwacht wachtrij na eerste fout, kreeg %', v_tekst; end if;

  -- 7. Na het maximum aantal pogingen: opgegeven, met de fout in de audit log (bron vies, geen gebruiker)
  perform set_config('role', 'postgres', true);
  update public.koppeling_taken set volgende_poging_op = now() - interval '1 second' where id = v_taak;
  perform set_config('role', 'service_role', true);
  perform public.claim_taken(50, array['vies']);
  v_tekst := public.rond_taak_af(v_taak, false, null, 'VIES niet bereikbaar', true);
  if v_tekst <> 'opgegeven' then raise exception 'FOUT 7a: verwacht opgegeven, kreeg %', v_tekst; end if;
  perform set_config('role', 'postgres', true);
  select count(*) into v_n from public.audit_log
  where organisatie_id = v_org and tabel = 'facturen' and record_id = v_factuur
    and actie = 'verrijking' and bron = 'vies' and user_id is null and toelichting = 'VIES niet bereikbaar';
  if v_n <> 1 then raise exception 'FOUT 7b: opgegeven taak niet in de audit log (%)', v_n; end if;

  -- 8. Invoerder ziet de status bij de factuur en mag opnieuw proberen
  perform set_config('request.jwt.claims', json_build_object('sub', v_invoerder, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select status into v_tekst from public.factuur_koppelingstatus where factuur_id = v_factuur and soort = 'vies';
  if v_tekst is distinct from 'opgegeven' then raise exception 'FOUT 8a: status bij factuur is %', v_tekst; end if;
  perform public.probeer_taak_opnieuw(v_taak);
  select status into v_tekst from public.koppeling_taken where id = v_taak;
  if v_tekst <> 'wachtrij' then raise exception 'FOUT 8b: opnieuw proberen zette status op %', v_tekst; end if;

  -- 9. Statuswijziging via de app heeft nog steeds bron 'app' en de gebruiker
  perform public.wijzig_status(v_factuur, 'gecontroleerd', null);
  select count(*) into v_n from public.audit_log
  where record_id = v_factuur and actie = 'statuswijziging' and bron = 'app' and user_id = v_invoerder;
  if v_n <> 1 then raise exception 'FOUT 9: statuswijziging niet met bron app en gebruiker gelogd (%)', v_n; end if;

  -- ===================== Buitenstaander =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_buiten, 'role', 'authenticated')::text, true);

  -- 10. Ziet geen taken of instellingen en kan niets opnieuw proberen
  select (select count(*) from public.koppeling_taken where organisatie_id = v_org)
       + (select count(*) from public.koppeling_instellingen where organisatie_id = v_org)
       + (select count(*) from public.factuur_koppelingstatus where organisatie_id = v_org) into v_n;
  if v_n <> 0 then raise exception 'FOUT 10a: buitenstaander ziet % rijen', v_n; end if;
  v_ok := false;
  begin
    perform public.probeer_taak_opnieuw(v_taak);
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 10b: buitenstaander kon een taak opnieuw proberen'; end if;

  raise exception 'GESLAAGD: alle 10 tests ok (testdata is teruggedraaid)';
end;
$$;
