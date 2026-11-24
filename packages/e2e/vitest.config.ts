import { defineConfig } from "vitest/config";

const junitOutput = process.env.DEPLOYMENTS_E2E_JUNIT_OUTPUT?.trim();

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 30_000,
    include: ["src/**/*.e2e.ts"],
    passWithNoTests: false,
    reporters: junitOutput ? ["default", "junit"] : ["default"],
    restoreMocks: true,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    ...(junitOutput ? { outputFile: { junit: junitOutput } } : {}),
  },
});
