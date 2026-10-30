// Crea la invitación de una persona y devuelve el enlace para que la administradora lo envíe.
// Solo una administradora puede llamarlo. Usa la llave de servicio de Supabase, que nunca llega al navegador.
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const fail = (status, error) => Response.json({ error }, { status });

export async function POST(req) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return fail(500, "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.");

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  if (!auth || !auth.user) return fail(401, "Tu sesión venció. Vuelve a ingresar.");

  const { data: me } = await admin.from("docs").select("data").eq("collection", "members").eq("id", auth.user.id).maybeSingle();
  if (!me || !me.data || me.data.role !== "admin") return fail(403, "Solo la administradora puede invitar personas.");

  let body;
  try { body = await req.json(); } catch { return fail(400, "Solicitud inválida."); }
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim();
  const title = String(body.title || "").trim();
  const projects = Array.isArray(body.projects) ? body.projects.map(String) : [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, "El correo no es válido.");

  const origin = process.env.APP_URL || req.headers.get("origin") || new URL(req.url).origin;
  const redirectTo = origin.replace(/\/$/, "") + "/aceptar";

  // Invitación nueva; si la persona ya existe, enlace de acceso para que entre y cree su contraseña.
  let res = await admin.auth.admin.generateLink({ type: "invite", email, options: { redirectTo, data: { name } } });
  if (res.error && /already|registered|exists/i.test(res.error.message)) {
    res = await admin.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo } });
  }
  if (res.error) return fail(400, "No se pudo crear la invitación: " + res.error.message);

  const userId = res.data.user.id;
  const link = res.data.properties.action_link;

  if (!body.resend) {
    const { data: prof } = await admin.from("profiles").select("name").eq("id", userId).maybeSingle();
    await admin.from("profiles").upsert({ id: userId, email, name: name || (prof && prof.name) || email.split("@")[0] });

    const { data: existing } = await admin.from("docs").select("data").eq("collection", "members").eq("id", userId).maybeSingle();
    const memberData = Object.assign(
      { role: "member", addedAt: Date.now(), addedBy: auth.user.id },
      existing ? existing.data : {},
      { title }
    );
    await admin.from("docs").upsert({ collection: "members", id: userId, data: memberData, updated_at: new Date().toISOString() });

    if (projects.length) {
      const { data: rows } = await admin.from("docs").select("id,data").eq("collection", "projects").in("id", projects);
      for (const p of rows || []) {
        const ids = Array.isArray(p.data.memberIds) ? p.data.memberIds : [];
        if (ids.includes(userId)) continue;
        await admin.rpc("doc_update", { c: "projects", i: p.id, patch: { memberIds: ids.concat(userId), updatedAt: Date.now() } });
      }
    }
  }

  return Response.json({ userId, link });
}
