// Avisos de tareas (en la app y por correo). Lo usan /api/notify (cambios hechos en la app)
// y el MCP (tareas creadas desde Claude).
// Recibe la tarea como quedó y cómo estaba antes; decide a quién avisar:
// - "assigned": responsables nuevos de la tarea
// - "subtask":  responsables nuevos de una subtarea
// - "status":   cambio de estado → responsables y quien creó la tarea
// - "mention":  te mencionaron con @ en un comentario (notifyMentions, más abajo)
// Nunca se avisa a quien hizo el cambio, y el mismo aviso no se repite en menos de un minuto.
import { mailReady, sendMail, taskEmail } from "./mail";

export const COLNAME = { todo: "Sin empezar", doing: "En progreso", review: "En revisión", done: "Hecho" };
export const NOTIFY_SETUP = "Falta correr supabase/10-notificaciones.sql en Supabase.";

const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-5);
const uniq = (a) => [...new Set(a.filter(Boolean))];

export async function notifyTaskChange(admin, { workspaceId, taskId, task, before, me, origin }) {
  const t = task || {};
  before = before && typeof before === "object" ? before : {};

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
    uniq([...(t.assignees || []), t.createdBy])
      .filter((id) => ok(id) && !newA.includes(id))
      .forEach((userId) => items.push({ userId, kind: "status", from, to }));
  }
  if (!items.length) return { sent: 0, emailed: 0 };

  const recent = await admin
    .from("docs")
    .select("data")
    .eq("workspace_id", workspaceId)
    .eq("collection", "notifications")
    .eq("data->>taskId", taskId)
    .gte("data->>at", String(Date.now() - 60000));
  if (recent.error) throw new Error(NOTIFY_SETUP);
  const key = (n) => [n.userId, n.kind, n.subId || "", n.to || ""].join("|");
  const seen = new Set((recent.data || []).map((r) => key(r.data || {})));
  const fresh = items.filter((n) => !seen.has(key(n)));
  if (!fresh.length) return { sent: 0, emailed: 0 };

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
  if (ins.error) throw new Error(NOTIFY_SETUP);

  let emailed = 0;
  if (mailReady()) {
    const actor = (pf[me] && pf[me].name) || "Alguien de tu equipo";
    const link = origin + "/?ws=" + encodeURIComponent(workspaceId) + "&p=" + encodeURIComponent(t.projectId || "") + "&t=" + encodeURIComponent(taskId);
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
  return { sent: fresh.length, emailed };
}

// Menciones en comentarios: avisa a cada persona etiquetada con @ en un comentario.
// Solo avisa a quien es de la empresa y puede ver el proyecto (si no, no podría abrir la tarea),
// nunca a quien escribió el comentario, y no repite el aviso del mismo comentario.
function canSee(project, userId, memberRoles) {
  if (!project || !memberRoles.has(userId)) return false;
  if (project.ownerId === userId) return true;
  const vis = project.visibility || "members";
  if (vis === "company") return true;
  if (vis === "private") return false;
  return memberRoles.get(userId) === "admin" || (Array.isArray(project.memberIds) && project.memberIds.includes(userId));
}

export async function notifyMentions(admin, { workspaceId, taskId, commentId, comment, task, me, origin }) {
  const c = comment || {};
  const t = task || {};
  const asked = uniq(Array.isArray(c.mentions) ? c.mentions.map(String) : []).filter((id) => id !== me).slice(0, 50);
  if (!asked.length) return { sent: 0, emailed: 0 };

  const [{ data: mem }, { data: proj }, { data: ws }] = await Promise.all([
    admin.from("docs").select("id,data").eq("workspace_id", workspaceId).eq("collection", "members"),
    admin.from("docs").select("data").eq("workspace_id", workspaceId).eq("collection", "projects").eq("id", t.projectId || "").maybeSingle(),
    admin.from("workspaces").select("name").eq("id", workspaceId).maybeSingle(),
  ]);
  const roles = new Map((mem || []).map((m) => [m.id, (m.data && m.data.role) || "member"]));
  const project = (proj && proj.data) || null;
  const targets = asked.filter((id) => canSee(project, id, roles));
  if (!targets.length) return { sent: 0, emailed: 0 };

  const prev = await admin
    .from("docs")
    .select("data")
    .eq("workspace_id", workspaceId)
    .eq("collection", "notifications")
    .eq("data->>taskId", taskId)
    .eq("data->>commentId", commentId);
  if (prev.error) throw new Error(NOTIFY_SETUP);
  const done = new Set((prev.data || []).map((r) => r.data && r.data.userId));
  const fresh = targets.filter((id) => !done.has(id));
  if (!fresh.length) return { sent: 0, emailed: 0 };

  const { data: people } = await admin.from("profiles").select("id,name,email").in("id", uniq([me, ...fresh]));
  const pf = Object.fromEntries((people || []).map((p) => [p.id, p]));
  const projectName = (project && project.name) || "Proyecto";
  const excerpt = String(c.text || "").replace(/\s+/g, " ").trim().slice(0, 240);
  const at = Date.now();
  const rows = fresh.map((userId) => ({
    workspace_id: workspaceId,
    collection: "notifications",
    id: rid(),
    data: { userId, kind: "mention", taskId, commentId, projectId: t.projectId || "", taskTitle: String(t.title || "Tarea"), projectName, excerpt, by: me, at, read: false },
    updated_at: new Date().toISOString(),
  }));
  const ins = await admin.from("docs").insert(rows);
  if (ins.error) throw new Error(NOTIFY_SETUP);

  let emailed = 0;
  if (mailReady()) {
    const actor = (pf[me] && pf[me].name) || "Alguien de tu equipo";
    const link = origin + "/?ws=" + encodeURIComponent(workspaceId) + "&p=" + encodeURIComponent(t.projectId || "") + "&t=" + encodeURIComponent(taskId);
    await Promise.all(
      fresh.map(async (userId) => {
        const p = pf[userId];
        if (!p || !p.email) return;
        try {
          const msg = taskEmail({ kind: "mention", name: p.name || "", actor, task: String(t.title || "Tarea"), project: projectName, company: (ws && ws.name) || "", excerpt, link });
          await sendMail(Object.assign({ to: p.email }, msg));
          emailed++;
        } catch (e) {
          console.error("Correo de mención:", e && e.message);
        }
      })
    );
  }
  return { sent: fresh.length, emailed };
}
