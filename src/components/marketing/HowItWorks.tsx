import { HOW_IT_WORKS } from "@/lib/marketing/copy";

export function HowItWorks() {
  return (
    <section aria-labelledby="how-heading" data-testid="section-how" className="flex flex-col gap-6">
      <h2 id="how-heading" className="font-heading text-2xl font-semibold tracking-tight">
        How it works
      </h2>
      <ol className="grid gap-4 sm:grid-cols-3">
        {HOW_IT_WORKS.map((step, i) => (
          <li key={step.title} className="flex gap-4 rounded-xl border bg-card p-4 sm:flex-col">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
            >
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="font-semibold">{step.title}</h3>
              <p className="text-sm text-muted-foreground">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
