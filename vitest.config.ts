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
        "src/models/**",
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
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
    testTimeout: 30000,
  },
});
