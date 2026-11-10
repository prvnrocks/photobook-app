// Shell for /privacy and /terms: title, "Last updated", draft note (LEGAL_DRAFT), table of
// contents and numbered sections. Server component, no client JS.
import { formatLegalDate, LEGAL_DRAFT_NOTE } from "@/lib/legal/meta";

export interface LegalSection {
  id: string;
  title: string;
  body: React.ReactNode;
}

type LegalPageProps = {
  title: string;
  intro: React.ReactNode;
  lastUpdated: string;
  draft: boolean;
  sections: LegalSection[];
};

export function LegalPage({ title, intro, lastUpdated, draft, sections }: LegalPageProps) {
  return (
    <main className="mx-auto flex w-full max-w-2xl min-w-0 flex-col gap-8 px-4 py-10 sm:px-6">
      <header className="flex flex-col gap-3">
        {draft ? (
          <p
            role="note"
            data-testid="legal-draft-note"
            className="self-start rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900"
          >
            {LEGAL_DRAFT_NOTE}
          </p>
        ) : null}
        <h1 className="font-heading text-3xl font-semibold tracking-tight break-words">{title}</h1>
        <p className="text-sm text-muted-foreground" data-testid="legal-last-updated">
          Last updated {formatLegalDate(lastUpdated)}
        </p>
        <div className="flex flex-col gap-3 text-base">{intro}</div>
      </header>

      <nav aria-label="Contents" className="rounded-xl border bg-muted/40 p-4">
        <p className="mb-2 text-sm font-semibold">Contents</p>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="underline-offset-4 hover:underline">
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {sections.map((s, i) => (
        <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`} className="flex scroll-mt-4 flex-col gap-3">
          <h2 id={`${s.id}-h`} className="font-heading text-xl font-semibold tracking-tight">
            {i + 1}. {s.title}
          </h2>
          <div className="flex flex-col gap-3 text-[0.95rem] leading-relaxed [&_a]:underline [&_a]:underline-offset-4 [&_ul]:pl-5 [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-1.5">
            {s.body}
          </div>
        </section>
      ))}
    </main>
  );
}
