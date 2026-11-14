// Scrolling benefits strip under the home hero (M15, Ghia-style). Server component, CSS only:
// home-marquee-track (globals.css) slides two halves of repeated lists; hover, keyboard focus or the
// pause toggle stop it; reduced motion shows one static, wrapping list. Ink text on pop pink (5.08:1).
import { Pause, Play } from "lucide-react";
import { MARQUEE_ITEMS } from "@/lib/marketing/copy";

function Items({ hidden = false }: { hidden?: boolean }) {
  return (
    <ul aria-hidden={hidden || undefined} className="flex shrink-0 items-center">
      {MARQUEE_ITEMS.map((item) => (
        <li key={item} className="flex shrink-0 items-center gap-5 px-2.5 sm:gap-7 sm:px-3.5">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0 fill-[#16121c] sm:size-5">
            <path d="M12 0c.7 6.4 5.6 11.3 12 12-6.4.7-11.3 5.6-12 12-.7-6.4-5.6-11.3-12-12C6.4 11.3 11.3 6.4 12 0Z" />
          </svg>
          <span className="font-brand text-xl font-bold tracking-[-0.01em] whitespace-nowrap text-[#16121c] sm:text-[1.6rem]">{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function Marquee() {
  return (
    <section aria-label="What you get" data-testid="section-marquee" className="home-marquee overflow-x-clip py-7 sm:py-10">
      <div className="-mx-[5%] flex w-[110%] -rotate-[1.4deg] items-center bg-[#ff1f84] py-2.5 ps-[5%] pe-[calc(5%+0.5rem)] shadow-[0_6px_0_#16121c] sm:py-3.5">
        <div className="flex min-w-0 flex-1 overflow-hidden">
          <div className="home-marquee-track flex w-max py-1">
            <Items />
            <Items hidden />
            <Items hidden />
            <Items hidden />
          </div>
        </div>
        <label className="relative ms-2 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#16121c] text-white has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-white motion-reduce:hidden">
          <input type="checkbox" data-testid="marquee-pause" className="peer sr-only" />
          <span className="sr-only">Pause scrolling text</span>
          <Pause aria-hidden="true" className="size-4 fill-current peer-checked:hidden" />
          <Play aria-hidden="true" className="hidden size-4 fill-current peer-checked:block" />
        </label>
      </div>
    </section>
  );
}
