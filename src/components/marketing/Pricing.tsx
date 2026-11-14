import { Check, X } from "lucide-react";
import Link from "next/link";
import { CTA_HREF, CTA_LABEL } from "@/lib/marketing/copy";
import { plans } from "@/lib/marketing/plans";

// M15 "Confetti": chunky rounded cards (paid on blush with an ink outline), pink pill CTA.
export function Pricing() {
  return (
    <section aria-labelledby="pricing-heading" data-testid="section-pricing" className="flex flex-col gap-8 sm:gap-10">
      <div className="flex flex-col items-start gap-3">
        <p className="rounded-full bg-[#16121c] px-3.5 py-1.5 text-xs font-bold tracking-[0.08em] text-white uppercase">Per book, not per month</p>
        <h2 id="pricing-heading" className="font-brand text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] text-[#16121c] sm:text-6xl lg:text-7xl">
          Pricing
        </h2>
        <p className="max-w-xl text-lg leading-snug text-[#4a3b4d]">Start free. Pay only for the books you want to keep — once.</p>
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:gap-7">
        {plans().map((plan) => {
          const paid = plan.id === "paid";
          return (
            <div
              key={plan.id}
              data-testid={`plan-${plan.id}`}
              className={`flex flex-col gap-5 rounded-[2rem] p-6 sm:p-8 ${
                paid ? "bg-[#ffd1ea] shadow-[0_6px_0_#16121c] ring-2 ring-[#16121c]" : "bg-white ring-1 ring-[#16121c]/12"
              }`}
            >
              <div className="flex flex-col gap-1.5">
                <h3 className="font-brand text-xl font-bold tracking-[-0.01em] text-[#16121c]">{plan.name}</h3>
                <p
                  className="font-brand text-6xl leading-none font-extrabold tracking-[-0.04em] text-[#16121c] lining-nums"
                  data-testid={`plan-${plan.id}-price`}
                >
                  {plan.price}
                </p>
                <p className="text-[0.95rem] text-[#4a3b4d]">{plan.priceNote}</p>
              </div>
              <ul className={`flex flex-col gap-2.5 border-t-2 pt-5 text-[0.95rem] ${paid ? "border-[#16121c]/15" : "border-[#16121c]/8"}`}>
                {plan.features.map((f) => (
                  <li key={f.key} className="flex items-start gap-2.5" data-testid={`plan-${plan.id}-${f.key}`}>
                    {f.included ? (
                      <span aria-hidden="true" className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-[#d1006a] text-white">
                        <Check className="size-3.5 stroke-[3]" />
                      </span>
                    ) : (
                      <span aria-hidden="true" className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-[#16121c]/10 text-[#4a3b4d]">
                        <X className="size-3.5 stroke-[3]" />
                      </span>
                    )}
                    <span className={f.included ? "font-medium text-[#16121c]" : "text-[#4a3b4d]"}>{f.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <Link
        href={CTA_HREF}
        className="inline-flex h-14 items-center justify-center self-stretch rounded-full bg-[#d1006a] px-9 font-brand text-lg font-bold text-white shadow-[0_5px_0_#16121c] transition-[transform,box-shadow,background-color] outline-none hover:translate-y-[2px] hover:bg-[#b8005c] hover:shadow-[0_3px_0_#16121c] focus-visible:ring-[3px] focus-visible:ring-[#16121c] focus-visible:ring-offset-[3px] focus-visible:ring-offset-[#fff7fb] motion-reduce:transition-none sm:self-start"
      >
        {CTA_LABEL}
      </Link>
    </section>
  );
}
