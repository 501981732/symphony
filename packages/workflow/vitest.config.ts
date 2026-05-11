import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text"],
      thresholds: {
        statements: 85,
        lines: 85,
      },
    },
  },
});
