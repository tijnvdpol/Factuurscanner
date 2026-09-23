-- Handmatige test voor stap 2 en 3: plak dit in de Supabase SQL Editor en klik Run.
--
-- Het script maakt tijdelijke testgebruikers aan en test signalen, RLS tussen organisaties,
-- functiescheiding, goedkeuringslimiet, blokkade door een kritiek signaal, terugval naar gescand en de
-- onveranderlijkheid van de audit log. Het eindigt ALTIJD met een foutmelding, zodat alle testdata
-- automatisch wordt teruggedraaid:
--   "GESLAAGD: ..."  -> alles werkt
--   "FOUT n: ..."    -> test n faalt (of een andere onverwachte fout)

do $$
declare
  v_beheerder   uuid := gen_random_uuid();
  v_invoerder   uuid := gen_random_uuid();
  v_goedkeurder uuid := gen_random_uuid();
  v_buiten      uuid := gen_random_uuid();
  v_org         uuid;
  v_rekening    uuid;
  v_f1          uuid;
  v_f2          uuid;
  v_f3          uuid;
  v_f4          uuid;
  v_signaal     uuid;
  v_n           int;
  v_tekst       text;
  v_ok          boolean;
begin
  insert into auth.users (id, email) values
    (v_beheerder, 'stap23-beheerder@example.invalid'),
    (v_invoerder, 'stap23-invoerder@example.invalid'),
    (v_goedkeurder, 'stap23-goedkeurder@example.invalid'),
    (v_buiten, 'stap23-buiten@example.invalid');

  -- 1. Nieuwe gebruiker krijgt een eigen organisatie (beheerder) met 16 grootboekrekeningen
  select organisatie_id into v_org from public.organisatie_leden where user_id = v_beheerder and rol = 'beheerder';
  if v_org is null then raise exception 'FOUT 1a: geen organisatie aangemaakt voor nieuwe gebruiker'; end if;
  select count(*) into v_n from public.grootboekrekeningen where organisatie_id = v_org;
  if v_n <> 16 then raise exception 'FOUT 1b: verwacht 16 grootboekrekeningen, kreeg %', v_n; end if;
  select id into v_rekening from public.grootboekrekeningen where organisatie_id = v_org and code = '4300';

  -- ===================== Beheerder: leden toevoegen =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  perform public.voeg_lid_toe(v_org, 'stap23-invoerder@example.invalid', 'invoerder', null);
  perform public.voeg_lid_toe(v_org, 'stap23-goedkeurder@example.invalid', 'goedkeurder', 5000);

  -- 2. Laatste beheerder kan zichzelf niet verwijderen
  v_ok := false;
  begin
    perform public.verwijder_lid(v_org, v_beheerder);
  exception when others then v_ok := sqlerrm like '%laatste beheerder%';
  end;
  if not v_ok then raise exception 'FOUT 2: laatste beheerder kon zichzelf verwijderen'; end if;

  -- ===================== Invoerder =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_invoerder, 'role', 'authenticated')::text, true);

  -- 3. Nieuwe factuur is altijd gescand, ook als er een andere status wordt meegegeven
  v_f1 := public.sla_factuur_op(jsonb_build_object(
    'organisatie_id', v_org, 'leverancier', 'Stap23 BV', 'factuurnummer', 'S-0001', 'totaal_incl', 121,
    'iban', 'NL91ABNA0417164300', 'grootboekrekening_id', v_rekening, 'status', 'goedgekeurd',
    'btw_regels', jsonb_build_array(jsonb_build_object('tarief', 21, 'grondslag', 100, 'btw_bedrag', 21))));
  select status into v_tekst from public.facturen where id = v_f1;
  if v_tekst <> 'gescand' then raise exception 'FOUT 3: nieuwe factuur heeft status %', v_tekst; end if;

  -- 4. Status rechtstreeks wijzigen kan niet
  v_ok := false;
  begin
    update public.facturen set status = 'goedgekeurd' where id = v_f1;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 4: status kon rechtstreeks worden gewijzigd'; end if;

  -- 5. Signalen: duplicaat (genormaliseerd factuurnummer) en afwijkend IBAN (kritiek)
  v_f2 := public.sla_factuur_op(jsonb_build_object(
    'organisatie_id', v_org, 'leverancier', 'stap23 bv', 'factuurnummer', 'S 1', 'totaal_incl', 50,
    'iban', 'NL44RABO0123456789', 'grootboekrekening_id', v_rekening));
  select count(*) into v_n from public.factuur_signalen
  where factuur_id = v_f2 and type in ('mogelijk_duplicaat', 'iban_afwijkend') and not opgelost;
  if v_n <> 2 then raise exception 'FOUT 5a: verwacht duplicaat- en IBAN-signaal, kreeg %', v_n; end if;
  select iban into v_tekst from public.leveranciers where organisatie_id = v_org and lower(naam) = 'stap23 bv';
  if v_tekst <> 'NL91ABNA0417164300' then raise exception 'FOUT 5b: bekend IBAN overschreven'; end if;

  -- 6. Invoerder controleert, maar kan niet goedkeuren
  perform public.wijzig_status(v_f1, 'gecontroleerd', null);
  v_ok := false;
  begin
    perform public.wijzig_status(v_f1, 'goedgekeurd', null);
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 6: invoerder kon goedkeuren'; end if;

  -- 7. Invoerder kan een kritiek signaal niet zelf oplossen
  select id into v_signaal from public.factuur_signalen where factuur_id = v_f2 and type = 'iban_afwijkend';
  v_ok := false;
  begin
    perform public.los_signaal_op(v_signaal, 'akkoord', false);
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 7: invoerder kon kritiek signaal oplossen'; end if;

  perform public.wijzig_status(v_f2, 'gecontroleerd', null);

  -- Factuur boven de limiet van de goedkeurder
  v_f3 := public.sla_factuur_op(jsonb_build_object(
    'organisatie_id', v_org, 'leverancier', 'Groot BV', 'factuurnummer', 'G-1', 'totaal_incl', 6000,
    'grootboekrekening_id', v_rekening));
  perform public.wijzig_status(v_f3, 'gecontroleerd', null);

  -- ===================== Beheerder voert in, goedkeurder moet goedkeuren =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
  v_f4 := public.sla_factuur_op(jsonb_build_object(
    'organisatie_id', v_org, 'leverancier', 'Eigen BV', 'factuurnummer', 'E-1', 'totaal_incl', 10,
    'grootboekrekening_id', v_rekening));
  perform public.wijzig_status(v_f4, 'gecontroleerd', null);

  -- 8. Functiescheiding: wie invoert (of controleert) kan niet goedkeuren
  v_ok := false;
  begin
    perform public.wijzig_status(v_f4, 'goedgekeurd', null);
  exception when insufficient_privilege then v_ok := sqlerrm like 'Functiescheiding%';
  end;
  if not v_ok then raise exception 'FOUT 8: beheerder kon eigen factuur goedkeuren'; end if;

  -- ===================== Goedkeurder =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_goedkeurder, 'role', 'authenticated')::text, true);

  -- 9. Goedkeuringslimiet
  v_ok := false;
  begin
    perform public.wijzig_status(v_f3, 'goedgekeurd', null);
  exception when insufficient_privilege then v_ok := sqlerrm like 'Boven je goedkeuringslimiet van € 5.000%';
  end;
  if not v_ok then raise exception 'FOUT 9: factuur boven de limiet kon worden goedgekeurd'; end if;

  -- 10. Open kritiek signaal blokkeert goedkeuren; na oplossen (met toelichting) wel
  v_ok := false;
  begin
    perform public.wijzig_status(v_f2, 'goedgekeurd', null);
  exception when invalid_parameter_value then v_ok := sqlerrm like '%kritiek signaal%';
  end;
  if not v_ok then raise exception 'FOUT 10a: kritiek signaal blokkeerde niet'; end if;
  perform public.los_signaal_op(v_signaal, 'Nagebeld via bekend nummer; nieuw rekeningnummer klopt', false);
  perform public.wijzig_status(v_f2, 'goedgekeurd', null);
  select status into v_tekst from public.facturen where id = v_f2;
  if v_tekst <> 'goedgekeurd' then raise exception 'FOUT 10b: goedkeuren na oplossen mislukt (%)', v_tekst; end if;

  -- 11. Goedgekeurd + gewijzigd bedrag → terug naar gescand
  perform public.wijzig_status(v_f1, 'goedgekeurd', null);
  perform public.sla_factuur_op(jsonb_build_object(
    'id', v_f1, 'organisatie_id', v_org, 'leverancier', 'Stap23 BV', 'factuurnummer', 'S-0001', 'totaal_incl', 122,
    'iban', 'NL91ABNA0417164300', 'grootboekrekening_id', v_rekening,
    'btw_regels', jsonb_build_array(jsonb_build_object('tarief', 21, 'grondslag', 100, 'btw_bedrag', 21))), true);
  select status into v_tekst from public.facturen where id = v_f1;
  if v_tekst <> 'gescand' then raise exception 'FOUT 11: status niet teruggezet (%)', v_tekst; end if;

  -- 12. Audit trail: statuswijzigingen met gebruiker
  select count(*) into v_n from public.audit_log
  where tabel = 'facturen' and record_id = v_f2 and actie = 'statuswijziging';
  if v_n <> 2 then raise exception 'FOUT 12: verwacht 2 statuswijzigingen in audit log, kreeg %', v_n; end if;

  -- 13. Audit log is niet te wijzigen of te verwijderen
  v_ok := false;
  begin
    update public.audit_log set toelichting = 'weg';
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 13a: lid kon audit log wijzigen'; end if;
  v_ok := false;
  begin
    delete from public.audit_log;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 13b: lid kon audit log verwijderen'; end if;

  perform set_config('role', 'postgres', true);
  v_ok := false;
  begin
    update public.audit_log set toelichting = 'weg' where organisatie_id = v_org;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 13c: beheerder (SQL Editor) kon audit log wijzigen'; end if;

  -- ===================== Buitenstaander =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_buiten, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- 14. Gebruiker uit een andere organisatie ziet niets
  select (select count(*) from public.facturen where organisatie_id = v_org)
       + (select count(*) from public.leveranciers where organisatie_id = v_org)
       + (select count(*) from public.factuur_signalen where organisatie_id = v_org)
       + (select count(*) from public.grootboekrekeningen where organisatie_id = v_org)
       + (select count(*) from public.audit_log where organisatie_id = v_org) into v_n;
  if v_n <> 0 then raise exception 'FOUT 14: buitenstaander ziet % rijen van de organisatie', v_n; end if;

  -- 15. …en kan geen status wijzigen of lid worden
  v_ok := false;
  begin
    perform public.wijzig_status(v_f3, 'goedgekeurd', null);
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 15a: buitenstaander kon status wijzigen'; end if;
  v_ok := false;
  begin
    perform public.voeg_lid_toe(v_org, 'stap23-buiten@example.invalid', 'beheerder', null);
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 15b: buitenstaander kon zichzelf toevoegen'; end if;

  raise exception 'GESLAAGD: alle 15 tests ok (testdata is teruggedraaid)';
end;
$$;
