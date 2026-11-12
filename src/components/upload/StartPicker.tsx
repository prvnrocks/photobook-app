"use client";
// Photos-first start (M13 T5, D-070): a "Choose photos" control that IS the file input's label, so
// a direct tap opens the phone's picker (iOS only opens it from a user gesture — it can't be opened
// after a navigation). On selection: disable, create the draft (startBookAction, with a page-shape
// hint read from the files' headers when that's quick), keep the File objects in memory
// (pending-files) and navigate client-side to the upload screen, which starts uploading them.
// Used on /books/start (hero), the dashboard header ("New book") and the empty dashboard (cta).
// Nothing about the photos is logged or sent anywhere except the user's own upload later.
import { ImagePlus, LoaderCircle, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type ChangeEvent } from "react";
import { startBookAction } from "@/app/books/actions";
import { buttonVariants } from "@/components/ui/button-variants";
import { probeFormat } from "@/lib/upload/image-size";
import { cn } from "@/lib/utils";
import { stashPendingFiles } from "./pending-files";

export const START_LOGIN_HREF = "/login?next=%2Fbooks%2Fstart";

const START_ERROR = "We couldn't start your book. Please try again.";

export type StartPickerVariant = "hero" | "button" | "cta";

export type StartPickerProps = {
  variant: StartPickerVariant;
  /** Visible label (defaults per variant). */
  label?: string;
  /** data-testid of the label (the tap target); the input gets `${testId}-input`. */
  testId: string;
  className?: string;
};

const DEFAULT_LABEL: Record<StartPickerVariant, string> = {
  hero: "Choose photos",
  button: "New book",
  cta: "Choose photos",
};

// The input sits inside the label (sr-only, still focusable): Tab reaches it, Space/Enter opens the
// picker, the label shows its focus ring, and the label text is its accessible name.
const focusRing =
  "has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-2 has-focus-visible:ring-offset-background";
const disabledLook = "has-disabled:cursor-progress has-disabled:opacity-70";

export function StartPicker({ variant, label, testId, className }: StartPickerProps) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const errorId = useId();
  const text = label ?? DEFAULT_LABEL[variant];

  async function onChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // picking the same photos again fires change again
    if (files.length === 0 || busyRef.current) return;
    busyRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const format = await probeFormat(files);
      const res = await startBookAction(format ? { format } : {});
      if (res.ok) {
        stashPendingFiles(res.bookId, { files, suggestedFormat: format });
        router.push(res.next);
        return; // stay disabled until the upload screen replaces this one
      }
      if (res.error === "unauthenticated") {
        router.push(START_LOGIN_HREF);
        return;
      }
      setError(START_ERROR);
    } catch {
      setError(START_ERROR);
    }
    busyRef.current = false;
    setStarting(false);
  }

  const input = (
    <input
      type="file"
      multiple
      accept="image/*,.heic,.heif"
      onChange={(e) => void onChange(e)}
      disabled={starting}
      aria-describedby={error ? errorId : undefined}
      className="sr-only"
      data-testid={`${testId}-input`}
    />
  );

  const errorLine = error ? (
    <p id={errorId} role="alert" className="text-sm text-destructive" data-testid={`${testId}-error`}>
      {error}
    </p>
  ) : null;

  if (variant === "hero") {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <label
          aria-busy={starting || undefined}
          className={cn(
            "group relative flex min-h-56 w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-input bg-card px-6 py-10 text-center shadow-card transition-colors hover:border-accent-strong hover:bg-secondary/60",
            focusRing,
            disabledLook,
          )}
          data-testid={testId}
        >
          {input}
          <span
            aria-hidden="true"
            className="flex size-16 items-center justify-center rounded-full bg-accent-strong text-accent-strong-foreground shadow-card"
          >
            {starting ? <LoaderCircle className="size-8 animate-spin" /> : <ImagePlus className="size-8" />}
          </span>
          <span className="type-h2 text-foreground">{starting ? "Starting your book…" : text}</span>
          <span className="type-small max-w-xs text-muted-foreground">
            Select as many as you like at once. iPhone photos (HEIC) work too.
          </span>
        </label>
        {errorLine}
      </div>
    );
  }

  const Icon = starting ? LoaderCircle : variant === "button" ? Plus : ImagePlus;
  return (
    <div className={cn("flex flex-col gap-2", variant === "cta" && "w-full", className)}>
      <label
        aria-busy={starting || undefined}
        className={cn(
          buttonVariants(variant === "cta" ? { variant: "accent", size: "cta" } : { size: "touch" }),
          "cursor-pointer",
          focusRing,
          disabledLook,
        )}
        data-testid={testId}
      >
        {input}
        <Icon aria-hidden="true" data-icon="inline-start" className={starting ? "animate-spin" : undefined} />
        {starting ? "Starting…" : text}
      </label>
      {errorLine}
    </div>
  );
}
