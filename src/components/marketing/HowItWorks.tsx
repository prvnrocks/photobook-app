// "How it works" row under the hero bookshelf (M14 mockup): line icon + title, one short line each.
import { Images, Share, Sparkles } from "lucide-react";
import { HOW_IT_WORKS } from "@/lib/marketing/copy";

const ICONS = { upload: Images, ai: Sparkles, share: Share } as const;

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-heading" data-testid="section-how" className="flex scroll-mt-20 flex-col items-center gap-6 pt-6 sm:pt-10">
      <h2 id="how-heading" className="type-h1 text-foreground sm:text-[2.5rem] sm:leading-tight">
        How it works
      </h2>
      <ol className="grid w-full gap-5 sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-border">
        {HOW_IT_WORKS.map((step) => {
          const Icon = ICONS[step.icon];
          return (
            <li key={step.title} className="flex items-start gap-4 sm:flex-col sm:items-center sm:gap-3 sm:px-5 sm:text-center lg:flex-row lg:items-start lg:justify-center lg:gap-4 lg:text-start">
              <Icon aria-hidden="true" className="mt-0.5 size-8 shrink-0 stroke-[1.25] text-foreground" />
              <div className="flex min-w-0 flex-col gap-1">
                <h3 className="text-lg font-medium text-foreground sm:text-xl">{step.title}</h3>
                <p className="type-small text-muted-foreground">{step.text}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
