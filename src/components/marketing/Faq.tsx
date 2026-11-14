// FAQ as native <details> — no client JS. M15 "Confetti": rounded white cards, pink plus badge.
import { faqItems } from "@/lib/marketing/faq";

export function Faq() {
  return (
    <section aria-labelledby="faq-heading" data-testid="section-faq" className="grid gap-8 sm:gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start lg:gap-16">
      <h2 id="faq-heading" className="lg:sticky lg:top-28 font-brand text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] text-[#16121c] sm:text-6xl lg:text-7xl">
        Questions
      </h2>
      <div className="flex flex-col gap-3">
        {faqItems().map((item) => (
          <details
            key={item.id}
            className="group rounded-[1.5rem] bg-white px-5 ring-1 ring-[#16121c]/12 open:bg-[#ffe8f4] open:ring-2 open:ring-[#16121c] sm:px-7"
            data-testid={`faq-${item.id}`}
          >
            <summary className="-mx-5 flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 rounded-[1.5rem] px-5 py-4 font-brand text-lg font-bold tracking-[-0.01em] text-[#16121c] outline-none focus-visible:ring-[3px] focus-visible:ring-[#16121c] focus-visible:ring-inset sm:-mx-7 sm:px-7 sm:text-xl [&::-webkit-details-marker]:hidden">
              <span>{item.question}</span>
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#d1006a] text-2xl leading-none font-medium text-white transition group-open:rotate-45 motion-reduce:transition-none"
              >
                +
              </span>
            </summary>
            <div className="flex flex-col gap-2 pb-5 text-base leading-relaxed text-[#4a3b4d]">
              {item.answer.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
