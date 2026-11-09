-- 6. Documentos compartidos con personas específicas.
-- Agrega la opción "Personas específicas": el documento lo leen quien lo creó
-- y las personas cuyo id está en data->'memberIds'.
-- Solo reemplaza la función de lectura; las políticas de la tabla docs siguen iguales.

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
    else true
  end;
$$;
