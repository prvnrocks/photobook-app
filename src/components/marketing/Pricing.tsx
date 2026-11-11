import { Check, X } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { CTA_HREF, CTA_LABEL } from "@/lib/marketing/copy";
import { plans } from "@/lib/marketing/plans";
import { cn } from "@/lib/utils";

export function Pricing() {
  return (
    <section aria-labelledby="pricing-heading" data-testid="section-pricing" className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <p className="type-eyebrow">Per book, not per month</p>
        <h2 id="pricing-heading" className="type-h1 text-foreground">
          Pricing
        </h2>
        <p className="type-body text-muted-foreground">Start free. Pay only for the books you want to keep — once.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {plans().map((plan) => (
          <div
            key={plan.id}
            data-testid={`plan-${plan.id}`}
            className={cn(
              "flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-card",
              plan.id === "paid" ? "border-primary ring-1 ring-primary" : "border-border",
            )}
          >
            <div className="flex flex-col gap-1">
              <h3 className="type-small font-semibold text-foreground">{plan.name}</h3>
              <p className="font-display text-4xl font-semibold text-foreground lining-nums" data-testid={`plan-${plan.id}-price`}>
                {plan.price}
              </p>
              <p className="type-small text-muted-foreground">{plan.priceNote}</p>
            </div>
            <ul className="flex flex-col gap-2 border-t border-border pt-4 type-small">
              {plan.features.map((f) => (
                <li key={f.key} className="flex gap-2" data-testid={`plan-${plan.id}-${f.key}`}>
                  {f.included ? (
                    <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <X aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className={cn(f.included ? "text-foreground" : "text-muted-foreground")}>{f.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {/* The hero holds the one accent CTA; this repeat is the navy primary. */}
      <Link href={CTA_HREF} className={cn(buttonVariants({ size: "cta" }), "sm:w-auto sm:self-start sm:px-8")}>
        {CTA_LABEL}
      </Link>
    </section>
  );
}
