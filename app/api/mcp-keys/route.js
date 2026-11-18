// Claves para conectar Claude (MCP). Cada persona ve, crea y borra solo las suyas.
// La clave completa se muestra una sola vez al crearla; en la base solo queda su huella.
import { adminClient, appOrigin, caller, fail } from "../../../lib/server";
import { hashKey, newKey } from "../../../lib/mcp";

export const dynamic = "force-dynamic";

const SETUP = "Falta correr supabase/8-conexion-claude.sql en Supabase.";

async function who(req) {
  const admin = adminClient();
  if (!admin) return { res: fail(500, "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.") };
  const c = await caller(admin, req);
  if (!c) return { res: fail(401, "Inicia sesión para ver tus conexiones.") };
  return { admin, userId: c.user.id };
}

export async function GET(req) {
  const w = await who(req);
  if (w.res) return w.res;
  const { data, error } = await w.admin
    .from("mcp_tokens")
    .select("id,name,hint,created_at,last_used_at")
    .eq("user_id", w.userId)
    .order("created_at", { ascending: false });
  if (error) return fail(500, SETUP);
  return Response.json({ keys: data || [], base: appOrigin(req) + "/api/mcp" });
}

export async function POST(req) {
  const w = await who(req);
  if (w.res) return w.res;
  const body = await req.json().catch(() => ({}));
  const name = String(body.name || "Claude").trim().slice(0, 60) || "Claude";
  const { count } = await w.admin.from("mcp_tokens").select("id", { count: "exact", head: true }).eq("user_id", w.userId);
  if ((count || 0) >= 10) return fail(400, "Ya tienes 10 conexiones. Borra alguna que no uses para crear otra.");
  const key = newKey();
  const { data, error } = await w.admin
    .from("mcp_tokens")
    .insert({ user_id: w.userId, name, token_hash: hashKey(key), hint: key.slice(-4) })
    .select("id,name,hint,created_at,last_used_at")
    .single();
  if (error) return fail(500, SETUP);
  const base = appOrigin(req) + "/api/mcp";
  return Response.json({ key: data, secret: key, url: base + "/" + key, base });
}

export async function DELETE(req) {
  const w = await who(req);
  if (w.res) return w.res;
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(400, "Conexión no válida.");
  const { error } = await w.admin.from("mcp_tokens").delete().eq("id", id).eq("user_id", w.userId);
  if (error) return fail(500, "No pudimos borrar la conexión.");
  return Response.json({ ok: true });
}
