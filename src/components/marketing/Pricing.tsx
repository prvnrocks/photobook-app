import { Check, X } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { CTA_HREF, CTA_LABEL } from "@/lib/marketing/copy";
import { plans } from "@/lib/marketing/plans";
import { cn } from "@/lib/utils";

export function Pricing() {
  return (
    <section aria-labelledby="pricing-heading" data-testid="section-pricing" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 id="pricing-heading" className="font-heading text-2xl font-semibold tracking-tight">
          Pricing
        </h2>
        <p className="text-muted-foreground">Start free. Pay only for the books you want to keep — once.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {plans().map((plan) => (
          <div
            key={plan.id}
            data-testid={`plan-${plan.id}`}
            className={cn(
              "flex flex-col gap-4 rounded-2xl border bg-card p-5",
              plan.id === "paid" && "border-primary ring-1 ring-primary",
            )}
          >
            <div className="flex flex-col gap-1">
              <h3 className="font-semibold">{plan.name}</h3>
              <p className="text-3xl font-semibold tracking-tight" data-testid={`plan-${plan.id}-price`}>
                {plan.price}
              </p>
              <p className="text-sm text-muted-foreground">{plan.priceNote}</p>
            </div>
            <ul className="flex flex-col gap-2 text-sm">
              {plan.features.map((f) => (
                <li key={f.key} className="flex gap-2" data-testid={`plan-${plan.id}-${f.key}`}>
                  {f.included ? (
                    <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                  ) : (
                    <X aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className={cn(!f.included && "text-muted-foreground")}>{f.text}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <Link href={CTA_HREF} className={cn(buttonVariants({ size: "lg" }), "h-11 w-full px-6 text-base sm:w-auto sm:self-start")}>
        {CTA_LABEL}
      </Link>
    </section>
  );
}
