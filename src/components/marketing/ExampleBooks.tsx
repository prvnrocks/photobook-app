// Example flipbooks. Returns nothing when the list is empty (section hidden).
import Link from "next/link";
import type { ExampleBook } from "@/lib/marketing/examples";

export function ExampleBooks({ books }: { books: readonly ExampleBook[] }) {
  if (books.length === 0) return null;
  return (
    <section aria-labelledby="examples-heading" data-testid="section-examples" className="flex flex-col gap-6">
      <h2 id="examples-heading" className="type-h1 text-foreground">
        Flip through an example
      </h2>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {books.map((b) => (
          <li key={b.slug}>
            <Link href={`/b/${b.slug}`} className="group flex flex-col gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
              {/* eslint-disable-next-line @next/next/no-img-element -- small static cover, no optimiser needed */}
              <img
                src={b.coverSrc}
                alt=""
                loading="lazy"
                className="aspect-[148/210] w-full rounded-sm object-cover shadow-card ring-1 ring-black/5 transition group-hover:shadow-lift"
              />
              <span dir="auto" className="font-display text-base font-semibold break-words text-foreground">
                {b.title}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
