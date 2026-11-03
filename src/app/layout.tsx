import type { Metadata, Viewport } from "next";
import { Cairo, Inter, Tajawal } from "next/font/google";
import "./globals.css";

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
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${cairo.variable} ${tajawal.variable}`}
    >
      <body className="antialiased">{children}</body>
    </html>
  );
}
