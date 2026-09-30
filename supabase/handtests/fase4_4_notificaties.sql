-- Handmatige test voor fase 4.4 (e-mailnotificaties): plak dit in de Supabase SQL Editor en klik Run.
--
-- Test wie een goedkeuringsmail krijgt (rol, limiet, functiescheiding), goedkeuren via de mail-actie
-- (eenmalig, bron email, zelfde controles als de app, strikte functiescheiding), de melding bij afkeuren en
-- de RLS. Resend wordt niet aangeroepen: het script doet wat de worker en de Edge Function mail-actie doen.
-- Het script eindigt ALTIJD met een foutmelding, zodat alle testdata automatisch wordt teruggedraaid:
--   "GESLAAGD: ..."  -> alles werkt
--   "FOUT n: ..."    -> test n faalt (of een andere onverwachte fout)

do $$
declare
  v_beheerder   uuid := gen_random_uuid();
  v_invoerder   uuid := gen_random_uuid();
  v_controller  uuid := gen_random_uuid();
  v_goedkeurder uuid := gen_random_uuid();
  v_org         uuid;
  v_rekening    uuid;
  v_factuur     uuid;
  v_factuur2    uuid;
  v_notificatie uuid;
  v_actie       uuid;
  v_r           jsonb;
  v_n           int;
  v_tekst       text;
  v_ok          boolean;
