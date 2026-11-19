// Servidor MCP del gestor de tareas: deja que Claude consulte proyectos y tareas, y cree tareas.
// Cada clave pertenece a una persona y Claude ve exactamente lo que esa persona ve en la app
// (la base de datos aplica los mismos permisos con la función mcp_read). Solo crea tareas en proyectos
// que esa persona puede ver, que es la misma regla de la app para escribir tareas (can_write_doc).
import { createHash, randomBytes } from "crypto";
import { adminClient, appOrigin } from "./server";
import { notifyTaskChange } from "./notify";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const ESTADOS = { todo: "Sin empezar", doing: "En progreso", review: "En revisión", done: "Hecho" };
const PRIORIDADES = { alta: "Alta", media: "Media", baja: "Baja" };
const TZ = "America/Bogota";

// ---------- claves ----------
export const hashKey = (key) => createHash("sha256").update(String(key)).digest("hex");
export const newKey = () => "pk_" + randomBytes(24).toString("base64url");
const keyOk = (k) => typeof k === "string" && /^pk_[A-Za-z0-9_-]{20,64}$/.test(k);

async function userFromKey(admin, key) {
  if (!keyOk(key)) return null;
  const { data, error } = await admin.from("mcp_tokens").select("id,user_id").eq("token_hash", hashKey(key)).maybeSingle();
  if (error) {
    console.error("mcp_tokens", error.message);
    throw new Error("setup");
  }
  if (!data) return null;
  admin.from("mcp_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {}, () => {});
  return data.user_id;
}

// ---------- utilidades ----------
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const hoy = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const fecha = (ms) => (ms ? new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Number(ms))) : null);
const estadoDe = (v) => {
  const n = norm(v);
  if (!n) return null;
  if (ESTADOS[n]) return n;
  const hit = Object.entries(ESTADOS).find(([, l]) => norm(l) === n || norm(l).startsWith(n));
  if (hit) return hit[0];
  if (/^(hecha?s?|terminad|cerrad|complet|finaliz)/.test(n)) return "done";
  if (/^(pendiente|por hacer|sin empez|nueva)/.test(n)) return "todo";
  if (/^(en curso|haciendo|progreso|trabajando)/.test(n)) return "doing";
  if (/^(revision|revisar|qa)/.test(n)) return "review";
  return "invalid";
};

// Lee todo lo que la persona puede ver y lo deja listo para buscar.
async function loadData(admin, userId, withComments) {
  const cols = ["members", "projects", "milestones", "tasks"].concat(withComments ? ["comments"] : []);
  const { data: rows, error } = await admin.rpc("mcp_read", { p_user: userId, p_collections: cols });
  if (error) {
    console.error("mcp_read", error.message);
    throw new Error("setup");
  }
  const by = { members: [], projects: [], milestones: [], tasks: [], comments: [] };
  (rows || []).forEach((r) => by[r.col] && by[r.col].push({ ws: r.ws, id: r.doc_id, ...r.doc }));
  const wsIds = [...new Set(by.members.filter((m) => m.id === userId).map((m) => m.ws))];
  const people = new Set([userId]);
  by.members.forEach((m) => people.add(m.id));
  const [{ data: wss }, { data: profs }] = await Promise.all([
    wsIds.length ? admin.from("workspaces").select("id,name").in("id", wsIds) : Promise.resolve({ data: [] }),
    admin.from("profiles").select("id,name,email").in("id", [...people]),
  ]);
  const wsName = Object.fromEntries((wss || []).map((w) => [w.id, w.name]));
  const pName = Object.fromEntries((profs || []).map((p) => [p.id, p.name || p.email || "Sin nombre"]));
  const key = (ws, id) => ws + "/" + id;
  const projects = new Map(by.projects.filter((p) => wsIds.includes(p.ws)).map((p) => [key(p.ws, p.id), p]));
  const miles = new Map(by.milestones.map((m) => [key(m.ws, m.id), m]));
  const tasks = by.tasks.filter((t) => projects.has(key(t.ws, t.projectId)));
  const membersByWs = {};
  by.members.forEach((m) => (membersByWs[m.ws] = membersByWs[m.ws] || []).push(m.id));
  return { userId, wsName, pName, projects, miles, tasks, comments: by.comments, key, membersByWs };
}

