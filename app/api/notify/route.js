// Avisos de tareas: cuando asignas a alguien una tarea o subtarea, o cuando una tarea cambia de estado.
// La app llama a esta ruta después de guardar, con cómo estaba la tarea ANTES del cambio.
// El servidor lee la tarea como quedó (con los permisos de quien llama) y decide a quién avisar
// (lib/notify.js): así nadie puede inventar avisos de cosas que no pasaron.
import { createClient } from "@supabase/supabase-js";
import { adminClient, appOrigin, caller, fail } from "../../../lib/server";
import { notifyTaskChange } from "../../../lib/notify";

export const dynamic = "force-dynamic";

// Cliente que lee con el token de quien llama: Supabase aplica sus permisos (RLS).
function userClient(token) {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/rest\/v1\/?$/, "");
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: "Bearer " + token } },
  });
}

export async function POST(req) {
  const admin = adminClient();
  if (!admin) return fail(500, "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.");
  const who = await caller(admin, req);
  if (!who) return fail(401, "Tu sesión venció. Vuelve a ingresar.");

  let body;
  try { body = await req.json(); } catch { return fail(400, "Solicitud inválida."); }
  const workspaceId = String(body.workspaceId || "");
  const taskId = String(body.taskId || "");
  if (!workspaceId || !taskId) return fail(400, "Falta la tarea.");

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const sb = userClient(token);
  if (!sb) return fail(500, "Falta configurar NEXT_PUBLIC_SUPABASE_ANON_KEY en Vercel.");
  const { data: row } = await sb
    .from("docs")
    .select("data")
    .eq("workspace_id", workspaceId)
    .eq("collection", "tasks")
    .eq("id", taskId)
    .maybeSingle();
  if (!row) return fail(404, "No encontramos la tarea.");

  try {
    const r = await notifyTaskChange(admin, { workspaceId, taskId, task: row.data || {}, before: body.before, me: who.user.id, origin: appOrigin(req) });
    return Response.json(r);
  } catch (e) {
    return fail(500, e.message);
  }
}
