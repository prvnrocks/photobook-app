import "server-only";
// OG / WhatsApp preview image for /b/[slug] (M6 T7, D-040, D-041). Used by src/app/b/[slug]/og/route.tsx.
//
// * ok + cover → the cover photo (cover-cropped) with a soft bottom gradient, the title and a small
//   APP_NAME mark. Locked/expired/missing/unavailable, no cover, or any failure → a generic branded
//   card without a title.
// * Font: next/og's bundled Noto Sans (Latin subset) only. Satori can't shape Arabic, and for any
//   glyph the font lacks @vercel/og fetches fonts from Google at runtime — so titles are drawn only
//   when every character is in that subset (isOgDrawableText). Arabic/emoji titles: photo + brand.
// * The cover is fetched server-side (timeout, size cap, Supabase origin only, JPEG/PNG sniffed)
//   and embedded as a data URL so the signed URL never reaches the crawler.
// * Output is PNG (ImageResponse). Photos compress badly as PNG (a textured 1200×630 cover is ~1.1 MB),
//   so we step down 1200×630 → 800×420 → 600×315 (same 1.91:1 aspect) until it fits OG_MAX_BYTES —
//   WhatsApp drops large preview images. The smallest step is returned even if still over budget.
//   A JPEG encoder (sharp) would keep 1200×630 at ~150 KB but is not a declared dependency.
import { ImageResponse } from "next/og";
import { APP_NAME } from "@/lib/brand";
import type { OgData } from "@/lib/db/public-books";
import { clipText } from "@/lib/text/clip";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from "@/lib/viewer/metadata";

export const OG_MAX_BYTES = 600 * 1024;
/** Render sizes tried in order (all 1.91:1; 600×315 is the Open Graph large-card minimum). */
export const OG_SIZE_STEPS = [
  { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT },
  { width: 800, height: 420 },
  { width: 600, height: 315 },
] as const;
export const COVER_FETCH_TIMEOUT_MS = 5_000;
export const COVER_MAX_BYTES = 4 * 1024 * 1024;
export const OG_TITLE_MAX_CHARS = 60;

/**
 * Real previews: 1 h (+10 min SWR) so an unpublish / password change stops serving the old cover
 * within ~70 min (T10 S5). Generic cards: short, so a transient failure doesn't stick.
 */
export const OG_CACHE_CONTROL = "public, s-maxage=3600, stale-while-revalidate=600";
export const OG_GENERIC_CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=3600";

// Noto Sans "latin" subset as bundled by @vercel/og (Basic Latin, Latin-1, œ/Œ/ı, punctuation, €, ™).
const DRAWABLE_RE = /^[ -~ -ÿıŒœ -⁯€™]*$/;

/** True when the bundled Latin font can draw the text without a runtime font fetch. */
export function isOgDrawableText(text: string): boolean {
  return DRAWABLE_RE.test(text);
}

function allowedCoverOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function sniffImageMime(b: Uint8Array): "image/jpeg" | "image/png" | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  return null;
}

/**
 * Fetches the signed cover URL and returns a data URL, or null on any problem (bad origin, timeout,
 * non-2xx, too large, not JPEG/PNG). Never throws, never logs the URL.
 */
export async function fetchCoverDataUrl(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? COVER_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? COVER_MAX_BYTES;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const origin = allowedCoverOrigin();
  if (origin ? parsed.origin !== origin : parsed.protocol !== "https:") return null;

  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(parsed, { signal, redirect: "error", cache: "no-store" });
    if (!res.ok || !res.body) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body.cancel().catch(() => {});
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    const mime = sniffImageMime(bytes);
    if (!mime) return null;
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

type Size = { width: number; height: number };

function Brand({ scale, onPhoto }: { scale: number; onPhoto: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: `${8 * scale}px ${18 * scale}px`,
        borderRadius: 999,
        background: onPhoto ? "rgba(0,0,0,0.38)" : "rgba(255,255,255,0.08)",
        color: "#ffffff",
        fontSize: 26 * scale,
        letterSpacing: 1.5 * scale,
      }}
    >
      {APP_NAME}
    </div>
  );
}

