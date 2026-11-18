// The book creation wizard (M19 D-071, M20 D-072; Task 5 order): one continuous 7-step wizard on
// /books/new — 1 title → 2 occasion → 3 photos → 4 story → 5 design → 6 create → 7 preview → editor.
// The client changes step in place (pushState); this page only answers hard loads / refreshes:
//   /books/new?step=N            — new book (create mode), clamped to steps 1–2; the draft lives in
//                                  the client (sessionStorage mirror). The book is created on step-2
//                                  Continue.
//   /books/new?book=<id>&step=N  — an existing book (edit mode), prefilled from the book. The step
//     comes from the book's SERVER state, not from the number alone (loadWizardStep + its gate,
//     resolveWizardStep, G2/G3) — so a link bookmarked under the old numbering still opens somewhere
//     sensible:
//     N = 1–5: one read (the Photos step's data, gated for N): no photos yet → 1–3 as asked, 4–5 → 3;
//              photos in → 3–5 as asked, 1–2 → 3 (locked); a build is running → 6; finished → 7.
//     N = 6–7: that step's data + gate (5 → 6 → 7 as the build goes).
//     Any N: user-edited or confirmed (books.album_confirmed_at, "Generate album" ran — M20c) → the
//     editor; a running rebuild → the classic build page.
//   Story answers and the design recommendation are loaded by their steps (story-actions.ts); the
//   design choice itself is the book's format / design_style, sent in the draft below.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NewBookWizard, type NewBookWizardMode } from "@/components/books/NewBookWizard";
import { WIZARD_BACK_CLASS } from "@/components/wizard/WizardNav";
import { WizardShell } from "@/components/wizard/WizardShell";
import { getCurrentUser } from "@/lib/auth/current-user";
import { bookDesignOf } from "@/lib/book/book-design";
import { OCCASIONS, type Occasion } from "@/lib/book/options";
import { designLockReason } from "@/lib/book/setup";
import { loadWizardStep, type WizardOpenStep, type WizardStepData } from "@/lib/books/wizard-data";
import { albumConfirmedOf, type WizardTarget } from "@/lib/books/wizard-gate";
import { parseStep, type WizardDraft, type WizardStep } from "@/lib/books/wizard-steps";
import { getMyBook, type MyBook } from "@/lib/db/books";
import { getMyProfile } from "@/lib/db/profiles";
import { defaultStyleFor, isFormDesignStyle } from "@/lib/design/defaults";
import { isUuid } from "@/lib/uuid";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "New book" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function pick<T extends string>(v: string | null, values: readonly T[]): T | null {
  return (values as readonly string[]).includes(v ?? "") ? (v as T) : null;
}

const editorHref = (id: string) => `/books/${id}/edit`;
const classicBuildHref = (id: string) => `/books/${id}/build`;

/** Leaves the wizard for a non-step gate answer; returns the step otherwise. */
function stepOrRedirect(bookId: string, target: WizardTarget): WizardStep {
  if (target === "editor") redirect(editorHref(bookId));
  if (target === "classic") redirect(classicBuildHref(bookId));
  return target;
}

/**
 * Hard load with a book: the gate's step + the data it needs. Steps 1–5 are gated from the Photos
 * step's reads (its data is handed to the wizard: the photo count locks steps 1–2 and step 3 opens
 * without a fetch); when the gate moves the book to 6 / 7 that step's data is loaded instead.
 */
async function resolveBookStep(
  book: MyBook,
  user: { id: string },
  requested: WizardStep,
  auto: boolean,
): Promise<{ step: WizardStep; data: WizardStepData }> {
  let ask: 3 | 6 | 7 = requested >= 6 ? (requested as 6 | 7) : 3;
  let target: WizardTarget = requested;
  let data: WizardStepData | null = null;
  // At most: the asked step, then the step the gate moved it to (3 → 6 → 7 can't loop back).
  for (let i = 0; i < 3; i++) {
    data = await loadWizardStep(book.id, ask, {
      user,
      book,
      auto,
      requestedStep: ask === 3 && requested <= 5 ? (requested as WizardOpenStep) : undefined,
    });
    if (!data) notFound();
    target = stepOrRedirect(book.id, data.resolved);
    const needs: 3 | 6 | 7 = target >= 6 ? (target as 6 | 7) : 3;
    if (needs === ask) break;
    ask = needs;
  }
  if (!data) notFound();
  return { step: target as WizardStep, data };
}

export default async function NewBookPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const requested = parseStep(params.step);
  const bookParam = first(params.book);

  const user = await getCurrentUser();
  if (!user) {
    const next = bookParam ? `/books/new?book=${encodeURIComponent(bookParam)}&step=${requested}` : "/books/new";
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }

  const profilePromise = getMyProfile().catch(() => null);
  let mode: NewBookWizardMode;
  let initialStep: WizardStep;
  let initialData: WizardStepData | null = null;

  if (bookParam !== undefined) {
    const book = isUuid(bookParam) ? await getMyBook(bookParam) : null;
    if (!book) notFound();
    // M20c: "Generate album" ran → this book never shows the wizard again (any step, 1–7).
    if (albumConfirmedOf(book.album_confirmed_at)) redirect(editorHref(book.id));

    const loaded = await resolveBookStep(book, user, requested, first(params.auto) === "1");
    initialStep = loaded.step;
    initialData = loaded.data;
    // Steps ≤ 5 of a book with a run are locked by the flow anyway; shown read-only if reached.
    const designLock = designLockReason({ hasRun: loaded.step >= 6, doc: book.doc });

    const occasion = pick<Occasion>(book.occasion, OCCASIONS);
    const design = bookDesignOf(book);
    const draft: WizardDraft = {
      title: book.title ?? "",
      occasion,
      format: design.format,
      designStyle: isFormDesignStyle(design.designStyle) ? design.designStyle : defaultStyleFor(occasion),
    };
    mode = { kind: "edit", bookId: book.id, draft, designLock };
  } else {
    // No book yet: steps 1–2 only (a ?step=3…7 without ?book= — e.g. an old bookmark — starts at 2 and
    // the client moves it to the first unanswered step). No caption-language question (D-072):
    // createBookAction derives it (title script: Arabic → ar, Latin → en; else memory → Accept-Language → en).
    mode = { kind: "create" };
    initialStep = Math.min(requested, 2) as WizardStep;
  }

  const profile = await profilePromise;
  const displayName = profile?.name ?? profile?.email ?? user.email ?? null;

  return (
    <WizardShell displayName={displayName}>
      {/* One constant key (M20 T6): the wizard goes create → edit in place, and a server action's
          revalidation re-renders this page at the current (edit) URL — a mode key would remount it
          mid-flow. NewBookWizard's mode guard reloads when the server sends another book or a fresh
          create wizard, so an existing book's answers never carry into a new one (M19 BUG-3). */}
      <NewBookWizard
        key="new-book-wizard"
        initialStep={initialStep}
        mode={mode}
        initialData={initialData}
        dashboardBack={
          <Link href="/dashboard" className={WIZARD_BACK_CLASS} data-testid="wizard-back">
            Back
          </Link>
        }
      />
    </WizardShell>
  );
}
