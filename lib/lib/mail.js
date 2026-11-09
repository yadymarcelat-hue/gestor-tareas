// Envío de correos desde Gmail (invitaciones y recuperar contraseña).
// Necesita en Vercel: GMAIL_USER (tu correo) y GMAIL_APP_PASSWORD (contraseña de aplicación de Google).
import nodemailer from "nodemailer";

export function mailReady() {
  return !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

let transport = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, "") },
    });
  }
  return transport;
}

// Devuelve true si se envió, false si el correo no está configurado. Lanza error si Gmail lo rechaza.
export async function sendMail({ to, subject, html, text }) {
  if (!mailReady()) return false;
  const fromName = process.env.MAIL_FROM_NAME || "Proyectos";
  await getTransport().sendMail({ from: `"${fromName}" <${process.env.GMAIL_USER}>`, to, subject, html, text });
  return true;
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function layout({ title, intro, button, link, foot }) {
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#15171c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e5e7ec;border-radius:16px;padding:32px 28px">
<tr><td style="font-size:14px;font-weight:700;color:#5f6673;padding-bottom:18px">Proyectos</td></tr>
<tr><td style="font-size:21px;font-weight:700;line-height:1.3;padding-bottom:12px">${title}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#3a3f48;padding-bottom:24px">${intro}</td></tr>
<tr><td style="padding-bottom:24px"><a href="${esc(link)}" style="display:inline-block;background:#1667ff;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px">${button}</a></td></tr>
<tr><td style="font-size:13px;line-height:1.6;color:#5f6673">${foot}<br><br>Si el botón no funciona, copia esta dirección en tu navegador:<br><span style="word-break:break-all;color:#1667ff">${esc(link)}</span></td></tr>
</table></td></tr></table></body></html>`;
}

export function inviteEmail({ name, company, inviter, link, existing }) {
  const hola = name ? `Hola ${esc(name)},` : "Hola,";
  if (existing) {
    return {
      subject: `Te agregaron a ${company} en Proyectos`,
      html: layout({
        title: `Ahora estás en ${esc(company)}`,
        intro: `${hola} ${esc(inviter)} te agregó al equipo de <b>${esc(company)}</b>. Entra con tu correo y tu contraseña de siempre; la verás en el menú de empresas.`,
        button: "Entrar",
        link,
        foot: "Si no esperabas este correo, puedes ignorarlo.",
      }),
      text: `${hola} ${inviter} te agregó a ${company}. Entra con tu correo y tu contraseña de siempre: ${link}`,
    };
  }
  return {
    subject: `${inviter} te invitó a ${company} en Proyectos`,
    html: layout({
      title: `Te invitaron a ${esc(company)}`,
      intro: `${hola} ${esc(inviter)} te invitó a trabajar en <b>${esc(company)}</b>. Abre el enlace, crea tu contraseña y entra a ver tus proyectos y tareas.`,
      button: "Aceptar invitación",
      link,
      foot: "El enlace vence en 24 horas y solo sirve una vez. Si vence, pídele uno nuevo a quien te invitó.",
    }),
    text: `${hola} ${inviter} te invitó a ${company}. Crea tu contraseña aquí (vence en 24 horas): ${link}`,
  };
}

export function resetEmail({ link }) {
  return {
    subject: "Crea una contraseña nueva para Proyectos",
    html: layout({
      title: "Crea una contraseña nueva",
      intro: "Recibimos una solicitud para cambiar tu contraseña. Abre el enlace y escribe la nueva.",
      button: "Crear contraseña nueva",
      link,
      foot: "El enlace vence en 1 hora. Si no lo pediste, ignora este correo: tu contraseña sigue igual.",
    }),
    text: `Crea tu contraseña nueva aquí (vence en 1 hora): ${link}`,
  };
}