begin
  insert into auth.users (id, email) values
    (v_beheerder, 'fase44-beheerder@example.invalid'),
    (v_invoerder, 'fase44-invoerder@example.invalid'),
    (v_controller, 'fase44-controller@example.invalid'),
    (v_goedkeurder, 'fase44-goedkeurder@example.invalid');
  select organisatie_id into v_org from public.organisatie_leden where user_id = v_beheerder;
  select id into v_rekening from public.grootboekrekeningen where organisatie_id = v_org and code = '4300';

  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.voeg_lid_toe(v_org, 'fase44-invoerder@example.invalid', 'invoerder', null);
  perform public.voeg_lid_toe(v_org, 'fase44-controller@example.invalid', 'controller', null);
  perform public.voeg_lid_toe(v_org, 'fase44-goedkeurder@example.invalid', 'goedkeurder', 5000);

  -- Invoerder voert twee facturen in, controller controleert ze
  perform set_config('request.jwt.claims', json_build_object('sub', v_invoerder, 'role', 'authenticated')::text, true);
  v_factuur := public.sla_factuur_op(jsonb_build_object(
    'organisatie_id', v_org, 'leverancier', 'Fase44 BV', 'factuurnummer', 'F44-1', 'totaal_incl', 1210,
    'iban', 'NL91ABNA0417164300', 'grootboekrekening_id', v_rekening));
  v_factuur2 := public.sla_factuur_op(jsonb_build_object(
    'organisatie_id', v_org, 'leverancier', 'Fase44 BV', 'factuurnummer', 'F44-2', 'totaal_incl', 7000,
    'iban', 'NL91ABNA0417164300', 'grootboekrekening_id', v_rekening));
  perform set_config('request.jwt.claims', json_build_object('sub', v_controller, 'role', 'authenticated')::text, true);
  perform public.wijzig_status(v_factuur, 'gecontroleerd');
  perform public.wijzig_status(v_factuur2, 'gecontroleerd');

  -- ===================== Als eigenaar (zoals de worker) =====================
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'postgres', true);

  -- 1. Goedkeuringsmail voor beheerder en goedkeurder; niet voor invoerder of controller (controleur)
  select string_agg(u.email, ',' order by u.email) into v_tekst
  from public.notificaties n join auth.users u on u.id = n.ontvanger_id
  where n.factuur_id = v_factuur and n.soort = 'goedkeuren';
  if v_tekst is distinct from 'fase44-beheerder@example.invalid,fase44-goedkeurder@example.invalid' then
    raise exception 'FOUT 1: goedkeuringsmail aan %', v_tekst;
  end if;

  -- 2. Boven de limiet van de goedkeurder (7.000 > 5.000): alleen de beheerder
  select count(*) into v_n from public.notificaties where factuur_id = v_factuur2 and soort = 'goedkeuren' and ontvanger_id = v_goedkeurder;
  if v_n <> 0 then raise exception 'FOUT 2: goedkeurder kreeg een mail voor een factuur boven zijn limiet'; end if;

  -- 3. Per mail een email-taak in de wachtrij
  select count(*) into v_n from public.koppeling_taken t
  where t.soort = 'email' and t.sleutel in (select id::text from public.notificaties where factuur_id = v_factuur);
  if v_n <> 2 then raise exception 'FOUT 3: verwacht 2 email-taken, kreeg %', v_n; end if;

  -- 4. Goedkeuren via de mail: als de goedkeurder, bron email
  select id into v_notificatie from public.notificaties where factuur_id = v_factuur and ontvanger_id = v_goedkeurder;
  v_actie := (public.maak_mail_actie(v_notificatie) ->> 'id')::uuid;
  v_r := public.voer_mail_actie_uit(v_actie, 'goedkeuren', null);
  select status || '|' || goedgekeurd_door::text into v_tekst from public.facturen where id = v_factuur;
  if (v_r ->> 'ok')::boolean is not true or v_tekst <> 'goedgekeurd|' || v_goedkeurder::text then
    raise exception 'FOUT 4: goedkeuren via de mail: % (factuur %)', v_r, v_tekst;
  end if;
  select count(*) into v_n from public.audit_log
  where record_id = v_factuur and actie = 'statuswijziging' and bron = 'email' and user_id = v_goedkeurder;
  if v_n <> 1 then raise exception 'FOUT 4: statuswijziging niet met bron email en de goedkeurder in de audit log'; end if;

  -- 5. De link werkt maar één keer
  v_r := public.voer_mail_actie_uit(v_actie, 'goedkeuren', null);
  if (v_r ->> 'ok')::boolean or v_r ->> 'melding' <> 'Deze link is al gebruikt.' then
    raise exception 'FOUT 5: link twee keer bruikbaar: %', v_r;
  end if;

  -- 6. Strikte functiescheiding: een link voor de controleur werkt niet
  v_notificatie := intern.plan_notificatie(v_org, 'goedkeuren', 'fase44-handmatig', v_controller, v_factuur2,
    jsonb_build_object('gecontroleerd_op', (select gecontroleerd_op from public.facturen where id = v_factuur2)));
  v_actie := (public.maak_mail_actie(v_notificatie) ->> 'id')::uuid;
  v_r := public.voer_mail_actie_uit(v_actie, 'goedkeuren', null);
  if (v_r ->> 'ok')::boolean or v_r ->> 'melding' not like 'Functiescheiding:%' then
    raise exception 'FOUT 6: controleur kon via de mail goedkeuren: %', v_r;
  end if;

  -- ===================== Beheerder (in de app) =====================
  perform set_config('request.jwt.claims', json_build_object('sub', v_beheerder, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- 7. Afkeuren → mail aan invoerder en controller, niet aan wie afkeurde
  perform public.wijzig_status(v_factuur2, 'afgekeurd', 'Geen inkooporder');
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'postgres', true);
  select count(*) into v_n from public.notificaties
  where factuur_id = v_factuur2 and soort = 'afgekeurd' and ontvanger_id in (v_invoerder, v_controller);
  if v_n <> 2 or exists (select 1 from public.notificaties where factuur_id = v_factuur2 and soort = 'afgekeurd' and ontvanger_id = v_beheerder) then
    raise exception 'FOUT 7: afkeurmail niet (alleen) aan invoerder en controller';
  end if;

  -- 8. Een gebruiker kan de mail-actie niet zelf uitvoeren
  perform set_config('request.jwt.claims', json_build_object('sub', v_goedkeurder, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  v_ok := false;
  begin
    perform public.voer_mail_actie_uit(v_actie, 'goedkeuren', null);
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then raise exception 'FOUT 8: gebruiker kon voer_mail_actie_uit aanroepen'; end if;

  -- 9. RLS: de invoerder ziet alleen zijn eigen mails
  perform set_config('request.jwt.claims', json_build_object('sub', v_invoerder, 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.notificaties where organisatie_id = v_org and ontvanger_id <> v_invoerder;
  if v_n <> 0 then raise exception 'FOUT 9: invoerder ziet % mails van anderen', v_n; end if;

  raise exception 'GESLAAGD: alle 9 tests ok (testdata is teruggedraaid)';
end;
$$;
