import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
