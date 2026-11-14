// FAQ as native <details> — no client JS. M16 "Emerald & gold": ivory rows with a hairline, a thin
// gold-ringed plus, a gold foil edge on the open row; deep emerald focus ring (10.28 on cream).
import { faqItems } from "@/lib/marketing/faq";
import { SECTION_LABELS } from "@/lib/marketing/copy";
import { SectionLabel } from "./SectionLabel";

export function Faq() {
  return (
    <section aria-labelledby="faq-heading" data-testid="section-faq" className="grid gap-8 sm:gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start lg:gap-16">
      <div className="flex flex-col items-start gap-5 lg:sticky lg:top-28">
        <SectionLabel>{SECTION_LABELS.faq}</SectionLabel>
        <h2 id="faq-heading" className="font-brand text-5xl leading-[0.95] font-light tracking-[-0.03em] text-[#0e3b2e] sm:text-6xl lg:text-7xl">
          Questions
        </h2>
      </div>
      <div className="flex flex-col gap-3">
        {faqItems().map((item) => (
          <details
            key={item.id}
            className="group relative overflow-hidden rounded-[0.6rem] bg-[#faf5ec] px-5 ring-1 ring-[#dccfb6] open:ring-[#c9a227]/70 sm:px-7"
            data-testid={`faq-${item.id}`}
          >
            <span aria-hidden="true" className="home-foil-v pointer-events-none absolute inset-y-0 left-0 hidden w-[2px] group-open:block" />
            <summary className="-mx-5 flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 rounded-[0.6rem] px-5 py-4 font-brand text-lg font-normal tracking-[-0.005em] text-[#1b1b1d] outline-none focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-inset sm:-mx-7 sm:px-7 sm:text-xl [&::-webkit-details-marker]:hidden">
              <span>{item.question}</span>
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-2xl leading-none font-light text-[#0e3b2e] ring-1 ring-[#c9a227] transition group-open:rotate-45 motion-reduce:transition-none"
              >
                +
              </span>
            </summary>
            <div className="flex flex-col gap-2 pb-5 text-base leading-relaxed text-[#4a4740]">
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
