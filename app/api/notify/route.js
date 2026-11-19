// Avisos de tareas: cuando asignas a alguien una tarea o subtarea, o cuando una tarea cambia de estado.
// La app llama a esta ruta después de guardar, con cómo estaba la tarea ANTES del cambio.
// El servidor lee la tarea como quedó (con los permisos de quien llama) y decide a quién avisar:
// así nadie puede inventar avisos de cosas que no pasaron.
// Cada aviso queda en la colección "notifications" (solo la ve su destinataria) y, si Gmail está
// configurado, también llega por correo.
import { createClient } from "@supabase/supabase-js";
import { adminClient, appOrigin, caller, fail } from "../../../lib/server";
import { mailReady, sendMail, taskEmail } from "../../../lib/mail";

export const dynamic = "force-dynamic";

const COLNAME = { todo: "Sin empezar", doing: "En progreso", review: "En revisión", done: "Hecho" };
const SETUP = "Falta correr supabase/10-notificaciones.sql en Supabase.";

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

const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-5);
const uniq = (a) => [...new Set(a.filter(Boolean))];

export async function POST(req) {
  const admin = adminClient();
  if (!admin) return fail(500, "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.");
  const who = await caller(admin, req);
  if (!who) return fail(401, "Tu sesión venció. Vuelve a ingresar.");
  const me = who.user.id;

  let body;
  try { body = await req.json(); } catch { return fail(400, "Solicitud inválida."); }
  const workspaceId = String(body.workspaceId || "");
  const taskId = String(body.taskId || "");
  const before = body.before && typeof body.before === "object" ? body.before : {};
  if (!workspaceId || !taskId) return fail(400, "Falta la tarea.");

  // 1. Leer la tarea como la ve quien llama. Si no la puede ver, no hay avisos.
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
  const t = row.data || {};

  // 2. Decidir a quién avisar.
  const members = new Set(
    ((await admin.from("docs").select("id").eq("workspace_id", workspaceId).eq("collection", "members")).data || []).map((m) => m.id)
  );
  const ok = (id) => id && id !== me && members.has(id);
  const items = [];

  const prevA = new Set(Array.isArray(before.assignees) ? before.assignees : []);
  const newA = uniq((t.assignees || []).filter((id) => !prevA.has(id) && ok(id)));
  newA.forEach((userId) => items.push({ userId, kind: "assigned" }));

  const prevSubs = before.subs && typeof before.subs === "object" ? before.subs : {};
  (t.subtasks || []).forEach((s) => {
    if (s && ok(s.assignee) && prevSubs[s.id] !== s.assignee && !newA.includes(s.assignee)) {
      items.push({ userId: s.assignee, kind: "subtask", subId: s.id, subTitle: String(s.title || "Subtarea") });
    }
  });

  const from = String(before.column || "");
  const to = t.column || "todo";
  if (from && COLNAME[from] && from !== to) {
    // Avisan: responsables de la tarea y quien la creó (sin repetir a quien ya recibió "te asignaron").
    uniq([...(t.assignees || []), t.createdBy])
      .filter((id) => ok(id) && !newA.includes(id))
      .forEach((userId) => items.push({ userId, kind: "status", from, to }));
  }
  if (!items.length) return Response.json({ sent: 0, emailed: 0 });

  // 3. No repetir el mismo aviso si llega dos veces en menos de un minuto.
  const recent = await admin
    .from("docs")
    .select("data")
    .eq("workspace_id", workspaceId)
    .eq("collection", "notifications")
    .eq("data->>taskId", taskId)
    .gte("data->>at", String(Date.now() - 60000));
  if (recent.error) return fail(500, SETUP);
  const key = (n) => [n.userId, n.kind, n.subId || "", n.to || ""].join("|");
  const seen = new Set((recent.data || []).map((r) => key(r.data || {})));
  const fresh = items.filter((n) => !seen.has(key(n)));
  if (!fresh.length) return Response.json({ sent: 0, emailed: 0 });

  // 4. Guardar los avisos.
  const [{ data: proj }, { data: ws }, { data: people }] = await Promise.all([
    admin.from("docs").select("data").eq("workspace_id", workspaceId).eq("collection", "projects").eq("id", t.projectId || "").maybeSingle(),
    admin.from("workspaces").select("name").eq("id", workspaceId).maybeSingle(),
    admin.from("profiles").select("id,name,email").in("id", uniq([me, ...fresh.map((n) => n.userId)])),
  ]);
  const projectName = (proj && proj.data && proj.data.name) || "Proyecto";
  const pf = Object.fromEntries((people || []).map((p) => [p.id, p]));
  const at = Date.now();
  const rows = fresh.map((n) => ({
    workspace_id: workspaceId,
    collection: "notifications",
    id: rid(),
    data: Object.assign(
      { userId: n.userId, kind: n.kind, taskId, projectId: t.projectId || "", taskTitle: String(t.title || "Tarea"), projectName, by: me, at, read: false },
      n.subId ? { subId: n.subId, subTitle: n.subTitle } : {},
      n.kind === "status" ? { from: n.from, to: n.to } : {}
    ),
    updated_at: new Date().toISOString(),
  }));
  const ins = await admin.from("docs").insert(rows);
  if (ins.error) return fail(500, SETUP);

  // 5. Correo (solo si Gmail está configurado). Un error de correo no deshace el aviso en la app.
  let emailed = 0;
  if (mailReady()) {
    const actor = (pf[me] && pf[me].name) || "Alguien de tu equipo";
    const link = appOrigin(req) + "/?ws=" + encodeURIComponent(workspaceId) + "&p=" + encodeURIComponent(t.projectId || "") + "&t=" + encodeURIComponent(taskId);
    await Promise.all(
      fresh.map(async (n) => {
        const p = pf[n.userId];
        if (!p || !p.email) return;
        try {
          const msg = taskEmail({
            kind: n.kind,
            name: p.name || "",
            actor,
            task: String(t.title || "Tarea"),
            sub: n.subTitle,
            project: projectName,
            company: (ws && ws.name) || "",
            from: COLNAME[n.from] || "",
            to: COLNAME[n.to] || "",
            link,
          });
          await sendMail(Object.assign({ to: p.email }, msg));
          emailed++;
        } catch (e) {
          console.error("Correo de aviso:", e && e.message);
        }
      })
    );
  }
  return Response.json({ sent: fresh.length, emailed });
}
