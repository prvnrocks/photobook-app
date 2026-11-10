// Service providers (processors) named in the Privacy Policy, and what each one receives.
// Pure data. Keep in sync when a vendor is added (tests/legal.test.tsx checks the list).

export interface Processor {
  name: string;
  purpose: string;
  /** What data they get, in plain English. */
  data: string;
  /** Where the data is processed / stored. */
  location: string;
}

export const PROCESSORS: readonly Processor[] = [
  {
    name: "Supabase",
    purpose: "Database, sign-in and photo storage",
    data: "Your account email, books, captions, photos and their thumbnails, photo dates and locations.",
    // TODO NEEDS-HUMAN: confirm the Supabase project region before launch.
    location: "Region to be confirmed",
  },
  {
    name: "Vercel",
    purpose: "Hosting the website",
    data: "Requests to the website (such as IP address and browser type) while pages load.",
    location: "Global edge network",
  },
  {
    name: "Anthropic (Claude)",
    purpose: "AI analysis that builds your album and writes captions",
    data: "Small 512 px thumbnails of your photos, their dates and place names, your book title, caption settings and names you've confirmed. Not your full-size originals or GPS coordinates.",
    location: "United States",
  },
  {
    name: "Mapbox",
    purpose: "Turning photo locations into place names",
    data: "GPS coordinates (one point per group of nearby photos). No photos.",
    location: "United States",
  },
  {
    name: "Stripe",
    purpose: "Payments",
    data: "Your email and payment details. We never see or store your card number.",
    location: "Global",
  },
  {
    name: "Resend",
    purpose: "Sending email (sign-in links and reminders)",
    data: "Your email address and the email content.",
    // TODO NEEDS-HUMAN: confirm the Resend sending region.
    location: "United States",
  },
  {
    name: "PostHog",
    purpose: "Anonymous usage statistics",
    data: "Which features are used (for example \"book published\"), without cookies. No photos, captions or names.",
    location: "European Union",
  },
  {
    name: "Sentry",
    purpose: "Error reports",
    data: "Technical details of errors, scrubbed of photos, captions, emails and other personal content.",
    location: "European Union",
  },
] as const;
