// Dev-only style board (M11 task 3, D-067): the app tokens and shared components next to real
// Classic and Modern <BookPage> thumbnails, for the user's sign-off. 404s in production builds
// (incl. Vercel previews, which run NODE_ENV=production). Screenshots: docs/design/m11-style-board-*.png.

import { notFound } from "next/navigation";
import { Ellipsis, Plus, Share2 } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ActionBar } from "@/components/app/ActionBar";
import { AppToast } from "@/components/app/AppToast";
import { EmptyState } from "@/components/app/EmptyState";
import { LoadingState } from "@/components/app/LoadingState";
import { Notice } from "@/components/app/Notice";
import { PageHeader } from "@/components/app/PageHeader";
import { PageSkeleton } from "@/components/app/Skeleton";
import { BookFonts } from "@/components/book/BookFonts";
import { BookPage } from "@/components/book/BookPage";
import { Button } from "@/components/ui/button";
import { CONTRAST_PAIRS, contrastRatio, PALETTE, paletteHex } from "@/lib/app/palette";
import { devPreviewDoc, devPreviewPhotos } from "@/lib/book/dev-preview";
import { devSampleDoc, devSamplePhotos } from "@/lib/book/dev-sample";
import type { RenderPhotos } from "@/lib/book/render";
import type { BookDoc } from "@/lib/book/types";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Style board (dev)" };

