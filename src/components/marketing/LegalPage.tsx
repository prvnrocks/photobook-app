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
    <main className="mx-auto flex w-full max-w-app min-w-0 flex-col gap-8 px-gutter py-10 sm:px-6">
      <header className="flex flex-col gap-3">
        {draft ? (
          <p
            role="note"
            data-testid="legal-draft-note"
            className="self-start rounded-md border border-warning-border bg-warning-soft px-3 py-1.5 text-xs font-medium text-warning"
          >
            {LEGAL_DRAFT_NOTE}
          </p>
        ) : null}
        <h1 className="type-h1 break-words text-foreground sm:type-display">{title}</h1>
        <p className="text-sm text-muted-foreground" data-testid="legal-last-updated">
          Last updated {formatLegalDate(lastUpdated)}
        </p>
        <div className="type-body flex flex-col gap-3 text-foreground/85">{intro}</div>
      </header>

      <nav aria-label="Contents" className="rounded-2xl border border-border bg-card p-4 shadow-card">
        <p className="type-eyebrow mb-2">Contents</p>
        <ol className="flex list-decimal flex-col ps-5 text-sm marker:text-muted-foreground">
          {sections.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="inline-flex min-h-11 items-center rounded-md underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9">
                {s.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {sections.map((s, i) => (
        <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`} className="flex scroll-mt-20 flex-col gap-3">
          <h2 id={`${s.id}-h`} className="type-h2 text-foreground">
            {i + 1}. {s.title}
          </h2>
          <div className="flex flex-col gap-3 text-[0.95rem] leading-relaxed [&_a]:underline [&_a]:underline-offset-4 [&_ul]:ps-5 [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-1.5">
            {s.body}
          </div>
        </section>
      ))}
    </main>
  );
}
