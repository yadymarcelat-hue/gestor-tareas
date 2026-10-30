// Empresas de la plataforma. Solo la dueña de la plataforma (superadmin) puede verlas todas y crearlas.
import { adminClient, caller, appOrigin, prepareAccess, addMember, fail } from "../../../lib/server";

export const dynamic = "force-dynamic";

// Lista de empresas con su número de personas y sus administradoras.
export async function GET(req) {
  const admin = adminClient();
  if (!admin) return fail(500, "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.");
  const who = await caller(admin, req);
  if (!who) return fail(401, "Tu sesión venció. Vuelve a ingresar.");
  if (!who.isSuperadmin) return fail(403, "Solo la dueña de la plataforma puede ver todas las empresas.");

  const [{ data: spaces }, { data: members }] = await Promise.all([
    admin.from("workspaces").select("id,name,created_at").order("created_at"),
    admin.from("docs").select("workspace_id,id,data").eq("collection", "members"),
  ]);
  const ids = [...new Set((members || []).map((m) => m.id))];
  const { data: profiles } = ids.length
    ? await admin.from("profiles").select("id,name,email").in("id", ids)
    : { data: [] };
  const byId = Object.fromEntries((profiles || []).map((p) => [p.id, p]));

  const list = (spaces || []).map((w) => {
    const ms = (members || []).filter((m) => m.workspace_id === w.id);
    return {
      id: w.id,
      name: w.name,
      createdAt: w.created_at,
      people: ms.length,
      admins: ms.filter((m) => m.data && m.data.role === "admin").map((m) => byId[m.id] || { id: m.id }),
      iAmMember: ms.some((m) => m.id === who.user.id),
    };
  });
  return Response.json({ workspaces: list });
}

// Crea una empresa e invita a su administradora. Con action "join", agrega a la dueña como administradora.
export async function POST(req) {
  const admin = adminClient();
  if (!admin) return fail(500, "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.");
  const who = await caller(admin, req);
  if (!who) return fail(401, "Tu sesión venció. Vuelve a ingresar.");
  if (!who.isSuperadmin) return fail(403, "Solo la dueña de la plataforma puede crear empresas.");

  let body;
  try { body = await req.json(); } catch { return fail(400, "Solicitud inválida."); }

  if (body.action === "join") {
    const id = String(body.id || "");
    const { data: ws } = await admin.from("workspaces").select("id").eq("id", id).maybeSingle();
    if (!ws) return fail(404, "Esa empresa no existe.");
    await addMember(admin, { workspaceId: id, userId: who.user.id, role: "admin", addedBy: who.user.id });
    return Response.json({ ok: true });
  }

  const name = String(body.name || "").trim();
  const adminEmail = String(body.adminEmail || "").trim().toLowerCase();
  const adminName = String(body.adminName || "").trim();
  const includeMe = !!body.includeMe;
  if (!name) return fail(400, "Escribe el nombre de la empresa.");
  if (adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) return fail(400, "El correo de la administradora no es válido.");
  if (!adminEmail && !includeMe) return fail(400, "Indica quién administra la empresa.");

  const id = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24)
    + "-" + Math.random().toString(36).slice(2, 7);

  const { error } = await admin.from("workspaces").insert({ id, name, created_by: who.user.id });
  if (error) return fail(500, "No se pudo crear la empresa: " + error.message);

  if (includeMe) await addMember(admin, { workspaceId: id, userId: who.user.id, role: "admin", addedBy: who.user.id });

  let access = null;
  if (adminEmail) {
    try {
      access = await prepareAccess(admin, { email: adminEmail, name: adminName, origin: appOrigin(req) });
      await addMember(admin, { workspaceId: id, userId: access.userId, role: "admin", title: "Administradora", addedBy: who.user.id });
    } catch (e) {
      return fail(400, "La empresa se creó, pero no se pudo invitar a la administradora: " + e.message);
    }
  }

  return Response.json({
    id,
    name,
    link: access ? access.link : null,
    existing: access ? access.existing : false,
    loginUrl: appOrigin(req) + "/login",
  });
}
