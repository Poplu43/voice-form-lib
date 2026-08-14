import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: "istanbul",
      // lcov is the SonarQube-compatible report. text/html are local-readable;
      // json-summary makes CI assertions easy.
      reporter: ["text", "lcov", "html", "json-summary"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/*.backup",
        "src/vite-env.d.ts",
        "src/environment.d.ts",
        // VoiceFormService.ts is a 7,255-line orchestrator that requires an
        // integration test harness (driving real-time speech-SDK callbacks,
        // mutation observers, dropdown retry loops, etc.) to cover usefully.
        // Excluded from unit-test coverage; tracked separately. See
        // sonar-project.properties for the matching SonarQube exclusion.
        "src/VoiceFormService.ts",
      ],
      all: true,
      // Project-wide threshold: >90% lines/functions, with VoiceFormService.ts
      // excluded as a SonarQube `sonar.coverage.exclusions` entry too — that
      // 7,255-line orchestrator class requires an integration test harness
      // (real-time speech-SDK callbacks, mutation observers, dropdown retry
      // loops) to cover usefully, not unit tests.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 78,
        statements: 90,
      },
    },
  },
  resolve: {
    alias: {
      "@voice-form": resolve(__dirname, "src"),
    },
  },
});
