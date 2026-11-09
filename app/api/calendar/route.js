// Agenda del día desde Google Calendar.
// La persona pega en la app la "dirección secreta en formato iCal" de su calendario; la app la guarda solo en su navegador
// y la manda aquí (por POST, para que no quede en los registros) junto con el día que quiere ver.
// Solo acepta direcciones de calendar.google.com y solo responde a personas con sesión iniciada.
import { adminClient, caller, fail } from "../../../lib/server";
import { eventsForDay } from "../../../lib/ical";

export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024;

function calendarUrl(raw) {
  let s = String(raw || "").trim().replace(/^webcal:\/\//i, "https://");
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== "https:" || u.hostname !== "calendar.google.com") return null;
  if (!/^\/calendar\/ical\/[^/]+\/[^/]+\/basic\.ics$/.test(u.pathname)) return null;
  return u.toString();
}

export async function POST(req) {
  const admin = adminClient();
  if (!admin) return fail(500, "Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel.");
  const who = await caller(admin, req);
  if (!who) return fail(401, "Inicia sesión para ver tu agenda.");

  const body = await req.json().catch(() => ({}));
  const url = calendarUrl(body.url);
  if (!url) return fail(400, "Esa no es una dirección secreta de Google Calendar. Debe empezar por https://calendar.google.com/calendar/ical/ y terminar en basic.ics.");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(body.day || "")) ? body.day : new Date().toISOString().slice(0, 10);

  let text;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", cache: "no-store" });
    clearTimeout(timer);
    if (r.status === 404 || r.status === 403) return fail(404, /\/public\/basic\.ics$/.test(url) ? "Esa es la dirección pública y tu calendario no es público. Copia la «Dirección secreta en formato iCal»." : "Google no reconoce esa dirección. Puede que la hayan cambiado: copia otra vez la dirección secreta.");
    if (!r.ok) return fail(502, "Google Calendar no respondió. Intenta de nuevo en un momento.");
    const len = Number(r.headers.get("content-length") || 0);
    if (len > MAX_BYTES) return fail(413, "El calendario es demasiado grande para leerlo.");
    text = await r.text();
    if (text.length > MAX_BYTES) return fail(413, "El calendario es demasiado grande para leerlo.");
  } catch (e) {
    return fail(504, "Google Calendar tardó demasiado en responder. Intenta de nuevo.");
  }
  if (!/BEGIN:VCALENDAR/.test(text)) return fail(502, "Esa dirección no devolvió un calendario.");

  try {
    const events = eventsForDay(text, day, String(body.tz || ""), who.user.email);
    return Response.json({ day, events }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("calendar parse", e);
    return fail(500, "No pudimos leer el calendario.");
  }
}
