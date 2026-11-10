// ============================================================================================
// TERMS OF SERVICE — DRAFT, NOT LEGAL ADVICE. Must be reviewed by a lawyer before launch
// (NEEDS-HUMAN, docs/LAUNCH.md). The visible "Draft — under legal review" note is controlled by
// LEGAL_DRAFT in src/lib/legal/meta.ts.
// Placeholders for the lawyer: legal entity (LEGAL_ENTITY_NAME), refund policy, liability limits,
// governing law / courts (UAE, Abu Dhabi — or ADGM / DIFC courts if the company sits there).
// Prices and limits come from code (pricing.ts, ai/limits.ts, publish/rules.ts, cleanup/rules.ts).
// ============================================================================================
import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, type LegalSection } from "@/components/marketing/LegalPage";
import { APP_NAME, LEGAL_ENTITY_NAME, SUPPORT_EMAIL } from "@/lib/brand";
import { LIMITS } from "@/lib/ai/limits";
import { FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY } from "@/lib/cleanup/rules";
import { LEGAL_DRAFT, LEGAL_LAST_UPDATED } from "@/lib/legal/meta";
import { UPGRADE } from "@/lib/pricing";
import { FREE_LINK_DAYS } from "@/lib/publish/rules";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: `The rules for using ${APP_NAME}.`,
  alternates: { canonical: "/terms" },
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

function sections(): LegalSection[] {
  return [
    {
      id: "service",
      title: "The service",
      body: (
        <p>
          {APP_NAME} (operated by {LEGAL_ENTITY_NAME}, Abu Dhabi, UAE) lets you upload photos, have AI build them into
          a photobook, edit it, and share it as a flipbook link — and, for paid books, download a PDF. By using{" "}
          {APP_NAME} you agree to these Terms and to our <Link href="/privacy">Privacy Policy</Link>.
        </p>
      ),
    },
    {
      id: "accounts",
      title: "Your account",
      body: (
        <p>
          You sign in with your email or Google account. Keep access to your email secure — anyone who can open your
          sign-in emails can open your account. You must be 18 or older. You are responsible for what happens in your
          account.
        </p>
      ),
    },
    {
      id: "content",
      title: "Your photos and content",
      body: (
        <>
          <p>
            <strong>You own your photos, captions and books.</strong> You give us a limited, non-exclusive licence to
            store, copy, resize, analyse (including with AI) and display them, only as needed to provide the service to
            you and to the people you share your book with. This licence ends when you delete the content, except for
            copies in backups that roll over normally.
          </p>
          <p>
            You confirm you have the right to upload each photo, and permission from the people shown in it where the
            law requires it.
          </p>
        </>
      ),
    },
    {
      id: "acceptable-use",
      title: "Acceptable use",
      body: (
        <>
          <p>You must not use {APP_NAME} to upload or share content that:</p>
          <ul>
            <li>is illegal in the UAE or where you are, including sexual content involving minors;</li>
            <li>infringes someone else&apos;s copyright, privacy or other rights;</li>
            <li>harasses, threatens or exposes others without their consent.</li>
          </ul>
          <p>
            You also must not try to break, overload or get around the limits of the service. We may remove content or
            suspend accounts that break these rules.
          </p>
        </>
      ),
    },
    {
      id: "ai",
      title: "AI-generated content",
      body: (
        <p>
          The AI chooses photos, layouts and captions as a <strong>draft</strong>. You decide what stays: every choice
          can be changed, and we never overwrite your own edits. AI can make mistakes — please check captions before
          you share your book. You are responsible for what you publish.
        </p>
      ),
    },
    {
      id: "plans",
      title: "Free and paid books",
      body: (
        <>
          <ul data-testid="terms-plans">
            <li>
              <strong>Free book:</strong> up to {LIMITS.free.maxPages} pages, a small watermark, no PDF, and a share
              link that expires {FREE_LINK_DAYS} days after you first publish.
            </li>
            <li>
              <strong>Paid book:</strong> a one-time payment of {UPGRADE.label} per book (VAT included, no
              subscription) — up to {LIMITS.paid.maxPages} pages, no watermark, a permanent link and PDF download.
            </li>
          </ul>
          <p>Payments are processed by Stripe. A book becomes paid once Stripe confirms the payment.</p>
        </>
      ),
    },
    {
      id: "refunds",
      title: "Refunds",
      // LEGAL REVIEW / NEEDS-HUMAN: final refund policy (UAE consumer protection law).
      body: (
        <p>
          If something went wrong with your book or payment, email {mail} within 14 days and we&apos;ll work it out
          with you, including a refund where appropriate. This does not affect your rights under consumer law.
        </p>
      ),
    },
    {
      id: "expiry",
      title: "Expiry and deletion of free books",
      body: (
        <p>
          When a free book&apos;s link expires, viewers can no longer open it. If you don&apos;t upgrade, the book and
          its photos are deleted {FREE_BOOK_GRACE_DAYS_AFTER_EXPIRY} days after the link expires. Unpublished drafts
          left unchanged are deleted too, after an email warning. The <Link href="/privacy#retention">Privacy
          Policy</Link> lists the exact periods.
        </p>
      ),
    },
    {
      id: "changes",
      title: "Changes to the service",
      body: (
        <p>
          We may improve, change or stop features. If we ever stop the service, we&apos;ll give paid customers
          reasonable notice so they can download their PDFs. If we change these Terms in an important way, we&apos;ll
          tell you by email before the change applies.
        </p>
      ),
    },
    {
      id: "liability",
      title: "Liability",
      // LEGAL REVIEW / NEEDS-HUMAN: liability cap wording.
      body: (
        <p>
          We work hard to keep your books safe and the service running, but we provide it &quot;as is&quot;. Keep your
          own copies of your original photos. To the extent the law allows, our total liability to you is limited to
          the amount you paid us for the book concerned. Nothing in these Terms limits liability that cannot be limited
          by law.
        </p>
      ),
    },
    {
      id: "law",
      title: "Governing law",
      // NEEDS-HUMAN: confirm governing law and courts (Abu Dhabi courts, or ADGM courts for an ADGM entity).
      body: (
        <p>
          These Terms are governed by the laws of the Emirate of Abu Dhabi and the federal laws of the United Arab
          Emirates. Disputes go to the courts of Abu Dhabi. [To be confirmed]
        </p>
      ),
    },
    {
      id: "contact",
      title: "Contact",
      body: <p>Questions about these Terms: {mail}.</p>,
    },
  ];
}

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      lastUpdated={LEGAL_LAST_UPDATED}
      draft={LEGAL_DRAFT}
      intro={<p>These are the rules for using {APP_NAME}, written to be read, not skimmed past.</p>}
      sections={sections()}
    />
  );
}
