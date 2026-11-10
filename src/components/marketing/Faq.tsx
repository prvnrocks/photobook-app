// FAQ as native <details> — no client JS.
import { faqItems } from "@/lib/marketing/faq";

export function Faq() {
  return (
    <section aria-labelledby="faq-heading" data-testid="section-faq" className="flex flex-col gap-6">
      <h2 id="faq-heading" className="font-heading text-2xl font-semibold tracking-tight">
        Questions
      </h2>
      <div className="divide-y rounded-2xl border bg-card">
        {faqItems().map((item) => (
          <details key={item.id} className="group px-4" data-testid={`faq-${item.id}`}>
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 py-3 font-medium [&::-webkit-details-marker]:hidden">
              <span>{item.question}</span>
              <span aria-hidden="true" className="text-xl leading-none text-muted-foreground transition group-open:rotate-45">
                +
              </span>
            </summary>
            <div className="flex flex-col gap-2 pb-4 text-sm text-muted-foreground">
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
