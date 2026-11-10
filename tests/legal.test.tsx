import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PrivacyPage from "@/app/(marketing)/privacy/page";
import TermsPage from "@/app/(marketing)/terms/page";
import { LegalPage } from "@/components/marketing/LegalPage";
import { LIMITS } from "@/lib/ai/limits";
import { LEGAL_ENTITY_NAME, SUPPORT_EMAIL } from "@/lib/brand";
import { retentionSummary } from "@/lib/cleanup/rules";
import { LEGAL_DRAFT, LEGAL_DRAFT_NOTE, LEGAL_LAST_UPDATED, formatLegalDate } from "@/lib/legal/meta";
import { PROCESSORS } from "@/lib/legal/processors";
import { UPGRADE } from "@/lib/pricing";
import { FREE_LINK_DAYS } from "@/lib/publish/rules";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const privacy = renderToStaticMarkup(<PrivacyPage />);
const terms = renderToStaticMarkup(<TermsPage />);

describe("privacy policy", () => {
  it("retention list is generated from retentionSummary()", () => {
    for (const r of retentionSummary()) {
      expect(privacy).toContain(`data-testid="retention-${r.key}"`);
      expect(privacy).toContain(esc(r.text));
    }
  });

  it("lists every processor with what it receives", () => {
    const names = PROCESSORS.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(["Supabase", "Vercel", "Anthropic (Claude)", "Mapbox", "Stripe", "Resend", "PostHog", "Sentry"]),
    );
    expect(privacy.match(/data-testid="privacy-processor"/g)?.length).toBe(PROCESSORS.length);
    for (const p of PROCESSORS) expect(privacy).toContain(esc(p.data));
  });

  it("covers AI processing, admin trace access, shared links and PDPL/GDPR rights", () => {
    expect(privacy).toMatch(/512 px thumbnails/);
    expect(privacy).toMatch(/deleted together with it/);
    expect(privacy).toMatch(/Admin access for debugging/);
    expect(privacy).toMatch(/anyone with the link/);
    expect(privacy).toMatch(/internal IDs/);
    expect(privacy).toContain("Federal Decree-Law No. 45 of 2021");
    expect(privacy).toContain("GDPR");
    expect(privacy).toContain(SUPPORT_EMAIL);
    expect(privacy).toContain(esc(LEGAL_ENTITY_NAME));
  });

  it("shows the last-updated date", () => {
    expect(privacy).toContain(`Last updated ${formatLegalDate(LEGAL_LAST_UPDATED)}`);
    expect(formatLegalDate("2026-11-10")).toBe("10 November 2026");
  });
});

describe("terms", () => {
  it("prices and limits come from constants", () => {
    expect(terms).toContain(UPGRADE.label);
    expect(terms).toContain(`up to ${LIMITS.free.maxPages} pages`);
    expect(terms).toContain(`up to ${LIMITS.paid.maxPages} pages`);
    expect(terms).toContain(`expires ${FREE_LINK_DAYS} days`);
  });

  it("covers ownership licence, acceptable use, AI drafts and governing law", () => {
    expect(terms).toMatch(/You own your photos/);
    expect(terms).toMatch(/Acceptable use/);
    expect(terms).toMatch(/AI-generated content/);
    expect(terms).toMatch(/Governing law/);
  });
});

describe("draft note", () => {
  it("follows LEGAL_DRAFT on both pages", () => {
    const shown = privacy.includes('data-testid="legal-draft-note"');
    expect(shown).toBe(LEGAL_DRAFT);
    expect(terms.includes('data-testid="legal-draft-note"')).toBe(LEGAL_DRAFT);
    if (LEGAL_DRAFT) expect(privacy).toContain(esc(LEGAL_DRAFT_NOTE));
  });

  it("is toggled by the draft prop", () => {
    const props = { title: "T", intro: null, lastUpdated: "2026-11-10", sections: [] };
    expect(renderToStaticMarkup(<LegalPage {...props} draft />)).toContain('data-testid="legal-draft-note"');
    expect(renderToStaticMarkup(<LegalPage {...props} draft={false} />)).not.toContain('data-testid="legal-draft-note"');
  });
});
