"use client";

// Client-only entry point for the flipbook: page-flip needs window/DOM, so the real component is
// loaded with next/dynamic(ssr:false). Server pages render this; the placeholder keeps the
// stage size stable until the book mounts.

import dynamic from "next/dynamic";
import { createContext, useContext } from "react";
import { pageAspectStyle } from "@/lib/book/format-style";
import type { BookFormat } from "@/lib/book/types";
import type { FlipbookProps } from "./Flipbook";

export type { FlipbookApi, FlipbookProps, FlipbookReadyInfo } from "./Flipbook";

// next/dynamic's loading component gets no props: the skeleton reads the book format from here.
const LoaderFormat = createContext<BookFormat | null | undefined>(undefined);

/** Placeholder page in the book's shape (A5 portrait class; inline aspect-ratio for other formats). */
export function FlipbookSkeleton({ format }: { format?: BookFormat | null }) {
  return (
    <div className="flex h-full w-full items-center justify-center" data-testid="flipbook-loading">
      <div className="aspect-[148/210] h-full max-h-full max-w-full animate-pulse rounded-sm bg-neutral-200" style={pageAspectStyle(format)} />
    </div>
  );
}

function LoadingSkeleton() {
  return <FlipbookSkeleton format={useContext(LoaderFormat)} />;
}

const Flipbook = dynamic(() => import("./Flipbook").then((m) => m.Flipbook), {
  ssr: false,
  loading: LoadingSkeleton,
});

export function FlipbookLoader(props: FlipbookProps) {
  return (
    <LoaderFormat.Provider value={props.doc.format}>
      <Flipbook {...props} />
    </LoaderFormat.Provider>
  );
}
