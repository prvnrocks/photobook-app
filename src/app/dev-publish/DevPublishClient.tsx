"use client";

// Mounts the real PublishPanelView with a fixture state and stubbed actions (dev-only route).
// Successful actions update the local fixture state the way a server refresh would.

import { Suspense, useMemo, useRef, useState } from "react";
import type { PublishBookResult, PublishState } from "@/app/books/[id]/publish/actions";
import { PublishHeader } from "@/components/publish/PublishHeader";
import { PublishPanelView, type PublishActions } from "@/components/publish/PublishPanel";
import { UpgradeCancelledNotice } from "@/components/upgrade/UpgradeCancelledNotice";
import type { PublishCompare } from "@/lib/publish/compare";
import { DEV_PUBLISH_URL, devPublishState, type DevPublishStateName } from "@/lib/publish/dev-fixture";

const BOOK_ID = "00000000-0000-4000-8000-000000000000";
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function DevPublishClient({
  name,
  result,
  paymentsEnabled,
  compare,
  shared = null,
}: {
  name: DevPublishStateName;
  result: "ok" | "conflict" | "conflict2" | "failed";
  paymentsEnabled: boolean;
  compare: PublishCompare;
  shared?: "live" | "changes" | null;
}) {
  const [state, setState] = useState<PublishState>(() => devPublishState(name));
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

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-app flex-col gap-stack px-gutter pb-10 pt-3">
      <PublishHeader bookId={BOOK_ID} title="Sara & Omar" />
      <Suspense fallback={null}>
        <UpgradeCancelledNotice />
      </Suspense>
      <PublishPanelView
        bookId={BOOK_ID}
        title="Sara & Omar"
        state={state}
        actions={actions}
        paymentsEnabled={paymentsEnabled}
        compare={compare}
        shared={shared}
        refresh={() => setState(next.current)}
      />
    </main>
  );
}
