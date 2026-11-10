import type { MetadataRoute } from "next";
import { PUBLIC_SITEMAP_PATHS } from "@/lib/marketing/sitemap";
import { getSiteUrl } from "@/lib/auth/redirect";

// Only public marketing/legal pages. Shared books (/b/*) are private-by-link and never listed.
export default function sitemap(): MetadataRoute.Sitemap {
  let base: string;
  try {
    base = getSiteUrl();
  } catch {
    base = "http://localhost:3000"; // build without NEXT_PUBLIC_APP_URL; prod deploys always set it
  }
  return PUBLIC_SITEMAP_PATHS.map((path) => ({ url: `${base}${path}`, changeFrequency: "monthly", priority: path === "/" ? 1 : 0.3 }));
}
