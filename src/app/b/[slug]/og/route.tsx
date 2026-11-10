// OG / WhatsApp preview image for /b/[slug] (M6 T7). Rendering lives in src/lib/viewer/og-image.tsx.
// Node runtime: getOgData uses the server-only admin client.
import { getOgData } from "@/lib/db/public-books";
import { isValidSlug } from "@/lib/publish/slug";
import {
  OG_CACHE_CONTROL,
  OG_GENERIC_CACHE_CONTROL,
  renderGenericOgImage,
  renderOgImage,
  type OgImageResult,
} from "@/lib/viewer/og-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  let result: OgImageResult;
  try {
    result = isValidSlug(slug) ? await renderOgImage(await getOgData(slug)) : await renderGenericOgImage();
  } catch {
    // DB error etc. — still answer with a branded card (short cache).
    result = await renderGenericOgImage();
  }
  return new Response(Buffer.from(result.png), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": result.generic ? OG_GENERIC_CACHE_CONTROL : OG_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
