-- 10. Notificaciones de tareas (te asignaron una tarea o subtarea, o una tarea cambió de estado).
-- Córrelo en Supabase > SQL Editor (después de 9-verificacion-dos-pasos.sql). Se puede correr más de una vez.
--
-- Los avisos se guardan en la tabla docs, colección 'notifications', con data->>'userId' = la destinataria.
-- Los crea solo el servidor (/api/notify, con la llave de servicio).
-- Este script hace que cada persona vea, marque como leídos y borre SOLO sus propios avisos.
-- Sin él, cualquier miembro de la empresa podría leer los avisos de los demás.
-- Reemplaza las funciones de permisos con las mismas reglas de antes + la regla de 'notifications'.

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
      or (d->>'visibility' = 'people' and coalesce(d->'memberIds', '[]'::jsonb) ? auth.uid()::text)
    when c = 'notifications' then d->>'userId' = auth.uid()::text
    else true
  end;
$$;

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
    when c = 'notifications' then d->>'userId' = auth.uid()::text
    else true
  end;
$$;

-- Buscar rápido los avisos de una persona y los recientes de una tarea.
create index if not exists docs_notif_user_idx on public.docs ((data->>'userId')) where collection = 'notifications';
create index if not exists docs_notif_task_idx on public.docs ((data->>'taskId')) where collection = 'notifications';
