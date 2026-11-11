// Shared status callout (M11, D-067) replacing hand-rolled amber/emerald/red boxes. Tone is shown
// by icon + a visually hidden prefix as well as colour. Errors are role="alert"; the rest
// role="status" (polite). Body can contain user text → dir="auto".

import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type NoticeTone = "info" | "success" | "warn" | "error";

const TONES: Record<NoticeTone, { icon: LucideIcon; box: string; icon_: string; prefix: string }> = {
  info: { icon: Info, box: "border-info-border bg-info-soft", icon_: "text-info", prefix: "Note:" },
  success: { icon: CircleCheck, box: "border-success-border bg-success-soft", icon_: "text-success", prefix: "Done:" },
  warn: { icon: TriangleAlert, box: "border-warning-border bg-warning-soft", icon_: "text-warning", prefix: "Warning:" },
  error: { icon: CircleAlert, box: "border-destructive-border bg-destructive-soft", icon_: "text-destructive", prefix: "Error:" },
};

export type NoticeProps = {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Buttons/links under the text. */
  action?: ReactNode;
  className?: string;
  "data-testid"?: string;
};

export function Notice({ tone = "info", title, children, action, className, ...rest }: NoticeProps) {
  const t = TONES[tone];
  const Icon = t.icon;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      data-tone={tone}
      data-testid={rest["data-testid"]}
      className={cn("flex gap-3 rounded-xl border p-4 text-foreground", t.box, className)}
    >
      <Icon className={cn("mt-0.5 size-5 shrink-0", t.icon_)} aria-hidden="true" />
      <div className="min-w-0 flex-1 type-small">
        <span className="sr-only">{t.prefix} </span>
        {title ? (
          <p dir="auto" className="font-semibold">
            {title}
          </p>
        ) : null}
        {children ? (
          <div dir="auto" className={cn(title ? "mt-1" : "", "text-foreground/85")}>
            {children}
          </div>
        ) : null}
        {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
      </div>
    </div>
  );
}
