// Entrega al navegador la URL y la llave pública de Supabase (son públicas por diseño).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "",
  });
}
