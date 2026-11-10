// ============================================================================================
// PRIVACY POLICY — DRAFT, NOT LEGAL ADVICE. Must be reviewed by a lawyer before launch
// (NEEDS-HUMAN, docs/LAUNCH.md). The visible "Draft — under legal review" note is controlled by
// LEGAL_DRAFT in src/lib/legal/meta.ts.
// Open points for the lawyer: legal entity + licence (LEGAL_ENTITY_NAME); if the company sits in a
// financial free zone (ADGM / DIFC) their own data-protection rules apply instead of the federal
// PDPL; cross-border transfer basis; Supabase region; minimum age.
// Numbers come from code: retention from retentionSummary() (src/lib/cleanup/rules.ts), vendors
// from PROCESSORS (src/lib/legal/processors.ts) — never type them here.
// ============================================================================================
import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, type LegalSection } from "@/components/marketing/LegalPage";
import { APP_NAME, LEGAL_ENTITY_NAME, SUPPORT_EMAIL } from "@/lib/brand";
import { retentionSummary } from "@/lib/cleanup/rules";
import { LEGAL_DRAFT, LEGAL_LAST_UPDATED } from "@/lib/legal/meta";
import { PROCESSORS } from "@/lib/legal/processors";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `How ${APP_NAME} handles your photos, captions and account data.`,
  alternates: { canonical: "/privacy" },
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

