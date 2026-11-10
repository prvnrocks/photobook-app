import "server-only";
// Demo video slot (M9 T11): shown only when a video AND the poster were added to /public/demo.
// scripts/record-demo.mjs writes demo.mp4 (when ffmpeg with libx264 exists) or demo.webm; mp4 is
// preferred because it plays on every phone. *.draft.* files are never picked up. The landing page
// is statically rendered, so this check runs at build time — adding the files needs a deploy.

import { existsSync } from "node:fs";
import path from "node:path";

export const DEMO_VIDEO_SOURCES = [
  { src: "/demo/demo.mp4", type: "video/mp4" },
  { src: "/demo/demo.webm", type: "video/webm" },
] as const;
export const DEMO_POSTER_SRC = "/demo/poster.jpg";

export interface DemoVideoInfo {
  src: string;
  type: string;
  poster: string;
}

const inPublic = (src: string) => path.join(process.cwd(), "public", ...src.split("/").filter(Boolean));

/** First existing demo video (mp4 before webm) + poster, or null when either is missing. */
export function getDemoVideo(exists: (file: string) => boolean = existsSync): DemoVideoInfo | null {
  if (!exists(inPublic(DEMO_POSTER_SRC))) return null;
  const video = DEMO_VIDEO_SOURCES.find((v) => exists(inPublic(v.src)));
  return video ? { src: video.src, type: video.type, poster: DEMO_POSTER_SRC } : null;
}

export function hasDemoVideo(): boolean {
  return getDemoVideo() !== null;
}
