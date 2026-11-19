// Print checks on the share page (Task 10): the result of the readiness check of the saved book
// against the digital A5 PDF spec, shown before "Download PDF". Hook-free (server-rendered slot).
// Copy comes from src/lib/print/copy.ts — it names what was checked and never says "print-ready"
// or "certified".

import { CircleAlert, CircleCheck, Info } from "lucide-react";
import type { ReadinessView } from "@/lib/print/copy";

export function PrintChecks({ view }: { view: ReadinessView }) {
  const tone = !view.ok ? "error" : view.lines.length > 0 ? "notes" : "ok";
  const Icon = tone === "error" ? CircleAlert : tone === "notes" ? Info : CircleCheck;
  return (
    <div
      className={`type-small rounded-xl border p-3 ${tone === "error" ? "border-red-200 bg-red-50 text-red-900" : "border-[#e9dfca] bg-[#fbf8f2] text-foreground"}`}
      data-testid="print-checks"
      data-state={tone}
    >
      <p className="flex items-start gap-2 font-medium">
        <Icon className={`mt-0.5 size-4 shrink-0 ${tone === "ok" ? "text-success" : ""}`} aria-hidden="true" />
        <span className="min-w-0 break-words" data-testid="print-checks-summary">
          {view.summary}
        </span>
      </p>
      {view.lines.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1 ps-6">
          {view.lines.map((l) => (
            <li key={l.text} className="list-disc break-words" data-severity={l.severity}>
              {l.text}
            </li>
          ))}
          {view.more > 0 ? <li className="list-none text-muted-foreground">and {view.more} more</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
