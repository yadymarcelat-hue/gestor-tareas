// Servidor MCP para Claude con la clave dentro de la dirección: /api/mcp/<clave>.
// Es la forma de conectarlo en claude.ai (Configuración > Conectores > Agregar conector personalizado).
import { mcpOther, mcpPost } from "../../../../lib/mcp";

export const dynamic = "force-dynamic";
export const POST = (req, { params }) => mcpPost(req, params.key);
export const GET = mcpOther;
export const DELETE = mcpOther;
