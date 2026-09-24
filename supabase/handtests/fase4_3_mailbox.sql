-- Handmatige test voor fase 4.3 (mailbox-import): plak dit in de Supabase SQL Editor en klik Run.
--
-- Test het ontvangstadres, vertrouwde afzenders, bekende en onbekende afzenders (incl. mislukte
-- SPF/DKIM-controle), beoordelen, factuur maken uit een bijlage (bron mailbox, geen "ingevoerd door"),
-- duplicaten en RLS. Mailgun en de scan worden niet aangeroepen: het script doet wat de Edge Functions
-- doen. Het script eindigt ALTIJD met een foutmelding, zodat alle testdata automatisch wordt teruggedraaid:
--   "GESLAAGD: ..."  -> alles werkt
--   "FOUT n: ..."    -> test n faalt (of een andere onverwachte fout)

do $$
declare
  v_beheerder  uuid := gen_random_uuid();
  v_invoerder  uuid := gen_random_uuid();
  v_buiten     uuid := gen_random_uuid();
  v_org        uuid;
  v_adres      text := 'fase43-' || left(gen_random_uuid()::text, 8) || '@inbox.voorbeeld.invalid';
  v_r          jsonb;
  v_bericht    uuid;
  v_bijlage    uuid;
  v_n          int;
  v_tekst      text;
  v_ok         boolean;
  v_scan       jsonb := jsonb_build_object(
    'leverancier', 'Fase43 Leverancier B.V.', 'factuurnummer', 'F43-001', 'factuurdatum', '2026-09-20',
    'valuta', 'EUR', 'bedrag_excl', 100, 'totaal_incl', 121, 'iban', 'NL91ABNA0417164300',
    'btw_regels', jsonb_build_array(jsonb_build_object('tarief', 21, 'grondslag', 100, 'btw_bedrag', 21)));
begin
  insert into auth.users (id, email) values
    (v_beheerder, 'fase43-beheerder@example.invalid'),
    (v_invoerder, 'fase43-invoerder@example.invalid'),
    (v_buiten, 'fase43-buiten@example.invalid');
  select organisatie_id into v_org from public.organisatie_leden where user_id = v_beheerder;

  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.voeg_lid_toe(v_org, 'fase43-invoerder@example.invalid', 'invoerder', null);

  -- 1. Ontvangstadres en vertrouwde afzender instellen (beheerder)
  perform public.stel_inbox_adres_in(v_org, upper(v_adres));
  perform public.voeg_inbox_afzender_toe(v_org, '@fase43-leverancier.invalid', 'Test');
  select count(*) into v_n from public.inbox_adressen where organisatie_id = v_org and adres = v_adres;
  if v_n <> 1 then raise exception 'FOUT 1: ontvangstadres niet (in kleine letters) opgeslagen'; end if;

  -- ===================== Worker / webhook (als eigenaar) =====================
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'postgres', true);

  -- 2. Bekende afzender met SPF Pass: geaccepteerd, bijlage in de wachtrij
  v_r := public.registreer_inbox_bericht(jsonb_build_object('aan', v_adres, 'van', 'facturen@fase43-leverancier.invalid',
    'message_id', '<f43-1@x>', 'spf', 'Pass', 'bron', 'mock'));
  v_bericht := (v_r ->> 'bericht_id')::uuid;
  perform public.rond_inbox_bericht_af(v_bericht, jsonb_build_array(jsonb_build_object(
    'volgnummer', 1, 'bestandsnaam', 'f.pdf', 'mime_type', 'application/pdf', 'grootte', 100, 'pad', v_org::text || '/inbox/f43.pdf')));
  select id, status into v_bijlage, v_tekst from public.inbox_bijlagen where bericht_id = v_bericht;
  if (v_r ->> 'bekend')::boolean is not true or v_tekst <> 'wachtrij' then
    raise exception 'FOUT 2: bekende afzender niet direct verwerkt (bekend %, bijlage %)', v_r ->> 'bekend', v_tekst;
  end if;

  -- 3. Zelfde domein maar SPF én DKIM mislukt: ter beoordeling
  v_r := public.registreer_inbox_bericht(jsonb_build_object('aan', v_adres, 'van', 'facturen@fase43-leverancier.invalid',
    'message_id', '<f43-2@x>', 'spf', 'Fail', 'dkim', 'Fail', 'bron', 'mock'));
  if (v_r ->> 'bekend')::boolean then raise exception 'FOUT 3: vervalste afzender werd vertrouwd'; end if;

  -- 4. Dubbele Message-Id na afronden = duplicaat
  v_r := public.registreer_inbox_bericht(jsonb_build_object('aan', v_adres, 'van', 'facturen@fase43-leverancier.invalid',
    'message_id', '<f43-1@x>', 'spf', 'Pass', 'bron', 'mock'));
  if v_r ->> 'status' <> 'duplicaat' then raise exception 'FOUT 4: verwacht duplicaat, kreeg %', v_r ->> 'status'; end if;

  -- 5. Factuur uit de bijlage: bron mailbox, geen "ingevoerd door", status gescand
  v_r := public.maak_factuur_uit_inbox(v_bijlage, v_bijlage, v_scan, v_org::text || '/' || v_bijlage::text || '/f.pdf', 'test', null);
  select bron || '|' || coalesce(user_id::text, 'leeg') || '|' || status into v_tekst from public.facturen where id = v_bijlage;
  if v_tekst <> 'mailbox|leeg|gescand' then raise exception 'FOUT 5: factuur uit mail heeft %', v_tekst; end if;

  -- 6. De factuur staat in de audit log met bron mailbox
  select count(*) into v_n from public.audit_log where tabel = 'facturen' and record_id = v_bijlage and bron = 'mailbox';
  if v_n < 2 then raise exception 'FOUT 6: verwacht aanmaken + import in de audit log, kreeg %', v_n; end if;

  -- ===================== Invoerder =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_invoerder, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- 7. Invoerder mag onbekende mail niet beoordelen
  select id into v_bericht from public.inbox_berichten where organisatie_id = v_org and message_id = '<f43-2@x>';
  v_ok := false;
  begin
    perform public.beoordeel_inbox_bericht(v_bericht, 'verwerken', false, null);
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 7: invoerder kon mail van een onbekende afzender verwerken'; end if;

  -- 8. De herkomst van een factuur is niet te vervalsen
  v_ok := false;
  begin
    update public.facturen set bron = 'upload' where id = v_bijlage;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 8: herkomst kon rechtstreeks worden gewijzigd'; end if;

  -- ===================== Buitenstaander =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_buiten, 'role', 'authenticated')::text, true);

  -- 9. Ziet niets van de inbox
  select (select count(*) from public.inbox_berichten where organisatie_id = v_org)
       + (select count(*) from public.inbox_bijlagen where organisatie_id = v_org)
       + (select count(*) from public.inbox_afzenders where organisatie_id = v_org)
       + (select count(*) from public.inbox_adressen where organisatie_id = v_org) into v_n;
  if v_n <> 0 then raise exception 'FOUT 9: buitenstaander ziet % rijen van de inbox', v_n; end if;

  raise exception 'GESLAAGD: alle 9 tests ok (testdata is teruggedraaid)';
end;
$$;
