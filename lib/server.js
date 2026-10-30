// Utilidades del servidor: cliente con llave de servicio, quién llama y cómo se invita a una persona.
import { createClient } from "@supabase/supabase-js";
import { mailReady, sendMail, inviteEmail } from "./mail";

export const fail = (status, error) => Response.json({ error }, { status });

export function adminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url.replace(/\/rest\/v1\/?$/, ""), serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Devuelve el usuario que hace la llamada (por su token) y si es dueña de la plataforma.
export async function caller(admin, req) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  if (!data || !data.user) return null;
  const { data: prof } = await admin.from("profiles").select("is_superadmin").eq("id", data.user.id).maybeSingle();
  return { user: data.user, isSuperadmin: !!(prof && prof.is_superadmin) };
}

export async function isWorkspaceAdmin(admin, workspaceId, userId) {
  const { data } = await admin
    .from("docs")
    .select("data")
    .eq("workspace_id", workspaceId)
    .eq("collection", "members")
    .eq("id", userId)
    .maybeSingle();
  return !!(data && data.data && data.data.role === "admin");
}

export function appOrigin(req) {
  return (process.env.APP_URL || req.headers.get("origin") || new URL(req.url).origin).replace(/\/$/, "");
}

// Arma el enlace con la dirección de la app (no la de Supabase): /aceptar?token_hash=...&type=...
// La página /aceptar lo valida con Supabase y abre la sesión para que la persona cree su contraseña.
function ownLink(origin, res, type) {
  const hash = res.data && res.data.properties && res.data.properties.hashed_token;
  if (!hash) return res.data.properties.action_link;
  return origin + "/aceptar?token_hash=" + encodeURIComponent(hash) + "&type=" + type;
}

/*
 * Prepara el acceso de una persona.
 * - Si no tiene cuenta: crea la invitación y devuelve el enlace para crear contraseña.
 * - Si ya tiene cuenta activa (por ejemplo, está en otra empresa): no hace falta enlace; entra con su contraseña.
 * - Si tiene cuenta pero nunca la activó: devuelve un enlace nuevo.
 */
export async function prepareAccess(admin, { email, name, origin, forceLink }) {
  const redirectTo = origin + "/aceptar";
  const { data: existing } = await admin.from("profiles").select("id").ilike("email", email).maybeSingle();

  if (existing) {
    const { data: u } = await admin.auth.admin.getUserById(existing.id);
    const active = !!(u && u.user && u.user.last_sign_in_at);
    if (active && !forceLink) return { userId: existing.id, existing: true, link: null };
    const res = await admin.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo } });
    if (res.error) throw new Error(res.error.message);
    return { userId: existing.id, existing: active, link: ownLink(origin, res, "email") };
  }

  let type = "invite";
  let res = await admin.auth.admin.generateLink({ type: "invite", email, options: { redirectTo, data: { name } } });
  if (res.error && /already|registered|exists/i.test(res.error.message)) {
    type = "email";
    res = await admin.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo } });
  }
  if (res.error) throw new Error(res.error.message);
  const userId = res.data.user.id;
  if (name) await admin.from("profiles").upsert({ id: userId, email, name });
  return { userId, existing: false, link: ownLink(origin, res, type) };
}

// Agrega (o actualiza) a una persona en una empresa.
export async function addMember(admin, { workspaceId, userId, role, title, addedBy }) {
  const { data: current } = await admin
    .from("docs")
    .select("data")
    .eq("workspace_id", workspaceId)
    .eq("collection", "members")
    .eq("id", userId)
    .maybeSingle();
  const data = Object.assign(
    { role: role || "member", title: title || "", addedAt: Date.now(), addedBy },
    current ? current.data : {},
    role ? { role } : {},
    title ? { title } : {}
  );
  const { error } = await admin
    .from("docs")
    .upsert({ workspace_id: workspaceId, collection: "members", id: userId, data, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

// Avisa por correo a la persona invitada (si el correo está configurado).
// Devuelve { emailed, mailError } para que la app muestre si llegó o si hay que mandar el enlace a mano.
export async function notifyAccess(admin, { workspaceId, inviterId, email, name, access, loginUrl }) {
  if (!mailReady()) return { emailed: false, mailError: null };
  const target = access.link || (access.existing ? loginUrl : null);
  if (!target) return { emailed: false, mailError: null };
  const [{ data: ws }, { data: inviter }, { data: person }] = await Promise.all([
    admin.from("workspaces").select("name").eq("id", workspaceId).maybeSingle(),
    admin.from("profiles").select("name").eq("id", inviterId).maybeSingle(),
    admin.from("profiles").select("name").eq("id", access.userId).maybeSingle(),
  ]);
  try {
    const msg = inviteEmail({
      name: name || (person && person.name) || "",
      company: (ws && ws.name) || "tu empresa",
      inviter: (inviter && inviter.name) || "Tu equipo",
      link: target,
      existing: !access.link && access.existing,
    });
    await sendMail(Object.assign({ to: email }, msg));
    return { emailed: true, mailError: null };
  } catch (e) {
    console.error("invite mail", e);
    return { emailed: false, mailError: "No pudimos enviar el correo. Mándale el enlace por WhatsApp o correo." };
  }
}
