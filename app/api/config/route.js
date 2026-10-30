// Entrega al navegador la URL y la llave pública de Supabase (son públicas por diseño).
export const dynamic = "force-dynamic";

export function GET() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");
  return Response.json({
    url,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "",
  });
}
