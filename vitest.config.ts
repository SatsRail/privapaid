import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    environmentMatchGlobs: [
      ["tests/components/**/*.test.tsx", "jsdom"],
      ["tests/components/**/*.test.ts", "jsdom"],
    ],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      include: [
        "src/lib/**",
        "src/app/api/**",
        "src/middleware.ts",
        "src/components/**",
      ],
      exclude: [
        "src/instrumentation.ts",
        "src/app/**/page.tsx",
        "src/app/**/layout.tsx",
        "src/app/**/loading.tsx",
        "src/app/api/auth/[...nextauth]/route.ts",
        "src/components/SessionProvider.tsx",
      ],
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 85,
      },
    },
    testTimeout: 30000,
    // Integration tests share a single Postgres test DB. Multiple vitest
    // forks each running TRUNCATE in parallel deadlock on cross-table
    // AccessExclusiveLocks. Single-fork serializes the writes; per-test
    // truncate stays cheap. (Vitest 4 moved pool config to top-level.)
    pool: "forks",
    forks: { singleFork: true },
    // Also disable test-file parallelism within the single fork so
    // beforeAll/afterAll setup don't trample each other.
    fileParallelism: false,
  },
});
