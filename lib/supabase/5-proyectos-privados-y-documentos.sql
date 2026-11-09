-- Proyectos · proyectos privados, documentos con enlace público y logo de la empresa
-- Córrelo en Supabase > SQL Editor (después de 4-fotos-de-perfil.sql). Se puede correr más de una vez.
--
-- Qué cambia:
-- 1. Cualquier persona de la empresa puede crear proyectos y elegir quién los ve:
--      private  = solo quien lo creó (ni las administradoras lo ven)
--      members  = las personas elegidas y las administradoras (así funcionaban todos los proyectos hasta hoy)
--      company  = toda la empresa
--    La base de datos lo controla: nadie puede leer las tareas, hitos o comentarios de un proyecto que no ve.
-- 2. Documentos (colección "documents"): privados, de toda la empresa o de un proyecto, con enlace público opcional.
-- 3. Logo de la empresa: columna logo_url y carpeta "logos" donde solo suben las administradoras.

-- 1. Quién ve qué ------------------------------------------------------------------

-- ¿La persona que llama puede ver un proyecto con estos datos?
-- Decide con los datos del proyecto mismo, así sirve también al crearlo (cuando todavía no está guardado).
create or replace function public.project_visible(ws text, d jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member(ws) and (
    d->>'ownerId' = auth.uid()::text
    or coalesce(d->>'visibility', 'members') = 'company'
    or (coalesce(d->>'visibility', 'members') = 'members'
        and (public.is_admin(ws) or coalesce(d->'memberIds', '[]'::jsonb) ? auth.uid()::text))
  );
$$;

-- ¿La persona que llama puede ver este proyecto guardado? (para sus tareas, hitos y comentarios)
create or replace function public.can_see_project(ws text, pid text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.docs p
    where p.workspace_id = ws and p.collection = 'projects' and p.id = pid
      and public.project_visible(ws, p.data)
  );
$$;

-- ¿Puede editar el proyecto y sus hitos? Quien lo creó, o una administradora si el proyecto no es privado.
create or replace function public.can_manage_project(ws text, pid text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member(ws) and exists (
    select 1 from public.docs p
    where p.workspace_id = ws and p.collection = 'projects' and p.id = pid
      and (
        p.data->>'ownerId' = auth.uid()::text
        or (public.is_admin(ws) and coalesce(p.data->>'visibility', 'members') <> 'private')
      )
  );
$$;

-- ¿Puede leer este documento de la tabla docs?
create or replace function public.can_read_doc(ws text, c text, i text, d jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member(ws) and case
    when c = 'projects' then public.project_visible(ws, d)
    when c in ('tasks', 'milestones') then public.can_see_project(ws, d->>'projectId')
    when c = 'comments' then public.can_see_project(ws, coalesce(
      d->>'projectId',
      (select t.data->>'projectId' from public.docs t where t.workspace_id = ws and t.collection = 'tasks' and t.id = d->>'taskId')
    ))
    when c = 'documents' then
      d->>'ownerId' = auth.uid()::text
      or coalesce(d->>'visibility', 'private') = 'company'
      or (d->>'visibility' = 'project' and public.can_see_project(ws, d->>'projectId'))
    else true
  end;
$$;

-- ¿Puede crear, cambiar o borrar este documento? Se revisa con los datos de antes y con los nuevos.
create or replace function public.can_write_doc(ws text, c text, i text, d jsonb) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member(ws) and case
    when c = 'members' then public.is_admin(ws)
    when c = 'projects' then
      d->>'ownerId' = auth.uid()::text
      or (public.is_admin(ws) and coalesce(d->>'visibility', 'members') <> 'private')
    when c = 'milestones' then public.can_manage_project(ws, d->>'projectId')
    when c in ('tasks', 'comments') then public.can_read_doc(ws, c, i, d)
    when c = 'documents' then
      d->>'ownerId' = auth.uid()::text
      or (public.is_admin(ws) and coalesce(d->>'visibility', 'private') <> 'private')
    else true
  end;
$$;

drop policy if exists "leer docs" on public.docs;
drop policy if exists "crear docs" on public.docs;
drop policy if exists "editar docs" on public.docs;
drop policy if exists "borrar docs" on public.docs;
create policy "leer docs"   on public.docs for select to authenticated
  using (public.can_read_doc(workspace_id, collection, id, data));
create policy "crear docs"  on public.docs for insert to authenticated
  with check (public.can_write_doc(workspace_id, collection, id, data));
create policy "editar docs" on public.docs for update to authenticated
  using (public.can_write_doc(workspace_id, collection, id, data))
  with check (public.can_write_doc(workspace_id, collection, id, data));
create policy "borrar docs" on public.docs for delete to authenticated
  using (public.can_write_doc(workspace_id, collection, id, data));

-- Buscar rápido un documento por su enlace público.
create index if not exists docs_share_idx on public.docs ((data->'share'->>'token')) where collection = 'documents';

-- 2. Logo de la empresa ------------------------------------------------------------

alter table public.workspaces add column if not exists logo_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('logos', 'logos', true, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

-- Solo las administradoras escriben en logos/<empresa>/...
drop policy if exists "admin sube logo" on storage.objects;
drop policy if exists "admin cambia logo" on storage.objects;
drop policy if exists "admin borra logo" on storage.objects;
drop policy if exists "admin ve carpeta de logo" on storage.objects;
create policy "admin sube logo" on storage.objects for insert to authenticated
  with check (bucket_id = 'logos' and public.is_admin(split_part(name, '/', 1)));
create policy "admin cambia logo" on storage.objects for update to authenticated
  using (bucket_id = 'logos' and public.is_admin(split_part(name, '/', 1)));
create policy "admin borra logo" on storage.objects for delete to authenticated
  using (bucket_id = 'logos' and public.is_admin(split_part(name, '/', 1)));
create policy "admin ve carpeta de logo" on storage.objects for select to authenticated
  using (bucket_id = 'logos' and public.is_admin(split_part(name, '/', 1)));
