"use client";
// Book preview card for the home bookshelf (M14). Native <dialog> (modal: focus stays inside, the
// page behind is inert, Esc closes); the card grows out of the shelf cover with a slight tilt
// (Web Animations API, FLIP from the cover's rect) and shrinks back on close. Reduced motion: fades.
import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { CTA_NOTE } from "@/lib/marketing/copy";
import { SHELF_FILTERS, type ShelfBook } from "@/lib/marketing/shelf";
import { ShelfCover } from "./ShelfCover";

const EASE_OUT = "cubic-bezier(0.2, 0.9, 0.25, 1.04)";

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Transform that maps the card's rect onto the origin rect (FLIP "first"), tilted like a lifted card. */
function fromTransform(card: DOMRect, origin: DOMRect | null) {
  if (!origin) return "translateY(24px) scale(0.92) rotate(-2deg)";
  const s = Math.max(0.15, Math.min(origin.width / card.width, origin.height / card.height));
  const dx = origin.left + origin.width / 2 - (card.left + card.width / 2);
  const dy = origin.top + origin.height / 2 - (card.top + card.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${s}) rotate(-4deg)`;
}

export function ShelfPreview({
  book,
  open,
  originEl,
  onClose,
  cta,
}: {
  book: ShelfBook;
  open: boolean;
  originEl: () => Element | null;
  onClose: () => void;
  /** "Make a book like this" link, rendered by the server page (keeps Link/cva out of this island). */
  cta: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const titleId = useId();
  const category = SHELF_FILTERS.find((f) => f.id === book.category)?.label ?? "";

  useEffect(() => {
    const dialog = dialogRef.current;
    const card = cardRef.current;
    const backdrop = backdropRef.current;
    if (!open || !dialog || !card || !backdrop || dialog.open) return;
    closing.current = false;
    dialog.showModal();
    document.documentElement.style.overflow = "hidden";
    if (reducedMotion()) {
      card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
      return;
    }
    const origin = originEl()?.getBoundingClientRect() ?? null;
    const first = fromTransform(card.getBoundingClientRect(), origin);
    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 380, easing: "ease-out" });
    card.animate(
      [
        { transform: first, opacity: 0.4, offset: 0 },
        { transform: "rotate(-1.2deg) scale(1.01)", opacity: 1, offset: 0.7 },
        { transform: "none", opacity: 1, offset: 1 },
      ],
      { duration: 620, easing: EASE_OUT },
    );
    card.querySelectorAll<HTMLElement>("[data-reveal]").forEach((el, i) =>
      el.animate(
        [
          { opacity: 0, transform: "translateY(8px)" },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: 360,
          delay: 260 + i * 60,
          easing: "ease-out",
          fill: "backwards",
        },
      ),
    );
  }, [open, originEl]);

  useEffect(() => () => void (document.documentElement.style.overflow = ""), []);

  async function close() {
    const dialog = dialogRef.current;
    const card = cardRef.current;
    const backdrop = backdropRef.current;
    if (!dialog?.open || closing.current) return;
    closing.current = true;
    if (card && backdrop && !reducedMotion()) {
      const to = fromTransform(card.getBoundingClientRect(), originEl()?.getBoundingClientRect() ?? null);
      backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: "ease-in", fill: "forwards" });
      await card
        .animate(
          [
            { transform: "none", opacity: 1 },
            { transform: to, opacity: 0 },
          ],
          { duration: 340, easing: "cubic-bezier(0.4, 0, 0.7, 0.2)", fill: "forwards" },
        )
        .finished.catch(() => undefined);
    }
    dialog.close();
    card?.getAnimations().forEach((a) => a.cancel());
    backdrop?.getAnimations().forEach((a) => a.cancel());
    document.documentElement.style.overflow = "";
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      data-testid="shelf-preview"
      onCancel={(e) => {
        e.preventDefault();
        void close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) void close();
      }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto bg-transparent p-0 text-foreground backdrop:bg-transparent open:flex open:items-center open:justify-center"
    >
      {open ? (
        <>
          <div
            ref={backdropRef}
            aria-hidden="true"
            className="fixed inset-0 bg-[#26221E]/55 backdrop-blur-[2px]"
            onClick={() => void close()}
          />
          <div
            ref={cardRef}
            className="relative m-4 grid w-full max-w-3xl gap-5 rounded-2xl bg-background p-5 pt-12 shadow-[0_30px_80px_-20px_rgb(38_34_30/0.55)] sm:p-8 sm:pt-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-center md:gap-8"
          >
            <button
              type="button"
              autoFocus
              aria-label="Close"
              data-testid="shelf-preview-close"
              onClick={() => void close()}
              className="absolute top-2 right-2 flex size-11 items-center justify-center rounded-full text-foreground outline-none hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
            <div className="mx-auto aspect-[362/419] w-[min(62vw,15rem)] sm:w-[min(60vw,19rem)] md:w-full md:max-w-[21rem]">
              <ShelfCover book={book} priority />
            </div>
            <div className="flex min-w-0 flex-col gap-3 text-center md:text-start">
              <p data-reveal className="type-eyebrow">{`${category} · sample book`}</p>
              <h2 data-reveal id={titleId} className="font-display text-3xl font-semibold break-words text-foreground sm:text-4xl">
                <span dir="auto">{book.title}</span>
              </h2>
              <p data-reveal className="type-body text-muted-foreground">
                {book.blurb}
              </p>
              <div data-reveal className="flex flex-col gap-2 pt-2">
                {cta}
                <p className="type-small text-muted-foreground">{CTA_NOTE}</p>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
