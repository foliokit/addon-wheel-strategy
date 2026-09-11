import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts so the engine tests run without the
// react/tailwind build plugins installed.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