// Mismas reglas que la app: quién puede ser responsable en un proyecto y si el proyecto usa hitos.
const visDe = (p) => (["private", "members", "company"].includes(p.visibility) ? p.visibility : "members");
function gentePro(D, p) {
  const v = visDe(p);
  const ws = D.membersByWs[p.ws] || [];
  const ids = new Set(v === "company" ? ws : v === "private" ? [] : (p.memberIds || []).filter((id) => ws.includes(id)));
  if (p.ownerId) ids.add(p.ownerId);
  return [...ids];
}
const hitosDe = (D, p) =>
  [...D.miles.values()].filter((m) => m.ws === p.ws && m.projectId === p.id).sort((a, b) => (a.date || "9").localeCompare(b.date || "9"));
const usaHitos = (D, p) => p.useHitos === true || (p.useHitos === undefined && hitosDe(D, p).length > 0);
const fechaOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(v + "T00:00:00Z"));
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-5);

const nombre = (D, id) => (id ? D.pName[id] || "Persona fuera de la empresa" : null);

function resumenTarea(D, t) {
  const p = D.projects.get(D.key(t.ws, t.projectId)) || {};
  const m = t.milestoneId ? D.miles.get(D.key(t.ws, t.milestoneId)) : null;
  const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
  const col = t.column || "todo";
  return {
    id: t.id,
    titulo: t.title || "Sin título",
    estado: ESTADOS[col] || col,
    proyecto: p.name || null,
    empresa: D.wsName[t.ws] || t.ws,
    prioridad: PRIORIDADES[t.priority] || "Sin prioridad",
    responsables: (t.assignees || []).map((id) => nombre(D, id)),
    inicio: t.start || null,
    fin: t.end || null,
    vencida: !!(t.end && col !== "done" && t.end < hoy()),
    hito: m ? m.name : null,
    clientes: Array.isArray(t.clients) ? t.clients : t.client ? [t.client] : [],
    subtareas: subs.length ? `${subs.filter((s) => s.done).length}/${subs.length} hechas` : "sin subtareas",
    cerrada_el: col === "done" ? fecha(t.doneAt) : null,
    archivada: !!t.archived,
  };
}

function buscarProyecto(D, q) {
  if (!q) return { list: null };
  const all = [...D.projects.values()].filter((p) => !p.archived || norm(q) === norm(p.id));
  const exact = all.filter((p) => p.id === q || norm(p.name) === norm(q));
  const list = exact.length ? exact : all.filter((p) => norm(p.name).includes(norm(q)));
  return { list };
}

function buscarPersona(D, q) {
  const n = norm(q);
  if (["yo", "mi", "mis", "me", "mias", "mio"].includes(n)) return [D.userId];
  return Object.entries(D.pName).filter(([id, name]) => id === q || norm(name).includes(n)).map(([id]) => id);
}

