// Task 9: the privacy + AI processing note shown next to the photo upload (wizard step 3 and the
// classic upload page). Plain language, short enough for 375 px. Pure data (tested).

export const UPLOAD_PRIVACY_NOTE = {
  privateLine: "Your photos stay private — only you can see them until you share your book.",
  aiLine:
    "To describe your photos and write your captions and story, we send a smaller copy of each photo (without location data) to Anthropic's Claude AI. Under Anthropic's commercial terms, it isn't used to train their models.",
  aiOffLine: "Only you can see your photos until you share your book.",
  linkText: "How we handle your photos",
  href: "/privacy#ai",
} as const;
