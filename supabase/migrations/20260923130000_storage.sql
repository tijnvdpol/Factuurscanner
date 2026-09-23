-- Factuurscanner: private Storage-bucket voor originele factuurbestanden.
-- Pad-structuur: {user_id}/{factuur_id}/{bestandsnaam}

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('facturen', 'facturen', false, 15728640, array['image/*', 'application/pdf'])
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Gebruikers mogen alleen in hun eigen map (eerste padsegment = eigen user_id).
drop policy if exists "Facturen: eigen bestanden lezen" on storage.objects;
drop policy if exists "Facturen: eigen bestanden uploaden" on storage.objects;
drop policy if exists "Facturen: eigen bestanden wijzigen" on storage.objects;
drop policy if exists "Facturen: eigen bestanden verwijderen" on storage.objects;

create policy "Facturen: eigen bestanden lezen"
  on storage.objects for select to authenticated
  using (bucket_id = 'facturen' and (storage.foldername(name))[1] = (select auth.uid()::text));

create policy "Facturen: eigen bestanden uploaden"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'facturen' and (storage.foldername(name))[1] = (select auth.uid()::text));

create policy "Facturen: eigen bestanden wijzigen"
  on storage.objects for update to authenticated
  using (bucket_id = 'facturen' and (storage.foldername(name))[1] = (select auth.uid()::text))
  with check (bucket_id = 'facturen' and (storage.foldername(name))[1] = (select auth.uid()::text));

create policy "Facturen: eigen bestanden verwijderen"
  on storage.objects for delete to authenticated
  using (bucket_id = 'facturen' and (storage.foldername(name))[1] = (select auth.uid()::text));
