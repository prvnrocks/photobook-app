// Scrolling benefits strip under the home hero (M15 structure, M16 "Emerald & gold"): a straight gold
// foil ribbon with ink hairlines and small caps in ink (≥ 6.09:1 on every foil stop). Server component,
// CSS only: home-marquee-track (globals.css) slides repeated lists; hover, keyboard focus or the pause
// toggle stop it; reduced motion shows one static, wrapping list.
import { Pause, Play } from "lucide-react";
import { MARQUEE_ITEMS } from "@/lib/marketing/copy";

function Items({ hidden = false }: { hidden?: boolean }) {
  return (
    <ul aria-hidden={hidden || undefined} className="flex shrink-0 items-center">
      {MARQUEE_ITEMS.map((item) => (
        <li key={item} className="flex shrink-0 items-center gap-6 px-3 sm:gap-9 sm:px-4.5">
          <svg aria-hidden="true" viewBox="0 0 10 10" className="size-2 shrink-0 fill-[#1b1b1d] sm:size-2.5">
            <path d="M5 0 10 5 5 10 0 5Z" />
          </svg>
          <span className="text-[0.8rem] font-semibold tracking-[0.24em] whitespace-nowrap text-[#1b1b1d] uppercase sm:text-[0.95rem]">{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function Marquee() {
  return (
    <section aria-label="What you get" data-testid="section-marquee" className="home-marquee overflow-x-clip py-8 sm:py-12">
      <div className="home-foil-fill relative flex w-full items-center py-2 ps-0 pe-2 shadow-[0_12px_28px_-18px_rgb(14_59_46/0.8)] sm:py-2.5 sm:pe-4">
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-[4px] h-px bg-[#1b1b1d]/35" />
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-[4px] h-px bg-[#1b1b1d]/35" />
        <div className="flex min-w-0 flex-1 overflow-hidden">
          <div className="home-marquee-track flex w-max py-2.5">
            <Items />
            <Items hidden />
            <Items hidden />
            <Items hidden />
          </div>
        </div>
        <label className="relative ms-2 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#1b1b1d] text-[#e3c766] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#0e3b2e] has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[#c9a227] motion-reduce:hidden">
          <input type="checkbox" data-testid="marquee-pause" className="peer sr-only" />
          <span className="sr-only">Pause scrolling text</span>
          <Pause aria-hidden="true" className="size-4 fill-current peer-checked:hidden" />
          <Play aria-hidden="true" className="hidden size-4 fill-current peer-checked:block" />
        </label>
      </div>
    </section>
  );
}
