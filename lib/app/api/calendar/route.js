// Agenda del día desde Google Calendar, con la cuenta que cada persona conectó.
// Recibe timeMin y timeMax (inicio y fin del día en la hora de quien mira) y devuelve sus reuniones.
import { adminClient, caller, fail } from "../../../lib/server";
import { decrypt, googleReady, listEvents, refreshAccess } from "../../../lib/google";

export const dynamic = "force-dynamic";

const isoOk = (s) => typeof s === "string" && !isNaN(Date.parse(s));

export async function POST(req) {
  const admin = adminClient();
  if (!admin) return fail(500, "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.");
  const who = await caller(admin, req);
  if (!who) return fail(401, "Inicia sesión para ver tu agenda.");
  if (!googleReady()) return Response.json({ connected: false, setup: false });

  const body = await req.json().catch(() => ({}));
  if (!isoOk(body.timeMin) || !isoOk(body.timeMax)) return fail(400, "Faltan las fechas del día.");
  const span = Date.parse(body.timeMax) - Date.parse(body.timeMin);
  if (span <= 0 || span > 3 * 86400000) return fail(400, "El rango de fechas no es válido.");

  const { data, error } = await admin.from("google_tokens").select("email,refresh_token").eq("user_id", who.user.id).maybeSingle();
  if (error) {
    console.error("google_tokens read", error.message);
    return fail(500, "Falta crear la tabla google_tokens en Supabase (archivo supabase/7-google-calendar.sql).");
  }
  if (!data) return Response.json({ connected: false, setup: true });

  let access;
  try {
    access = (await refreshAccess(decrypt(data.refresh_token))).access_token;
  } catch (e) {
    if (e.code === "invalid_grant" || /decrypt|auth|tag/i.test(e.message)) {
      await admin.from("google_tokens").delete().eq("user_id", who.user.id);
      return Response.json({ connected: false, setup: true, expired: true });
    }
    console.error("google refresh", e.message);
    return fail(502, "Google no respondió. Intenta de nuevo en un momento.");
  }

  try {
    const events = await listEvents(access, new Date(body.timeMin).toISOString(), new Date(body.timeMax).toISOString(), String(body.tz || ""));
    return Response.json({ connected: true, email: data.email || "", events }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("google events", e.status, e.message);
    return fail(502, "No pudimos leer tu calendario de Google.");
  }
}
