// M11 task 2: shared app components (src/components/app/*). Static renders (no DOM).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionBar } from "@/components/app/ActionBar";
import { AppToast } from "@/components/app/AppToast";
import { EmptyState } from "@/components/app/EmptyState";
import { LoadingState } from "@/components/app/LoadingState";
import { Notice } from "@/components/app/Notice";
import { BACK_LINK_CLASS, PageHeader } from "@/components/app/PageHeader";
import { PageSkeleton, Skeleton } from "@/components/app/Skeleton";
import { StepProgress } from "@/components/app/StepProgress";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("StepProgress", () => {
  it("labels the current step and marks it aria-current (M13: three steps)", () => {
    const h = html(<StepProgress current="build" />);
    expect(h).toContain('aria-label="Book steps"');
    expect(h).toContain("Step 2 of 3: Your book");
    expect(h).toContain('data-step="book"');
    expect(count(h, 'aria-current="step"')).toBe(1);
    expect(h).toMatch(/<li aria-current="step" data-state="current"[^>]*>.*?Your book/);
    expect(count(h, 'data-state="done"')).toBe(1);
    expect(count(h, 'data-state="todo"')).toBe(1);
    expect(count(h, "<li")).toBe(3);
  });
  it("maps review and edit to Your book, new to Photos", () => {
    expect(html(<StepProgress current="review" />)).toContain("Step 2 of 3: Your book");
    expect(html(<StepProgress current="edit" />)).toContain("Step 2 of 3: Your book");
    expect(html(<StepProgress current="new" />)).toContain("Step 1 of 3: Photos");
    expect(html(<StepProgress current="share" />)).toContain("Step 3 of 3: Share");
  });
  it("fits 375 px: three equal grid columns, names hidden below sm", () => {
    const h = html(<StepProgress current="new" />);
    expect(h).toContain("grid-cols-3");
    expect(h).toContain("sr-only sm:not-sr-only");
  });
});

describe("PageHeader", () => {
  it("renders an h1 with dir=auto, eyebrow, description, back link and steps", () => {
    const h = html(
      <PageHeader title="رحلة العائلة" eyebrow="Wedding" description="Pick your photos" back={{ href: "/dashboard", label: "My books" }} step="photos" />,
    );
    expect(h).toMatch(/<h1 dir="auto"[^>]*>رحلة العائلة<\/h1>/);
    expect(h).toContain("type-h1");
    expect(h).toContain("Wedding");
    expect(h).toMatch(/<p dir="auto"[^>]*>Pick your photos<\/p>/);
    expect(h).toContain('href="/dashboard"');
    expect(h).toContain("h-11");
    expect(h).toContain("Step 1 of 3: Photos");
  });
  it("display size and no optional parts", () => {
    const h = html(<PageHeader title="Your books" size="display" />);
    expect(h).toContain("type-display");
    expect(h).not.toContain("step-progress");
    expect(h).not.toContain("<a ");
  });
});

describe("Notice", () => {
  it.each([
    ["info", "status", "Note:"],
    ["success", "status", "Done:"],
    ["warn", "status", "Warning:"],
    ["error", "alert", "Error:"],
  ] as const)("%s → role=%s with icon and hidden prefix", (tone, role, prefix) => {
    const h = html(
      <Notice tone={tone} title="Heads up" data-testid="n">
        Body
      </Notice>,
    );
    expect(h).toContain(`role="${role}"`);
    expect(h).toContain(`data-tone="${tone}"`);
    expect(h).toContain('data-testid="n"');
    expect(h).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(h).toContain(`<span class="sr-only">${prefix} </span>`);
    expect(h).toMatch(/<p dir="auto"[^>]*>Heads up<\/p>/);
    expect(h).toMatch(/<div dir="auto"[^>]*>Body<\/div>/);
  });
  it("defaults to info and renders actions", () => {
    const h = html(<Notice action={<button type="button">Retry</button>}>x</Notice>);
    expect(h).toContain('data-tone="info"');
    expect(h).toContain("Retry");
  });
});

describe("EmptyState", () => {
  it("has a heading, decorative art and an action", () => {
    const h = html(<EmptyState title="No books yet" description="Start one" action={<a href="/books/new">New book</a>} data-testid="empty" />);
    expect(h).toMatch(/<h2 dir="auto"[^>]*>No books yet<\/h2>/);
    expect(h).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(h).toContain('href="/books/new"');
    expect(h).toContain('data-testid="empty"');
  });
});

