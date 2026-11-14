import { Check, X } from "lucide-react";
import Link from "next/link";
import { CTA_HREF, CTA_LABEL, SECTION_LABELS } from "@/lib/marketing/copy";
import { plans } from "@/lib/marketing/plans";
import { SectionLabel } from "./SectionLabel";

// M16 "Emerald & gold": free plan on ivory with a hairline, paid plan in emerald leather with a gold
// foil frame (cream text 10.28, pale gold price), gold pill CTA with ink text (7.11).
export function Pricing() {
  return (
    <section aria-labelledby="pricing-heading" data-testid="section-pricing" className="flex flex-col gap-8 sm:gap-10">
      <div className="flex flex-col items-start gap-5">
        <SectionLabel>{SECTION_LABELS.pricing}</SectionLabel>
        <h2 id="pricing-heading" className="font-brand text-5xl leading-[0.95] font-light tracking-[-0.03em] text-[#0e3b2e] sm:text-6xl lg:text-7xl">
          Pricing
        </h2>
        <p className="max-w-xl text-lg leading-snug text-[#4a4740]">Start free. Pay only for the books you want to keep — once.</p>
      </div>
      <div className="grid gap-5 sm:grid-cols-2 lg:gap-7">
        {plans().map((plan) => {
          const paid = plan.id === "paid";
          return (
            <div
              key={plan.id}
              data-testid={`plan-${plan.id}`}
              className={`relative flex flex-col gap-5 rounded-[0.6rem] p-7 sm:p-9 ${
                paid ? "home-leather text-[#f2e8d8] shadow-[0_28px_44px_-28px_rgb(14_59_46/0.95)]" : "bg-[#faf5ec] text-[#1b1b1d] ring-1 ring-[#dccfb6]"
              }`}
            >
              {paid ? <span aria-hidden="true" className="pointer-events-none absolute inset-[6px] rounded-[0.35rem] border border-[#c9a227]/70" /> : null}
              <div className="flex flex-col gap-2">
                <h3 className={`text-sm font-semibold tracking-[0.24em] uppercase ${paid ? "text-[#e3c766]" : "text-[#7a5f0e]"}`}>{plan.name}</h3>
                <p
                  className={`font-brand text-6xl leading-none font-light tracking-[-0.03em] lining-nums ${paid ? "text-[#e3c766]" : "text-[#0e3b2e]"}`}
                  data-testid={`plan-${plan.id}-price`}
                >
                  {plan.price}
                </p>
                <p className={`text-[0.95rem] ${paid ? "text-[#d7cdb9]" : "text-[#4a4740]"}`}>{plan.priceNote}</p>
              </div>
              <ul className={`flex flex-col gap-2.5 border-t pt-5 text-[0.95rem] ${paid ? "border-[#c9a227]/45" : "border-[#dccfb6]"}`}>
                {plan.features.map((f) => (
                  <li key={f.key} className="flex items-start gap-2.5" data-testid={`plan-${plan.id}-${f.key}`}>
                    {f.included ? (
                      <span
                        aria-hidden="true"
                        className={`mt-px flex size-5 shrink-0 items-center justify-center rounded-full ${paid ? "home-foil-fill text-[#1b1b1d]" : "bg-[#0e3b2e] text-[#f2e8d8]"}`}
                      >
                        <Check className="size-3.5 stroke-[3]" />
                      </span>
                    ) : (
                      <span aria-hidden="true" className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-[#1b1b1d]/10 text-[#4a4740]">
                        <X className="size-3.5 stroke-[3]" />
                      </span>
                    )}
                    <span className={f.included ? "font-medium" : paid ? "text-[#d7cdb9]" : "text-[#4a4740]"}>{f.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <Link
        href={CTA_HREF}
        className="home-foil-fill inline-flex h-14 items-center justify-center self-stretch rounded-full px-10 font-brand text-lg font-semibold text-[#1b1b1d] shadow-[0_14px_28px_-16px_rgb(14_59_46/0.8),inset_0_1px_0_rgb(255_255_255/0.4)] transition-[filter,transform] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-[#0e3b2e] focus-visible:ring-offset-[3px] focus-visible:ring-offset-[#f2e8d8] active:translate-y-px motion-reduce:transition-none sm:self-start"
      >
        {CTA_LABEL}
      </Link>
    </section>
  );
}
