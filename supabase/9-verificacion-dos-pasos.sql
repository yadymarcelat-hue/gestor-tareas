-- 9. Verificación en dos pasos (2FA) para quien la quiera activar.
-- Córrelo en Supabase > SQL Editor (después de 8-conexion-claude.sql). Se puede correr más de una vez.
--
-- Antes: revisa en Supabase > Authentication > Multi-Factor (o Sign In / Providers > Multi-Factor)
-- que "TOTP (App Authenticator)" esté habilitado. Viene habilitado por defecto.
--
-- Qué agrega:
-- La app ya pide el código al entrar. Esto hace que la BASE DE DATOS también lo exija:
-- si una persona activó la verificación en dos pasos, una sesión que solo puso la contraseña
-- no puede leer ni cambiar nada (tareas, proyectos, perfiles, empresas ni archivos).
-- Quien no la activó sigue entrando igual que siempre.

create or replace function public.mfa_ok()
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = auth.uid() and f.status = 'verified'
      );
$$;
grant execute on function public.mfa_ok() to authenticated;

-- Políticas "restrictivas": se suman a las que ya existen (no las reemplazan).
drop policy if exists "dos pasos" on public.docs;
create policy "dos pasos" on public.docs as restrictive for all to authenticated
  using (public.mfa_ok()) with check (public.mfa_ok());

drop policy if exists "dos pasos" on public.profiles;
create policy "dos pasos" on public.profiles as restrictive for all to authenticated
  using (public.mfa_ok()) with check (public.mfa_ok());

drop policy if exists "dos pasos" on public.workspaces;
create policy "dos pasos" on public.workspaces as restrictive for all to authenticated
  using (public.mfa_ok()) with check (public.mfa_ok());

drop policy if exists "dos pasos" on storage.objects;
create policy "dos pasos" on storage.objects as restrictive for all to authenticated
  using (public.mfa_ok()) with check (public.mfa_ok());

-- ¿Alguien perdió el celular? Quítale la verificación en dos pasos corriendo esto
-- (cambia el correo). Después entra solo con su contraseña y la puede volver a activar.
--
--   delete from auth.mfa_factors
--   where user_id = (select id from auth.users where email = 'persona@empresa.com');