describe("LoadingState / Skeleton", () => {
  it("LoadingState is a polite status", () => {
    const h = html(<LoadingState label="Preparing your PDF…" description="About a minute" />);
    expect(h).toContain('role="status"');
    expect(h).toContain('aria-live="polite"');
    expect(h).toContain("Preparing your PDF…");
    expect(h).toContain("motion-reduce:animate-none");
  });
  it("Skeleton is hidden from assistive tech; PageSkeleton announces once", () => {
    expect(html(<Skeleton className="h-4" />)).toContain('aria-hidden="true"');
    const h = html(<PageSkeleton cards={3} />);
    expect(count(h, 'role="status"')).toBe(1);
    expect(h).toContain('aria-live="polite"');
    expect(h).toContain('<span class="sr-only">Loading…</span>');
  });
});

describe("ActionBar", () => {
  it("is a labelled group, sticky by default", () => {
    const h = html(
      <ActionBar label="Next step">
        <button type="button">Continue</button>
      </ActionBar>,
    );
    expect(h).toContain('role="group"');
    expect(h).toContain('aria-label="Next step"');
    expect(h).toContain("sticky bottom-0");
    expect(h).toContain("safe-area-inset-bottom");
    expect(html(<ActionBar sticky={false}>x</ActionBar>)).not.toContain("sticky");
  });
});

describe("AppToast", () => {
  it("keeps an empty polite live region mounted without a message", () => {
    const h = html(<AppToast message={null} />);
    expect(h).toContain('role="status"');
    expect(h).toContain('aria-live="polite"');
    expect(h).toContain('aria-atomic="true"');
    expect(h).not.toContain("<p");
  });
  it("shows the message (dir=auto) and a 44 px dismiss button", () => {
    const h = html(<AppToast message="Link copied" tone="success" onDismiss={() => {}} inline />);
    expect(h).toMatch(/<p dir="auto"[^>]*>Link copied<\/p>/);
    expect(h).toContain('aria-label="Dismiss"');
    expect(h).toContain("size-11");
    expect(h).not.toContain("fixed");
  });
});

describe("PageHeader testid props (M11 follow-up)", () => {
  it("puts testids on the back link, eyebrow and title when given", () => {
    const html = renderToStaticMarkup(
      <PageHeader title="T" eyebrow="E" back={{ href: "/x", label: "Back", testId: "b-id" }} titleTestId="t-id" eyebrowTestId="e-id" />,
    );
    expect(html).toContain('data-testid="b-id"');
    expect(html).toContain('data-testid="t-id"');
    expect(html).toContain('data-testid="e-id"');
  });
  it("omits them otherwise", () => {
    const html = renderToStaticMarkup(<PageHeader title="T" />);
    expect(html).not.toContain('data-testid="t-id"');
  });
});

describe("PageHeader options (M11 review)", () => {
  it("description testid, inline actions and the text eyebrow for user titles", () => {
    const h = renderToStaticMarkup(
      <PageHeader title="T" description="D" descriptionTestId="d-id" eyebrow="سارة وعمر" eyebrowVariant="text" eyebrowTestId="e-id" actions={<button>Go</button>} actionsInline />,
    );
    expect(h).toMatch(/<p dir="auto"[^>]*data-testid="d-id"[^>]*>D<\/p>/);
    expect(h).toMatch(/<p dir="auto" class="type-small[^"]*truncate[^"]*" data-testid="e-id">سارة وعمر<\/p>/);
    expect(h).not.toContain("type-eyebrow");
    expect(h).toContain("flex gap-3 flex-row items-end justify-between");
  });
  it("defaults: tracked label eyebrow, actions stack below sm", () => {
    const h = renderToStaticMarkup(<PageHeader title="T" eyebrow="Account" actions={<button>Go</button>} />);
    expect(h).toContain("type-eyebrow");
    expect(h).toContain("flex-col sm:flex-row");
  });
  it("back link uses the exported BACK_LINK_CLASS", () => {
    const h = renderToStaticMarkup(<PageHeader title="T" back={{ href: "/x", label: "Back" }} />);
    expect(h).toContain(`class="${BACK_LINK_CLASS}"`);
  });
});

describe("EmptyState headingLevel", () => {
  it("renders h2 by default and h1 when asked", () => {
    expect(renderToStaticMarkup(<EmptyState title="A" />)).toContain("<h2");
    const h1 = renderToStaticMarkup(<EmptyState title="A" headingLevel={1} />);
    expect(h1).toContain("<h1");
    expect(h1).not.toContain("<h2");
  });
});