// ---------- herramientas ----------
const TOOLS = [
  {
    name: "listar_proyectos",
    title: "Listar proyectos",
    description:
      "Lista los proyectos que la persona conectada puede ver en el gestor de tareas, con su empresa, clientes y cuántas tareas hay en cada estado. Úsala primero cuando no sepas el nombre exacto de un proyecto.",
    inputSchema: {
      type: "object",
      properties: {
        empresa: { type: "string", description: "Opcional. Nombre o parte del nombre de la empresa para filtrar." },
        incluir_archivados: { type: "boolean", description: "Opcional. Incluir proyectos archivados. Por defecto no." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "listar_tareas",
    title: "Listar tareas",
    description:
      "Lista tareas de los proyectos que la persona puede ver. Se puede filtrar por proyecto, estado, responsable, texto y si están vencidas. Devuelve para cada tarea su estado, prioridad, responsables, fechas, hito y avance de subtareas.",
    inputSchema: {
      type: "object",
      properties: {
        proyecto: { type: "string", description: "Opcional. Nombre (o parte) o id del proyecto." },
        estado: {
          type: "string",
          description: "Opcional. Sin empezar, En progreso, En revisión o Hecho. También acepta 'abiertas' para todo lo que no está Hecho.",
        },
        responsable: { type: "string", description: "Opcional. Nombre (o parte) de la persona, o 'yo' para la persona conectada." },
        buscar: { type: "string", description: "Opcional. Texto a buscar en el título, la descripción o la historia (como/quiero/para)." },
        solo_vencidas: { type: "boolean", description: "Opcional. Solo tareas con fecha de fin pasada que no están Hechas." },
        incluir_archivadas: { type: "boolean", description: "Opcional. Incluir tareas archivadas. Por defecto no." },
        limite: { type: "integer", minimum: 1, maximum: 200, description: "Opcional. Máximo de tareas a devolver (por defecto 50)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ver_tarea",
    title: "Ver una tarea",
    description:
      "Muestra el detalle de una tarea: estado, historia de usuario, descripción, responsables, fechas, subtareas, criterios de aceptación, archivos y los últimos comentarios. Recibe el id de la tarea o parte de su título.",
    inputSchema: {
      type: "object",
      properties: {
        tarea: { type: "string", description: "Id de la tarea o parte de su título." },
        proyecto: { type: "string", description: "Opcional. Proyecto, para desempatar si hay varias tareas con títulos parecidos." },
      },
      required: ["tarea"],
      additionalProperties: false,
    },
  },
  {
    name: "mis_tareas",
    title: "Mis tareas",
    description:
      "Lista las tareas asignadas a la persona conectada (como responsable de la tarea o de alguna subtarea), ordenadas por fecha de fin. Por defecto solo las que no están Hechas.",
    inputSchema: {
      type: "object",
      properties: {
        incluir_hechas: { type: "boolean", description: "Opcional. Incluir también las tareas en Hecho." },
      },
      additionalProperties: false,
    },
  },
].map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } }));
TOOLS.push(
  {
    name: "crear_tarea",
    title: "Crear tarea",
    description:
      "Crea una tarea nueva en un proyecto que la persona conectada puede ver, a su nombre. Si el proyecto usa hitos, el hito es obligatorio (listar_proyectos muestra los hitos y las personas de cada proyecto). A los responsables les llega el aviso de que se les asignó la tarea. Devuelve la tarea creada.",
    inputSchema: {
      type: "object",
      properties: {
        proyecto: { type: "string", description: "Nombre (o parte) o id del proyecto." },
        titulo: { type: "string", description: "Título de la tarea." },
        descripcion: { type: "string", description: "Opcional. Contexto y alcance." },
        estado: { type: "string", description: "Opcional. Sin empezar (por defecto), En progreso, En revisión o Hecho." },
        prioridad: { type: "string", enum: ["alta", "media", "baja", "sin prioridad"], description: "Opcional. Por defecto sin prioridad." },
        responsables: { type: "array", items: { type: "string" }, description: "Opcional. Nombres (o parte) de las personas del proyecto, o 'yo'." },
        inicio: { type: "string", description: "Opcional. Fecha de inicio AAAA-MM-DD." },
        fin: { type: "string", description: "Opcional. Fecha de fin AAAA-MM-DD." },
        hito: { type: "string", description: "Nombre (o parte) del hito. Obligatorio si el proyecto usa hitos." },
        clientes: { type: "array", items: { type: "string" }, description: "Opcional. Clientes de la tarea." },
        como: { type: "string", description: "Opcional. Historia de usuario: Como…" },
        quiero: { type: "string", description: "Opcional. Historia de usuario: Quiero…" },
        para: { type: "string", description: "Opcional. Historia de usuario: Para…" },
        subtareas: {
          type: "array",
          description: "Opcional. Subtareas: texto, o {titulo, responsable, inicio, fin}.",
          items: { anyOf: [{ type: "string" }, { type: "object", properties: { titulo: { type: "string" }, responsable: { type: "string" }, inicio: { type: "string" }, fin: { type: "string" } }, required: ["titulo"] }] },
        },
        criterios: { type: "array", items: { type: "string" }, description: "Opcional. Criterios de aceptación." },
      },
      required: ["proyecto", "titulo"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }
);

const ordenFin = (a, b) => (a.end || "9999").localeCompare(b.end || "9999") || (a.title || "").localeCompare(b.title || "");

async function runTool(name, args, ctx) {
  const a = args && typeof args === "object" ? args : {};
  const D = await loadData(ctx.admin, ctx.userId, name === "ver_tarea");

  if (name === "listar_proyectos") {
    let ps = [...D.projects.values()].filter((p) => a.incluir_archivados || !p.archived);
    if (a.empresa) ps = ps.filter((p) => norm(D.wsName[p.ws] || p.ws).includes(norm(a.empresa)));
    const out = ps
      .map((p) => {
        const ts = D.tasks.filter((t) => t.ws === p.ws && t.projectId === p.id && !t.archived);
        const cuenta = Object.fromEntries(Object.entries(ESTADOS).map(([k, l]) => [l, ts.filter((t) => (t.column || "todo") === k).length]));
        return {
          id: p.id,
          nombre: p.name || "Sin nombre",
          empresa: D.wsName[p.ws] || p.ws,
          descripcion: p.description || "",
          clientes: Array.isArray(p.clients) ? p.clients : p.client ? [p.client] : [],
          inicio: p.start || null,
          fin: p.noEnd ? "sin fecha de fin" : p.end || null,
          tareas: ts.length,
          por_estado: cuenta,
          vencidas: ts.filter((t) => t.end && (t.column || "todo") !== "done" && t.end < hoy()).length,
          hitos: usaHitos(D, p) ? hitosDe(D, p).map((m) => m.name) : "no usa hitos",
          personas: gentePro(D, p).map((id) => nombre(D, id)),
          archivado: !!p.archived,
        };
      })
      .sort((x, y) => x.empresa.localeCompare(y.empresa, "es") || x.nombre.localeCompare(y.nombre, "es"));
    return { proyectos: out, total: out.length };
  }

  if (name === "listar_tareas" || name === "mis_tareas") {
    let ts = D.tasks;
    const notas = [];
    if (name === "mis_tareas") {
      ts = ts.filter((t) => (t.assignees || []).includes(D.userId) || (t.subtasks || []).some((s) => s.assignee === D.userId && !s.done));
      ts = ts.filter((t) => !t.archived && (a.incluir_hechas || (t.column || "todo") !== "done"));
    } else {
      if (!a.incluir_archivadas) ts = ts.filter((t) => !t.archived);
      if (a.proyecto) {
        const { list } = buscarProyecto(D, a.proyecto);
        if (!list.length) return { error: `No encontré un proyecto que se llame "${a.proyecto}" entre los que puedes ver. Usa listar_proyectos para ver los nombres.` };
        const ids = new Set(list.map((p) => D.key(p.ws, p.id)));
        ts = ts.filter((t) => ids.has(D.key(t.ws, t.projectId)));
        if (list.length > 1) notas.push("Coinciden varios proyectos: " + list.map((p) => p.name).join(", "));
      }
      if (a.estado) {
        if (/^abiert|^pendientes?$|^no hech/.test(norm(a.estado))) ts = ts.filter((t) => (t.column || "todo") !== "done");
        else {
          const e = estadoDe(a.estado);
          if (e === "invalid") return { error: `Estado "${a.estado}" no válido. Usa: ${Object.values(ESTADOS).join(", ")} o "abiertas".` };
          ts = ts.filter((t) => (t.column || "todo") === e);
        }
      }
      if (a.responsable) {
        const ids = buscarPersona(D, a.responsable);
        if (!ids.length) return { error: `No encontré a "${a.responsable}" en tus empresas.` };
        ts = ts.filter((t) => (t.assignees || []).some((x) => ids.includes(x)) || (t.subtasks || []).some((s) => ids.includes(s.assignee)));
      }
      if (a.buscar) {
        const q = norm(a.buscar);
        ts = ts.filter((t) => norm([t.title, t.description, t.como, t.quiero, t.para].join(" ")).includes(q));
      }
      if (a.solo_vencidas) ts = ts.filter((t) => t.end && (t.column || "todo") !== "done" && t.end < hoy());
    }
    const lim = Math.min(Math.max(parseInt(a.limite, 10) || 50, 1), 200);
    const sorted = ts.slice().sort(ordenFin);
    const out = { tareas: sorted.slice(0, lim).map((t) => resumenTarea(D, t)), total: sorted.length };
    if (sorted.length > lim) out.nota = `Se muestran ${lim} de ${sorted.length}. Filtra más o sube el límite.`;
    if (notas.length) out.nota = [out.nota, ...notas].filter(Boolean).join(" ");
    out.hoy = hoy();
    return out;
  }

  if (name === "crear_tarea") return crearTarea(D, a, ctx);

  if (name === "ver_tarea") {
    const q = String(a.tarea || "").trim();
    if (!q) return { error: "Indica el id o parte del título de la tarea." };
    let ts = D.tasks;
    if (a.proyecto) {
      const { list } = buscarProyecto(D, a.proyecto);
      const ids = new Set((list || []).map((p) => D.key(p.ws, p.id)));
      ts = ts.filter((t) => ids.has(D.key(t.ws, t.projectId)));
    }
    let hits = ts.filter((t) => t.id === q);
    if (!hits.length) hits = ts.filter((t) => norm(t.title) === norm(q));
    if (!hits.length) hits = ts.filter((t) => norm(t.title).includes(norm(q)));
    if (!hits.length) return { error: `No encontré una tarea "${q}" en los proyectos que puedes ver.` };
    if (hits.length > 1)
      return {
        varias: "Hay varias tareas que coinciden. Pide el detalle con el id de la que necesitas.",
        coincidencias: hits.slice(0, 20).map((t) => ({ id: t.id, titulo: t.title, estado: ESTADOS[t.column || "todo"], proyecto: (D.projects.get(D.key(t.ws, t.projectId)) || {}).name })),
      };
    const t = hits[0];
    const coms = D.comments
      .filter((c) => c.ws === t.ws && c.taskId === t.id)
      .sort((x, y) => (y.at || 0) - (x.at || 0))
      .slice(0, 20)
      .map((c) => ({ por: nombre(D, c.by), fecha: fecha(c.at), texto: c.text || "", es_respuesta: !!c.parentId }));
    return {
      ...resumenTarea(D, t),
      historia: t.como || t.quiero || t.para ? { como: t.como || "", quiero: t.quiero || "", para: t.para || "" } : null,
      descripcion: t.description || "",
      subtareas: (t.subtasks || []).map((s) => ({ titulo: s.title || "", hecha: !!s.done, responsable: nombre(D, s.assignee), inicio: s.start || null, fin: s.end || null })),
      criterios: (t.criteria || []).filter((c) => c && c.text).map((c) => ({ texto: c.text, cumplido: !!c.done })),
      archivos: (t.docs || []).map((x) => ({ nombre: x.name || x.url, url: x.url || null, tipo: x.kind === "file" ? "archivo" : "enlace" })),
      comentarios_recientes: coms,
      creada: fecha(t.createdAt),
      actualizada: fecha(t.updatedAt),
      abrir_en_la_app: ctx.origin,
      hoy: hoy(),
    };
  }
  return null;
}

async function crearTarea(D, a, ctx) {
  const titulo = String(a.titulo || "").trim();
  if (!titulo) return { error: "Falta el título de la tarea." };
  const { list } = buscarProyecto(D, String(a.proyecto || "").trim());
  if (!list || !list.length) return { error: `No encontré un proyecto "${a.proyecto}" entre los que puedes ver. Usa listar_proyectos para ver los nombres.` };
  if (list.length > 1) return { error: "Coinciden varios proyectos. Indica cuál con su nombre completo o id.", coincidencias: list.map((p) => ({ id: p.id, nombre: p.name, empresa: D.wsName[p.ws] || p.ws })) };
  const p = list[0];

  const col = a.estado ? estadoDe(a.estado) : "todo";
  if (!col || col === "invalid") return { error: `Estado "${a.estado}" no válido. Usa: ${Object.values(ESTADOS).join(", ")}.` };
  const pn = norm(a.prioridad);
  const priority = !pn || /^sin/.test(pn) ? "none" : PRIORIDADES[pn] ? pn : null;
  if (!priority) return { error: `Prioridad "${a.prioridad}" no válida. Usa alta, media, baja o sin prioridad.` };
  for (const [k, v] of [["inicio", a.inicio], ["fin", a.fin]]) if (v && !fechaOk(v)) return { error: `La fecha de ${k} debe tener el formato AAAA-MM-DD (por ejemplo ${hoy()}).` };
  if (a.inicio && a.fin && a.fin < a.inicio) return { error: "La fecha de fin es anterior a la de inicio." };

  // Hito (obligatorio si el proyecto usa hitos)
  let milestoneId = "";
  if (usaHitos(D, p)) {
    const hs = hitosDe(D, p);
    if (hs.length) {
      if (!a.hito) return { error: "Este proyecto usa hitos: indica el hito de la tarea.", hitos: hs.map((m) => m.name) };
      const hit = hs.filter((m) => m.id === a.hito || norm(m.name) === norm(a.hito));
      const cand = hit.length ? hit : hs.filter((m) => norm(m.name).includes(norm(a.hito)));
      if (cand.length !== 1) return { error: cand.length ? "Coinciden varios hitos; indica uno." : `No encontré el hito "${a.hito}".`, hitos: hs.map((m) => m.name) };
      milestoneId = cand[0].id;
    }
  }

  // Personas del proyecto
  const gente = gentePro(D, p);
  const persona = (q) => {
    const n = norm(q);
    if (["yo", "mi", "me"].includes(n)) return gente.includes(D.userId) ? [D.userId] : [];
    const exact = gente.filter((id) => norm(D.pName[id]) === n);
    return exact.length ? exact : gente.filter((id) => norm(D.pName[id]).includes(n));
  };
  const assignees = [];
  for (const q of Array.isArray(a.responsables) ? a.responsables : []) {
    const ids = persona(q);
    if (ids.length !== 1)
      return { error: ids.length ? `"${q}" coincide con varias personas: ${ids.map((id) => D.pName[id]).join(", ")}.` : `"${q}" no es una persona de este proyecto.`, personas_del_proyecto: gente.map((id) => nombre(D, id)) };
    if (!assignees.includes(ids[0])) assignees.push(ids[0]);
  }
  const subtasks = [];
  for (const sRaw of Array.isArray(a.subtareas) ? a.subtareas : []) {
    const sx = typeof sRaw === "string" ? { titulo: sRaw } : sRaw || {};
    const st = String(sx.titulo || "").trim();
    if (!st) continue;
    let assignee = "";
    if (sx.responsable) {
      const ids = persona(sx.responsable);
      if (ids.length !== 1) return { error: `Subtarea "${st}": "${sx.responsable}" no es una persona de este proyecto (o coincide con varias).`, personas_del_proyecto: gente.map((id) => nombre(D, id)) };
      assignee = ids[0];
    }
    for (const v of [sx.inicio, sx.fin]) if (v && !fechaOk(v)) return { error: `Subtarea "${st}": las fechas van en formato AAAA-MM-DD.` };
    subtasks.push({ id: rid(), title: st, done: false, assignee, withDates: !!(sx.inicio || sx.fin), start: sx.inicio || "", end: sx.fin || "" });
  }
  const criteria = (Array.isArray(a.criterios) ? a.criterios : []).map((c) => String(c || "").trim()).filter(Boolean).map((text) => ({ id: rid(), text, done: false }));
  const clients = [...new Set((Array.isArray(a.clientes) ? a.clientes : []).map((c) => String(c || "").trim()).filter(Boolean))];

  const now = Date.now();
  const enCol = D.tasks.filter((t) => t.ws === p.ws && t.projectId === p.id && (t.column || "todo") === col);
  const task = {
    title: titulo.slice(0, 500),
    como: String(a.como || ""),
    quiero: String(a.quiero || ""),
    para: String(a.para || ""),
    description: String(a.descripcion || ""),
    milestoneId,
    priority,
    clients,
    start: a.inicio || "",
    end: a.fin || "",
    assignees,
    subtasks,
    criteria,
    docs: [],
    archived: false,
    projectId: p.id,
    column: col,
    order: enCol.reduce((m, t) => Math.max(m, t.order || 0), 0) + 1,
    createdAt: now,
    createdBy: D.userId,
    updatedAt: now,
    doneAt: col === "done" ? now : null,
    via: "claude",
  };
  const id = rid();
  const { error } = await ctx.admin.from("docs").insert({ workspace_id: p.ws, collection: "tasks", id, data: task, updated_at: new Date().toISOString() });
  if (error) {
    console.error("crear_tarea", error.message);
    return { error: "No se pudo guardar la tarea. Intenta de nuevo." };
  }
  // Los clientes nuevos se suman al proyecto si quien crea la tarea es dueña del proyecto (en la app, si puede editarlo).
  const pcl = Array.isArray(p.clients) ? p.clients : p.client ? [p.client] : [];
  const extra = clients.filter((c) => !pcl.some((x) => norm(x) === norm(c)));
  if (extra.length && p.ownerId === D.userId) {
    const { ws: _w, id: _i, ...pdata } = p;
    await ctx.admin.from("docs").update({ data: { ...pdata, clients: pcl.concat(extra) }, updated_at: new Date().toISOString() }).eq("workspace_id", p.ws).eq("collection", "projects").eq("id", p.id).then(() => {}, () => {});
  }
  let aviso = null;
  try {
    const r = await notifyTaskChange(ctx.admin, { workspaceId: p.ws, taskId: id, task, before: { assignees: [], subs: {}, column: "" }, me: D.userId, origin: ctx.origin });
    if (r.sent) aviso = `Se avisó a ${r.sent} ${r.sent === 1 ? "persona" : "personas"}${r.emailed ? " (también por correo)" : ""}.`;
  } catch (e) {
    console.error("crear_tarea aviso", e && e.message);
  }
  D.tasks.push({ ws: p.ws, id, ...task });
  return {
    creada: true,
    ...resumenTarea(D, { ws: p.ws, id, ...task }),
    aviso,
    abrir_en_la_app: ctx.origin + "/?ws=" + encodeURIComponent(p.ws) + "&p=" + encodeURIComponent(p.id) + "&t=" + encodeURIComponent(id),
  };
}

// ---------- protocolo (MCP sobre HTTP, sin sesión) ----------
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handleMessage(msg, ctx) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg && msg.id, -32600, "Solicitud no válida");
  const isNote = msg.id === undefined || msg.id === null;
  const { id, method, params } = msg;
  if (isNote) return null; // notifications/initialized, cancelled, etc.
  switch (method) {
    case "initialize": {
      const asked = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "gestor-de-tareas", title: "Gestor de tareas", version: "1.1.0" },
        instructions:
          "Consulta el gestor de tareas de la persona conectada y crea tareas a su nombre. Ves únicamente los proyectos y tareas a los que esa persona tiene permiso. Estados posibles: Sin empezar, En progreso, En revisión, Hecho. Para saber en qué estado está una tarea usa ver_tarea; para listar, listar_tareas o mis_tareas; si no conoces el nombre del proyecto, empieza con listar_proyectos (también muestra los hitos y las personas de cada proyecto). Para crear usa crear_tarea; antes de crear, confirma con la persona el proyecto, el título y los responsables si no los dijo claramente.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = params && params.name;
      if (!TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `Herramienta desconocida: ${name}`);
      try {
        const out = await runTool(name, params.arguments, ctx);
        const isError = !!(out && out.error);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 1) }], isError });
      } catch (e) {
        const setup = e && e.message === "setup";
        console.error("mcp tool", name, e);
        return rpcResult(id, {
          content: [{ type: "text", text: setup ? "El servidor no está listo: falta correr supabase/8-conexion-claude.sql en Supabase." : "No pudimos leer los datos. Intenta de nuevo." }],
          isError: true,
        });
      }
    }
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Método no soportado: ${method}`);
  }
}

const json = (body, status = 200, extra = {}) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: Object.assign({ "content-type": "application/json", "cache-control": "no-store" }, extra),
  });

// Punto de entrada: la clave llega en la dirección (/api/mcp/<clave>) o en el encabezado Authorization: Bearer <clave>.
export async function mcpPost(req, keyFromPath) {
  const admin = adminClient();
  if (!admin) return json(rpcError(null, -32603, "El servicio no está configurado."), 500);
  const key = keyFromPath || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  let userId;
  try {
    userId = await userFromKey(admin, key);
  } catch {
    return json(rpcError(null, -32603, "Falta correr supabase/8-conexion-claude.sql en Supabase."), 500);
  }
  if (!userId) return json(rpcError(null, -32001, "Clave no válida o revocada. Crea una nueva en Mi perfil > Conectar con Claude."), 401);

  let body;
  try {
    body = await req.json();
  } catch {
    return json(rpcError(null, -32700, "JSON no válido"), 400);
  }
  const ctx = { admin, userId, origin: appOrigin(req) };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
    return out.length ? json(out) : json(null, 202);
  }
  const out = await handleMessage(body, ctx);
  return out ? json(out) : json(null, 202);
}

export const mcpOther = () => json(rpcError(null, -32000, "Este servidor solo acepta POST."), 405, { allow: "POST" });
