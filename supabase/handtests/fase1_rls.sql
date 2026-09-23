-- Handmatige test voor fase 1: plak dit in de Supabase SQL Editor en klik Run.
--
-- Het script maakt twee tijdelijke testgebruikers aan, test RLS/duplicaatcontrole/triggers en
-- eindigt ALTIJD met een foutmelding, zodat alle testdata automatisch wordt teruggedraaid:
--   "GESLAAGD: ..."  -> alles werkt
--   "FOUT n: ..."    -> test n faalt (of een andere onverwachte fout)

do $$
declare
  v_a     uuid := gen_random_uuid();
  v_b     uuid := gen_random_uuid();
  v_f1    uuid;
  v_lev_a uuid;
  v_n     int;
  v_tekst text;
  v_ts    timestamptz;
  v_ok    boolean;
begin
  insert into auth.users (id, email) values
    (v_a, 'fase1-test-a@example.invalid'),
    (v_b, 'fase1-test-b@example.invalid');

  -- ===================== Gebruiker A =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- 1. Factuur met twee btw-regels opslaan
  v_f1 := public.sla_factuur_op(jsonb_build_object(
    'leverancier', 'Bol.com', 'factuurnummer', 'F-001', 'factuurdatum', '2026-09-01',
    'vervaldatum', '2026-10-01', 'valuta', 'eur', 'bedrag_excl', 100, 'totaal_incl', 115,
    'iban', 'nl91 abna 0417 1643 00', 'btw_nummer', 'NL 8567.12.345.B01',
    'btw_regels', jsonb_build_array(
      jsonb_build_object('tarief', 21, 'grondslag', 50, 'btw_bedrag', 10.50),
      jsonb_build_object('tarief', 9, 'grondslag', 50, 'btw_bedrag', 4.50))));
  select count(*) into v_n from public.btw_regels where factuur_id = v_f1;
  if v_n <> 2 then raise exception 'FOUT 1: verwacht 2 btw-regels, kreeg %', v_n; end if;

  -- 2. Leverancier aangemaakt en gekoppeld, IBAN/btw-nummer/valuta genormaliseerd
  select l.id, l.iban || '|' || l.btw_nummer || '|' || f.valuta into v_lev_a, v_tekst
    from public.facturen f join public.leveranciers l on l.id = f.leverancier_id
    where f.id = v_f1;
  if v_tekst is distinct from 'NL91ABNA0417164300|NL856712345B01|EUR' then
    raise exception 'FOUT 2: leverancier niet goed gekoppeld/genormaliseerd: %', v_tekst;
  end if;

  -- 3. Zelfde leverancier (andere hoofdletters) + zelfde factuurnummer = duplicaat
  v_ok := false;
  begin
    perform public.sla_factuur_op(jsonb_build_object('leverancier', 'BOL.COM', 'factuurnummer', 'F-001'));
  exception when unique_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 3: duplicaat werd niet geweigerd'; end if;

  -- 4. Nog steeds maar één leverancier
  select count(*) into v_n from public.leveranciers;
  if v_n <> 1 then raise exception 'FOUT 4: verwacht 1 leverancier, kreeg %', v_n; end if;

  -- 5. Facturen zonder factuurnummer blokkeren elkaar niet
  perform public.sla_factuur_op(jsonb_build_object('leverancier', 'Bol.com'));
  perform public.sla_factuur_op(jsonb_build_object('leverancier', 'Bol.com'));

  -- 6. Duplicaat zonder leverancier wordt ook herkend
  perform public.sla_factuur_op(jsonb_build_object('factuurnummer', 'X-1'));
  v_ok := false;
  begin
    perform public.sla_factuur_op(jsonb_build_object('factuurnummer', 'X-1'));
  exception when unique_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 6: duplicaat zonder leverancier werd niet geweigerd'; end if;

  -- 7. Nieuwe scan overschrijft bestaand IBAN niet. Sinds stap 2 ook een bewerking niet: het IBAN
  --    wordt op de factuur bewaard en een afwijking wordt een signaal (zie fase2_3_workflow.sql).
  perform public.sla_factuur_op(jsonb_build_object('leverancier', 'bol.com', 'factuurnummer', 'F-002', 'iban', 'NL02RABO0123456789'));
  select iban into v_tekst from public.leveranciers where id = v_lev_a;
  if v_tekst <> 'NL91ABNA0417164300' then raise exception 'FOUT 7a: IBAN onterecht overschreven'; end if;
  perform public.sla_factuur_op(jsonb_build_object('id', v_f1, 'leverancier', 'Bol.com', 'factuurnummer', 'F-001', 'iban', 'NL02RABO0123456789'), true);
  select iban into v_tekst from public.leveranciers where id = v_lev_a;
  if v_tekst <> 'NL91ABNA0417164300' then raise exception 'FOUT 7b: IBAN onterecht overschreven bij bewerken'; end if;

  -- 8. Bewerken vervangt btw-regels en behoudt status
  update public.facturen set status = 'goedgekeurd' where id = v_f1;
  perform public.sla_factuur_op(jsonb_build_object(
    'id', v_f1, 'leverancier', 'Bol.com', 'factuurnummer', 'F-001',
    'btw_regels', jsonb_build_array(jsonb_build_object('tarief', 21, 'grondslag', 100, 'btw_bedrag', 21))));
  select count(*) into v_n from public.btw_regels where factuur_id = v_f1;
  if v_n <> 1 then raise exception 'FOUT 8a: verwacht 1 btw-regel na bewerken, kreeg %', v_n; end if;
  select status into v_tekst from public.facturen where id = v_f1;
  if v_tekst <> 'goedgekeurd' then raise exception 'FOUT 8b: status onterecht gewijzigd naar %', v_tekst; end if;

  -- 9. updated_at-trigger (sinds stap 3 mogen gebruikers updated_at niet zelf zetten; als beheerder testen)
  perform set_config('role', 'postgres', true);
  update public.facturen set updated_at = '2000-01-01' where id = v_f1;
  perform set_config('role', 'authenticated', true);
  select updated_at into v_ts from public.facturen where id = v_f1;
  if v_ts < now() - interval '1 minute' then raise exception 'FOUT 9: updated_at-trigger werkt niet'; end if;

  -- 10. Ongeldige status en valuta worden geweigerd
  v_ok := false;
  begin
    update public.facturen set status = 'onzin' where id = v_f1;
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 10a: ongeldige status geaccepteerd'; end if;
  v_ok := false;
  begin
    perform public.sla_factuur_op(jsonb_build_object('factuurnummer', 'V-1', 'valuta', 'EU'));
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 10b: ongeldige valuta geaccepteerd'; end if;

  -- ===================== Gebruiker B =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);

  -- 11. B ziet niets van A
  select (select count(*) from public.facturen)
       + (select count(*) from public.leveranciers)
       + (select count(*) from public.btw_regels) into v_n;
  if v_n <> 0 then raise exception 'FOUT 11: gebruiker B ziet % rijen van A', v_n; end if;

  -- 12. B kan A's factuur niet wijzigen of verwijderen
  update public.facturen set status = 'betaald' where id = v_f1;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FOUT 12a: B kon factuur van A wijzigen'; end if;
  delete from public.facturen where id = v_f1;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FOUT 12b: B kon factuur van A verwijderen'; end if;

  -- 13. B kan geen btw-regel aan A's factuur hangen
  v_ok := false;
  begin
    insert into public.btw_regels (factuur_id, tarief) values (v_f1, 21);
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 13: B kon btw-regel toevoegen aan factuur van A'; end if;

  -- 14. B kan A's factuur niet overschrijven via de RPC
  v_ok := false;
  begin
    perform public.sla_factuur_op(jsonb_build_object('id', v_f1, 'factuurnummer', 'GEHACKT'));
  exception when others then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 14: B kon factuur van A overschrijven via RPC'; end if;

  -- 15. B kan geen factuur op naam van A aanmaken
  v_ok := false;
  begin
    insert into public.facturen (user_id, factuurnummer) values (v_a, 'NEP');
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 15: B kon factuur op naam van A aanmaken'; end if;

  -- 16. B kan eigen factuur niet aan A's leverancier koppelen (sinds stap 3: in B's eigen organisatie)
  v_ok := false;
  begin
    insert into public.facturen (organisatie_id, user_id, leverancier_id, factuurnummer)
    values ((select organisatie_id from public.organisatie_leden where user_id = v_b), v_b, v_lev_a, 'NEP');
  exception when foreign_key_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 16: B kon factuur koppelen aan leverancier van A'; end if;

  -- 17. B kan geen bestandspad in A's map opgeven
  v_ok := false;
  begin
    perform public.sla_factuur_op(jsonb_build_object('factuurnummer', 'P-1', 'bestand_pad', v_a::text || '/x/y.pdf'));
  exception when invalid_parameter_value then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 17: bestandspad buiten eigen map geaccepteerd'; end if;

  -- ===================== Niet ingelogd (anon) =====================
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);

  -- 18. anon heeft geen toegang
  v_ok := false;
  begin
    perform count(*) from public.facturen;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 18: anon kan facturen lezen'; end if;

  -- ===================== Terug naar A: cascade bij verwijderen =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- 19. Verwijderen van factuur verwijdert btw-regels
  delete from public.facturen where id = v_f1;
  perform set_config('role', 'postgres', true);
  select count(*) into v_n from public.btw_regels where factuur_id = v_f1;
  if v_n <> 0 then raise exception 'FOUT 19: btw-regels niet mee verwijderd'; end if;

  raise exception 'GESLAAGD: alle 19 tests ok (testdata is teruggedraaid)';
end;
$$;
