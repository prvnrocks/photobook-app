import "server-only";
// Demo video slot (M9 T11): shown only when both files were added to /public/demo. The landing
// page is statically rendered, so this check runs at build time — adding the files needs a deploy.

import { existsSync } from "node:fs";
import path from "node:path";

export const DEMO_VIDEO_SRC = "/demo/demo.mp4";
export const DEMO_POSTER_SRC = "/demo/poster.jpg";

const inPublic = (src: string) => path.join(process.cwd(), "public", ...src.split("/").filter(Boolean));

export function hasDemoVideo(): boolean {
  return existsSync(inPublic(DEMO_VIDEO_SRC)) && existsSync(inPublic(DEMO_POSTER_SRC));
}
