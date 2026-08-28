import { defineConfig } from "vitest/config";

/**
 * Root Vitest config. The whole workspace is tested from one runner so the
 * Docker green-gate is a single `pnpm test`. Tests live next to the code they
 * cover (`*.test.ts`). Browser/e2e tests use Playwright (apps/web), not Vitest.
 *
 * The deterministic core (shared / compiler offset mapping / agent loop with
 * fakes) runs in the Node environment with no network — see the manifest's
 * "Determinism" test layer.
 */
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"],
    environment: "node",
  },
});
