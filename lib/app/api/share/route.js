// Documento compartido con un enlace público (/d/<enlace>). No pide sesión: quien tenga el enlace puede leerlo.
// Solo responde si el documento tiene el enlace activado, y solo entrega lo que se ve en la página pública.
import { adminClient, fail } from "../../../lib/server";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const admin = adminClient();
  if (!admin) return fail(500, "El servicio no está configurado.");
  const token = new URL(req.url).searchParams.get("t") || "";
  if (!/^[A-Za-z0-9_-]{12,64}$/.test(token)) return fail(404, "Este enlace no existe o ya no está disponible.");

  const { data: rows, error } = await admin
    .from("docs")
    .select("workspace_id,data")
    .eq("collection", "documents")
    .eq("data->share->>token", token)
    .limit(1);
  if (error) return fail(500, "No pudimos abrir el documento.");
  const row = rows && rows[0];
  const d = row && row.data;
  if (!d || !d.share || d.share.enabled !== true) return fail(404, "Este enlace no existe o ya no está disponible.");

  const [{ data: ws }, { data: author }] = await Promise.all([
    admin.from("workspaces").select("*").eq("id", row.workspace_id).maybeSingle(),
    d.ownerId ? admin.from("profiles").select("name").eq("id", d.ownerId).maybeSingle() : Promise.resolve({ data: null }),
  ]);

  const files = (Array.isArray(d.attachments) ? d.attachments : [])
    .filter((x) => x && /^https?:\/\//i.test(String(x.url || "")))
    .map((x) => ({ name: String(x.name || x.url), url: String(x.url), kind: x.kind === "file" ? "file" : "link", size: Number(x.size) || 0 }));

  return Response.json(
    {
      title: String(d.title || "Documento"),
      content: String(d.content || ""),
      files,
      updatedAt: d.updatedAt || d.createdAt || null,
      author: (author && author.name) || "",
      company: (ws && ws.name) || "",
      logo: (ws && ws.logo_url) || "",
    },
    { headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } }
  );
}
