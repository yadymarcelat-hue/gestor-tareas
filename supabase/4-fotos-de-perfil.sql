-- Proyectos · fotos de perfil
-- Córrelo UNA vez en Supabase > SQL Editor (después de 3-actualizar-a-empresas.sql).
-- Agrega la foto a cada perfil y una carpeta "avatars" donde cada persona solo puede subir la suya.

alter table public.profiles add column if not exists avatar_url text;

-- Cada persona puede cambiar su nombre y su foto (nada más).
revoke update on public.profiles from authenticated;
grant update (name, avatar_url) on public.profiles to authenticated;

-- Bucket público para fotos: hasta 5 MB, solo imágenes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

-- Cada persona solo escribe dentro de su propia carpeta: avatars/<su id>/...
drop policy if exists "subir mi foto" on storage.objects;
drop policy if exists "cambiar mi foto" on storage.objects;
drop policy if exists "borrar mi foto" on storage.objects;
create policy "subir mi foto" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and split_part(name, '/', 1) = auth.uid()::text);
create policy "cambiar mi foto" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and split_part(name, '/', 1) = auth.uid()::text);
create policy "borrar mi foto" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and split_part(name, '/', 1) = auth.uid()::text);
