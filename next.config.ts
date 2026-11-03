import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this repo. Without it Next picks up a stray
  // lockfile in a parent folder and infers the wrong root for file tracing.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
