"use client";

// Mounts the real share page body (ShareBand + PublishPanelView + shareSlots) with a fixture state
// and stubbed actions (dev-only route). Successful actions update the local fixture state the way a
// server refresh would. The toolbar under the page switches states and simulates reduced motion
// (every animation / transition off — the real CSS keeps motion behind prefers-reduced-motion).

import { ChevronLeft } from "lucide-react";
import { Suspense, useMemo, useRef, useState } from "react";
import type { PublishBookResult, PublishPreview, PublishState } from "@/app/books/[id]/publish/actions";
import { PublishPanelView, type PublishActions } from "@/components/publish/PublishPanel";
import { SHARE_BACK_LINK, SHARE_BODY, shareChipKind } from "@/components/publish/share-page-classes";
import { ShareBand } from "@/components/publish/ShareBand";
import { shareSlots } from "@/components/publish/share-slots";
import { UpgradeCancelledNotice } from "@/components/upgrade/UpgradeCancelledNotice";
import type { PublishCompare } from "@/lib/publish/compare";
import { DEV_PUBLISH_STATES, DEV_PUBLISH_URL, devPublishState, type DevPublishStateName } from "@/lib/publish/dev-fixture";
import { shareStatus } from "@/lib/publish/status";

const BOOK_ID = "00000000-0000-4000-8000-000000000000";
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Simulated reduced motion: stop every animation and transition under the fixture root. */
const REDUCE_CSS =
  "[data-dev-reduce-motion] *,[data-dev-reduce-motion] *::before,[data-dev-reduce-motion] *::after{animation:none!important;transition:none!important}" +
  "[data-dev-reduce-motion] .share-burst{display:none!important}";

const TOOL_LINK =
  "inline-flex min-h-11 items-center rounded-full border border-[#e9dfca] bg-white px-3 text-sm font-medium text-[#0e3b2e] outline-none hover:bg-[#f3f7f4] focus-visible:ring-2 focus-visible:ring-[#0e3b2e] aria-[current=page]:border-[#0e3b2e] aria-[current=page]:bg-[#0e3b2e] aria-[current=page]:text-white";

export function DevPublishClient({
  name,
  result,
  paymentsEnabled,
  compare,
  shared = null,
  title,
  preview,
  reduceMotion = false,
  toolbar = true,
}: {
  name: DevPublishStateName;
  result: "ok" | "conflict" | "conflict2" | "failed";
  paymentsEnabled: boolean;
  compare: PublishCompare;
  shared?: "live" | "changes" | null;
  title: string;
  preview: PublishPreview;
  reduceMotion?: boolean;
  toolbar?: boolean;
}) {
  const [state, setState] = useState<PublishState>(() => devPublishState(name));
  const [reduce, setReduce] = useState(reduceMotion);
  const next = useRef<PublishState>(state);
  const calls = useRef(0);

  const actions = useMemo<PublishActions>(
    () => ({
      async publish(): Promise<PublishBookResult> {
        await wait(400);
        calls.current += 1;
        if (result === "failed") return { ok: false, error: "failed" };
        if (result === "conflict2" || (result === "conflict" && calls.current === 1)) return { ok: false, error: "conflict" };
        const expiresAt = state.isPaid ? null : (state.expiresAt ?? "2026-12-12T08:00:00.000Z");
        next.current = { ...state, published: true, hasChanges: false, slug: "sara-and-omar-wedding-7Hq2xYp9Kd", url: DEV_PUBLISH_URL, expiresAt };
        return { ok: true, slug: "sara-and-omar-wedding-7Hq2xYp9Kd", url: DEV_PUBLISH_URL, expiresAt };
      },
      async unpublish() {
        await wait(300);
        next.current = { ...state, published: false, hasChanges: false };
        return { ok: true as const };
      },
      async setPassword(pw: string | null) {
        await wait(300);
        if (pw !== null && Array.from(pw).length < 4) return { ok: false as const, error: "too_short" as const };
        next.current = { ...state, hasPassword: pw !== null };
        return { ok: true as const, hasPassword: pw !== null };
      },
    }),
    [state, result],
  );

  const refresh = () => setState(next.current);
  const status = shareStatus(state, new Date());
  const slots = shareSlots({ bookId: BOOK_ID, title, state, preview, compare, paymentsEnabled, refresh });

  return (
    <main className="flex w-full flex-1 flex-col" data-dev-reduce-motion={reduce ? "" : undefined} data-testid="publish-main">
      {reduce ? <style>{REDUCE_CSS}</style> : null}
      <ShareBand
        title={title}
        chip={{ text: status.chip, kind: shareChipKind(status) }}
        back={
          <a href="/dev-editor" className={SHARE_BACK_LINK} data-testid="publish-back">
            <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
            Back to editor
          </a>
        }
      />
      <div className={`${SHARE_BODY} pt-4 pb-10 sm:pt-8 lg:pt-10 lg:pb-16`}>
        <h2 className="sr-only">Share your book</h2>
        <Suspense fallback={null}>
          <UpgradeCancelledNotice className="mb-4 sm:mb-stack" />
        </Suspense>
        <PublishPanelView
          bookId={BOOK_ID}
          title={title}
          state={state}
          actions={actions}
          paymentsEnabled={paymentsEnabled}
          shared={shared}
          preview={slots.preview}
          plan={slots.plan}
          pdf={slots.pdf}
          refresh={refresh}
        />
        {toolbar ? (
          <nav aria-label="Fixture" className="mt-10 flex flex-wrap items-center gap-2 border-t border-dashed border-[#e2d7c1] pt-4" data-testid="dev-publish-toolbar">
            {DEV_PUBLISH_STATES.map((s) => (
              <a key={s} href={`/dev-publish?state=${s}`} className={TOOL_LINK} aria-current={s === name ? "page" : undefined}>
                {s}
              </a>
            ))}
            <button type="button" className={TOOL_LINK} aria-pressed={reduce} onClick={() => setReduce((r) => !r)} data-testid="dev-reduce-motion">
              Reduced motion: {reduce ? "on" : "off"}
            </button>
          </nav>
        ) : null}
      </div>
    </main>
  );
}
