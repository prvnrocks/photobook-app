import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <main className="mx-auto flex w-full max-w-md min-w-0 flex-1 flex-col gap-8 px-4 py-12 sm:px-6">
        <section className="flex flex-col gap-4">
          <h1
            data-testid="hero-heading"
            className="font-heading text-3xl font-semibold tracking-tight break-words"
          >
            Turn your photos into a beautiful book
          </h1>
          <p className="text-base text-muted-foreground">
            Upload your photos, our AI builds the album, and you share it as a
            flipbook link anyone can open.
          </p>
          <Link
            href="/login"
            data-testid="cta-create"
            className={cn(buttonVariants({ size: "lg" }), "h-11 w-full px-4 text-base sm:w-auto sm:self-start")}
          >
            Create your book
          </Link>
        </section>

        <section
          aria-label="Sample captions"
          className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground"
        >
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Sample captions
          </p>
          <p dir="auto" className="text-lg break-words">
            Golden hour on the Corniche, just the two of us.
          </p>
          <p
            dir="auto"
            lang="ar"
            data-testid="sample-caption-ar"
            className="font-arabic text-lg break-words"
          >
            أجمل الذكريات تبدأ بصورة
          </p>
        </section>
      </main>

      <footer className="mx-auto w-full max-w-md px-4 py-6 text-center text-sm text-muted-foreground sm:px-6">
        Made in Abu Dhabi
      </footer>
    </div>
  );
}
