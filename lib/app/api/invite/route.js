// Invita a una persona a una empresa. Solo puede llamarlo una administradora de esa empresa.
import { adminClient, caller, isWorkspaceAdmin, appOrigin, prepareAccess, addMember, notifyAccess, fail } from "../../../lib/server";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const admin = adminClient();
  if (!admin) return fail(500, "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.");

  const who = await caller(admin, req);
  if (!who) return fail(401, "Tu sesión venció. Vuelve a ingresar.");

  let body;
  try { body = await req.json(); } catch { return fail(400, "Solicitud inválida."); }
  const workspaceId = String(body.workspaceId || "");
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim();
  const title = String(body.title || "").trim();
  const projects = Array.isArray(body.projects) ? body.projects.map(String) : [];

  if (!workspaceId) return fail(400, "Falta la empresa.");
  if (!(await isWorkspaceAdmin(admin, workspaceId, who.user.id))) {
    return fail(403, "Solo las administradoras de esta empresa pueden invitar personas.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, "El correo no es válido.");

  let access;
  try {
    access = await prepareAccess(admin, { email, name, origin: appOrigin(req), forceLink: !!body.resend });
  } catch (e) {
    return fail(400, "No se pudo crear la invitación: " + e.message);
  }

  if (!body.resend) {
    try {
      await addMember(admin, { workspaceId, userId: access.userId, title, addedBy: who.user.id });
    } catch (e) {
      return fail(500, "No se pudo agregar a la persona: " + e.message);
    }
    if (projects.length) {
      const { data: rows } = await admin
        .from("docs")
        .select("id,data")
        .eq("workspace_id", workspaceId)
        .eq("collection", "projects")
        .in("id", projects);
      for (const p of rows || []) {
        const ids = Array.isArray(p.data.memberIds) ? p.data.memberIds : [];
        if (ids.includes(access.userId)) continue;
        await admin.rpc("doc_update", {
          w: workspaceId, c: "projects", i: p.id,
          patch: { memberIds: ids.concat(access.userId), updatedAt: Date.now() },
        });
      }
    }
  }

  const loginUrl = appOrigin(req) + "/login";
  const mail = await notifyAccess(admin, { workspaceId, inviterId: who.user.id, email, name, access, loginUrl });
  return Response.json({ userId: access.userId, link: access.link, existing: access.existing, loginUrl, ...mail });
}
