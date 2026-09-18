import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "json-summary", "html", "lcov"],
      thresholds: {
        branches: 53,
        functions: 72,
        lines: 74,
        statements: 70,
      },
    },
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
