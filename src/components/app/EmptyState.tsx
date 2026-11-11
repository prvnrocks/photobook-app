// Shared empty state (M11, D-067): a small open-book drawing in the paper palette, a serif title,
// one line of help and usually one action. No texture image (0 extra bytes).

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

function OpenBookArt() {
  return (
    <svg viewBox="0 0 120 80" className="h-20 w-30" aria-hidden="true" focusable="false">
      <path d="M60 18 C46 10 26 9 10 13 V70 C26 66 46 67 60 75 Z" fill="var(--card)" stroke="var(--input)" strokeWidth="1.5" />
      <path d="M60 18 C74 10 94 9 110 13 V70 C94 66 74 67 60 75 Z" fill="var(--card)" stroke="var(--input)" strokeWidth="1.5" />
      <rect x="20" y="22" width="30" height="22" rx="2" fill="var(--secondary)" />
      <path d="M22 42 l9-9 6 6 4-4 7 7" fill="none" stroke="var(--primary)" strokeWidth="1.5" strokeLinejoin="round" opacity="0.55" />
      <circle cx="43" cy="28" r="2.5" fill="var(--accent-strong)" />
      <path d="M20 52 h28 M20 58 h20" stroke="var(--border)" strokeWidth="2" strokeLinecap="round" />
      <path d="M70 26 h28 M70 32 h22 M70 38 h26" stroke="var(--border)" strokeWidth="2" strokeLinecap="round" />
      <rect x="70" y="46" width="28" height="16" rx="2" fill="var(--secondary)" />
      <path d="M60 18 V75" stroke="var(--input)" strokeWidth="1.5" />
    </svg>
  );
}

export type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** Replaces the default open-book drawing. */
  art?: ReactNode;
  className?: string;
  /** 1 when the empty state is the whole page (e.g. /b state screens); default 2. */
  headingLevel?: 1 | 2;
  "data-testid"?: string;
};

export function EmptyState({ title, description, action, art, className, headingLevel = 2, ...rest }: EmptyStateProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <section
      data-testid={rest["data-testid"]}
      className={cn("flex flex-col items-center rounded-2xl border border-border bg-card px-6 py-10 text-center shadow-card", className)}
    >
      {art ?? <OpenBookArt />}
      <Heading dir="auto" className="type-h2 mt-5 text-foreground">
        {title}
      </Heading>
      {description ? (
        <p dir="auto" className="type-small mt-2 max-w-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-6 flex w-full max-w-xs flex-col gap-2">{action}</div> : null}
    </section>
  );
}
