// Servidor MCP para Claude. La clave va en el encabezado Authorization: Bearer <clave> (Claude Code y otros clientes).
import { mcpOther, mcpPost } from "../../../lib/mcp";

export const dynamic = "force-dynamic";
export const POST = (req) => mcpPost(req, null);
export const GET = mcpOther;
export const DELETE = mcpOther;
