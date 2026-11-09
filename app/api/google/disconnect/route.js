// Desconecta Google Calendar: borra el permiso guardado y se lo devuelve a Google.
import { adminClient, caller, fail } from "../../../../lib/server";
import { decrypt, revoke } from "../../../../lib/google";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const admin = adminClient();
  if (!admin) return fail(500, "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.");
  const who = await caller(admin, req);
  if (!who) return fail(401, "Inicia sesión.");
  const { data } = await admin.from("google_tokens").select("refresh_token").eq("user_id", who.user.id).maybeSingle();
  if (data && data.refresh_token) {
    try { await revoke(decrypt(data.refresh_token)); } catch (e) { /* si no se puede descifrar, igual se borra */ }
  }
  await admin.from("google_tokens").delete().eq("user_id", who.user.id);
  return Response.json({ ok: true });
}
