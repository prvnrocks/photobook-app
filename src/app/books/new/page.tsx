// The book creation wizard (M19 D-071, M20 D-072): one continuous 7-step wizard on /books/new —
// 1 title → 2 purpose → 3 shape → 4 style → 5 photos → 6 sorting → 7 review → editor. The client
// changes step in place (pushState); this page only answers hard loads / refreshes:
//   /books/new?step=N            — new book (create mode), clamped to steps 1–4; the draft lives in
//                                  the client (sessionStorage mirror).
//   /books/new?book=<id>&step=N  — an existing draft (edit mode), prefilled from the book.
//     N = 5–7: loadWizardStep + its gate (resolveWizardStep, G2/G3) pick the step and its data:
//              user-edited → the editor; running rebuild → the classic build page (AI off runs
//              steps 6–7 like AI, M20b); another
//              step (e.g. 5 asked, the build is running → 6, finished → 7) → rendered directly.
//     N = 1–4: while the details can still change (D-070 rules) → steps 1–4; once locked → where the
//              gate sends the book (6 / 7 / editor / classic build).
//     Any N: a confirmed book (books.album_confirmed_at, "Generate album" ran — M20c) → the editor.

import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NewBookWizard, type NewBookWizardMode } from "@/components/books/NewBookWizard";
import { WIZARD_BACK_CLASS } from "@/components/wizard/WizardNav";
import { WizardShell } from "@/components/wizard/WizardShell";
import { resolveAiMode } from "@/lib/ai/client";
import { getCurrentUser } from "@/lib/auth/current-user";
import { bookDesignOf } from "@/lib/book/book-design";
import { OCCASIONS, type Occasion } from "@/lib/book/options";
import { docOrigin } from "@/lib/book/replaceable";
import { designLockReason, detailsLockReason } from "@/lib/book/setup";
import { loadWizardStep, type WizardDataStep, type WizardStepData } from "@/lib/books/wizard-data";
import { albumConfirmedOf, resolveWizardStep, type WizardTarget } from "@/lib/books/wizard-gate";
import { parseStep, type WizardDraft, type WizardStep } from "@/lib/books/wizard-steps";
import { getActiveRunForBook, hasAnyRunForBook } from "@/lib/db/agent-runs";
import { getMyBook, type MyBook } from "@/lib/db/books";
import { getMyProfile } from "@/lib/db/profiles";
import { defaultStyleFor, isFormDesignStyle } from "@/lib/design/defaults";
import { albumEditedByUser } from "@/lib/review/ui";
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

/** Hard load of step 5–7: the gate's step + its data (a second load when the gate moved the step). */
async function dataStep(
  book: MyBook,
  user: { id: string },
  requested: WizardDataStep,
  auto: boolean,
): Promise<{ step: WizardDataStep; data: WizardStepData }> {
  const data = await loadWizardStep(book.id, requested, { user, book, auto });
  if (!data) notFound();
  const target = stepOrRedirect(book.id, data.resolved);
  if (target === requested) return { step: requested, data };
  // The gate never answers 1–4 for a 5–7 request; be defensive anyway (→ 5).
  const step: WizardDataStep = target >= 5 ? (target as WizardDataStep) : 5;
  const moved = await loadWizardStep(book.id, step, { user, book, auto });
  if (!moved) notFound();
  if (moved.resolved === "editor" || moved.resolved === "classic") stepOrRedirect(book.id, moved.resolved);
  return { step, data: moved };
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

    let designLock: ReturnType<typeof designLockReason> = null;
    if (requested >= 5) {
      const loaded = await dataStep(book, user, requested as WizardDataStep, first(params.auto) === "1");
      initialStep = loaded.step;
      initialData = loaded.data;
      // Steps 1–4 of a book with a run are locked by the flow anyway; shown read-only if reached.
      designLock = designLockReason({ hasRun: loaded.step >= 6, doc: book.doc });
    } else {
      // Unknown (read error) → "no run", like the upload page; updateBookSetupAction re-checks anyway.
      const hasRun = await hasAnyRunForBook(book.id).catch(() => false);
      const detailsLock = detailsLockReason({ hasRun, doc: book.doc });
      if (detailsLock) {
        // Locked: steps 1–4 can't change any more → where the gate sends this book.
        const active = await getActiveRunForBook(book.id).then(
          (run) => ({ ok: true as const, run }),
          () => ({ ok: false as const, run: null }),
        );
        const target = resolveWizardStep({
          requested,
          hasRun,
          active: active.run !== null,
          activeTrigger: active.run ? (active.run.trigger === "rebuild" ? "rebuild" : "build") : null,
          readError: !active.ok,
          detailsLock,
          docOrigin: { generator: docOrigin(book.doc).generator, userEdited: albumEditedByUser(book.doc) },
          albumConfirmed: false, // confirmed books left above
          aiOn: resolveAiMode() !== "off",
        });
        const step = stepOrRedirect(book.id, target);
        redirect(step >= 5 ? `/books/new?book=${book.id}&step=${step}` : editorHref(book.id));
      }
      initialStep = requested;
      designLock = designLockReason({ hasRun, doc: book.doc });
    }

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
    // No book yet: steps 1–4 only. No caption-language question (D-072): createBookAction derives it
    // (title script: Arabic → ar, Latin → en; else memory → Accept-Language → en).
    mode = { kind: "create" };
    initialStep = Math.min(requested, 4) as WizardStep;
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
