import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // tsconfig has jsx: "preserve" (Next compiles JSX); component render tests need the automatic runtime.
  oxc: { jsx: { runtime: "automatic" } },
  // Components may import plain CSS (e.g. src/components/wizard/wizard-motion.css). Tests don't need it
  // processed, and postcss.config.mjs's string plugin form only works under Next — use an empty inline
  // PostCSS config so Vite never loads it.
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // next/font/local only works under Next's compiler (print fonts, src/components/print).
      "next/font/local": fileURLToPath(new URL("./tests/stubs/next-font-local.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
