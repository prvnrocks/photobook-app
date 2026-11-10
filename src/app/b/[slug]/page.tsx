// Public flipbook /b/[slug] (M6, D-039/D-040/D-041). Anyone with the link can open it; no auth.
// State machine from getViewerBook: not_found → 404, expired → ExpiredBook (owner CTAs),
// locked → PasswordGate (no title), unavailable → friendly message, ok → PublicViewer.
// The internal book id never reaches client props; only the owner's own editor link contains it.

import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { BookUnavailable } from "@/components/viewer/public/BookUnavailable";
import { ExpiredBook } from "@/components/viewer/public/ExpiredBook";
import { PasswordGate } from "@/components/viewer/public/PasswordGate";
import { PublicViewer } from "@/components/viewer/public/PublicViewer";
import { getSiteUrl } from "@/lib/auth/redirect";
import { APP_NAME } from "@/lib/brand";
import { isViewerOwner, type OgData, type ViewerBookResult } from "@/lib/db/public-books";
import { accessCookieName } from "@/lib/publish/access-cookie";
import { publicDocToRenderDoc } from "@/lib/publish/public-doc";
import { isValidSlug } from "@/lib/publish/slug";
import { isPaymentsEnabled } from "@/lib/stripe";
import { getOgDataCached, getViewerBookCached } from "@/lib/viewer/cached-reads";
import { buildBookMetadata } from "@/lib/viewer/metadata";

export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f5f5f5",
};

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  let og: OgData;
  try {
    og = await getOgDataCached(slug);
  } catch {
    og = { state: "unavailable", title: null, coverUrl: null, isPaid: false, publishedRev: null, hasPassword: false, captionLang: "en" };
  }
  return buildBookMetadata(slug, og);
}

export default async function PublicBookPage({ params }: Params) {
  const { slug } = await params;
  if (!isValidSlug(slug)) notFound();

  const accessCookie = (await cookies()).get(accessCookieName(slug))?.value ?? null;
  let result: ViewerBookResult;
  try {
    result = await getViewerBookCached(slug, accessCookie);
  } catch {
    return <BookUnavailable />;
  }
  const { bookId, book } = result;

  switch (book.state) {
    case "not_found":
      return notFound();
    case "expired": {
      const isOwner = bookId ? await isViewerOwner(bookId) : false;
      const owned = isOwner && bookId ? bookId : null;
      return (
        <ExpiredBook
          isOwner={isOwner}
          editorHref={owned ? `/books/${owned}/edit` : null}
          upgrade={owned ? { bookId: owned, returnTo: `/b/${slug}`, paymentsEnabled: isPaymentsEnabled() } : null}
        />
      );
    }
    case "locked":
      return <PasswordGate slug={slug} />;
    case "ok": {
      if (!book.doc) return <BookUnavailable />;
      const doc = publicDocToRenderDoc(book.doc);
      // Snapshot only (D-039): getViewerBook derives the title from the published cover title
      // (else APP_NAME) and captionLang from the snapshot — never the live books row.
      const title = book.title?.trim() || APP_NAME;
      // Password books: share text carries no title (D-040).
      const shareTitle = book.hasPassword ? `A photobook on ${APP_NAME}` : title;
      return (
        <PublicViewer
          slug={slug}
          doc={doc}
          photos={book.photos}
          captionLang={book.captionLang}
          title={title}
          isPaid={book.isPaid}
          shareUrl={`${getSiteUrl()}/b/${slug}`}
          shareTitle={shareTitle}
        />
      );
    }
    default:
      return <BookUnavailable />;
  }
}
