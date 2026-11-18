-- 8. Conexión con Claude (servidor MCP).
-- Córrelo en Supabase > SQL Editor (después de 7-google-calendar.sql). Se puede correr más de una vez.
--
-- Qué agrega:
-- 1. Tabla mcp_tokens: las claves que cada persona crea en "Mi perfil > Conectar con Claude".
--    Solo se guarda la huella (sha256) de cada clave, nunca la clave misma.
--    Solo el servidor (llave de servicio) lee y escribe esta tabla: RLS activo y sin políticas.
-- 2. Función mcp_read: devuelve los datos que una persona puede ver, usando las MISMAS reglas
--    de permisos de la app (can_read_doc). Así Claude nunca ve un proyecto, tarea o comentario
--    que esa persona no vería en la app.

create table if not exists public.mcp_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null default 'Claude',
  token_hash   text not null unique,
  hint         text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists mcp_tokens_user_idx on public.mcp_tokens (user_id);

alter table public.mcp_tokens enable row level security;
revoke all on public.mcp_tokens from anon, authenticated;

-- Lee como si fuera la persona p_user: activa su identidad solo dentro de esta llamada
-- y filtra con can_read_doc, igual que la política "leer docs" de la tabla docs.
create or replace function public.mcp_read(p_user uuid, p_collections text[])
returns table (ws text, col text, doc_id text, doc jsonb)
language plpgsql volatile security definer set search_path = public as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  return query
    select d.workspace_id, d.collection, d.id, d.data
    from public.docs d
    where d.collection = any (p_collections)
      and public.is_member(d.workspace_id)
      and public.can_read_doc(d.workspace_id, d.collection, d.id, d.data);
end;
$$;

-- Muy importante: solo el servidor puede usarla. Si cualquiera pudiera llamarla, podría leer como otra persona.
revoke all on function public.mcp_read(uuid, text[]) from public, anon, authenticated;
grant execute on function public.mcp_read(uuid, text[]) to service_role;
