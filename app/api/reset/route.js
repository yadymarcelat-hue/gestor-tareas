// "Olvidé mi contraseña": manda desde Gmail un enlace a /aceptar para crear una contraseña nueva.
// Siempre responde igual, exista o no el correo, para no revelar quién tiene cuenta.
import { adminClient, appOrigin, fail } from "../../../lib/server";
import { mailReady, sendMail, resetEmail } from "../../../lib/mail";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const admin = adminClient();
  if (!admin) return fail(500, "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.");
  if (!mailReady()) return fail(503, "El envío de correos no está configurado. Pídele a la administradora un enlace nuevo.");

  let body;
  try { body = await req.json(); } catch { return fail(400, "Solicitud inválida."); }
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, "Escribe un correo válido.");

  const origin = appOrigin(req);
  const res = await admin.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: origin + "/aceptar" } });
  const hash = res.data && res.data.properties && res.data.properties.hashed_token;
  if (!res.error && hash) {
    const link = origin + "/aceptar?token_hash=" + encodeURIComponent(hash) + "&type=recovery";
    try {
      await sendMail(Object.assign({ to: email }, resetEmail({ link })));
    } catch (e) {
      console.error("reset mail", e);
      return fail(502, "No pudimos enviar el correo en este momento. Intenta de nuevo en unos minutos.");
    }
  }
  return Response.json({ ok: true });
}
