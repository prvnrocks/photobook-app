// M11 task 2: shared app components (src/components/app/*). Static renders (no DOM).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionBar } from "@/components/app/ActionBar";
import { AppToast } from "@/components/app/AppToast";
import { EmptyState } from "@/components/app/EmptyState";
import { LoadingState } from "@/components/app/LoadingState";
import { Notice } from "@/components/app/Notice";
import { PageHeader } from "@/components/app/PageHeader";
import { PageSkeleton, Skeleton } from "@/components/app/Skeleton";
import { StepProgress } from "@/components/app/StepProgress";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("StepProgress", () => {
  it("labels the current step and marks it aria-current", () => {
    const h = html(<StepProgress current="build" />);
    expect(h).toContain('aria-label="Book steps"');
    expect(h).toContain("Step 3 of 6: AI build");
    expect(count(h, 'aria-current="step"')).toBe(1);
    expect(h).toMatch(/<li aria-current="step" data-state="current"[^>]*>.*?AI build/);
    expect(count(h, 'data-state="done"')).toBe(2);
    expect(count(h, 'data-state="todo"')).toBe(3);
    expect(count(h, "<li")).toBe(6);
  });
  it("fits 375 px: six equal grid columns, names hidden below sm", () => {
    const h = html(<StepProgress current="new" />);
    expect(h).toContain("grid-cols-6");
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
    expect(h).toContain("Step 2 of 6: Photos");
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
