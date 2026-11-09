// Empieza la conexión con Google Calendar: devuelve la dirección de Google donde la persona autoriza su cuenta.
import { adminClient, caller, fail } from "../../../../lib/server";
import { authUrl, googleReady } from "../../../../lib/google";

export const dynamic = "force-dynamic";

export async function POST(req) {
  if (!googleReady()) return fail(500, "Falta configurar GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Vercel.");
  const admin = adminClient();
  if (!admin) return fail(500, "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.");
  const who = await caller(admin, req);
  if (!who) return fail(401, "Inicia sesión para conectar tu calendario.");
  return Response.json({ url: authUrl(req, who.user.id) }, { headers: { "cache-control": "no-store" } });
}
