import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Sets dummy env vars before any module (config.ts) loads.
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
