// Last flipbook page (back cover). No hooks: rendered inside page-flip's static page nodes.
// Links must contain text only — page-flip's clickEventForward only lets taps through when the
// event target itself is an <a>/<button>. Sizes in cqw of the outer box so it scales with the page.

import { APP_NAME, MADE_WITH } from "@/lib/brand";
import { CREATE_YOURS_HREF } from "@/lib/viewer/share";

export function EndCard({ isPaid }: { isPaid: boolean }) {
  return (
    <div
      className="relative aspect-[148/210] w-full overflow-hidden [container-type:inline-size]"
      data-testid="end-card"
      data-paid={String(isPaid)}
    >
      {isPaid ? (
        <div className="absolute inset-0 flex flex-col items-center justify-end bg-white p-[8cqw]">
          <a href={CREATE_YOURS_HREF} className="text-[3.6cqw] text-neutral-400 underline-offset-2 hover:underline">
            {MADE_WITH}
          </a>
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-[5cqw] bg-neutral-50 p-[10cqw] text-center">
          <p className="text-[3.6cqw] font-medium tracking-wide text-neutral-500 uppercase">{MADE_WITH}</p>
          <h2 className="text-[8cqw] leading-tight font-semibold text-neutral-900">Make your own photobook</h2>
          <p className="text-[4.2cqw] text-neutral-600">
            Upload your photos and {APP_NAME} lays them out for you in minutes.
          </p>
          <a
            href={CREATE_YOURS_HREF}
            data-testid="end-card-cta"
            className="mt-[2cqw] inline-block rounded-full bg-neutral-900 px-[7cqw] py-[3cqw] text-[4.4cqw] font-medium text-white"
          >
            Create yours
          </a>
        </div>
      )}
    </div>
  );
}
