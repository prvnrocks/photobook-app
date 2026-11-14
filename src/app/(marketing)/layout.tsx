// Public marketing + legal pages: shared header/footer. No session reads (stays static).
// theme-home (globals.css) maps the M15 "Confetti" palette onto the app tokens for these pages only.
// The display faces are loaded here only, so app screens, the book render and print never download them.
import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque } from "next/font/google";
import localFont from "next/font/local";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteHeader } from "@/components/marketing/SiteHeader";

const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();

// Variable font with the optical-size axis: at headline sizes the browser picks opsz 96 (chunky,
// tight), smaller headings get a calmer cut automatically (font-optical-sizing: auto).
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  axes: ["opsz"],
  display: "swap",
});

// Arabic display for the Arabic sample book (same file the book fonts use; Next dedupes the asset).
// No fallback face: next/font's adjusted fallback has Arabic glyphs and would mask Cairo.
const lalezar = localFont({
  variable: "--font-lalezar-home",
  src: [{ path: "../../components/print/fonts/Lalezar-400.woff2", weight: "400", style: "normal" }],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
});

export const metadata: Metadata = {
  // Absolute OG image URLs; Next falls back to VERCEL_URL / localhost when unset.
  ...(appUrl ? { metadataBase: new URL(appUrl) } : {}),
};

export const viewport: Viewport = {
  themeColor: "#ffd1ea",
};

export default function MarketingLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className={`theme-home ${bricolage.variable} ${lalezar.variable} flex min-h-dvh flex-col bg-background text-foreground`}>
      <SiteHeader />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      <SiteFooter />
    </div>
  );
}
