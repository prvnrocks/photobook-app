// "How it works" (M15 "Confetti"): three chunky rounded cards — number badge, icon, title, one line.
// Slight alternating tilt on wider screens; straight on phones and under reduced motion it never moves.
import { Images, Share, Sparkles } from "lucide-react";
import { HOW_IT_WORKS } from "@/lib/marketing/copy";

const ICONS = { upload: Images, ai: Sparkles, share: Share } as const;
const CARD_STYLE = [
  "bg-[#ffd1ea] sm:-rotate-[1.5deg]",
  "bg-white ring-2 ring-[#16121c] sm:translate-y-3 sm:rotate-[1deg]",
  "bg-[#ffd1ea] sm:-rotate-[0.75deg]",
] as const;

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-heading" data-testid="section-how" className="flex scroll-mt-24 flex-col items-center gap-8 pt-6 sm:gap-12 sm:pt-10">
      <h2 id="how-heading" className="text-center font-brand text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] text-[#16121c] sm:text-6xl lg:text-7xl">
        How it works
      </h2>
      <ol className="grid w-full gap-4 sm:grid-cols-3 sm:gap-5 lg:gap-7">
        {HOW_IT_WORKS.map((step, i) => {
          const Icon = ICONS[step.icon];
          return (
            <li key={step.title} className={`flex flex-col gap-4 rounded-[2rem] p-6 shadow-[0_5px_0_#16121c] sm:p-7 lg:p-8 ${CARD_STYLE[i % CARD_STYLE.length]}`}>
              <div className="flex items-center justify-between">
                <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-[#d1006a] font-brand text-2xl font-extrabold text-white">
                  {i + 1}
                </span>
                <Icon aria-hidden="true" className="size-8 stroke-[1.6] text-[#16121c]" />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <h3 className="font-brand text-2xl leading-tight font-bold tracking-[-0.02em] text-[#16121c] lg:text-[1.7rem]">{step.title}</h3>
                <p className="text-base leading-relaxed text-[#4a3b4d]">{step.text}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
