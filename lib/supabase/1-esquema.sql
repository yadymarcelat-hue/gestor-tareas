-- Proyectos · esquema de base de datos (varias empresas)
-- Instalación nueva: pégalo completo en Supabase > SQL Editor y dale Run.
-- Si ya tenías la versión anterior instalada, usa 3-actualizar-a-empresas.sql en su lugar.

-- 1. Tablas ----------------------------------------------------------------------

-- Cada empresa es un espacio de trabajo.
create table if not exists public.workspaces (
  id         text primary key,
  name       text not null,
  created_at timestamptz not null default now(),
  created_by uuid
);

-- Todos los datos de la app, separados por empresa: miembros, proyectos, hitos, tareas y comentarios.
create table if not exists public.docs (
  workspace_id text not null,
  collection   text not null,
  id           text not null,
  data         jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, collection, id)
);

-- Nombre y correo de cada persona con cuenta.
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text,
  name          text,
  is_superadmin boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists docs_ws_col_idx on public.docs (workspace_id, collection);
create index if not exists docs_member_idx on public.docs (collection, id);
create index if not exists docs_project_idx on public.docs ((data->>'projectId'));
create index if not exists docs_task_idx on public.docs ((data->>'taskId'));

-- 2. Quién puede qué -----------------------------------------------------------
-- Se borran primero las reglas y funciones de la versión anterior (de un solo espacio).

drop policy if exists "leer docs" on public.docs;
drop policy if exists "crear docs" on public.docs;
drop policy if exists "editar docs" on public.docs;
drop policy if exists "borrar docs" on public.docs;
drop policy if exists "ver perfiles" on public.profiles;
drop policy if exists "editar mi perfil" on public.profiles;
drop policy if exists "ver espacios" on public.workspaces;
drop policy if exists "miembros suben archivos" on storage.objects;
drop policy if exists "miembros borran archivos" on storage.objects;
drop function if exists public.is_member();
drop function if exists public.is_admin();
drop function if exists public.can_write(text);
drop function if exists public.doc_update(text, text, jsonb);

-- Dueña de la plataforma: crea empresas e invita a su primera administradora.
create or replace function public.is_superadmin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_superadmin from public.profiles where id = auth.uid()), false);
$$;

-- Miembro de una empresa: tiene documento en "members" de ese espacio.
create or replace function public.is_member(ws text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.docs where workspace_id = ws and collection = 'members' and id = auth.uid()::text);
$$;

-- Administradora de una empresa.
create or replace function public.is_admin(ws text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.docs
    where workspace_id = ws and collection = 'members' and id = auth.uid()::text and data->>'role' = 'admin'
  );
$$;

-- Proyectos, hitos y equipo: solo administradoras de esa empresa. Tareas y comentarios: cualquier miembro.
create or replace function public.can_write(ws text, c text) returns boolean
language sql stable security definer set search_path = public as $$
  select case when c in ('projects', 'milestones', 'members') then public.is_admin(ws) else public.is_member(ws) end;
$$;

-- Dos personas comparten al menos una empresa (para ver nombres y correos del equipo).
create or replace function public.shares_workspace(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.docs a join public.docs b on a.workspace_id = b.workspace_id
    where a.collection = 'members' and b.collection = 'members'
      and a.id = auth.uid()::text and b.id = other::text
  );
$$;

alter table public.docs enable row level security;
create policy "leer docs"   on public.docs for select to authenticated using (public.is_member(workspace_id));
create policy "crear docs"  on public.docs for insert to authenticated with check (public.can_write(workspace_id, collection));
create policy "editar docs" on public.docs for update to authenticated using (public.can_write(workspace_id, collection)) with check (public.can_write(workspace_id, collection));
create policy "borrar docs" on public.docs for delete to authenticated using (public.can_write(workspace_id, collection));

alter table public.profiles enable row level security;
create policy "ver perfiles" on public.profiles for select to authenticated
  using (id = auth.uid() or public.shares_workspace(id) or public.is_superadmin());
create policy "editar mi perfil" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- Cada persona solo puede cambiar su nombre (no su correo ni si es dueña de la plataforma).
revoke update on public.profiles from authenticated;
grant update (name) on public.profiles to authenticated;
-- (4-fotos-de-perfil.sql agrega avatar_url y permite cambiar la foto)

alter table public.workspaces enable row level security;
create policy "ver espacios" on public.workspaces for select to authenticated
  using (public.is_member(id) or public.is_superadmin());

-- 3. Actualizar solo algunos campos de un documento -------------------------------

create or replace function public.doc_update(w text, c text, i text, patch jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  update public.docs set data = data || patch, updated_at = now() where workspace_id = w and collection = c and id = i;
  if not found then
    raise exception 'sin permiso o el documento no existe' using errcode = '42501';
  end if;
end;
$$;
grant execute on function public.doc_update(text, text, text, jsonb) to authenticated, service_role;

-- 4. Al crear una cuenta ---------------------------------------------------------
-- Crea su perfil. La primera cuenta de toda la plataforma queda como dueña (superadmin).

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  if not exists (select 1 from public.profiles where is_superadmin) then
    update public.profiles set is_superadmin = true where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- 5. Cambios en vivo -------------------------------------------------------------

alter table public.docs replica identity full;
do $$
begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null;
end $$;

-- 6. Archivos adjuntos -----------------------------------------------------------
-- Cada archivo se guarda dentro de la carpeta de su empresa: <empresa>/<persona>/<archivo>.

insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = 52428800;

create policy "miembros suben archivos" on storage.objects for insert to authenticated
  with check (bucket_id = 'files' and public.is_member(split_part(name, '/', 1)));
create policy "miembros borran archivos" on storage.objects for delete to authenticated
  using (bucket_id = 'files' and public.is_member(split_part(name, '/', 1)));

-- 7. Fotos de perfil: corre también 4-fotos-de-perfil.sql
