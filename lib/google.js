// Conexión con Google Calendar (OAuth). Cada persona autoriza su propia cuenta de Google.
// El permiso de larga duración (refresh token) se guarda cifrado en la tabla google_tokens, que solo lee el servidor.
import crypto from "crypto";
import { appOrigin } from "./server";

export const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events.readonly"];

export function googleReady() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export const redirectUri = (req) => appOrigin(req) + "/api/google/callback";

const secret = () => process.env.GOOGLE_CLIENT_SECRET || "";
const b64u = (buf) => Buffer.from(buf).toString("base64url");

// "state" firmado: dice qué persona pidió conectar y vence en 10 minutos.
export function signState(userId) {
  const body = b64u(JSON.stringify({ u: userId, x: Date.now() + 10 * 60 * 1000, n: crypto.randomBytes(8).toString("hex") }));
  const sig = b64u(crypto.createHmac("sha256", secret()).update(body).digest());
  return body + "." + sig;
}

export function readState(state) {
  const [body, sig] = String(state || "").split(".");
  if (!body || !sig) return null;
  const good = b64u(crypto.createHmac("sha256", secret()).update(body).digest());
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return p && p.u && p.x > Date.now() ? p.u : null;
  } catch (e) {
    return null;
  }
}

const key = () => crypto.createHash("sha256").update("google-calendar-token:" + secret()).digest();

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return [b64u(iv), b64u(c.getAuthTag()), b64u(enc)].join(".");
}

export function decrypt(blob) {
  const [iv, tag, enc] = String(blob || "").split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
}

export function authUrl(req, userId) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: signState(userId),
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p.toString();
}

async function tokenCall(params) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.assign({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: secret() }, params)),
    cache: "no-store",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error_description || j.error || "Google no aceptó la autorización.");
    e.code = j.error || "token_error";
    throw e;
  }
  return j;
}

export const exchangeCode = (req, code) => tokenCall({ code, grant_type: "authorization_code", redirect_uri: redirectUri(req) });
export const refreshAccess = (refreshToken) => tokenCall({ refresh_token: refreshToken, grant_type: "refresh_token" });

export function emailFromIdToken(idToken) {
  try {
    const p = JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf8"));
    return p.email || "";
  } catch (e) {
    return "";
  }
}

export async function revoke(token) {
  await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(token), { method: "POST" }).catch(() => {});
}

function meetingLink(e) {
  if (e.hangoutLink) return e.hangoutLink;
  const ep = e.conferenceData && (e.conferenceData.entryPoints || []).find((x) => x.entryPointType === "video" && x.uri);
  if (ep) return ep.uri;
  const hay = [e.location, e.description].filter(Boolean).join(" ");
  const m = /https:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|teams\.live\.com)\/[^\s"<>]+/i.exec(hay);
  return m ? m[0] : "";
}

// Eventos del calendario principal entre timeMin y timeMax (ISO), con las repeticiones ya expandidas por Google.
export async function listEvents(accessToken, timeMin, timeMax, timeZone) {
  const p = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
  if (timeZone) p.set("timeZone", timeZone);
  const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?" + p.toString(), {
    headers: { authorization: "Bearer " + accessToken },
    cache: "no-store",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((j.error && j.error.message) || "Google Calendar no respondió.");
    e.status = r.status;
    throw e;
  }
  return (j.items || [])
    .filter((e) => e.status !== "cancelled" && e.eventType !== "workingLocation")
    .filter((e) => !(e.attendees || []).some((a) => a.self && a.responseStatus === "declined"))
    .map((e) => {
      const allDay = !!(e.start && e.start.date);
      return {
        id: e.id,
        title: e.summary || "(Sin título)",
        start: allDay ? e.start.date : e.start.dateTime,
        end: allDay ? (e.end && e.end.date) || e.start.date : (e.end && e.end.dateTime) || e.start.dateTime,
        allDay,
        location: e.location || "",
        link: meetingLink(e),
      };
    });
}
