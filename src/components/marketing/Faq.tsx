// FAQ as native <details> — no client JS.
import { faqItems } from "@/lib/marketing/faq";

export function Faq() {
  return (
    <section aria-labelledby="faq-heading" data-testid="section-faq" className="flex flex-col gap-6">
      <h2 id="faq-heading" className="type-h1 text-foreground">
        Questions
      </h2>
      <div className="divide-y divide-border rounded-2xl border border-border bg-card shadow-card">
        {faqItems().map((item) => (
          <details key={item.id} className="group px-4" data-testid={`faq-${item.id}`}>
            <summary className="-mx-4 flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-4 py-3 font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
              <span>{item.question}</span>
              <span
                aria-hidden="true"
                className="text-xl leading-none text-accent-strong transition group-open:rotate-45 motion-reduce:transition-none"
              >
                +
              </span>
            </summary>
            <div className="flex flex-col gap-2 pb-4 type-small text-muted-foreground">
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
