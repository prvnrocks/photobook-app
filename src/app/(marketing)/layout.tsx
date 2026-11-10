// Public marketing + legal pages: shared header/footer. No session reads (stays static).
import type { Metadata } from "next";
import { SiteFooter } from "@/components/marketing/SiteFooter";
import { SiteHeader } from "@/components/marketing/SiteHeader";

const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();

export const metadata: Metadata = {
  // Absolute OG image URLs; Next falls back to VERCEL_URL / localhost when unset.
  ...(appUrl ? { metadataBase: new URL(appUrl) } : {}),
};

export default function MarketingLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      <SiteFooter />
    </div>
  );
}
