// Shown on the dashboard when the user has no books yet. M18: an empty library shelf in emerald &
// gold, three short steps, and the screen's one gold call to action ("Make your first book"; the
// header band shows no New book button then). M19 (D-071): the call to action opens the creation
// wizard (/books/new).
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button-variants";

/** Three emerald hard covers with gold foil on a shelf, the fourth slot a dashed "your book" outline. */
function ShelfArt() {
  return (
    <svg viewBox="0 0 260 150" className="h-auto w-full max-w-[16rem]" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="empty-foil" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#b8962a" />
          <stop offset="0.45" stopColor="#e6cf7a" />
          <stop offset="1" stopColor="#c9a227" />
        </linearGradient>
      </defs>
      <ellipse cx="130" cy="134" rx="118" ry="7" fill="#0e3b2e" opacity="0.08" />
      <rect x="10" y="126" width="240" height="6" rx="2" fill="#e5dccb" />
      {/* book 1: deep emerald, upright */}
      <rect x="34" y="40" width="38" height="86" rx="3" fill="#0e3b2e" />
      <rect x="34" y="40" width="5" height="86" rx="2" fill="#000" opacity="0.18" />
      <rect x="44" y="54" width="20" height="1.5" fill="url(#empty-foil)" />
      <rect x="44" y="110" width="20" height="1.5" fill="url(#empty-foil)" />
      <circle cx="54" cy="82" r="4" fill="none" stroke="url(#empty-foil)" strokeWidth="1.5" />
      {/* book 2: emerald, upright, taller */}
      <rect x="76" y="28" width="44" height="98" rx="3" fill="#1f6f54" />
      <rect x="76" y="28" width="5" height="98" rx="2" fill="#000" opacity="0.18" />
      <rect x="86" y="44" width="26" height="1.5" fill="url(#empty-foil)" />
      <rect x="90" y="50" width="18" height="1.5" fill="url(#empty-foil)" opacity="0.7" />
      <rect x="86" y="110" width="26" height="1.5" fill="url(#empty-foil)" />
      {/* book 3: leaning */}
      <g transform="rotate(12 146 126)">
        <rect x="128" y="46" width="34" height="80" rx="3" fill="#0e3b2e" />
        <rect x="128" y="46" width="5" height="80" rx="2" fill="#000" opacity="0.18" />
        <rect x="137" y="60" width="18" height="1.5" fill="url(#empty-foil)" />
        <rect x="137" y="112" width="18" height="1.5" fill="url(#empty-foil)" />
      </g>
      {/* the empty slot */}
      <rect x="184" y="40" width="50" height="86" rx="4" fill="#fffdf8" stroke="#c9a227" strokeWidth="1.5" strokeDasharray="5 4" />
      <path d="M209 72 v22 M198 83 h22" stroke="#7a5f0e" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const STEPS = [
  { n: "1", title: "Choose your photos", text: "Pick as many as you like — iPhone photos work too." },
  { n: "2", title: "We draft the album", text: "AI drops the blurry shots, groups moments and writes captions." },
  { n: "3", title: "Share the link", text: "Tweak anything, then send a flipbook on WhatsApp." },
] as const;

export function EmptyState() {
  return (
    <section
      data-testid="dashboard-empty"
      aria-labelledby="dashboard-empty-title"
      className="relative overflow-hidden rounded-3xl border border-border bg-card shadow-card"
    >
      <span aria-hidden="true" className="home-foil-h absolute inset-x-0 top-0 h-[3px]" />
      <div className="grid items-center gap-8 px-6 py-10 sm:px-10 sm:py-12 lg:grid-cols-[1.1fr_1fr] lg:gap-14 lg:px-14 lg:py-16">
        <div className="flex flex-col items-center text-center lg:items-start lg:text-start">
          <p className="type-eyebrow">Your shelf is ready</p>
          <h2 dir="auto" id="dashboard-empty-title" className="type-h1 mt-3 text-heading sm:text-[2.25rem]">
            No books yet
          </h2>
          <p dir="auto" className="type-body mt-3 max-w-md text-muted-foreground">
            Choose your photos and we&apos;ll lay out the first draft for you. Nothing is shared until you say so.
          </p>
          <div className="mt-7 flex w-full max-w-xs flex-col gap-2">
            <Link href="/books/new" className={buttonVariants({ variant: "accent", size: "cta" })} data-testid="create-first-book">
              Make your first book
            </Link>
          </div>
        </div>
        <div className="flex flex-col items-center gap-8">
          <ShelfArt />
          <ol className="grid w-full max-w-md gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="flex gap-3 rounded-2xl bg-background p-3.5 ring-1 ring-border sm:flex-col sm:gap-2 lg:flex-row xl:flex-col">
                <span
                  aria-hidden="true"
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary font-display text-sm font-semibold text-accent-strong"
                >
                  {s.n}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-heading">{s.title}</span>
                  <span className="text-xs leading-relaxed text-muted-foreground">{s.text}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