// Soft "photo-like" placeholders in the book palette (sky / sea / sand / dusk), so the thumbnails read
// like a real album instead of the saturated test grids. Same ids and pixel sizes as the fixtures.
const SCENES = [
  ["#2f3b55", "#8a6f7d", "#e2b48f"], // dusk
  ["#c9d6dc", "#8fb0bd", "#e8dcc6"], // sea
  ["#e9d8c2", "#c9a27e", "#5e4a3c"], // sand
  ["#dfe5df", "#9fb3a0", "#566b5c"], // garden
  ["#f0e3d0", "#d6b48f", "#a65a3f"], // terracotta
  ["#e7e2da", "#b9ada0", "#6b6257"], // stone
]
function scene(w: number, h: number, i: number): string {
  const [a, b, c] = SCENES[i % SCENES.length];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/>` +
    `<stop offset=".62" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/>` +
    `<circle cx="${w * 0.7}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.09}" fill="#fff" fill-opacity=".55"/>` +
    `<path d="M0 ${h * 0.78} Q ${w * 0.3} ${h * 0.66} ${w * 0.55} ${h * 0.75} T ${w} ${h * 0.7} V ${h} H 0 Z" fill="${c}" fill-opacity=".55"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
function softPhotos(src: RenderPhotos): RenderPhotos {
  const out: Record<string, RenderPhotos[string]> = {};
  Object.entries(src).forEach(([id, p], i) => {
    if (p) out[id] = { ...p, url: scene(p.width ?? 1200, p.height ?? 1600, i) };
  });
  return out;
}

function Section({ title, kicker, children, className }: { title: string; kicker?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("border-t border-border pt-8", className)}>
      {kicker ? <p className="type-eyebrow mb-1.5">{kicker}</p> : null}
      <h2 className="type-h2 mb-5 text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Swatch({ token, hex, role }: { token: string; hex: string; role: string }) {
  return (
    <li className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-2.5 shadow-card">
      <span className="size-11 shrink-0 rounded-lg border border-black/5" style={{ background: hex }} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">--{token}</span>
        <span className="block truncate text-xs text-muted-foreground">
          <span className="font-mono uppercase">{hex}</span> · {role}
        </span>
      </span>
    </li>
  );
}

function Chip({ tone, children }: { tone: "success" | "warn" | "neutral"; children: ReactNode }) {
  const cls =
    tone === "success"
      ? "border-success-border bg-success-soft text-success"
      : tone === "warn"
        ? "border-warning-border bg-warning-soft text-warning"
        : "border-border bg-muted text-muted-foreground";
  return <span className={cn("inline-flex h-6 items-center rounded-full border px-2.5 text-xs font-medium", cls)}>{children}</span>;
}

/** Illustrative dashboard card (the real one is task 8): cover thumbnail = a real <BookPage>. */
function SampleBookCard({ doc, photos, title, meta, chips }: { doc: BookDoc; photos: RenderPhotos; title: string; meta: string; chips: ReactNode }) {
  const landscape = doc.format === "A5_LANDSCAPE";
  return (
    <article className="flex gap-4 rounded-2xl border border-border bg-card p-3 shadow-card">
      <div className={cn("shrink-0 self-start overflow-hidden rounded-[3px] shadow-lift", landscape ? "w-28" : "w-20")}>
        <BookPage doc={doc} page="cover" mode="view" photos={photos} priority />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <h3 dir="auto" className="font-display text-lg leading-snug font-semibold text-foreground">
          {title}
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">{chips}</div>
        <div className="mt-auto flex items-center justify-end gap-1 pt-3">
          <Button variant="outline" size="touch">
            <Share2 data-icon="inline-start" aria-hidden="true" />
            Share
          </Button>
          <Button variant="ghost" size="touch" className="w-11 px-0" aria-label="More actions">
            <Ellipsis aria-hidden="true" />
          </Button>
        </div>
      </div>
    </article>
  );
}

function Thumb({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="min-w-0">
      {children}
      <figcaption className="mt-2 text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  );
}

const FOCUS_DEMO = "ring-2 ring-ring ring-offset-2 ring-offset-background";

export default function DevStyleBoard() {
  if (process.env.NODE_ENV === "production") notFound();
  const classic = devPreviewDoc();
  const classicPhotos = softPhotos(devPreviewPhotos());
  const modern = devSampleDoc("modern-portrait");
  const modernLand = devSampleDoc("modern-landscape");
  const modernPhotos = softPhotos(devSamplePhotos());

  return (
    <BookFonts>
      <main className="mx-auto flex max-w-wide flex-col gap-section px-gutter py-8 sm:px-8 sm:py-12" data-testid="dev-style-board">
        <PageHeader
          eyebrow="Photobook · M11 style board"
          title="Classic paper, modern clarity"
          description="App screens borrow the books' paper, ink and serif. Playfair Display for headings, Inter for reading, Cairo for Arabic. One terracotta call to action per screen."
          size="display"
        />

        <Section kicker="01" title="Type">
          <div className="grid gap-8 md:grid-cols-[1fr_1fr]">
            <div className="flex flex-col gap-4">
              <div>
                <p className="mb-1 font-mono text-[11px] text-muted-foreground">type-display · Playfair 36/40</p>
                <p className="type-display text-foreground">Our summer by the sea</p>
              </div>
              <div>
                <p className="mb-1 font-mono text-[11px] text-muted-foreground">type-h1 · Playfair 28</p>
                <p className="type-h1 text-foreground">Review your photos</p>
              </div>
              <div>
                <p className="mb-1 font-mono text-[11px] text-muted-foreground">type-h2 · Playfair 20</p>
                <p className="type-h2 text-foreground">Look of the book</p>
              </div>
              <div>
                <p className="mb-1 font-mono text-[11px] text-muted-foreground">type-eyebrow · Inter 12 caps</p>
                <p className="type-eyebrow">Wedding · 64 photos</p>
              </div>
              <div>
                <p className="mb-1 font-mono text-[11px] text-muted-foreground">type-body · Inter 16/26</p>
                <p className="type-body max-w-prose text-foreground">
                  We picked the sharpest shots, grouped them into moments and wrote a first caption for each. Change anything — your edits are never
                  overwritten.
                </p>
              </div>
              <div>
                <p className="mb-1 font-mono text-[11px] text-muted-foreground">type-small · Inter 14 · muted</p>
                <p className="type-small text-muted-foreground">Free books stay online for 30 days after you publish.</p>
              </div>
            </div>
            <div className="flex flex-col gap-4 self-start rounded-2xl border border-border bg-card p-5 shadow-card">
              <p className="type-eyebrow">Arabic (dir=&quot;auto&quot;, Cairo)</p>
              <p dir="auto" lang="ar" className="type-h1 text-foreground">
                رحلة العائلة إلى أبوظبي
              </p>
              <p dir="auto" lang="ar" className="type-body text-foreground">
                أجمل ليلة بدأت بضحكة، وانتهت بذكرى لا تُنسى.
              </p>
              <p dir="auto" className="type-h2 text-foreground">
                Eid with Teta · عيد سعيد ٢٠٢٦
              </p>
              <p className="type-small text-muted-foreground">
                Display headings fall through from Playfair to Cairo, so Arabic titles never land in a Latin fallback face.
              </p>
            </div>
          </div>
        </Section>

        <Section kicker="02" title="Colour">
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {PALETTE.map((p) => (
              <Swatch key={p.token} {...p} />
            ))}
          </ul>
          <h3 className="mt-8 mb-3 text-sm font-semibold text-foreground">Contrast (WCAG 2: text 4.5:1, UI parts 3:1)</h3>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
            <table className="w-full text-start text-sm">
              <thead className="bg-muted text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 text-start font-medium">
                    Pair
                  </th>
                  <th scope="col" className="px-3 py-2 text-end font-medium">
                    Ratio
                  </th>
                  <th scope="col" className="hidden px-3 py-2 text-end font-medium sm:table-cell">
                    Needs
                  </th>
                </tr>
              </thead>
              <tbody>
                {CONTRAST_PAIRS.map((p) => {
                  const r = contrastRatio(paletteHex(p.fg), paletteHex(p.bg));
                  return (
                    <tr key={p.use} className="border-t border-border" data-contrast={r.toFixed(2)}>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          <span
                            className="inline-flex h-6 w-9 shrink-0 items-center justify-center rounded border border-black/5 text-[11px] font-semibold"
                            style={{ background: paletteHex(p.bg), color: paletteHex(p.fg) }}
                            aria-hidden="true"
                          >
                            Aa
                          </span>
                          <span className="min-w-0">
                            <span className="block text-foreground">{p.use}</span>
                            <span className="block font-mono text-[11px] text-muted-foreground">
                              {p.fg} / {p.bg}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-end font-mono tabular-nums text-foreground">
                        {r.toFixed(2)}:1 <span className="text-success">✓</span>
                      </td>
                      <td className="hidden px-3 py-2 text-end text-muted-foreground sm:table-cell">{p.min}:1</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>

        <Section kicker="03" title="Buttons">
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap gap-2">
              <Button size="touch">Default</Button>
              <Button size="touch" variant="accent">
                Accent
              </Button>
              <Button size="touch" variant="outline">
                Outline
              </Button>
              <Button size="touch" variant="secondary">
                Secondary
              </Button>
              <Button size="touch" variant="ghost">
                Ghost
              </Button>
              <Button size="touch" variant="destructive">
                Delete
              </Button>
              <Button size="touch" variant="link">
                Link
              </Button>
            </div>
            <div>
              <p className="mb-2 text-xs text-muted-foreground">Keyboard focus (shown statically) and disabled</p>
              <div className="flex flex-wrap gap-3">
                <Button size="touch" className={FOCUS_DEMO}>
                  Focused
                </Button>
                <Button size="touch" variant="accent" className={FOCUS_DEMO}>
                  Focused
                </Button>
                <Button size="touch" variant="outline" className={FOCUS_DEMO}>
                  Focused
                </Button>
                <Button size="touch" disabled>
                  Disabled
                </Button>
              </div>
            </div>
            <div className="grid max-w-app gap-2">
              <p className="text-xs text-muted-foreground">size=&quot;cta&quot; (48 px, full width) — one per screen</p>
              <Button size="cta" variant="accent">
                Build my album
              </Button>
              <Button size="cta">Continue to editor</Button>
              <Button size="touch" variant="outline">
                <Plus data-icon="inline-start" aria-hidden="true" />
                Add more photos
              </Button>
            </div>
          </div>
        </Section>

        <Section kicker="04" title="Page header and steps">
          <div className="max-w-app rounded-2xl border border-border bg-background p-gutter shadow-card sm:p-6">
            <PageHeader
              back={{ href: "/dashboard", label: "My books" }}
              step="build"
              eyebrow="Wedding · 64 photos"
              title="Sara & Omar's wedding"
              description="We're choosing the best photos and grouping them into moments. This takes a minute or two."
            />
          </div>
        </Section>

        <Section kicker="05" title="Notices">
          <div className="grid max-w-app gap-3">
            <Notice tone="info" title="Keep this screen open">
              Your photos are uploading. Closing the tab pauses the upload.
            </Notice>
            <Notice tone="success" title="Album updated">
              Your changes are saved. Captions you wrote were kept.
            </Notice>
            <Notice tone="warn" title="Free book">
              The link works for 30 days after you publish. Upgrade for a permanent link and a PDF.
            </Notice>
            <Notice
              tone="error"
              title="We couldn't finish the AI album"
              action={
                <Button size="touch" variant="outline">
                  Try AI again
                </Button>
              }
            >
              Your photos are safe. We made a simple album for you to start from.
            </Notice>
          </div>
        </Section>

        <Section kicker="06" title="Empty, loading and toast">
          <div className="grid gap-6 md:grid-cols-2">
            <EmptyState
              className="md:self-start"
              title="Your first book starts here"
              description="Pick an occasion, add your photos and we'll lay out the pages for you."
              action={
                <Button size="cta" variant="accent">
                  <Plus data-icon="inline-start" aria-hidden="true" />
                  New book
                </Button>
              }
            />
            <div className="flex flex-col gap-5">
              <div className="rounded-2xl border border-border bg-card p-4 shadow-card">
                <LoadingState label="Preparing your PDF…" description="Usually under a minute. You can keep editing." />
              </div>
              <PageSkeleton cards={1} />
              <AppToast inline message="Link copied" tone="success" />
            </div>
          </div>
        </Section>

        <Section kicker="07" title="Next-step bar">
          <div className="max-w-app rounded-2xl border border-border bg-background p-gutter shadow-card">
            <p className="type-small mb-4 text-muted-foreground">Sticks to the bottom on phones; sits inline from 640 px.</p>
            <ActionBar sticky={false} label="Next step">
              <Button size="cta">Continue to editor</Button>
              <Button size="touch" variant="ghost" className="sm:h-12">
                Rebuild with AI
              </Button>
            </ActionBar>
          </div>
        </Section>

        <Section kicker="08" title="Matches the books">
          <div className="grid gap-8 lg:grid-cols-[22rem_1fr]">
            <div className="flex flex-col gap-3">
              <SampleBookCard
                doc={classic}
                photos={classicPhotos}
                title="Sara & Omar"
                meta="A5 portrait · Classic · 18 pages"
                chips={
                  <>
                    <Chip tone="success">Live</Chip>
                    <Chip tone="warn">Free · link expires 10 Dec</Chip>
                  </>
                }
              />
              <SampleBookCard
                doc={modernLand}
                photos={modernPhotos}
                title="رحلة العائلة إلى أبوظبي"
                meta="A5 landscape · Modern · 26 pages"
                chips={<Chip tone="neutral">Draft</Chip>}
              />
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Thumb label="Classic · cover">
                <div className="shadow-lift">
                  <BookPage doc={classic} page="cover" mode="view" photos={classicPhotos} priority />
                </div>
              </Thumb>
              <Thumb label="Classic · page">
                <div className="shadow-lift">
                  <BookPage doc={classic} page={1} mode="view" photos={classicPhotos} priority />
                </div>
              </Thumb>
              <Thumb label="Modern · cover">
                <div className="shadow-lift">
                  <BookPage doc={modern} page="cover" mode="view" photos={modernPhotos} captionLang="en" priority />
                </div>
              </Thumb>
              <Thumb label="Modern · page">
                <div className="shadow-lift">
                  <BookPage doc={modern} page={0} mode="view" photos={modernPhotos} captionLang="en" priority />
                </div>
              </Thumb>
            </div>
          </div>
        </Section>
      </main>
    </BookFonts>
  );
}
