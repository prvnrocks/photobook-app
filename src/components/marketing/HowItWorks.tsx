// "How it works" (M16 "Emerald & gold"): three emerald cards like the reference business card — a gold
// foil frame, the step number in a gold ring, cream title and line (cream on #1F6F54: 5.00:1).
import { Images, Share, Sparkles } from "lucide-react";
import { HOW_IT_WORKS, SECTION_LABELS } from "@/lib/marketing/copy";
import { SectionLabel } from "./SectionLabel";

const ICONS = { upload: Images, ai: Sparkles, share: Share } as const;

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-heading" data-testid="section-how" className="flex scroll-mt-24 flex-col items-center gap-8 pt-6 sm:gap-12 sm:pt-10">
      <div className="flex flex-col items-center gap-5">
        <SectionLabel align="center">{SECTION_LABELS.how}</SectionLabel>
        <h2 id="how-heading" className="text-center font-brand text-5xl leading-[0.95] font-light tracking-[-0.03em] text-[#0e3b2e] sm:text-6xl lg:text-7xl">
          How it works
        </h2>
      </div>
      <ol className="grid w-full gap-4 sm:grid-cols-3 sm:gap-5 lg:gap-7">
        {HOW_IT_WORKS.map((step, i) => {
          const Icon = ICONS[step.icon];
          return (
            <li key={step.title} className="relative flex flex-col gap-5 rounded-[0.6rem] bg-[#1f6f54] p-7 text-[#f2e8d8] shadow-[0_24px_40px_-28px_rgb(14_59_46/0.9)] lg:p-9">
              <span aria-hidden="true" className="pointer-events-none absolute inset-[6px] rounded-[0.35rem] border border-[#c9a227]/55" />
              <div className="flex items-center justify-between">
                <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-full font-brand text-lg font-normal ring-1 ring-[#c9a227]">
                  {i + 1}
                </span>
                <Icon aria-hidden="true" className="size-7 stroke-[1.3]" />
              </div>
              <span aria-hidden="true" className="home-foil-h block h-px w-10" />
              <div className="flex min-w-0 flex-col gap-2">
                <h3 className="font-brand text-2xl leading-tight font-normal tracking-[-0.01em] lg:text-[1.7rem]">{step.title}</h3>
                <p className="text-base leading-relaxed">{step.text}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
