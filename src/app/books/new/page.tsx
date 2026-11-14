// Book creation wizard, steps 1–4 (M19 T3/T4/T8, D-071): title → occasion → shape → style. The book
// is created on step-4 Continue (createBookAction → /books/<id>/upload = step 5).
//   /books/new?step=N            — new book; the draft lives in the client (sessionStorage mirror).
//   /books/new?book=<id>&step=N  — re-open steps 1–4 of an existing draft (step 5's Back): prefilled
//                                  from the book, saved with updateBookSetupAction. Only while its
//                                  details can change (D-070 rules); otherwise → the editor.
// The step changes client-side (pushState), so the client island renders the step header itself.

import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NewBookWizard, type NewBookWizardMode } from "@/components/books/NewBookWizard";
import { WIZARD_BACK_CLASS } from "@/components/wizard/WizardNav";
import { WizardShell } from "@/components/wizard/WizardShell";
import { getCurrentUser } from "@/lib/auth/current-user";
import { bookDesignOf } from "@/lib/book/book-design";
import { CAPTION_LANGS, OCCASIONS, type CaptionLang, type Occasion } from "@/lib/book/options";
import { designLockReason, detailsLockReason } from "@/lib/book/setup";
import { parseStep, type WizardDraft } from "@/lib/books/wizard-steps";
import { hasAnyRunForBook } from "@/lib/db/agent-runs";
import { getMyBook } from "@/lib/db/books";
import { getOwnMemoryView } from "@/lib/db/memory";
import { getMyProfile } from "@/lib/db/profiles";
import { defaultStyleFor, isFormDesignStyle } from "@/lib/design/defaults";
import { suggestCaptionLang } from "@/lib/design/infer";
import { isUuid } from "@/lib/uuid";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "New book" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function pick<T extends string>(v: string | null, values: readonly T[]): T | null {
  return (values as readonly string[]).includes(v ?? "") ? (v as T) : null;
}

async function acceptLanguage(): Promise<string> {
  try {
    return (await headers()).get("accept-language") ?? "";
  } catch {
    return "";
  }
}

export default async function NewBookPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const step = parseStep(params.step);
  const bookParam = first(params.book);

  const user = await getCurrentUser();
  if (!user) {
    const next = bookParam ? `/books/new?book=${encodeURIComponent(bookParam)}&step=${step}` : "/books/new";
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  const profilePromise = getMyProfile().catch(() => null);
  let mode: NewBookWizardMode;

  if (bookParam !== undefined) {
    // T8: re-open the wizard for an existing draft.
    const book = isUuid(bookParam) ? await getMyBook(bookParam) : null;
    if (!book) notFound();
    // Unknown (read error) → "no run", like the upload page; updateBookSetupAction re-checks anyway.
    const hasRun = await hasAnyRunForBook(book.id).catch(() => false);
    if (detailsLockReason({ hasRun, doc: book.doc })) redirect(`/books/${book.id}/edit`);

    const occasion = pick<Occasion>(book.occasion, OCCASIONS);
    const design = bookDesignOf(book);
    const draft: WizardDraft = {
      title: book.title ?? "",
      occasion,
      captionLang: pick<CaptionLang>(book.caption_lang, CAPTION_LANGS) ?? "en",
      format: design.format,
      designStyle: isFormDesignStyle(design.designStyle) ? design.designStyle : defaultStyleFor(occasion),
    };
    mode = { kind: "edit", bookId: book.id, draft, designLock: designLockReason({ hasRun, doc: book.doc }) };
  } else {
    // Best effort (D-032): a memory error must never block creating a book.
    const [memory, locale] = await Promise.all([getOwnMemoryView().catch(() => null), acceptLanguage()]);
    mode = { kind: "create", initialLang: suggestCaptionLang(locale, memory?.language) };
  }

  const profile = await profilePromise;
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;

  return (
    <WizardShell step={step} displayName={displayName} stepHeader="client" wide>
      <NewBookWizard
        initialStep={step}
        mode={mode}
        dashboardBack={
          <Link href="/dashboard" className={WIZARD_BACK_CLASS} data-testid="wizard-back">
            Back
          </Link>
        }
      />
    </WizardShell>
  );
}