function CoverCard({ cover, title, size }: { cover: string; title: string | null; size: Size }) {
  const s = size.width / OG_IMAGE_WIDTH;
  return (
    <div style={{ display: "flex", position: "relative", width: size.width, height: size.height, background: "#1c1917" }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- Satori renders plain <img> */}
      <img
        src={cover}
        alt=""
        width={size.width}
        height={size.height}
        style={{ position: "absolute", top: 0, left: 0, width: size.width, height: size.height, objectFit: "cover" }}
      />
      <div
        style={{
          display: "flex",
          position: "absolute",
          top: 0,
          left: 0,
          width: size.width,
          height: size.height,
          backgroundImage: "linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.18) 45%, rgba(0,0,0,0) 70%)",
        }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          position: "absolute",
          top: 0,
          left: 0,
          width: size.width,
          height: size.height,
          padding: 48 * s,
        }}
      >
        <div style={{ display: "flex" }}>
          <Brand scale={s} onPhoto />
        </div>
        {title ? (
          <div
            style={{
              display: "flex",
              color: "#ffffff",
              fontSize: 64 * s,
              lineHeight: 1.15,
              maxWidth: size.width - 96 * s,
              textShadow: "0 2px 12px rgba(0,0,0,0.45)",
            }}
          >
            {title}
          </div>
        ) : (
          <div style={{ display: "flex" }} />
        )}
      </div>
    </div>
  );
}

function GenericCard({ size }: { size: Size }) {
  const s = size.width / OG_IMAGE_WIDTH;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        width: size.width,
        height: size.height,
        backgroundImage: "linear-gradient(135deg, #292524 0%, #1c1917 60%, #0c0a09 100%)",
        color: "#ffffff",
      }}
    >
      {/* Closed-book mark: two stacked rounded rectangles. */}
      <div style={{ display: "flex", position: "relative", width: 120 * s, height: 160 * s, marginBottom: 40 * s }}>
        <div
          style={{
            display: "flex",
            position: "absolute",
            left: 14 * s,
            top: 10 * s,
            width: 106 * s,
            height: 150 * s,
            borderRadius: 10 * s,
            background: "rgba(255,255,255,0.18)",
          }}
        />
        <div
          style={{
            display: "flex",
            position: "absolute",
            left: 0,
            top: 0,
            width: 106 * s,
            height: 150 * s,
            borderRadius: 10 * s,
            background: "#f5f5f4",
            borderLeft: `${10 * s}px solid #d6d3d1`,
          }}
        />
      </div>
      <div style={{ display: "flex", fontSize: 72 * s, letterSpacing: 2 * s }}>{APP_NAME}</div>
      <div style={{ display: "flex", marginTop: 16 * s, fontSize: 30 * s, color: "rgba(255,255,255,0.7)" }}>
        Tap to flip through
      </div>
    </div>
  );
}

/** Title to draw on the cover image, or null (no title, Arabic/RTL/emoji, too odd for the Latin font). */
export function ogDrawableTitle(title: string | null): string | null {
  const t = title?.replace(/\s+/g, " ").trim();
  if (!t || !isOgDrawableText(t)) return null;
  const clipped = clipText(t, OG_TITLE_MAX_CHARS);
  if (clipped === t) return t;
  // Prefer a word boundary when the cut lands mid-word.
  const body = clipped.replace(/…$/, "");
  const space = body.lastIndexOf(" ");
  return space > OG_TITLE_MAX_CHARS / 2 ? `${body.slice(0, space).trimEnd()}…` : clipped;
}

async function render(node: React.ReactElement, size: Size): Promise<Uint8Array> {
  const res = new ImageResponse(node, { width: size.width, height: size.height });
  return new Uint8Array(await res.arrayBuffer());
}

export type OgImageResult = { png: Uint8Array; generic: boolean; width: number; height: number };

const FULL: Size = { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT };

export async function renderGenericOgImage(): Promise<OgImageResult> {
  return { png: await render(<GenericCard size={FULL} />, FULL), generic: true, ...FULL };
}

/** Renders the preview for getOgData's result. Falls back to the generic card on any failure. */
export async function renderOgImage(og: Pick<OgData, "state" | "title" | "coverUrl">): Promise<OgImageResult> {
  if (og.state !== "ok" || !og.coverUrl) return renderGenericOgImage();
  const cover = await fetchCoverDataUrl(og.coverUrl);
  if (!cover) return renderGenericOgImage();
  const title = ogDrawableTitle(og.title);
  try {
    let last: OgImageResult | null = null;
    for (const size of OG_SIZE_STEPS) {
      const png = await render(<CoverCard cover={cover} title={title} size={size} />, size);
      last = { png, generic: false, width: size.width, height: size.height };
      if (png.byteLength <= OG_MAX_BYTES) break;
    }
    return last ?? (await renderGenericOgImage());
  } catch {
    return renderGenericOgImage();
  }
}
