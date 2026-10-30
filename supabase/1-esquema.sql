-- Proyectos Ingenio SAS · esquema de base de datos
-- Pégalo completo en Supabase > SQL Editor y dale Run. Se puede correr más de una vez.

-- 1. Tablas -----------------------------------------------------------------

-- Todos los datos de la app: miembros, proyectos, hitos, tareas y comentarios.
create table if not exists public.docs (
  collection text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);
create index if not exists docs_project_idx on public.docs ((data->>'projectId'));
create index if not exists docs_task_idx on public.docs ((data->>'taskId'));

-- Nombre y correo de cada persona con cuenta.
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  name       text,
  created_at timestamptz not null default now()
);

-- 2. Quién puede qué ----------------------------------------------------------

-- Miembro: tiene un documento en la colección "members".
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.docs where collection = 'members' and id = auth.uid()::text);
$$;

-- Administradora: miembro con role = 'admin'.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.docs
    where collection = 'members' and id = auth.uid()::text and data->>'role' = 'admin'
  );
$$;

-- Proyectos, hitos y equipo: solo administradora. Tareas y comentarios: cualquier miembro.
create or replace function public.can_write(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select case when c in ('projects', 'milestones', 'members') then public.is_admin() else public.is_member() end;
$$;

alter table public.docs enable row level security;
drop policy if exists "leer docs" on public.docs;
drop policy if exists "crear docs" on public.docs;
drop policy if exists "editar docs" on public.docs;
drop policy if exists "borrar docs" on public.docs;
create policy "leer docs"   on public.docs for select to authenticated using (public.is_member());
create policy "crear docs"  on public.docs for insert to authenticated with check (public.can_write(collection));
create policy "editar docs" on public.docs for update to authenticated using (public.can_write(collection)) with check (public.can_write(collection));
create policy "borrar docs" on public.docs for delete to authenticated using (public.can_write(collection));

alter table public.profiles enable row level security;
drop policy if exists "ver perfiles" on public.profiles;
drop policy if exists "editar mi perfil" on public.profiles;
create policy "ver perfiles"     on public.profiles for select to authenticated using (public.is_member() or id = auth.uid());
create policy "editar mi perfil" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- 3. Actualizar solo algunos campos de un documento ---------------------------

create or replace function public.doc_update(c text, i text, patch jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update public.docs set data = data || patch, updated_at = now() where collection = c and id = i;
  if not found then
    raise exception 'sin permiso o el documento no existe' using errcode = '42501';
  end if;
end;
$$;
grant execute on function public.doc_update(text, text, jsonb) to authenticated, service_role;

-- 4. Al crear una cuenta ----------------------------------------------------
-- Crea su perfil. La primera cuenta que exista queda como administradora.

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;

  if not exists (select 1 from public.docs where collection = 'members') then
    insert into public.docs (collection, id, data)
    values ('members', new.id::text,
            jsonb_build_object('role', 'admin', 'title', '', 'addedAt', (extract(epoch from now()) * 1000)::bigint));
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- 5. Cambios en vivo ----------------------------------------------------------

alter table public.docs replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null;
end $$;

-- 6. Archivos adjuntos ------------------------------------------------------
-- Bucket "files": cualquier tipo de archivo, hasta 50 MB.
-- Es público para poder abrir los archivos con su enlace; cada archivo tiene un nombre imposible de adivinar.

insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = 52428800;

drop policy if exists "miembros suben archivos" on storage.objects;
drop policy if exists "miembros borran archivos" on storage.objects;
create policy "miembros suben archivos" on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and public.is_member());
create policy "miembros borran archivos" on storage.objects for delete to authenticated
  using (bucket_id = 'files' and public.is_member());
