"use client";

// Client-only entry point for the flipbook: page-flip needs window/DOM, so the real component is
// loaded with next/dynamic(ssr:false). Server pages render this; the placeholder keeps the
// stage size stable until the book mounts.

import dynamic from "next/dynamic";
import type { FlipbookProps } from "./Flipbook";

export type { FlipbookApi, FlipbookProps, FlipbookReadyInfo } from "./Flipbook";

const Flipbook = dynamic(() => import("./Flipbook").then((m) => m.Flipbook), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center" data-testid="flipbook-loading">
      <div className="aspect-[148/210] h-full max-h-full max-w-full animate-pulse rounded-sm bg-neutral-200" />
    </div>
  ),
});

export function FlipbookLoader(props: FlipbookProps) {
  return <Flipbook {...props} />;
}
