// Google vuelve aquí después de que la persona autoriza (o cancela). Guarda el permiso cifrado y regresa al Inicio.
import { adminClient, appOrigin } from "../../../../lib/server";
import { emailFromIdToken, encrypt, exchangeCode, googleReady, readState } from "../../../../lib/google";

export const dynamic = "force-dynamic";

const back = (req, status) => Response.redirect(appOrigin(req) + "/?gcal=" + status + "#inicio", 302);

export async function GET(req) {
  const q = new URL(req.url).searchParams;
  if (q.get("error")) return back(req, "cancel");
  const admin = adminClient();
  if (!admin || !googleReady()) return back(req, "config");
  const userId = readState(q.get("state"));
  if (!userId || !q.get("code")) return back(req, "expired");

  try {
    const tok = await exchangeCode(req, q.get("code"));
    const granted = String(tok.scope || "");
    if (!/calendar\.events\.readonly|calendar\.readonly|auth\/calendar(\s|$)/.test(granted)) return back(req, "scope");
    if (!tok.refresh_token) return back(req, "norefresh");
    const { error } = await admin.from("google_tokens").upsert({
      user_id: userId,
      email: emailFromIdToken(tok.id_token),
      refresh_token: encrypt(tok.refresh_token),
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.error("google_tokens upsert", error.message);
      return back(req, "db");
    }
    return back(req, "ok");
  } catch (e) {
    console.error("google callback", e.message);
    return back(req, "error");
  }
}
