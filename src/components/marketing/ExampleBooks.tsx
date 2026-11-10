// Example flipbooks. Returns nothing when the list is empty (section hidden).
import Link from "next/link";
import type { ExampleBook } from "@/lib/marketing/examples";

export function ExampleBooks({ books }: { books: readonly ExampleBook[] }) {
  if (books.length === 0) return null;
  return (
    <section aria-labelledby="examples-heading" data-testid="section-examples" className="flex flex-col gap-6">
      <h2 id="examples-heading" className="font-heading text-2xl font-semibold tracking-tight">
        Flip through an example
      </h2>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {books.map((b) => (
          <li key={b.slug}>
            <Link href={`/b/${b.slug}`} className="group flex flex-col gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- small static cover, no optimiser needed */}
              <img
                src={b.coverSrc}
                alt=""
                loading="lazy"
                className="aspect-[148/210] w-full rounded-lg object-cover shadow-md ring-1 ring-black/5 transition group-hover:shadow-lg"
              />
              <span dir="auto" className="text-sm font-medium break-words">
                {b.title}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