function sections(): LegalSection[] {
  return [
    {
      id: "who",
      title: "Who we are",
      body: (
        <p>
          {APP_NAME} is operated by {LEGAL_ENTITY_NAME}, based in Abu Dhabi, United Arab Emirates
          (&quot;we&quot;, &quot;us&quot;). We are responsible for the personal data described here. Questions:{" "}
          {mail}.
        </p>
      ),
    },
    {
      id: "collect",
      title: "What we collect",
      body: (
        <ul data-testid="privacy-collect">
          <li>
            <strong>Account:</strong> your email address (and your name, if you sign in with
            Google).
          </li>
          <li>
            <strong>Photos:</strong> the photos you upload, plus smaller copies we make from them (a web copy and a
            512 px thumbnail).
          </li>
          <li>
            <strong>Photo details:</strong> the date a photo was taken and, if your phone saved it, its GPS location
            — read from the photo file (EXIF) on your device.
          </li>
          <li>
            <strong>Your books:</strong> titles, captions, layouts, and your caption preferences (tone, length,
            language, and names you&apos;ve confirmed). You can see and clear these preferences in Settings.
          </li>
          <li>
            <strong>Payments:</strong> whether a book is paid and the order record. Card details are handled by
            Stripe; we never see or store your card number.
          </li>
          <li>
            <strong>Technical data:</strong> anonymous usage events (without cookies) and error reports, scrubbed of
            personal content.
          </li>
        </ul>
      ),
    },
    {
      id: "use",
      title: "How we use it",
      body: (
        <ul>
          <li>To run the service: store your photos, build and show your album, and share it when you publish.</li>
          <li>To build your album with AI (see the next section).</li>
          <li>To send sign-in links and service emails, such as a reminder before a free link expires.</li>
          <li>To take payments and prevent fraud and abuse.</li>
          <li>To fix errors and understand which features are used.</li>
        </ul>
      ),
    },
    {
      id: "ai",
      title: "AI processing of your photos",
      body: (
        <>
          <p>
            Our AI provider, Anthropic (Claude), helps choose your best photos, group them into moments, lay out the
            album and draft captions. For this we send it small 512 px thumbnails of your photos together with their
            dates and place names, your book title, and your caption preferences. We do not send your full-size
            originals or your GPS coordinates.
          </p>
          {/* LEGAL REVIEW: confirm this wording against Anthropic's current commercial terms. */}
          <p>
            Under Anthropic&apos;s commercial terms, data sent through its API is not used to train its models. We do
            not use your photos to train any AI either.
          </p>
          <p>
            The AI&apos;s notes about a photo (for example a short description or a quality score) are stored with the
            photo and deleted together with it. Captions the AI writes are drafts: you can change or remove every one.
          </p>
          <p>
            <strong>Admin access for debugging:</strong> a small number of our team can open the technical log of an
            AI run (which steps ran, photo IDs and keep/drop choices, timings and costs) to investigate problems. When
            you delete a book, the content of its logs is removed.
          </p>
        </>
      ),
    },
    {
      id: "processors",
      title: "Service providers we use",
      body: (
        <>
          <p>We share data only with these providers, only what each needs, and only to run the service:</p>
          <ul data-testid="privacy-processors">
            {PROCESSORS.map((p) => (
              <li key={p.name} data-testid="privacy-processor">
                <strong>{p.name}</strong> — {p.purpose}. <span>Receives: {p.data}</span>{" "}
                <span className="text-muted-foreground">({p.location})</span>
              </li>
            ))}
          </ul>
          <p>
            Some of these providers process data outside the UAE (for example in the United States or the European
            Union). We rely on their contractual data-protection commitments for these transfers. We never sell your
            data or use it for advertising.
          </p>
        </>
      ),
    },
    {
      id: "sharing",
      title: "Shared links",
      body: (
        <>
          <p>
            Your books are private until you publish. When you publish, <strong>anyone with the link</strong> can view
            the book, and they can forward the link. You can add a password, and you can unpublish at any time.
          </p>
          <p>
            Viewers see web copies of your photos without location data. The image links inside a shared book contain
            random internal IDs of your account and book (never your name or email), so someone holding links to two of
            your books could tell they come from the same account. These image links stop working after a few hours.
          </p>
        </>
      ),
    },
    {
      id: "retention",
      title: "How long we keep your data",
      body: (
        <>
          <ul data-testid="privacy-retention">
            {retentionSummary().map((r) => (
              <li key={r.key} data-testid={`retention-${r.key}`}>
                <strong>{r.title}:</strong> {r.text}
              </li>
            ))}
          </ul>
          <p data-testid="privacy-delete-how">
            Delete a free book from its ⋯ menu on your dashboard. Books with a payment can&apos;t be deleted
            individually — delete your account in Settings (which removes all your books) or email us at{" "}
            {mail}. Deleted photos and books are removed from our
            storage; backups held by our providers roll over within their normal backup cycle.
          </p>
        </>
      ),
    },
    {
      id: "cookies",
      title: "Cookies",
      body: (
        <p>
          We use only cookies needed to run the service: one that keeps you signed in, and — for password-protected
          books — one that remembers a viewer entered the right password. We don&apos;t use advertising or tracking
          cookies; our usage statistics work without cookies.
        </p>
      ),
    },
    {
      id: "rights",
      title: "Your rights",
      body: (
        <>
          <p>
            Under the UAE Personal Data Protection Law (Federal Decree-Law No. 45 of 2021) and, for visitors in the
            European Union, the GDPR, you can ask to:
          </p>
          <ul>
            <li>access the personal data we hold about you and get a copy of it;</li>
            <li>correct data that is wrong;</li>
            <li>delete your data — delete a free book from your dashboard, delete your account in Settings, or ask us;</li>
            <li>object to or restrict some processing, and withdraw consent where we rely on it.</li>
          </ul>
          <p>
            Email {mail} and we&apos;ll reply within 30 days. If you&apos;re unhappy with our answer, you can complain
            to the data-protection authority where you live.
          </p>
        </>
      ),
    },
    {
      id: "security",
      title: "Security",
      body: (
        <p>
          Your data is encrypted in transit, access is limited per account, and only you can see your photos and
          drafts. No system is perfectly secure; if a breach affects you, we will tell you as the law requires.
        </p>
      ),
    },
    {
      id: "children",
      title: "Children",
      // LEGAL REVIEW: confirm the minimum age.
      body: <p>{APP_NAME} is meant for adults. Please don&apos;t create an account if you are under 18.</p>,
    },
    {
      id: "changes",
      title: "Changes and contact",
      body: (
        <p>
          If we change this policy, we&apos;ll update the date above and, for important changes, tell you by email.
          Contact: {mail}. See also our <Link href="/terms">Terms</Link>.
        </p>
      ),
    },
  ];
}

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      lastUpdated={LEGAL_LAST_UPDATED}
      draft={LEGAL_DRAFT}
      intro={
        <p>
          Your photos are yours. This policy explains, in plain language, what we collect, why, who helps us run the
          service, and how long we keep things.
        </p>
      }
      sections={sections()}
    />
  );
}
