// Landing page FAQ (M9 T11). Pure data. Retention answers come from retentionSummary()
// (src/lib/cleanup/rules.ts) so the FAQ, the Privacy Policy and the cron can never disagree.
//
// LEGAL REVIEW: the privacy / AI answers are drafts — check with a lawyer before launch
// (NEEDS-HUMAN, see docs/LAUNCH.md).

import { APP_NAME, SUPPORT_EMAIL } from "@/lib/brand";
import { retentionSummary, type RetentionRule } from "@/lib/cleanup/rules";
import { UPGRADE } from "@/lib/pricing";
import { FREE_LINK_DAYS } from "@/lib/publish/rules";

export interface FaqItem {
  id: "privacy" | "ai" | "arabic" | "after_30_days" | "refunds" | "printing";
  question: string;
  /** Paragraphs, plain text. */
  answer: string[];
}

function rule(key: RetentionRule["key"]): string {
  const r = retentionSummary().find((x) => x.key === key);
  if (!r) throw new Error(`missing retention rule ${key}`);
  return r.text;
}

export function faqItems(): FaqItem[] {
  return [
    {
      id: "privacy",
      question: "Who can see my photos?",
      answer: [
        "Only you, until you publish. When you publish, anyone with the book's link can view it — you can add a password, and you can unpublish at any time.",
        `We never sell your photos or use them for advertising. ${APP_NAME} strips location data from the copies that viewers see.`,
      ],
    },
    {
      id: "ai",
      question: "What does the AI see, and is it used for training?",
      answer: [
        "To build your album we send small thumbnails (512 px) of your photos, with their dates and place names, to our AI provider Anthropic (Claude). Your full-size originals and your GPS coordinates are not sent.",
        "Under Anthropic's commercial terms, data sent through its API is not used to train its models. The AI's notes about your photos are deleted together with the photo.",
      ],
    },
    {
      id: "arabic",
      question: "Can captions be in Arabic?",
      answer: [
        "Yes. Choose Arabic for your book and the AI writes captions in Arabic. You can also type your own — Arabic and English text display correctly in the flipbook and in the PDF.",
      ],
    },
    {
      id: "after_30_days",
      question: `What happens to a free book after ${FREE_LINK_DAYS} days?`,
      answer: [rule("free_published"), rule("draft"), rule("paid")],
    },
    {
      id: "refunds",
      question: "Can I get a refund?",
      answer: [
        `The upgrade is a one-time ${UPGRADE.label} per book. If something went wrong, email us at ${SUPPORT_EMAIL} and we'll sort it out.`,
      ],
    },
    {
      id: "printing",
      question: "Can I order a printed book?",
      answer: [
        "Not yet — printed books delivered in the UAE are coming later. Paid books already include a print-quality PDF you can take to any print shop.",
      ],
    },
  ];
}
