-- Handmatige test voor fase 4.2 (verrijken: VIES, ECB, KvK): plak dit in de Supabase SQL Editor en klik Run.
--
-- Test de omrekening naar euro, de goedkeuringslimiet in euro, het inplannen van controles en de signalen
-- uit VIES- en KvK-resultaten. De externe API's worden hier niet aangeroepen: het script zet de resultaten
-- zelf, zoals de worker dat doet. Het script eindigt ALTIJD met een foutmelding, zodat alle testdata
-- automatisch wordt teruggedraaid:
--   "GESLAAGD: ..."  -> alles werkt
--   "FOUT n: ..."    -> test n faalt (of een andere onverwachte fout)

do $$
declare
  v_beheerder   uuid := gen_random_uuid();
  v_invoerder   uuid := gen_random_uuid();
  v_goedkeurder uuid := gen_random_uuid();
  v_org         uuid;
  v_rekening    uuid;
  v_eur         uuid;
  v_usd         uuid;
  v_vies        uuid;
  v_kvk         uuid;
  v_n           int;
  v_getal       numeric;
  v_tekst       text;
  v_ok          boolean;
begin
  insert into auth.users (id, email) values
    (v_beheerder, 'fase42-beheerder@example.invalid'),
    (v_invoerder, 'fase42-invoerder@example.invalid'),
    (v_goedkeurder, 'fase42-goedkeurder@example.invalid');
  select organisatie_id into v_org from public.organisatie_leden where user_id = v_beheerder;
  select id into v_rekening from public.grootboekrekeningen where organisatie_id = v_org and code = '4300';

  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.voeg_lid_toe(v_org, 'fase42-invoerder@example.invalid', 'invoerder', null);
  perform public.voeg_lid_toe(v_org, 'fase42-goedkeurder@example.invalid', 'goedkeurder', 5000);

  -- ===================== Invoerder =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_invoerder, 'role', 'authenticated')::text, true);

  -- 1. Euro-factuur: bedrag in euro = totaal
  v_eur := public.sla_factuur_op(jsonb_build_object(
    'organisatie_id', v_org, 'leverancier', 'Fase42 Euro BV', 'factuurnummer', 'F42-1', 'totaal_incl', 121,
    'iban', 'NL91ABNA0417164300', 'grootboekrekening_id', v_rekening));
  select bedrag_eur into v_getal from public.facturen where id = v_eur;
  if v_getal is distinct from 121 then raise exception 'FOUT 1: bedrag_eur is % (verwacht 121)', v_getal; end if;

  -- 2. Dollarfactuur: nog geen euro-bedrag, wel een ecb-taak
  v_usd := public.sla_factuur_op(jsonb_build_object(
    'organisatie_id', v_org, 'leverancier', 'Fase42 Dollar Inc', 'factuurnummer', 'F42-2', 'totaal_incl', 6000,
    'valuta', 'USD', 'factuurdatum', '2026-09-07', 'iban', 'NL91ABNA0417164300', 'grootboekrekening_id', v_rekening));
  select count(*) into v_n from public.koppeling_taken where factuur_id = v_usd and soort = 'ecb';
  if v_n <> 1 then raise exception 'FOUT 2: verwacht 1 ecb-taak, kreeg %', v_n; end if;

  -- 3. VIES en KvK worden ingepland bij een btw- en KvK-nummer
  v_vies := public.sla_factuur_op(jsonb_build_object(
    'organisatie_id', v_org, 'leverancier', 'Fase42 Katrien Kappers', 'factuurnummer', 'F42-3', 'totaal_incl', 50,
    'btw_nummer', 'NL999999999B99', 'kvk_nummer', '68750110', 'iban', 'NL91ABNA0417164300', 'grootboekrekening_id', v_rekening));
  select count(*) into v_n from public.koppeling_taken
  where organisatie_id = v_org and ((soort = 'vies' and sleutel = 'NL999999999B99') or (soort = 'kvk' and sleutel = '68750110'));
  if v_n <> 2 then raise exception 'FOUT 3: verwacht een vies- en een kvk-taak, kreeg %', v_n; end if;

  perform public.wijzig_status(v_usd, 'gecontroleerd', null);

  -- ===================== Goedkeurder (limiet € 5.000) =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_goedkeurder, 'role', 'authenticated')::text, true);

  -- 4. Zonder koers: goedkeuren geblokkeerd
  v_ok := false;
  begin
    perform public.wijzig_status(v_usd, 'goedgekeurd', null);
  exception when others then v_ok := sqlerrm like '%wisselkoers%';
  end;
  if not v_ok then raise exception 'FOUT 4: goedkeuren zonder koers was mogelijk'; end if;

  -- ===================== Worker (als eigenaar van de functies) =====================
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'postgres', true);

  -- 5. Koers verwerken: USD 6.000 / 1,1622 = € 5.162,62
  v_getal := public.verwerk_wisselkoers(v_usd, 'USD', '2026-09-07', '2026-09-07', 1.1622, 'ecb');
  if v_getal is distinct from 5162.62 then raise exception 'FOUT 5: omgerekend bedrag %', v_getal; end if;

  -- 6. VIES ongeldig → signaal
  perform public.sla_verificatie_op(v_org, 'vies', 'NL999999999B99', 'ongeldig', '{}'::jsonb, 'mock');
  select count(*) into v_n from public.factuur_signalen where factuur_id = v_vies and type = 'btw_vies_ongeldig' and not opgelost;
  if v_n <> 1 then raise exception 'FOUT 6: verwacht signaal btw_vies_ongeldig, kreeg %', v_n; end if;

  -- 7. KvK: andere naam dan op de factuur → waarschuwing
  perform public.sla_verificatie_op(v_org, 'kvk', '68750110', 'gevonden',
    jsonb_build_object('naam', 'Test BV Donald', 'handelsnamen', jsonb_build_array('Test BV Donald')), 'mock');
  select bericht into v_tekst from public.factuur_signalen where factuur_id = v_vies and type = 'kvk_afwijking' and not opgelost;
  if v_tekst is null or v_tekst not like '%komt niet overeen met de KvK-gegevens%' then
    raise exception 'FOUT 7: verwacht signaal kvk_afwijking, kreeg %', v_tekst;
  end if;

  -- ===================== Goedkeurder =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_goedkeurder, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- 8. € 5.162,62 is boven de limiet van € 5.000
  v_ok := false;
  begin
    perform public.wijzig_status(v_usd, 'goedgekeurd', null);
  exception when others then v_ok := sqlerrm like '%Boven je goedkeuringslimiet%';
  end;
  if not v_ok then raise exception 'FOUT 8: factuur boven de limiet (in euro) kon worden goedgekeurd'; end if;

  -- 9. De euro-kolommen zijn niet rechtstreeks te wijzigen
  v_ok := false;
  begin
    update public.facturen set bedrag_eur = 1 where id = v_usd;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 9: bedrag_eur kon rechtstreeks worden gewijzigd'; end if;

  raise exception 'GESLAAGD: alle 9 tests ok (testdata is teruggedraaid)';
end;
$$;
