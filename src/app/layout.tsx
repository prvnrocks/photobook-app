import type { Metadata, Viewport } from "next";
import { Cairo, Inter, Playfair_Display, Tajawal } from "next/font/google";
import "./globals.css";
// --- analytics (M9 T14, D-058) ---
import { Analytics } from "@/components/analytics/Analytics";
import { analyticsEnabled } from "@/lib/analytics/flash";
// --- end analytics ---

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const cairo = Cairo({
  variable: "--font-cairo",
  subsets: ["arabic", "latin"],
  display: "swap",
});

// Default Latin caption / cover font (src/lib/book/fonts.ts → "Playfair").
const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  display: "swap",
});

const tajawal = Tajawal({
  variable: "--font-tajawal",
  subsets: ["arabic"],
  weight: ["400", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Photobook",
  description:
    "Upload your photos, let AI build the album, and share it as a flipbook link.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#fbf8f2",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${cairo.variable} ${tajawal.variable} ${playfair.variable}`}
    >
      <body className="antialiased">
        {children}
        {/* analytics (M9 T14): renders nothing; no-op without NEXT_PUBLIC_POSTHOG_KEY */}
        {analyticsEnabled() ? <Analytics /> : null}
      </body>
    </html>
  );
}
