import { HOW_IT_WORKS } from "@/lib/marketing/copy";

export function HowItWorks() {
  return (
    <section aria-labelledby="how-heading" data-testid="section-how" className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <p className="type-eyebrow">Three steps</p>
        <h2 id="how-heading" className="type-h1 text-foreground">
          How it works
        </h2>
      </div>
      <ol className="grid gap-4 sm:grid-cols-3">
        {HOW_IT_WORKS.map((step, i) => (
          <li key={step.title} className="flex gap-4 rounded-2xl border border-border bg-card p-5 shadow-card sm:flex-col">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary font-display text-lg font-semibold text-accent-strong lining-nums"
            >
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="type-h2 text-foreground">{step.title}</h3>
              <p className="type-small text-muted-foreground">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
