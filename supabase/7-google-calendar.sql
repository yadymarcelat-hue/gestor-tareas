-- 7. Conexión con Google Calendar.
-- Guarda, por persona, el permiso de Google (cifrado por el servidor) para leer su calendario.
-- Solo el servidor (llave de servicio) lee y escribe esta tabla: RLS activo y sin políticas.

create table if not exists public.google_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  refresh_token text not null,
  updated_at timestamptz not null default now()
);

alter table public.google_tokens enable row level security;
revoke all on public.google_tokens from anon, authenticated;
